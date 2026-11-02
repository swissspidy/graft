import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Verification } from '@swissspidy/graft-core';
import { formatSpecLocation } from '../src/format.ts';
import { main } from '../src/main.ts';
import { formatVerification } from '../src/verify.ts';

const root = join(import.meta.dirname, '../../..');

describe('spec locations in the CLI', () => {
	afterEach(() => vi.restoreAllMocks());

	it('formats a location as file:line with the frontmatter key', () => {
		expect(formatSpecLocation({ path: '/mount/slot', line: 6 }, '/elsewhere/q.md')).toBe('/elsewhere/q.md:6 (/mount/slot)');
		expect(formatSpecLocation({ line: 20 }, undefined)).toBe('spec:20');
		expect(formatSpecLocation(undefined, 'q.md')).toBe('');
	});

	it('graft build points at the spec line a build disagrees with', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'graft-format-'));
		const spec = join(dir, 'review-queue.md');
		const build = join(dir, 'review-queue.json');
		copyFileSync(join(root, 'examples/builds/review-queue.json'), build);
		const source = readFileSync(join(root, 'examples/specs/review-queue.md'), 'utf8');
		writeFileSync(spec, source.replace(/^  - posts\.status:write\n/m, ''));
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		expect(await main(['build', build, '--surface', join(root, 'hosts/wordpress/plugin/surfaces/7.1.json'), '--spec', spec])).toBe(1);
		const line = source.split('\n').findIndex((l) => l.startsWith('permissions:')) + 1;
		const output = log.mock.calls.map((c) => String(c[0])).join('\n');
		expect(output).toContain(`[build-scope-not-requested]  → ${spec}:${line} (/permissions)`);
	});

	it('graft verify names the spec line of each failing or unchecked criterion', () => {
		const verification = {
			passed: false,
			spec: { id: 'q', hash: 'sha256:x' },
			surface: { host: 'wordpress', hostVersion: '7.1', hash: 'sha256:y' },
			results: [
				{ criterion: 'ok', passed: true, failures: [] },
				{ criterion: 'broken', passed: false, failures: ['expected 1 row'] },
			],
			unchecked: ['lonely'],
			verifiedAt: '2026-01-01T00:00:00.000Z',
		} as unknown as Verification;
		const output = formatVerification([{ file: 'q.json', verification, errors: [], spec: { file: '/x/q.md', criteria: { ok: 10, broken: 11, lonely: 12 } } }]);
		expect(output).toContain('  ✔ ok\n');
		expect(output).toContain('  ✖ broken  (/x/q.md:11)');
		expect(output).toContain('  ✖ lonely  (no check)  (/x/q.md:12)');
	});
});
