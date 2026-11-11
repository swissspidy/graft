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
		const post = expected as { title?: string; status?: string; excerpt?: string; meta?: Record<string, unknown>; terms?: Record<string, string[]> };
		// Any of status, excerpt, meta and terms may be asserted: say only the ones that are.
		const parts: string[] = [];
		if (post.status !== undefined) {
			parts.push(`is ${statuses[post.status] ?? post.status}`);
		}
		if (post.excerpt !== undefined) {
			parts.push(`has the excerpt "${post.excerpt}"`);
		}
		for (const [field, value] of Object.entries(post.meta ?? {})) {
			parts.push(value === null ? `has no "${field}"` : `has "${field}" set to ${JSON.stringify(value)}`);
		}
		for (const [taxonomy, slugs] of Object.entries(post.terms ?? {})) {
			parts.push(slugs.length === 0 ? `has no "${taxonomy}" terms` : `has exactly the "${taxonomy}" terms ${slugs.map((slug) => `"${slug}"`).join(', ')}`);
		}
		if (parts.length === 0) {
			return `the post "${post.title}" exists`;
		}
		return `the post "${post.title}" ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`;
	},
};
