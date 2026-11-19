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

const views: CustomizationView[] = [];

async function start(): Promise<void> {
	const root = document.getElementById('panel')!;
	const infos = await send<PanelInfo[]>({ type: 'panel-mounts' });
	root.replaceChildren();
	if (infos.length === 0) {
		const empty = el('p', undefined, 'Nothing here yet. Customizations for the side panel show up here once you approve them. ');
		const link = el('button', undefined, 'Open the customizations');
		link.type = 'button';
		link.addEventListener('click', () => void chrome.runtime.openOptionsPage());
		empty.append(link);
		root.append(empty);
		return;
	}
	for (const info of infos) {
		const view = new CustomizationView(info.id, info.title, {
			render: (state) => send<RenderReply>({ type: 'panel-render', id: info.id, state }),
			act: (key, state) => send<RenderReply>({ type: 'panel-act', id: info.id, key, state }),
		});
		views.push(view);
		root.append(view.host);
		void view.render();
	}
}

let timer: ReturnType<typeof setTimeout> | undefined;
function refresh(): void {
	clearTimeout(timer);
	timer = setTimeout(() => views.forEach((view) => void view.render()), 300);
}

chrome.tabs.onCreated.addListener(refresh);
chrome.tabs.onRemoved.addListener(refresh);
chrome.tabs.onUpdated.addListener((_id, change) => {
	if (change.title !== undefined || change.url !== undefined || change.pinned !== undefined) {
		refresh();
	}
});
chrome.tabs.onActivated.addListener(refresh);

void start();
