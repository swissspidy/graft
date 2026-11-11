import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCheck, type Build } from '@swissspidy/graft-core';
import { describers } from '../src/index.ts';

const build = JSON.parse(readFileSync(join(import.meta.dirname, '../../../../examples/builds/review-queue.json'), 'utf8')) as Build;

describe('WordPress check descriptions', () => {
	it('read like the criteria they prove', () => {
		expect(build.checks.map((c) => `${c.criterion}: ${describeCheck(c, describers)}`)).toEqual([
			'pending-only: Given an editor "e", a pending post "Draft A", a draft post "Draft B" and a published post "Post C", when "e" opens it, then the list shows exactly "Draft A".',
			'columns: Given an editor "e" and a pending post "Draft A", when "e" opens it, then the columns are "Title", "Author" and "Submitted".',
			'approve: Given an editor "e" and a pending post "Draft A", when "e" opens it, and uses "approve" on "Draft A", then the list is empty and the post "Draft A" is published.',
			'contributors-no-approve: Given a contributor "c" and a pending post "Draft A" by "c", when "c" opens it, then the list shows exactly "Draft A" and "approve" on "Draft A" is not available.',
			'empty-state: Given an editor "e" and no posts, when "e" opens it, then the list is empty and the page says "Nothing to review".',
		]);
	});

	it('say what a post assertion asserts, and nothing it does not', () => {
		const say = (post: Record<string, unknown>) => describers.assertion!('post', post);
		expect(say({ title: 'A', status: 'publish' })).toBe('the post "A" is published');
		expect(say({ title: 'A', excerpt: 'Short.' })).toBe('the post "A" has the excerpt "Short."');
		expect(say({ title: 'A', status: 'draft', meta: { sold_out: true, venue: null }, terms: { audience: ['family'], genre: [] } })).toBe(
			'the post "A" is draft, has "sold_out" set to true, has no "venue", has exactly the "audience" terms "family" and has no "genre" terms',
		);
		expect(say({ title: 'A' })).toBe('the post "A" exists');
	});
});
