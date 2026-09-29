import { describe, expect, it } from 'vitest';
import {
	applyMigrations,
	extractRefs,
	hashSpec,
	staticCheck,
	upgradeBuild,
	verifyBuild,
	type Build,
	type Surface,
	type UpgradeOptions,
} from '../src/index.ts';
import { createCan, fakeSandbox, pageBuild, semantics, spec, specSource, surface, type FakeHostOptions } from './fixtures/acme.ts';

const specHash = await hashSpec(specSource);
const grant = ['items:read', 'items:write'];

/** A surface derived from the base one. */
function surfaceB(change: (s: Surface) => void): Surface {
	const s = structuredClone(surface);
	s.hostVersion = '2.0';
	change(s);
	return s;
}

function upgrade(build: Build, to: Surface, host: FakeHostOptions = {}, extra: Partial<UpgradeOptions> = {}) {
	return upgradeBuild({
		build,
		spec,
		specHash,
		grant,
		from: surface,
		to,
		verify: (candidate, g) => verifyBuild({ build: candidate, spec, surface: to, sandbox: fakeSandbox(host), semantics, createCan, grant: g }),
		...extra,
	});
}

/** A row-action build on the item.actions extension slot. */
async function linkBuild(): Promise<Build> {
	const build = await pageBuild();
	build.mount = { slot: 'item.actions' };
	build.data = {};
	build.tree = {
		type: 'link',
		props: {
			id: 'close',
			label: 'Close',
			visible: { $and: [{ $eq: [{ $slot: 'item.status' }, 'open'] }, { $can: 'items:write' }] },
			onClick: { $call: 'items.close', input: { id: { $slot: 'item.id' } }, then: ['reload:page'] },
		},
	};
	const close = {
		criterion: 'close',
		fixtures: { users: [{ as: 'm', role: 'manager' }], items: [{ title: 'Open A', status: 'open' }, { title: 'Done B', status: 'done' }] },
		view_as: 'm',
		steps: [{ action: 'close', row: { title: 'Open A' } }],
		expect: [{ item: { title: 'Open A', status: 'done' } }, { action: 'close', row: { title: 'Done B' }, available: false }],
	};
	// One behavioral check, filed under every criterion so none is unchecked.
	build.checks = spec.criteria.map((c) => ({ ...close, criterion: c.id }));
	build.refs = extractRefs(build, surface);
	return build;
}

describe('staticCheck', () => {
	it('ignores text-only changes and classifies the rest', async () => {
		const build = await pageBuild();
		const text = surfaceB((s) => {
			s.components.list!.description = 'Now with better docs';
			s.capabilities['items.list']!.description = 'Lists items.';
		});
		expect(staticCheck(build, surface, text)).toEqual({ changes: [], start: 'reverify' });

		const renamed = surfaceB((s) => {
			s.capabilities['items.query'] = s.capabilities['items.list']!;
			delete s.capabilities['items.list'];
			s.migrations = [{ op: 'rename', kind: 'capability', from: 'items.list', to: 'items.query' }];
		});
		expect(staticCheck(build, surface, renamed).start).toBe('migrate');

		const scopes = surfaceB((s) => {
			s.scopes['items:admin'] = { title: 'Administer items' };
			s.capabilities['items.close']!.scopes = ['items:write', 'items:admin'];
		});
		expect(staticCheck(build, surface, scopes)).toEqual({
			changes: [{ kind: 'capability', symbol: 'items.close', change: 'changed', refsOnly: true }],
			start: 'reverify',
		});

		const input = surfaceB((s) => {
			s.capabilities['items.list']!.input = { type: 'object', properties: { state: { type: 'string' } } };
		});
		expect(staticCheck(build, surface, input).start).toBe('regenerate');
	});
});

describe('applyMigrations', () => {
	it('renames capabilities in data and actions, and props with value maps', async () => {
		const build = await pageBuild();
		const migrated = applyMigrations(build, [
			{ op: 'rename', kind: 'capability', from: 'items.close', to: 'items.archive' },
			{ op: 'rename', kind: 'component', from: 'list', to: 'grid' },
			{ op: 'rename-prop', component: 'grid', from: 'empty', to: 'emptyText' },
		])!;
		const grid = (migrated.tree.children as Build['tree'][])[1]!;
		expect(grid.type).toBe('grid');
		expect(grid.props!.emptyText).toBe('All done');
		expect(JSON.stringify(grid.props)).toContain('"$call":"items.archive"');
		expect(applyMigrations(build, [{ op: 'remove', kind: 'capability', symbol: 'items.close' }])).toBeUndefined();
		expect(applyMigrations(build, [{ op: 'remove', kind: 'capability', symbol: 'unused' }])).toEqual(build);
	});
});

