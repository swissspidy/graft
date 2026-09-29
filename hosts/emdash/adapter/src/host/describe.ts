import type { CheckDescribers } from '@graft/core/runtime';

/** Plain-language describers for EmDash fixtures and host assertions. */

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

export const describers: CheckDescribers = {
	fixtures(fixtures) {
		const users = (fixtures.users as Array<{ as: string; role: string }> | undefined) ?? [];
		const entries = (fixtures.entries as Array<{ title: string; status?: string; collection?: string }> | undefined) ?? [];
		const parts = users.map((u) => `${article(u.role)} ${u.role} "${u.as}"`);
		if (entries.length === 0) {
			parts.push('no entries');
		}
		for (const entry of entries) {
			const status = entry.status ?? 'published';
			const kind = entry.collection && entry.collection !== 'posts' ? `${entry.collection} entry` : 'post';
			parts.push(`${article(status)} ${status} ${kind} "${entry.title}"`);
		}
		return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
	},
	assertion(kind, expected) {
		if (kind !== 'entry') {
			return undefined;
		}
		const entry = expected as { title?: string; status?: string };
		return `the entry "${entry.title}" is ${entry.status}`;
	},
};
