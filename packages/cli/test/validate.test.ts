import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/main.ts';

const examples = join(import.meta.dirname, '../../../examples/specs');

describe('graft validate', () => {
	afterEach(() => vi.restoreAllMocks());

	it('exits 0 for the example specs', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		expect(await main(['validate', examples])).toBe(0);
		expect(log.mock.calls[0]?.[0]).toContain('2 spec(s), 0 invalid');
	});

	it('exits 1 and prints JSON diagnostics for an invalid spec', async () => {
		const dir = mkdtempSync(join(tmpdir(), 'graft-'));
		const file = join(dir, 'bad.md');
		writeFileSync(file, '---\ngraft: 1\n---\n# Bad\n');
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		expect(await main(['validate', '--json', file])).toBe(1);
		const [result] = JSON.parse(log.mock.calls[0]?.[0] as string);
		expect(result.ok).toBe(false);
		expect(result.diagnostics.map((d: { code: string }) => d.code)).toContain('criteria-missing');
	});

	it('exits 2 without arguments', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await main(['validate'])).toBe(2);
	});
});
