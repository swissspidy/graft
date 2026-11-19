import type { Tab, Tabs } from '../browser/tabs.ts';

/**
 * The browser surface's tab API over `chrome.tabs`, in the service
 * worker. Only what ../browser/tabs.ts asks for: list, get, close, open in
 * the background, bring to the front.
 */

function toTab(tab: chrome.tabs.Tab): Tab {
	return {
		id: tab.id ?? -1,
		title: tab.title ?? '',
		url: tab.url ?? '',
		pinned: tab.pinned,
		active: tab.active,
		...(typeof (tab as { lastAccessed?: number }).lastAccessed === 'number' ? { lastAccessed: (tab as { lastAccessed?: number }).lastAccessed! } : {}),
	};
}

export function chromeTabs(): Tabs {
	return {
		async query() {
			return (await chrome.tabs.query({})).filter((tab) => typeof tab.id === 'number').map(toTab);
		},
		async get(id) {
			try {
				return toTab(await chrome.tabs.get(id));
			} catch {
				return undefined;
			}
		},
		async remove(id) {
			await chrome.tabs.remove(id);
		},
		async create(url) {
			return toTab(await chrome.tabs.create({ url, active: false }));
		},
		async focus(id) {
			const tab = await chrome.tabs.update(id, { active: true });
			if (tab?.windowId !== undefined) {
				await chrome.windows.update(tab.windowId, { focused: true });
			}
			return toTab(tab!);
		},
	};
}
