import { resolveAnchor } from '../host/anchor.ts';
import type { ViewButton, ViewNode } from '../host/a2ui.ts';
import type { ContentMessage, MountInfo, RenderReply, Reply } from './messages.ts';

/**
 * The content script: runs in the app's pages, in Chrome's isolated world.
 * It finds each customization's anchor, inserts an element of its own
 * there with a shadow root (so the app's styles and the customization's
 * do not mix) and draws the view the service worker renders, with DOM
 * APIs only: no markup is ever parsed. A click sends the button's key
 * back; clicks the page's scripts synthesize are ignored.
 *
 * It holds no data and no capabilities. When an anchor does not appear,
 * or is only found again by its landmark, it tells the service worker,
 * which records it as drift.
 */

const ANCHOR_TIMEOUT = 5_000;

const STYLE = `:host{all:initial;display:block;margin:12px 0;font:14px/1.4 system-ui,sans-serif;color:#1d2327}
.graft{border:1px solid #c3c4c7;border-radius:6px;padding:10px 12px;background:#fff}
.graft-title{font-weight:600;margin:0 0 6px}
h1,h2,h3{font-size:15px;margin:6px 0}.caption{color:#646970;font-size:12px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #f0f0f1;vertical-align:top}
th{font-weight:600;font-size:12px;color:#50575e}
button{font:inherit;border:1px solid #2271b1;border-radius:4px;background:#fff;color:#2271b1;padding:2px 10px;cursor:pointer}
button.primary{background:#2271b1;color:#fff}.row{display:flex;gap:8px;flex-wrap:wrap}.card{border:1px solid #dcdcde;border-radius:4px;padding:8px}
.tone-error{color:#d63638}.tone-warning{color:#996800}.tone-success{color:#00a32a}.tone-info{color:#2271b1}
.notice{padding:6px 8px;border-left:4px solid #72aee6;margin:6px 0;background:#f6f7f7}.notice.error{border-color:#d63638}.notice.success{border-color:#00a32a}`;

async function send<T>(message: ContentMessage): Promise<T> {
	const reply = (await chrome.runtime.sendMessage(message)) as Reply<T> | undefined;
	if (!reply) {
		throw new Error('The extension did not answer.');
	}
	if (!reply.ok) {
		throw new Error(reply.error);
	}
	return reply.value;
}

const sheet = (() => {
	// A constructed sheet, not a <style>: it is not subject to the page's CSP.
	const css = new CSSStyleSheet();
	css.replaceSync(STYLE);
	return css;
})();

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

class MountedCustomization {
	readonly host: HTMLElement;
	private readonly root: ShadowRoot;
	private state: Record<string, unknown> = {};
	private busy = false;

	constructor(readonly info: MountInfo) {
		this.host = document.createElement('graft-customization');
		this.host.dataset.graft = info.id;
		this.root = this.host.attachShadow({ mode: 'open' });
		this.root.adoptedStyleSheets = [sheet];
	}

	async render(): Promise<void> {
		try {
			this.show(await send<RenderReply>({ type: 'render', id: this.info.id, state: this.state }));
		} catch (error) {
			this.show({ view: [{ type: 'notice', tone: 'error', text: (error as Error).message }], state: this.state });
		}
	}

	private async press(button: ViewButton, event: MouseEvent): Promise<void> {
		// Only the person's own clicks: the page can dispatch clicks on an open shadow root too.
		if (!event.isTrusted || this.busy) {
			return;
		}
		this.busy = true;
		try {
			this.show(await send<RenderReply>({ type: 'act', id: this.info.id, key: button.key, state: this.state }));
		} catch (error) {
			this.show({ view: [{ type: 'notice', tone: 'error', text: (error as Error).message }], state: this.state });
		} finally {
			this.busy = false;
		}
	}

	private show(reply: RenderReply): void {
		this.state = reply.state;
		const box = el('section', 'graft');
		box.setAttribute('aria-label', this.info.title);
		box.append(el('p', 'graft-title', this.info.title));
		if (reply.notice) {
			const notice = el('p', `notice ${reply.notice.tone}`, reply.notice.text);
			notice.setAttribute('role', reply.notice.tone === 'error' ? 'alert' : 'status');
			box.append(notice);
		}
		for (const node of reply.view) {
			box.append(this.draw(node));
		}
		this.root.replaceChildren(box);
	}

