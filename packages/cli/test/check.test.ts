import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkBuildFile } from '../src/build.ts';
import { checkFiles, formatCheck } from '../src/check.ts';
import { main } from '../src/main.ts';

const root = join(import.meta.dirname, '../../..');
const agency = join(root, 'examples/agency');

/** A copy of the agency example (specs, builds, a managed bundle and the site's surface) to break. */
function copyAgency(): string {
	const dir = join(mkdtempSync(join(tmpdir(), 'graft-check-')), 'agency');
	cpSync(agency, dir, { recursive: true });
	return dir;
}

function editJson(file: string, edit: (value: Record<string, any>) => void): void {
	const value = JSON.parse(readFileSync(file, 'utf8'));
	edit(value);
	writeFileSync(file, JSON.stringify(value, null, '\t') + '\n');
}

function codes(result: Awaited<ReturnType<typeof checkFiles>>, file: string): string[] {
	return result.files.find((f) => f.file.endsWith(file))?.diagnostics.map((d) => d.code) ?? [];
}

describe('graft check', () => {
	afterEach(() => vi.restoreAllMocks());

	it('passes the checked-in examples, bundles and canary corpus', async () => {
		const log = vi.spyOn(console, 'log').mockImplementation(() => {});
		const code = await main([
			'check',
			join(root, 'examples'),
			join(root, 'fixtures/canary'),
			'--surface',
			join(root, 'hosts/wordpress/plugin/surfaces/7.1.json'),
			'--surface',
			join(root, 'hosts/emdash/adapter/surfaces/1.3.json'),
			'--surface',
			join(root, 'hosts/chrome-extension/adapter/surfaces/tasklet.json'),
		]);
		const output = String(log.mock.calls[0]?.[0]);
		expect(output).toContain('all up to date');
		expect(code).toBe(0);
	});

	it('pairs each build with the nearest spec of its id and finds surfaces under the paths', async () => {
		const result = await checkFiles([copyAgency()]);
		expect(result.ok).toBe(true);
		expect(result.surfaces).toHaveLength(1);
		const build = result.files.find((f) => f.file.endsWith('builds/upcoming-events.json'));
		expect(build?.spec).toMatch(/specs\/upcoming-events\.md$/);
		const bundle = result.files.find((f) => f.file.endsWith('managed/upcoming-events.json'));
		expect(bundle?.kind).toBe('bundle');
		expect(bundle?.spec).toMatch(/specs\/upcoming-events\.md$/);
	});

	it('reports builds and bundles made from an older version of the spec', async () => {
		const dir = copyAgency();
		const spec = join(dir, 'specs/upcoming-events.md');
		writeFileSync(spec, readFileSync(spec, 'utf8').replace('soonest first', 'latest first'));
		const result = await checkFiles([dir]);
		expect(result.ok).toBe(false);
		expect(codes(result, 'builds/upcoming-events.json')).toEqual(['check-spec-stale']);
		expect(codes(result, 'managed/upcoming-events.json')).toEqual(['check-bundle-stale']);
		expect(codes(result, 'builds/family-friendly.json')).toEqual([]);
	});

	it('points a build diagnostic about its spec at the spec line', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'builds/family-friendly.json'), (build) => {
			const [first] = build.checks;
			build.checks = build.checks.filter((check: { criterion: string }) => check.criterion !== first.criterion);
		});
		const result = await checkFiles([dir]);
		const unchecked = result.files.find((f) => f.file.endsWith('builds/family-friendly.json'))?.diagnostics.find((d) => d.code === 'build-criterion-unchecked');
		expect(unchecked?.spec?.line).toBeGreaterThan(0);
		expect(formatCheck(result, dir)).toMatch(/\[build-criterion-unchecked\]  → .*family-friendly\.md:\d+/);
	});

	it('reports a build edited by hand', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'builds/family-friendly.json'), (build) => {
			build.refs.capabilities = [...build.refs.capabilities, 'core/delete-post'];
		});
		const result = await checkFiles([dir]);
		expect(codes(result, 'builds/family-friendly.json')).toContain('build-refs-mismatch');
	});

	it('reports a build for a surface that is not here any more', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'builds/family-friendly.json'), (build) => {
			build.surface.hash = `sha256:${'0'.repeat(64)}`;
		});
		const result = await checkFiles([dir]);
		expect(codes(result, 'builds/family-friendly.json')).toEqual(['check-surface-stale']);
	});

	it('reports a build without its spec, and a criterion the build stopped checking', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'builds/upcoming-events.json'), (build) => {
			build.spec.id = 'nowhere';
		});
		editJson(join(dir, 'builds/family-friendly.json'), (build) => {
			const [first] = build.checks;
			build.checks = build.checks.filter((check: { criterion: string }) => check.criterion !== first.criterion);
		});
		const result = await checkFiles([dir]);
		expect(codes(result, 'builds/upcoming-events.json')).toContain('check-spec-missing');
		expect(codes(result, 'builds/family-friendly.json')).toContain('build-criterion-unchecked');
	});

	it('reports a bundle whose verification is not for its build', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'managed/upcoming-events.json'), (bundle) => {
			bundle.builds[0].verification.passed = false;
		});
		const result = await checkFiles([dir]);
		expect(codes(result, 'managed/upcoming-events.json')).toEqual(['check-bundle-verification']);
	});

	it('reports builds it cannot read instead of skipping them', async () => {
		const dir = copyAgency();
		const broken = join(dir, 'builds/family-friendly.json');
		writeFileSync(broken, readFileSync(broken, 'utf8').replace(/\}\s*$/, ',}'));
		editJson(join(dir, 'builds/upcoming-events.json'), (build) => {
			delete build.ui;
			build.kind = 'page';
		});
		const result = await checkFiles([dir]);
		expect(codes(result, 'builds/family-friendly.json')).toEqual(['check-json']);
		expect(codes(result, 'builds/upcoming-events.json')).toContain('build-schema');
	});

	it('reports a bundled build edited by hand after it was verified', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'managed/upcoming-events.json'), (bundle) => {
			// A text change keeps the build valid and its refs the same; only the verification can tell.
			const [table] = bundle.builds[0].build.ui.components;
			table.empty = `${table.empty} (edited)`;
		});
		expect(codes(await checkFiles([dir]), 'managed/upcoming-events.json')).toEqual(['check-bundle-verification']);
	});

	it('reports a bundle whose verification says passed over a failed check', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'managed/upcoming-events.json'), (bundle) => {
			bundle.builds[0].verification.results[0].passed = false;
		});
		expect(codes(await checkFiles([dir]), 'managed/upcoming-events.json')).toEqual(['check-bundle-verification']);
	});

	it('reports a bundle whose verification does not cover every check of its build', async () => {
		const dir = copyAgency();
		editJson(join(dir, 'managed/upcoming-events.json'), (bundle) => {
			bundle.builds[0].verification.results.pop();
		});
		expect(codes(await checkFiles([dir]), 'managed/upcoming-events.json')).toEqual(['check-bundle-verification']);
	});

	it('leaves JSON that is not a graft document alone, even when it does not parse', async () => {
		const dir = copyAgency();
		writeFileSync(join(dir, 'tsconfig.json'), '{\n\t// comments are fine here\n\t"compilerOptions": {},\n}\n');
		const result = await checkFiles([dir]);
		expect(result.ok).toBe(true);
		expect(result.files.some((f) => f.file.endsWith('tsconfig.json'))).toBe(false);
	});

	it('reports a bundle with two specs of its id equally near', async () => {
		const dir = copyAgency();
		cpSync(join(dir, 'specs/upcoming-events.md'), join(dir, 'specs/upcoming-events-copy.md'));
		const result = await checkFiles([dir]);
		expect(codes(result, 'managed/upcoming-events.json')).toEqual(['check-spec-ambiguous']);
		expect(codes(result, 'builds/upcoming-events.json')).toEqual(['check-spec-ambiguous']);
	});

	it('reports a bundle without builds, or with a build missing its surface', async () => {
		const empty = copyAgency();
		editJson(join(empty, 'managed/upcoming-events.json'), (bundle) => {
			bundle.builds = [];
		});
		expect(codes(await checkFiles([empty]), 'managed/upcoming-events.json')).toEqual(['check-bundle-shape']);

		const nullSurface = copyAgency();
		editJson(join(nullSurface, 'managed/upcoming-events.json'), (bundle) => {
			bundle.builds[0].build.surface = null;
		});
		expect(codes(await checkFiles([nullSurface]), 'managed/upcoming-events.json')).toContain('check-build-shape');
	});

	it('exits 2 without paths', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await main(['check'])).toBe(2);
	});
});

describe('graft build --fix-refs', () => {
	const files = (dir: string) => ({ build: join(dir, 'builds/upcoming-events.json'), options: { surface: join(dir, 'surface.json'), spec: join(dir, 'specs/upcoming-events.md'), fixRefs: true } });

	it('re-stamps a build whose refs are stale', async () => {
		const { build, options } = files(copyAgency());
		editJson(build, (value) => {
			value.refs.capabilities = [];
		});
		expect(await checkBuildFile(build, options)).toMatchObject({ ok: true, fixed: true });
		expect(JSON.parse(readFileSync(build, 'utf8')).refs.capabilities.length).toBeGreaterThan(0);
	});

	it('leaves a build that is still invalid as it was, so its stale spec hash keeps showing', async () => {
		const { build, options } = files(copyAgency());
		editJson(build, (value) => {
			value.spec.hash = 'sha256:stale';
			value.checks[0].criterion = 'gone';
		});
		const before = readFileSync(build, 'utf8');
		expect(await checkBuildFile(build, options)).toMatchObject({ ok: false, fixed: false });
		expect(readFileSync(build, 'utf8')).toBe(before);
	});
});
