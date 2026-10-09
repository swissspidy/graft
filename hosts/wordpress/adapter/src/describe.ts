import type { CheckDescribers } from '@swissspidy/graft-core/runtime';

/** Plain-language describers for WordPress fixtures and host assertions. */

const statuses: Record<string, string> = {
	publish: 'published',
	future: 'scheduled',
	draft: 'draft',
	pending: 'pending',
	private: 'private',
};

const article = (word: string) => (/^[aeiou]/.test(word) ? 'an' : 'a');

export const describers: CheckDescribers = {
	fixtures(fixtures) {
		const users = (fixtures.users as Array<{ as: string; role: string }> | undefined) ?? [];
		const posts = (fixtures.posts as Array<{ title: string; status?: string; author?: string }> | undefined) ?? [];
		const parts = users.map((u) => `${article(u.role)} ${u.role} "${u.as}"`);
		if (posts.length === 0) {
			parts.push('no posts');
		}
		for (const post of posts) {
			const status = statuses[post.status ?? 'publish'] ?? post.status ?? 'published';
			parts.push(`${article(status)} ${status} post "${post.title}"${post.author ? ` by "${post.author}"` : ''}`);
		}
		return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
	},
	assertion(kind, expected) {
		if (kind !== 'post') {
			return undefined;
		}
		const post = expected as { title?: string; status?: string };
		return `the post "${post.title}" is ${statuses[post.status ?? ''] ?? post.status}`;
	},
};