	private button(button: ViewButton): HTMLButtonElement {
		const node = el('button', button.primary ? 'primary' : undefined, button.label);
		node.type = 'button';
		node.addEventListener('click', (event) => void this.press(button, event));
		return node;
	}

	private draw(node: ViewNode): Node {
		switch (node.type) {
			case 'text': {
				const tag = node.variant === 'h1' || node.variant === 'h2' || node.variant === 'h3' ? node.variant : 'p';
				return el(tag, node.variant === 'caption' ? 'caption' : undefined, node.text);
			}
			case 'divider':
				return el('hr');
			case 'button':
				return this.button(node.button);
			case 'notice': {
				const notice = el('p', `notice ${node.tone}`, node.text);
				notice.setAttribute('role', node.tone === 'error' ? 'alert' : 'status');
				return notice;
			}
			case 'group': {
				const group = el('div', node.kind === 'Row' ? 'row' : node.kind === 'Card' ? 'card' : 'column');
				node.children.forEach((child) => group.append(this.draw(child)));
				return group;
			}
			case 'table': {
				if (node.rows.length === 0) {
					return el('p', 'empty', node.empty);
				}
				const table = el('table');
				const head = el('tr');
				node.columns.forEach((column) => head.append(el('th', undefined, column)));
				const withButtons = node.rows.some((row) => row.buttons.length > 0);
				if (withButtons) {
					head.append(el('th'));
				}
				table.append(el('thead'), el('tbody'));
				table.tHead!.append(head);
				for (const row of node.rows) {
					const tr = el('tr');
					row.cells.forEach((cell) => {
						const td = el('td', cell.tone ? `tone-${cell.tone}` : undefined, cell.text);
						if (cell.tone) {
							td.dataset.tone = cell.tone;
						}
						tr.append(td);
					});
					if (withButtons) {
						const td = el('td');
						row.buttons.forEach((button) => td.append(this.button(button)));
						tr.append(td);
					}
					table.tBodies[0]!.append(tr);
				}
				return table;
			}
		}
	}
}

const mounted = new Map<string, MountedCustomization>();
let infos: MountInfo[] = [];
const waitingSince = new Map<string, number>();
const reported = new Set<string>();

function place(info: MountInfo): void {
	const existing = mounted.get(info.id);
	if (existing?.host.isConnected) {
		return;
	}
	const resolved = resolveAnchor(info.anchor, document);
	const report = (status: 'moved' | 'broken') => {
		if (!reported.has(info.slot)) {
			reported.add(info.slot);
			void send({ type: 'anchor', slot: info.slot, status, reason: resolved.reason ?? 'not found' }).catch(() => {});
		}
	};
	if (!resolved.element) {
		const since = waitingSince.get(info.id) ?? Date.now();
		waitingSince.set(info.id, since);
		if (Date.now() - since > ANCHOR_TIMEOUT) {
			report('broken');
		}
		return;
	}
	waitingSince.delete(info.id);
	if (resolved.status === 'moved') {
		// Found again by a later selector or by its landmark alone: shown, and reported as drift.
		report('moved');
	}
	const customization = existing ?? new MountedCustomization(info);
	mounted.set(info.id, customization);
	const target = resolved.element;
	switch (info.anchor.insert) {
		case 'prepend':
			target.prepend(customization.host);
			break;
		case 'before':
			target.before(customization.host);
			break;
		case 'after':
			target.after(customization.host);
			break;
		default:
			target.append(customization.host);
	}
	if (!existing) {
		void customization.render();
	}
}

async function start(): Promise<void> {
	try {
		infos = await send<MountInfo[]>({ type: 'mounts' });
	} catch {
		return;
	}
	if (infos.length === 0) {
		return;
	}
	const placeAll = () => infos.forEach(place);
	placeAll();
	// Apps draw late and redraw: put customizations back when their anchor appears or their element is removed.
	new MutationObserver(placeAll).observe(document.documentElement, { childList: true, subtree: true });
	const timer = setInterval(() => {
		placeAll();
		if (infos.every((info) => mounted.get(info.id)?.host.isConnected || reported.has(info.slot))) {
			clearInterval(timer);
		}
	}, 1_000);
}

void start();
