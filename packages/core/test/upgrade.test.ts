import { describe, expect, it } from 'vitest';
import {
	applyMigrations,
	compatibleSchema,
	extractRefs,
	hashSpec,
	staticCheck,
	upgradeBuild,
	verifyBuild,
	type Build,
	type Surface,
	type UpgradeOptions,
} from '../src/index.ts';
import { createCan, fakeSandbox, pageBuild, spec, specSource, surface, type FakeHostOptions } from './fixtures/acme.ts';

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
		verify: (candidate, g) => verifyBuild({ build: candidate, spec, surface: to, sandbox: fakeSandbox(host), createCan, grant: g }),
		...extra,
	});
}

/** A row-action build on the item.actions extension slot. */
async function linkBuild(): Promise<Build> {
	const build = await pageBuild();
	build.mount = { slot: 'item.actions' };
	build.data = {};
	build.ui = {
		...build.ui,
		components: [
			{
				id: 'root',
				component: 'Button',
				child: 'close-label',
				actionId: 'close',
				action: { event: { name: 'close', context: { id: { path: '/slot/item/id' } } } },
				checks: [
					{ condition: { call: 'equals', args: { a: { path: '/slot/item/status' }, b: 'open' } }, message: 'Only open items close.' },
					{ condition: { call: 'can', args: { scope: 'items:write' } }, message: 'Only managers close items.' },
				],
			},
			{ id: 'close-label', component: 'Text', text: 'Close' },
		],
	};
	build.events = { close: { call: 'items.close', input: { id: { $context: 'id' } }, then: ['reload:page'] } };
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
			s.slots.page!.description = 'Now with better docs';
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

describe('compatibleSchema', () => {
	const post = {
		type: 'object',
		properties: { id: { type: 'integer' }, status: { type: 'string', enum: ['draft', 'publish'] }, meta: { type: 'object', properties: { venue: { type: ['string', 'null'] } }, additionalProperties: false } },
		required: ['id', 'status'],
		additionalProperties: false,
	};
	const change = (edit: (schema: typeof post & Record<string, unknown>) => void) => {
		const schema = structuredClone(post) as typeof post & Record<string, unknown>;
		edit(schema);
		return schema;
	};

	it('lets outputs gain properties and keep what they promised', () => {
		const more = change((s) => {
			(s.properties.meta.properties as Record<string, unknown>).notes = { type: ['string', 'null'] };
		});
		expect(compatibleSchema(post, more, 'provides')).toBe(true);
		expect(compatibleSchema(post, change((s) => void delete (s.properties as Record<string, unknown>).status), 'provides')).toBe(false);
		expect(compatibleSchema(post, change((s) => (s.required = ['id'])), 'provides')).toBe(false);
		expect(compatibleSchema(post, change((s) => (s.properties.status.enum = ['draft', 'publish', 'trash'])), 'provides')).toBe(false);
		expect(compatibleSchema(post, change((s) => (s.properties.id = { type: ['integer', 'null'] as never })), 'provides')).toBe(false);
	});

	it('lets inputs accept more, never less', () => {
		expect(compatibleSchema(post, change((s) => (s.properties.status.enum = ['draft', 'publish', 'pending'])), 'accepts')).toBe(true);
		expect(compatibleSchema(post, change((s) => (s.required = ['id'])), 'accepts')).toBe(true);
		expect(compatibleSchema(post, change((s) => ((s.properties as Record<string, unknown>).search = { type: 'string' })), 'accepts')).toBe(true);
		expect(compatibleSchema(post, change((s) => (s.required = ['id', 'status', 'search'])), 'accepts')).toBe(false);
		expect(compatibleSchema(post, change((s) => (s.properties.status.enum = ['draft'])), 'accepts')).toBe(false);
		expect(compatibleSchema(post, change((s) => (s.properties.id = { type: 'integer', minimum: 5 } as never)), 'accepts')).toBe(false);
		expect(compatibleSchema({ type: 'object' }, { type: 'object', additionalProperties: false }, 'accepts')).toBe(false);
	});
});

describe('applyMigrations', () => {
	it('renames capabilities in data and events, and refuses removals the build uses', async () => {
		const build = await pageBuild();
		const migrated = applyMigrations(build, [
			{ op: 'rename', kind: 'capability', from: 'items.close', to: 'items.archive' },
			{ op: 'rename', kind: 'capability', from: 'items.list', to: 'items.query' },
		])!;
		expect(migrated.events.close!.call).toBe('items.archive');
		expect(migrated.data.open!.call).toBe('items.query');
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

	it('re-verifies a build when a capability and its slot only gained optional fields', async () => {
		const typed = surfaceB((s) => {
			s.hostVersion = '1.0';
			s.capabilities['items.list']!.input = { type: 'object', properties: { status: { type: 'string' } }, additionalProperties: false };
			s.capabilities['items.list']!.output = { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } } } } } };
		});
		const wider = structuredClone(typed);
		wider.hostVersion = '2.0';
		(wider.capabilities['items.list']!.input as { properties: Record<string, unknown> }).properties.search = { type: 'string' };
		(wider.capabilities['items.list']!.output as { properties: { items: { items: { properties: Record<string, unknown> } } } }).properties.items.items.properties.notes = {
			type: 'string',
		};
		(wider.slots['item.actions']!.provides as { properties: Record<string, unknown> }).properties.labels = { type: 'array' };
		const build = await linkBuild();
		const check = staticCheck(await pageBuild(), typed, wider);
		expect(check.start).toBe('reverify');
		expect(check.changes).toEqual([{ kind: 'capability', symbol: 'items.list', change: 'changed', compatible: true }]);
		expect(staticCheck(build, typed, wider).changes).toEqual([{ kind: 'slot', symbol: 'item.actions', change: 'changed', compatible: true }]);

		const result = await upgradeBuild({
			build: await pageBuild(),
			spec,
			specHash,
			grant,
			from: typed,
			to: wider,
			verify: (candidate, g) => verifyBuild({ build: candidate, spec, surface: wider, sandbox: fakeSandbox(), createCan, grant: g }),
		});
		expect(result.outcome).toBe('survived');
		expect(result.path[0]!.note).toBe('capability items.list changed compatibly');
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
				return verifyBuild({ build: candidate, spec: s, surface: to, sandbox: fakeSandbox(), createCan, grant: g });
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
