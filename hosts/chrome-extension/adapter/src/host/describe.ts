import type { CheckDescribers } from '@swissspidy/graft-core/runtime';

/** Plain-language describers for Tasklet fixtures and host assertions. */

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

interface TabFixture {
	title: string;
	pinned?: boolean;
	active?: boolean;
	unused_days?: number;
}

const list = (parts: string[]) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : (parts[0] ?? ''));

function describeTabs(tabs: TabFixture[]): string {
	if (tabs.length === 0) {
		return 'no open tabs';
	}
	return list(
		tabs.map((tab) => {
			const kind = [tab.pinned ? 'pinned' : '', tab.active ? 'active' : ''].filter(Boolean).join(', ');
			const days = tab.unused_days ? `, unused for ${tab.unused_days} days` : '';
			return `${kind ? `a ${kind}` : 'a'} tab "${tab.title}"${days}`;
		}),
	);
}

export const describers: CheckDescribers = {
	fixtures(fixtures) {
		if (Array.isArray(fixtures.tabs)) {
			return describeTabs(fixtures.tabs as TabFixture[]);
		}
		const users = (fixtures.users as Array<{ as: string; role: string }> | undefined) ?? [];
		const tasks = (fixtures.tasks as Array<{ title: string; status?: string; due_in_days?: number | null; assignee?: string | null }> | undefined) ?? [];
		const parts = users.map((u) => `${article(u.role)} ${u.role} "${u.as}"`);
		if (tasks.length === 0) {
			parts.push('no tasks');
		}
		for (const task of tasks) {
			const due = task.due_in_days === undefined || task.due_in_days === null ? '' : task.due_in_days < 0 ? `, ${-task.due_in_days} days overdue` : `, due in ${task.due_in_days} days`;
			parts.push(`${article(task.status ?? 'open')} ${task.status ?? 'open'} task "${task.title}"${task.assignee ? ` for "${task.assignee}"` : ''}${due}`);
		}
		return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
	},
	assertion(kind, expected) {
		if (kind === 'tabs' && Array.isArray(expected)) {
			return expected.length === 0 ? 'no tabs are open' : `exactly ${list(expected.map((title) => `"${String(title)}"`))} ${expected.length === 1 ? 'is' : 'are'} open`;
		}
		if (kind !== 'task') {
			return undefined;
		}
		const task = expected as { title?: string; status?: string };
		return `the task "${task.title}" is ${task.status}`;
	},
};