describe('upgradeBuild', () => {
	it('survives a host change that does not touch the build', async () => {
		const result = await upgrade(await pageBuild(), surfaceB(() => {}));
		expect(result.outcome).toBe('survived');
		expect(result.build!.surface.hostVersion).toBe('2.0');
		expect(result.path.map((p) => p.state)).toEqual(['static_check', 'reverify']);
	});

	it('migrates a renamed capability', async () => {
		const to = surfaceB((s) => {
			s.capabilities['items.query'] = s.capabilities['items.list']!;
			delete s.capabilities['items.list'];
			s.migrations = [{ op: 'rename', kind: 'capability', from: 'items.list', to: 'items.query' }];
		});
		const result = await upgrade(await pageBuild(), to, { aliases: { 'items.query': 'items.list' } });
		expect(result.outcome).toBe('migrated');
		expect(result.build!.data.open!.call).toBe('items.query');
		expect(result.build!.provenance).toMatchObject({ strategy: 'migrated', replaces: expect.stringMatching(/^sha256:/) });
	});

	it('re-anchors to a deprecated slot\'s successor', async () => {
		const to = surfaceB((s) => {
			s.slots['item.links'] = { ...s.slots['item.actions']! };
			s.slots['item.actions'] = { ...s.slots['item.actions']!, deprecated: true, successor: 'item.links' };
		});
		const result = await upgrade(await linkBuild(), to, { itemSlots: ['item.actions', 'item.links'] });
		expect(result.outcome).toBe('reanchored');
		expect(result.build!.mount.slot).toBe('item.links');
		expect(result.path.map((p) => p.state)).toEqual(['static_check', 'verify_reanchored']);
	});

	it('regenerates when nothing deterministic fits, and fails without a compiler', async () => {
		const to = surfaceB((s) => {
			s.capabilities['items.list']!.input = { type: 'object', properties: { state: { type: 'string' } }, additionalProperties: false };
		});
		const host = { statusKey: 'state' };
		const failed = await upgrade(await pageBuild(), to, host);
		expect(failed.outcome).toBe('failed');
		expect(failed.path.at(-1)).toEqual({ state: 'regenerate', note: 'no compiler available' });

		const regenerated = await upgrade(await pageBuild(), to, host, {
			regenerate: async ({ previous, checks }) => {
				const build = structuredClone(previous);
				build.data.open!.input = { state: 'open' };
				build.checks = checks;
				build.provenance = { compiler: 'test', strategy: 'regenerated' };
				return build;
			},
		});
		expect(regenerated.outcome).toBe('regenerated');
		expect(regenerated.build!.data.open!.input).toEqual({ state: 'open' });
	});

	it('escalates when the behavior behind an unchanged capability broke', async () => {
		// The host ignores the old filter name now, but the schema did not say so.
		const result = await upgrade(await pageBuild(), surfaceB(() => {}), { statusKey: 'state' });
		expect(result.outcome).toBe('failed');
		expect(result.path.map((p) => p.state)).toEqual(['static_check', 'reverify', 'migrate', 'regenerate']);
		expect(result.path[1]!.note).toContain('checks fail: open-only');
	});

	it('exits as needs_approval when the new host needs a scope outside the grant', async () => {
		const to = surfaceB((s) => {
			s.scopes['items:admin'] = { title: 'Administer items' };
			s.capabilities['items.close']!.scopes = ['items:write', 'items:admin'];
		});
		const result = await upgrade(await pageBuild(), to);
		expect(result.outcome).toBe('needs_approval');
		expect(result.extraScopes).toEqual(['items:admin']);
		expect(result.verification?.passed).toBe(true);
	});
});

describe('runCanary', () => {
	it('reports per tenant and shares results for identical customizations', async () => {
		const { runCanary, formatCanaryReport } = await import('../src/index.ts');
		const to = surfaceB((s) => {
			s.scopes['items:admin'] = { title: 'Administer items' };
			s.capabilities['items.close']!.scopes = ['items:write', 'items:admin'];
		});
		const build = await pageBuild();
		let verifications = 0;
		const report = await runCanary({
			corpus: [
				{ tenant: 'north', source: specSource, build, grant },
				{ tenant: 'south', source: specSource, build, grant },
				{ tenant: 'east', source: specSource, build, grant: [...grant, 'items:admin'] },
				{ tenant: 'west', source: 'not a spec', build, grant },
			],
			from: surface,
			to,
			verify: (candidate, s, g) => {
				verifications++;
				return verifyBuild({ build: candidate, spec: s, surface: to, sandbox: fakeSandbox(), semantics, createCan, grant: g });
			},
		});
		expect(report.entries.map((e) => [e.tenant, e.outcome, e.shared])).toEqual([
			['north', 'needs_approval', false],
			['south', 'needs_approval', true],
			['east', 'survived', false],
			['west', 'failed', false],
		]);
		expect(report.runs).toBe(3);
		expect(verifications).toBe(2);
		expect(report.counts).toMatchObject({ needs_approval: 2, survived: 1, failed: 1 });
		const text = formatCanaryReport(report);
		expect(text).toContain('north / open-items  needs approval  needs items:admin');
		expect(text).toContain('(shared)');
		expect(text).toContain('4 customizations, 3 distinct upgrade runs');
	});
});
