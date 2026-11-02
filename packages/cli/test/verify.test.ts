import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Build, Spec, Verification } from '@swissspidy/graft-core';

// No sandbox: the host verifies by failing the first check of every build.
vi.mock('../src/hosts.ts', async (importOriginal) => {
	const original = await importOriginal<typeof import('../src/hosts.ts')>();
	return {
		...original,
		hostTools: async () => ({
			verify: async (targets: Array<{ build: Build; spec: Spec }>) =>
				targets.map(({ build }): Verification => ({
					passed: false,
					spec: build.spec,
					surface: { host: build.surface.host, hostVersion: '7.1', hash: build.surface.hash },
					results: build.checks.map((check, index) => ({ criterion: check.criterion, check: index, passed: index !== 0, failures: index === 0 ? ['stubbed failure'] : [] })),
					unchecked: [],
					verifiedAt: '2026-01-01T00:00:00.000Z',
				}) as unknown as Verification),
		}),
	};
});

const { formatVerification, verifyFiles } = await import('../src/verify.ts');
const root = join(import.meta.dirname, '../../..');

describe('graft verify', () => {
	it('names the spec line of a failing criterion', async () => {
		const spec = join(root, 'examples/specs/review-queue.md');
		const results = await verifyFiles([join(root, 'examples/builds/review-queue.json')], {
			surface: join(root, 'hosts/wordpress/plugin/surfaces/7.1.json'),
			spec,
		});
		const [result] = results;
		expect(result?.spec?.file).toBe(spec);
		const failing = result!.verification!.results[0]!.criterion;
		const line = result!.spec!.criteria[failing];
		expect(line).toBeGreaterThan(0);
		expect(formatVerification(results)).toContain(`✖ ${failing}  (examples/specs/review-queue.md:${line})`);
	});
});
