import { resolveAnchor } from '../host/anchor.ts';
import type { ContentMessage, MountInfo, RenderReply, Reply } from './messages.ts';
import { CustomizationView } from './view.ts';

/**
 * The content script: runs in the app's pages, in Chrome's isolated world.
 * It finds each customization's anchor, inserts an element of its own
 * there with a shadow root (so the app's styles and the customization's
 * do not mix) and draws the view the service worker renders (./view.ts).
 *
 * It holds no data and no capabilities. When an anchor does not appear,
 * or is only found again by its landmark, it tells the service worker,
 * which records it as drift.
 */

const ANCHOR_TIMEOUT = 5_000;

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

/** A customization in this page: its view, talking to the service worker as the content script. */
function mountedView(info: MountInfo): CustomizationView {
	return new CustomizationView(info.id, info.title, {
		render: (state) => send<RenderReply>({ type: 'render', id: info.id, state }),
		act: (key, state) => send<RenderReply>({ type: 'act', id: info.id, key, state }),
	});
}

const mounted = new Map<string, CustomizationView>();
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
	const customization = existing ?? mountedView(info);
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
