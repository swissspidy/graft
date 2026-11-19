import type { ViewButton, ViewNode } from '../host/a2ui.ts';
import type { RenderReply } from './messages.ts';

/**
 * Draws a customization's view (rendered in the service worker) into an
 * element of its own with an open shadow root, with DOM APIs only: no
 * markup is ever parsed. Shared by the content script (in an app's page)
 * and the side panel. A click sends the button's key back; clicks a
 * page's scripts synthesize are ignored.
 */

const STYLE = `:host{all:initial;color-scheme:light;display:block;margin:12px 0;font:14px/1.4 system-ui,sans-serif;color:#1d2327}
.graft{border:1px solid #c3c4c7;border-radius:6px;padding:10px 12px;background:#fff}
.graft-title{font-weight:600;margin:0 0 6px}
h1,h2,h3{font-size:15px;margin:6px 0}.caption{color:#646970;font-size:12px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:4px 6px;border-bottom:1px solid #f0f0f1;vertical-align:top}
th{font-weight:600;font-size:12px;color:#50575e}
button{font:inherit;border:1px solid #2271b1;border-radius:4px;background:#fff;color:#2271b1;padding:2px 10px;cursor:pointer}
button.primary{background:#2271b1;color:#fff}.row{display:flex;gap:8px;flex-wrap:wrap}.card{border:1px solid #dcdcde;border-radius:4px;padding:8px}
.tone-error{color:#d63638}.tone-warning{color:#996800}.tone-success{color:#00a32a}.tone-info{color:#2271b1}
.notice{padding:6px 8px;border-left:4px solid #72aee6;margin:6px 0;background:#f6f7f7}.notice.error{border-color:#d63638}.notice.success{border-color:#00a32a}
.visually-hidden{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}`;

let sheet: CSSStyleSheet | undefined;

/** A constructed sheet, not a <style>: it is not subject to the page's CSP. */
function styles(): CSSStyleSheet {
	if (!sheet) {
		sheet = new CSSStyleSheet();
		sheet.replaceSync(STYLE);
	}
	return sheet;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (className) {
		node.className = className;
	}
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

/** How a view reaches the service worker. */
export interface Transport {
	render(state: Record<string, unknown>): Promise<RenderReply>;
	act(key: string, state: Record<string, unknown>): Promise<RenderReply>;
}

export class CustomizationView {
	readonly host: HTMLElement;
	private readonly root: ShadowRoot;
	private state: Record<string, unknown> = {};
	private busy = false;
	/** Each drawn button's key, to give focus back to the same button after a redraw. */
	private readonly keys = new WeakMap<HTMLButtonElement, string>();

	constructor(
		readonly id: string,
		readonly title: string,
		private readonly transport: Transport,
	) {
		this.host = document.createElement('graft-customization');
		this.host.dataset.graft = id;
		this.root = this.host.attachShadow({ mode: 'open' });
		this.root.adoptedStyleSheets = [styles()];
	}

	async render(): Promise<void> {
		if (this.busy) {
			return;
		}
		try {
			this.show(await this.transport.render(this.state));
		} catch (error) {
			this.show({ view: [{ type: 'notice', tone: 'error', text: (error as Error).message }], state: this.state });
		}
	}

	private async press(button: ViewButton, event: MouseEvent): Promise<void> {
		// Only the person's own clicks: a page can dispatch clicks on an open shadow root too.
		if (!event.isTrusted || this.busy) {
			return;
		}
		this.busy = true;
		try {
			this.show(await this.transport.act(button.key, this.state));
		} catch (error) {
			this.show({ view: [{ type: 'notice', tone: 'error', text: (error as Error).message }], state: this.state });
		} finally {
			this.busy = false;
		}
	}

	private show(reply: RenderReply): void {
		this.state = reply.state;
		// Redrawing replaces every button: the one that had focus hands it to its replacement, or to the box.
		const focused = this.root.activeElement instanceof HTMLButtonElement ? this.keys.get(this.root.activeElement) : undefined;
		const box = el('section', 'graft');
		box.setAttribute('aria-label', this.title);
		box.append(el('p', 'graft-title', this.title));
		if (reply.notice) {
			const notice = el('p', `notice ${reply.notice.tone}`, reply.notice.text);
			notice.setAttribute('role', reply.notice.tone === 'error' ? 'alert' : 'status');
			box.append(notice);
		}
		for (const node of reply.view) {
			box.append(this.draw(node));
		}
		this.root.replaceChildren(box);
		if (focused !== undefined) {
			const again = [...box.querySelectorAll('button')].find((b) => this.keys.get(b) === focused);
			if (again) {
				again.focus();
			} else {
				box.tabIndex = -1;
				box.focus();
			}
		}
	}

	private button(button: ViewButton): HTMLButtonElement {
		const node = el('button', button.primary ? 'primary' : undefined, button.label);
		node.type = 'button';
		this.keys.set(node, button.key);
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
				const th = (text?: string) => {
					const cell = el('th', undefined, text);
					cell.scope = 'col';
					return cell;
				};
				node.columns.forEach((column) => head.append(th(column)));
				const withButtons = node.rows.some((row) => row.buttons.length > 0);
				if (withButtons) {
					const actions = th();
					actions.append(el('span', 'visually-hidden', 'Actions'));
					head.append(actions);
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
