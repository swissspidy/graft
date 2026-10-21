import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeCheck, type Build } from '../src/index.ts';

const build = JSON.parse(readFileSync(join(import.meta.dirname, '../../../examples/builds/review-queue.json'), 'utf8')) as Build;
const byCriterion = Object.fromEntries(build.checks.map((c) => [c.criterion, c]));

describe('describeCheck', () => {
	it('reads the review queue checks as sentences', () => {
		expect(describeCheck(byCriterion['pending-only']!)).toBe('When "e" opens it, then the list shows exactly "Draft A".');
		expect(describeCheck(byCriterion.approve!)).toBe(
			'When "e" opens it, and uses "approve" on "Draft A", then the list is empty and post matches {"title":"Draft A","status":"publish"}.',
		);
		expect(describeCheck(byCriterion['contributors-no-approve']!)).toBe(
			'When "c" opens it, then the list shows exactly "Draft A" and "approve" on "Draft A" is not available.',
		);
	});

	it('reads direct calls and refusals', () => {
		expect(
			describeCheck({ criterion: 'refused', view_as: 'c', steps: [{ action: 'approve', row: { title: 'Draft A' }, direct: true }], expect: [{ refused: 'approve', row: { title: 'Draft A' } }] }),
		).toBe('When "c" opens it, and calls "approve" on "Draft A" directly, without the button, then calling "approve" on "Draft A" is refused.');
	});

	it('reads drops and named lists', () => {
		expect(describeCheck({ criterion: 'move', view_as: 'e', steps: [{ drop: { title: 'Draft A' }, on: 'pending' }], expect: [{ rows: ['Draft A'], in: 'pending' }, { rows: [], in: 'draft' }] })).toBe(
			'When "e" opens it, and drags "Draft A" onto "pending", then the "pending" list shows exactly "Draft A" and the "draft" list is empty.',
		);
	});

	it('uses host describers for fixtures and assertions', () => {
		const text = describeCheck(byCriterion.approve!, {
			fixtures: () => 'an editor "e" and a pending post "Draft A"',
			assertion: (kind, expected) => (kind === 'post' ? `the post is ${(expected as { status: string }).status}` : undefined),
		});
		expect(text).toBe('Given an editor "e" and a pending post "Draft A", when "e" opens it, and uses "approve" on "Draft A", then the list is empty and the post is publish.');
	});
});
