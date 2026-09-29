import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deriveCriterionId, parseSpec, validateSpec } from '../src/index.ts';

const examplesDir = join(import.meta.dirname, '../../../examples/specs');

const valid = `---
graft: 1
id: review-queue
host: wordpress
mount:
  slot: admin.page
  menu: { parent: posts, title: Review queue }
audience: [editor]
permissions: [posts:read, posts.status:write]
---

# Review queue

Editors see pending posts.

## Acceptance criteria

- Only posts with status "pending" are listed {#pending-only}
- "Approve" sets status to "publish"
  and removes the row {#approve}

## Out of scope

- Rejecting posts

## Notes

Keep it simple.

## Background

Asked for by the editorial team.
`;

function codes(source: string) {
	return validateSpec(source).diagnostics.map((d) => d.code);
}

describe('validateSpec', () => {
	it('accepts every example spec without warnings', () => {
		for (const file of readdirSync(examplesDir)) {
			const result = validateSpec(readFileSync(join(examplesDir, file), 'utf8'));
			expect(result.diagnostics, file).toEqual([]);
			expect(result.ok, file).toBe(true);
		}
	});

	it('parses every part of a spec', () => {
		const { ok, spec } = validateSpec(valid);
		expect(ok).toBe(true);
		expect(spec?.manifest.mount).toEqual({ slot: 'admin.page', menu: { parent: 'posts', title: 'Review queue' } });
		expect(spec?.title).toBe('Review queue');
		expect(spec?.description).toBe('Editors see pending posts.');
		expect(spec?.criteria).toEqual([
			{ id: 'pending-only', text: 'Only posts with status "pending" are listed', explicitId: true, line: 18 },
			{ id: 'approve', text: '"Approve" sets status to "publish" and removes the row', explicitId: true, line: 19 },
		]);
		expect(spec?.outOfScope).toEqual(['Rejecting posts']);
		expect(spec?.notes).toBe('Keep it simple.');
		expect(spec?.sections).toEqual([{ heading: 'Background', content: 'Asked for by the editorial team.', line: 30 }]);
	});

	it('reports schema errors on the offending frontmatter line', () => {
		const source = valid.replace('posts.status:write', 'posts.status:delete').replace('host: wordpress', 'host: wordpress\ncolor: red');
		const result = validateSpec(source);
		expect(result.ok).toBe(false);
		expect(result.spec).toBeUndefined();
		expect(result.diagnostics).toEqual([
			expect.objectContaining({ code: 'frontmatter-schema', path: '/color', line: 5 }),
			expect.objectContaining({ code: 'frontmatter-schema', path: '/permissions/1', line: 10 }),
		]);
	});

	it('requires the manifest fields', () => {
		const source = valid.replace(/^id: .*\n/m, '').replace(/^graft: 1\n/m, 'graft: 2\n');
		const messages = validateSpec(source).diagnostics.map((d) => d.message);
		expect(messages).toContain('The frontmatter is missing required field "id".');
		expect(messages).toContain('"graft" must be 1.');
	});

	it('rejects missing or broken frontmatter', () => {
		expect(codes('# Title\n')).toContain('frontmatter-missing');
		expect(codes('---\nid: x\n# Title\n')).toContain('frontmatter-unterminated');
		expect(codes('---\nid: [x\n---\n')).toContain('frontmatter-yaml');
		expect(codes('---\n- a\n---\n')).toContain('frontmatter-not-object');
	});

	it('requires a title and acceptance criteria', () => {
		expect(codes(valid.replace('# Review queue', ''))).toContain('title-missing');
		expect(codes(valid.replace('## Acceptance criteria', '## Criteria'))).toContain('criteria-missing');
		expect(codes(valid.replace(/- Only[^\n]*\n- "Approve"[^\n]*\n[^\n]*\n/, 'Nothing listed.\n'))).toContain(
			'criteria-empty',
		);
	});

	it('rejects duplicate and invalid criterion ids', () => {
		expect(codes(valid.replace('{#approve}', '{#pending-only}'))).toContain('criterion-id-duplicate');
		expect(codes(valid.replace('{#approve}', '{#Approve_It}'))).toContain('criterion-id-invalid');
	});

	it('derives ids for unmarked criteria with a warning', () => {
		const result = validateSpec(valid.replace(' {#approve}', '').replace(' {#pending-only}', ''));
		expect(result.ok).toBe(true);
		expect(result.spec?.criteria.map((c) => [c.id, c.explicitId])).toEqual([
			['only-posts-with-status-pending-are-listed', false],
			['approve-sets-status-to-publish-and-removes-the', false],
		]);
		expect(result.diagnostics.map((d) => d.code)).toEqual(['criterion-id-derived', 'criterion-id-derived']);
	});

	it('ignores headings inside code fences', () => {
		const source = valid.replace('Editors see pending posts.', 'Editors see pending posts.\n\n```\n## Acceptance criteria\n```');
		expect(validateSpec(source).ok).toBe(true);
	});
});

describe('deriveCriterionId', () => {
	it('normalizes accents and punctuation and cuts at a word boundary', () => {
		expect(deriveCriterionId('Éditeurs voient « Approuver »')).toBe('editeurs-voient-approuver');
		expect(deriveCriterionId('a'.repeat(60))).toHaveLength(48);
	});
});

describe('parseSpec', () => {
	it('never throws on garbage', () => {
		expect(() => parseSpec('\u0000---\n:::\n')).not.toThrow();
	});
});
