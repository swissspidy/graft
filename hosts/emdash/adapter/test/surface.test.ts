import { hashSurface, validateSurface } from '@swissspidy/graft-core';
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hostSurface } from '../src/host/surface.ts';

describe('the EmDash surface', () => {
	it('is valid and matches the committed snapshot', async () => {
		const committed = JSON.parse(await readFile(new URL('../surfaces/1.0.json', import.meta.url), 'utf8'));
		const surface = hostSurface(committed.hostVersion);
		expect((await validateSurface(surface)).ok).toBe(true);
		expect(await hashSurface(surface)).toBe(committed.hash);
	});

	it('maps every scope to EmDash permissions', () => {
		for (const scope of Object.values(hostSurface('1.0.1').scopes)) {
			expect(scope.host?.length).toBeGreaterThan(0);
		}
	});
});
