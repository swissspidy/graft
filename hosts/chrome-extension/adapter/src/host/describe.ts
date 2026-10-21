import type { CheckDescribers } from '@swissspidy/graft-core/runtime';

/** Plain-language describers for Tasklet fixtures and host assertions. */

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

export const describers: CheckDescribers = {
	fixtures(fixtures) {
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
		if (kind !== 'task') {
			return undefined;
		}
		const task = expected as { title?: string; status?: string };
		return `the task "${task.title}" is ${task.status}`;
	},
};
