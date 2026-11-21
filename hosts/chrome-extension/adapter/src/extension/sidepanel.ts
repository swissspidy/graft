import type { PanelInfo, PanelMessage, RenderReply, Reply } from './messages.ts';
import { CustomizationView, el } from './view.ts';

/**
 * The side panel: the slot the browser surface owns. It draws every
 * approved customization for it, as the content script does in an app's
 * page, and draws them again when tabs change, since what they show is
 * the person's tabs.
 */

async function send<T>(message: PanelMessage): Promise<T> {
	const reply = (await chrome.runtime.sendMessage(message)) as Reply<T>;
	if (!reply.ok) {
		throw new Error(reply.error);
	}
	return reply.value;
}

/** The views drawn, by customization id: kept across refreshes so each keeps its state. */
const views = new Map<string, CustomizationView>();
/** The latest draw started: an older one whose reply arrives late must not overwrite it. */
let drawing = 0;

/**
 * Draws the side panel's customizations as the service worker lists them
 * now: one approved, revoked, previewed or stopped by safe mode since the
 * last time appears or goes, and the others draw again.
 */
async function draw(): Promise<void> {
	const root = document.getElementById('panel')!;
	const mine = ++drawing;
	let infos: PanelInfo[];
	try {
		infos = await send<PanelInfo[]>({ type: 'panel-mounts' });
	} catch (error) {
		if (mine === drawing) {
			root.replaceChildren(el('p', 'error', `Could not load the customizations: ${(error as Error).message}`));
		}
		return;
	}
	if (mine !== drawing) {
		return;
	}
	const ids = new Set(infos.map((info) => `${info.id}${info.preview ? ':preview' : ''}`));
	for (const id of [...views.keys()].filter((id) => !ids.has(id))) {
		views.delete(id);
	}
	if (infos.length === 0) {
		const empty = el('p', undefined, 'Nothing here yet. Customizations for the side panel show up here once you approve them. ');
		const link = el('button', undefined, 'Open the customizations');
		link.type = 'button';
		link.addEventListener('click', () => void chrome.runtime.openOptionsPage());
		empty.append(link);
		root.replaceChildren(empty);
		return;
	}
	const hosts: HTMLElement[] = [];
	for (const info of infos) {
		const id = `${info.id}${info.preview ? ':preview' : ''}`;
		let view = views.get(id);
		if (!view) {
			view = new CustomizationView(info.id, info.title, {
				render: (state) => send<RenderReply>({ type: 'panel-render', id: info.id, state }),
				act: (key, state) => send<RenderReply>({ type: 'panel-act', id: info.id, key, state }),
			});
			views.set(id, view);
		}
		hosts.push(view.host);
		void view.render();
	}
	// Only when the list changed: replacing the same elements would detach them, and a focused button would lose focus.
	const same = hosts.length === root.children.length && hosts.every((host, i) => root.children[i] === host);
	if (!same) {
		root.replaceChildren(...hosts);
	}
}

let timer: ReturnType<typeof setTimeout> | undefined;
function refresh(): void {
	clearTimeout(timer);
	timer = setTimeout(() => void draw(), 300);
}

// What is shown changes with approvals, previews and safe mode, as well as with the tabs.
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === 'local' && ['customizations', 'previews', 'safeMode'].some((key) => key in changes)) {
		refresh();
	}
});
chrome.tabs.onCreated.addListener(refresh);
chrome.tabs.onRemoved.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, change) => {
	if (change.title !== undefined || change.url !== undefined || change.pinned !== undefined) {
		refresh();
	}
});
chrome.tabs.onActivated.addListener(refresh);

void draw();
