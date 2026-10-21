import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
	applyMigrations,
	compileSpec,
	describeCheck,
	describeWhen,
	evaluate,
	extractRefs,
	hashSpec,
	hashSurface,
	modelAnswers,
	runTrigger,
	SandboxCallError,
	staticCheck,
	triggerCallRefusal,
	upgradeBuild,
	validateBuild,
	validateSpec,
	verifyBuild,
	type Build,
	type ModelClient,
	type Sandbox,
	type Surface,
	type Value,
} from '../src/index.ts';
import { createCan, fakeSandbox, pageBuild, surface as baseSurface } from './fixtures/acme.ts';

/** Acme with triggers: a daily sweep may read and close items; an event when an item is reopened. */
const item = { type: 'object', properties: { id: { type: 'integer' }, title: { type: 'string' }, status: { type: 'string' }, created: { type: 'string' } } };
const surface: Surface = {
	...structuredClone(baseSurface),
	capabilities: {
		'items.list': { kind: 'read', input: { type: 'object', properties: { status: { type: 'string' } } }, output: { type: 'object', properties: { items: { type: 'array', items: item } } }, scopes: ['items:read'] },
		'items.close': { kind: 'write', input: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } }, output: {}, scopes: ['items:write'] },
	},
	triggers: {
		identity: 'Acme automation',
		minInterval: 3600,
		maxPerRun: 5,
		capabilities: ['items.list', 'items.close'],
		events: { 'item.reopened': { title: 'An item is reopened', provides: item } },
	},
};
surface.hash = await hashSurface(surface);

const specSource = `---
graft: 1
id: open-items
host: acme
mount: { slot: page }
audience: [manager, clerk]
permissions: [items:read, items:write]
triggers:
  close-stale:
    schedule: { every: 1d, at: "09:00" }
    permissions: [items:read, items:write]
    limit: 2
  close-reopened:
    event: item.reopened
    permissions: [items:write]
---

# Open items

Managers close open items; stale ones close on their own.

## Acceptance criteria

- Only open items are listed {#open-only}
- Every morning, items open for more than 7 days are closed, at most 2 per run {#sweep}
- A reopened item is closed again {#reopen}
`;
const spec = validateSpec(specSource, { surface }).spec!;
const specHash = await hashSpec(specSource);

const stale = { $gt: [{ $daysSince: { $target: 'created' } }, 7] } as Value;
const users = [{ as: 'm', role: 'manager' }];

async function triggerBuild(): Promise<Build> {
	const build = await pageBuild();
	build.spec = { id: 'open-items', hash: specHash };
	build.surface = { host: 'acme', hostVersion: '1.0', hash: surface.hash! };
	build.triggers = {
		'close-stale': {
			schedule: { every: '1d', at: '09:00' },
			targets: { call: 'items.list', input: { status: 'open' } },
			where: stale,
			call: 'items.close',
			input: { id: { $target: 'id' } },
			once: true,
		},
		'close-reopened': { event: 'item.reopened', call: 'items.close', input: { id: { $target: 'id' } } },
	};
	const open = (n: number) => Array.from({ length: n }, (_, i) => ({ title: `Open ${i + 1}`, status: 'open' }));
	build.checks = [
		{ criterion: 'open-only', fixtures: { users, items: open(1) }, view_as: 'm', expect: [{ rows: ['Open 1'] }] },
		{
			criterion: 'sweep',
			fixtures: { users, items: open(3) },
			view_as: 'm',
			clock: { advanceDays: 8 },
			steps: [{ trigger: 'close-stale' }],
			expect: [{ run: { trigger: 'close-stale', calls: 2, skipped: 1 } }, { rows: ['Open 3'] }, { item: { title: 'Open 1', status: 'done' } }],
		},
		{ criterion: 'sweep', fixtures: { users, items: open(1) }, view_as: 'm', clock: { advanceDays: 6 }, steps: [{ trigger: 'close-stale' }], expect: [{ run: { calls: 0 } }, { rows: ['Open 1'] }] },
		{
			criterion: 'sweep',
			fixtures: { users, items: open(1) },
			view_as: 'm',
			clock: { advanceDays: 8 },
			steps: [{ trigger: 'close-stale' }, { trigger: 'close-stale' }],
			expect: [{ run: { calls: 0, matched: 0 } }],
		},
		{
			criterion: 'reopen',
			fixtures: { users, items: [{ title: 'Done A', status: 'done' }] },
			view_as: 'm',
			steps: [{ trigger: 'close-reopened', target: { title: 'Done A' } }],
			expect: [{ run: { calls: 1 } }, { item: { title: 'Done A', status: 'done' } }],
		},
	];
	build.refs = extractRefs(build, surface);
	return build;
}

/**
 * The fake host with a trigger runner: the core's runTrigger over the
 * host's gateway checks. Items carry when they were created; an event
 * trigger first reopens its target.
 */
function triggerSandbox(): Sandbox & { calls: string[] } {
	const base = fakeSandbox();
	let items: Array<Record<string, unknown>> = [];
	const handled = new Map<string, Set<string>>();
	const seeded = Date.now();
	return {
		...base,
		async reset() {
			handled.clear();
			await base.reset();
		},
		async seed(fixtures) {
			const result = await base.seed(fixtures);
			items = ((await base.call('m', 'items.list', null)) as { items: Array<Record<string, unknown>> }).items;
			return result;
		},
		async call(user, capability, input) {
			const result = await base.call(user, capability, input);
			if (capability === 'items.list') {
				const list = (result as { items: Array<Record<string, unknown>> }).items;
				return { items: list.map((i) => ({ ...i, created: new Date(seeded).toISOString() })) };
			}
			return result;
		},
		async fire({ build, trigger: id, grant, limit, now, target }) {
			const trigger = build.triggers![id]!;
			let subject: unknown;
			if (trigger.event) {
				const found = items.find((i) => i.title === target?.title);
				if (found) {
					found.status = 'open';
				}
				subject = found;
			}
			const done = handled.get(id) ?? new Set<string>();
			handled.set(id, done);
			return runTrigger({
				id,
				trigger,
				limit,
				now,
				subject,
				handled: done,
				call: async (capability, input) => {
					const refusal = triggerCallRefusal(trigger, capability, surface, grant);
					if (refusal) {
						throw new SandboxCallError(refusal, `Refused ${capability}`);
					}
					return this.call('m', capability, input);
				},
			});
		},
	};
}

describe('trigger expressions', () => {
	const conformance = JSON.parse(readFileSync(new URL('../../../fixtures/triggers/expressions.json', import.meta.url), 'utf8')) as {
		now: string;
		target: unknown;
		cases: Array<{ value: Value; expected: unknown }>;
	};
	it.each(conformance.cases.map((c) => [JSON.stringify(c.value), c] as const))('%s', (_, c) => {
		const value = evaluate(c.value, { data: {}, slot: {}, can: () => false, now: Date.parse(conformance.now), target: conformance.target });
		expect(value ?? null).toEqual(c.expected);
	});
});

describe('runTrigger', () => {
	const items = [
		{ id: 1, title: 'A', created: '2026-10-01T00:00:00Z' },
		{ id: 2, title: 'B', created: '2026-10-02T00:00:00Z' },
		{ id: 3, title: 'C', created: '2026-10-20T00:00:00Z' },
	];
	const now = Date.parse('2026-10-21T00:00:00Z');
	const trigger = {
		schedule: { every: '1d' },
		targets: { call: 'items.list' },
		where: stale,
		call: 'items.close',
		input: { id: { $target: 'id' } },
	};

	it('calls once per matching target, up to the cap', async () => {
		const calls: unknown[] = [];
		const run = await runTrigger({
			id: 't',
			trigger,
			limit: 1,
			now,
			call: async (capability, input) => {
				calls.push([capability, input]);
				return capability === 'items.list' ? { items } : {};
			},
		});
		expect(calls).toEqual([
			['items.list', null],
			['items.close', { id: 1 }],
		]);
		expect(run).toEqual({ trigger: 't', status: 'ok', targets: 3, matched: 2, skipped: 1, calls: [{ target: { id: 1, title: 'A' }, input: { id: 1 }, ok: true }] });
	});

	it('plans without calling in a dry run', async () => {
		const calls: string[] = [];
		const run = await runTrigger({ id: 't', trigger, limit: 5, now, dryRun: true, call: async (c) => (calls.push(c), { items }) });
		expect(calls).toEqual(['items.list']);
		expect(run.status).toBe('dry-run');
		expect(run.calls.map((c) => c.input)).toEqual([{ id: 1 }, { id: 2 }]);
	});

	it('keeps going after a failed call, and reports it', async () => {
		const run = await runTrigger({
			id: 't',
			trigger,
			limit: 5,
			now,
			call: async (capability, input) => {
				if (capability === 'items.list') {
					return { items };
				}
				if ((input as { id: number }).id === 1) {
					throw new SandboxCallError('forbidden', 'No');
				}
				return {};
			},
		});
		expect(run.status).toBe('partial');
		expect(run.calls.map((c) => [c.ok, c.error])).toEqual([
			[false, 'No'],
			[true, undefined],
		]);
	});

	it('fails a run whose targets cannot be read', async () => {
		const run = await runTrigger({ id: 't', trigger, limit: 5, now, call: async () => ({ nope: true }) });
		expect(run).toMatchObject({ status: 'failed', calls: [], error: 'Reading the targets failed: "items.list" did not return a list at "items"' });
	});

	it('acts on a target only once with once, and retries failures', async () => {
		const handled = new Set<string>();
		let fail = true;
		const call = async (capability: string, input: unknown) => {
			if (capability === 'items.list') {
				return { items };
			}
			if ((input as { id: number }).id === 2 && fail) {
				throw new Error('busy');
			}
			return {};
		};
		const first = await runTrigger({ id: 't', trigger: { ...trigger, once: true }, limit: 5, now, handled, call });
		expect(first.calls.map((c) => c.ok)).toEqual([true, false]);
		fail = false;
		const second = await runTrigger({ id: 't', trigger: { ...trigger, once: true }, limit: 5, now, handled, call });
		expect(second.calls.map((c) => c.target.id)).toEqual([2]);
		expect([...handled]).toEqual(['1', '2']);
	});

	it("runs an event trigger on the event's subject", async () => {
		const run = await runTrigger({ id: 'e', trigger: { event: 'item.reopened', call: 'items.close', input: { id: { $target: 'id' } } }, limit: 5, subject: items[2], call: async () => ({}) });
		expect(run.calls).toEqual([{ target: { id: 3, title: 'C' }, input: { id: 3 }, ok: true }]);
	});
});

describe('trigger gateway checks', () => {
	const trigger = { schedule: { every: '1d' }, targets: { call: 'items.list' }, call: 'items.close' };
	it('refuses what the trigger does not call, what triggers may not use, and what is not granted', () => {
		expect(triggerCallRefusal(trigger, 'items.close', surface, ['items:read', 'items:write'])).toBeUndefined();
		expect(triggerCallRefusal({ ...trigger, targets: { call: 'items.close' } }, 'items.list', surface, ['items:read'])).toBe('graft_capability_not_in_trigger');
		expect(triggerCallRefusal(trigger, 'items.close', { ...surface, triggers: { ...surface.triggers!, capabilities: ['items.list'] } }, ['items:write'])).toBe('graft_capability_not_unattended');
		expect(triggerCallRefusal(trigger, 'items.close', surface, ['items:read'])).toBe('graft_not_granted');
	});
});

describe('describeWhen', () => {
	it('says when a trigger runs', () => {
		expect(describeWhen({ schedule: { every: '1d', at: '09:00' } })).toBe('every day at 09:00');
		expect(describeWhen({ schedule: { every: '6h' } })).toBe('every 6 hours');
		expect(describeWhen({ event: 'item.reopened' }, surface)).toBe('when an item is reopened');
	});
});

describe('triggers in specs', () => {
	it('accepts triggers the surface allows', () => {
		expect(validateSpec(specSource, { surface }).diagnostics).toEqual([]);
	});

	it('refuses triggers the surface does not allow', () => {
		const codes = (source: string, s: Surface = surface) => validateSpec(source, { surface: s }).diagnostics.map((d) => d.code);
		expect(codes(specSource, baseSurface)).toContain('trigger-unsupported');
		expect(codes(specSource.replace('every: 1d, at: "09:00"', 'every: 6h, at: "09:00"'))).toEqual(['trigger-at']);
		const often = { ...surface, triggers: { ...surface.triggers!, minInterval: 7 * 86400 } };
		expect(codes(specSource, often)).toEqual(['trigger-too-often']);
		expect(codes(specSource.replace('event: item.reopened', 'event: item.deleted'))).toEqual(['trigger-unknown-event']);
		expect(codes(specSource.replace('limit: 2', 'limit: 50'))).toEqual(['trigger-limit']);
		expect(codes(specSource.replace('event: item.reopened\n', 'event: item.reopened\n    schedule: { every: 1d }\n'))).toContain('frontmatter-schema');
	});
});

describe('triggers in builds', () => {
	const codes = async (build: Build, s: Surface = surface) => (await validateBuild(build, s, { spec: { spec, hash: specHash } })).diagnostics.map((d) => d.code);

	it('accepts a valid build and computes what its triggers use', async () => {
		const build = await triggerBuild();
		expect(await codes(build)).toEqual([]);
		expect(build.refs.triggers).toEqual({ events: ['item.reopened'], capabilities: ['items.close', 'items.list'], scopes: ['items:read', 'items:write'] });
	});

	it('leaves the refs of builds without triggers as they were', async () => {
		expect((await pageBuild()).refs.triggers).toBeUndefined();
	});

	it('refuses triggers that leave the bounds the surface and spec set', async () => {
		const mutate = async (change: (b: Build) => void) => {
			const build = await triggerBuild();
			change(build);
			build.refs = extractRefs(build, surface);
			return codes(build);
		};
		expect(await mutate((b) => delete b.triggers!['close-reopened'])).toEqual(['build-trigger-missing']);
		expect(await mutate((b) => (b.triggers!.extra = { event: 'item.reopened', call: 'items.close' }))).toEqual(['build-trigger-undeclared']);
		expect(await mutate((b) => (b.triggers!['close-stale']!.schedule = { every: '2d' }))).toEqual(['build-trigger-when-mismatch']);
		expect(await mutate((b) => (b.triggers!['close-stale']!.where = { $can: 'items:write' }))).toEqual(['build-trigger-expression']);
		expect(await mutate((b) => (b.triggers!['close-stale']!.input = { id: { $slot: 'item.id' } }))).toEqual(['build-trigger-expression']);
		expect(await mutate((b) => (b.triggers!['close-stale']!.input = { id: { $target: 'number' } }))).toEqual(['build-trigger-unknown-target-prop']);
		expect(await mutate((b) => (b.triggers!['close-stale']!.input = { id: 'one' }))).toEqual(['build-invalid-value']);
		expect(await mutate((b) => (b.triggers!['close-stale']!.targets!.input = { status: { $target: 'status' } }))).toEqual(['build-trigger-expression']);
		expect(await mutate((b) => (b.triggers!['close-reopened']!.call = 'items.list'))).toEqual(['build-trigger-scope-not-requested']);
		expect(await mutate((b) => (b.data.open!.input = { status: { $target: 'status' } }))).toEqual(['build-target-outside-trigger']);
		const unattended = { ...surface, triggers: { ...surface.triggers!, capabilities: ['items.list'] } };
		const build = await triggerBuild();
		expect(await codes(build, { ...unattended, hash: await hashSurface(unattended) })).toEqual(expect.arrayContaining(['build-trigger-capability']));
		expect(await codes(build, baseSurface)).toEqual(expect.arrayContaining(['build-triggers-unsupported']));
	});
});

describe('verifying triggers', () => {
	it('runs triggers in checks and asserts over what they did', async () => {
		const result = await verifyBuild({ build: await triggerBuild(), spec, surface, sandbox: triggerSandbox(), createCan });
		expect(result.results.filter((r) => !r.passed)).toEqual([]);
		expect(result.passed).toBe(true);
	});

	it("simulates the trigger's grant, not the viewer's", async () => {
		const result = await verifyBuild({ build: await triggerBuild(), spec, surface, sandbox: triggerSandbox(), createCan, triggerGrant: { 'close-stale': ['items:read'] } });
		expect(result.results[1]!.failures).toEqual([
			'Expected the run of "close-stale" to have calls 2, found calls 0 (Refused items.close).',
			'Expected rows "Open 3", found "Open 1", "Open 2", "Open 3".',
			'Expected item {"status":"done","title":"Open 1"}, found {"id":1,"status":"open","title":"Open 1"}.',
		]);
	});

	it('fails checks that run triggers on a host that cannot', async () => {
		const result = await verifyBuild({ build: await triggerBuild(), spec, surface, sandbox: fakeSandbox(), createCan });
		expect(result.results[1]!.failures).toEqual(['Step 1: this host\'s sandbox cannot run triggers.']);
	});

	it('describes trigger steps and runs in plain language', async () => {
		const build = await triggerBuild();
		expect(describeCheck(build.checks[1]!)).toBe(
			'When "m" opens it 8 days later, and "close-stale" runs on its own, then the run of "close-stale" acts on 2 targets and leaves 1 for the next run, the list shows exactly "Open 3" and item matches {"title":"Open 1","status":"done"}.',
		);
		expect(describeCheck(build.checks[4]!)).toContain('and "close-reopened" runs on its own on "Done A"');
	});
});

describe('upgrading triggers', () => {
	const to = (change: (s: Surface) => void) => {
		const s = structuredClone(surface);
		s.hostVersion = '2.0';
		delete s.hash;
		change(s);
		return s;
	};

	it('notices when the host stops letting triggers do what they do', async () => {
		const build = await triggerBuild();
		expect(staticCheck(build, surface, to(() => undefined)).start).toBe('reverify');
		const removed = staticCheck(build, surface, to((s) => (s.triggers!.events = {})));
		expect(removed.changes).toEqual([{ kind: 'event', symbol: 'item.reopened', change: 'removed' }]);
		expect(removed.start).toBe('regenerate');
		const unattended = staticCheck(build, surface, to((s) => (s.triggers!.capabilities = ['items.list'])));
		expect(unattended.changes).toEqual([{ kind: 'capability', symbol: 'items.close', change: 'changed' }]);
		expect(staticCheck(build, surface, to((s) => delete s.triggers)).start).toBe('regenerate');
	});

	it('migrates renamed capabilities and events in triggers', async () => {
		const build = await triggerBuild();
		const s = to((x) => {
			x.capabilities['items.archive'] = x.capabilities['items.close']!;
			delete x.capabilities['items.close'];
			x.triggers!.capabilities = ['items.list', 'items.archive'];
			x.triggers!.events['item.revived'] = x.triggers!.events['item.reopened']!;
			delete x.triggers!.events['item.reopened'];
			x.migrations = [
				{ op: 'rename', kind: 'capability', from: 'items.close', to: 'items.archive' },
				{ op: 'rename', kind: 'event', from: 'item.reopened', to: 'item.revived' },
			];
		});
		expect(staticCheck(build, surface, s).start).toBe('migrate');
		const migrated = applyMigrations(build, s.migrations!)!;
		expect(migrated.triggers!['close-stale']!.call).toBe('items.archive');
		expect(migrated.triggers!['close-reopened']).toMatchObject({ event: 'item.revived', call: 'items.archive' });
		expect(applyMigrations(build, [{ op: 'remove', kind: 'event', symbol: 'item.reopened' }])).toBeUndefined();
	});

	it('lets an upgrade change the event only as the surface renames it', async () => {
		const build = await triggerBuild();
		build.triggers!['close-reopened']!.event = 'item.revived';
		const renamed = to((s) => {
			s.triggers!.events['item.revived'] = s.triggers!.events['item.reopened']!;
			s.migrations = [{ op: 'rename', kind: 'event', from: 'item.reopened', to: 'item.revived' }];
		});
		renamed.hash = await hashSurface(renamed);
		build.surface.hash = renamed.hash;
		build.refs = extractRefs(build, renamed);
		const severity = async (s: Surface) =>
			(await validateBuild(build, s, { spec: { spec, hash: specHash }, upgrade: true })).diagnostics.find((d) => d.code === 'build-trigger-when-mismatch')?.severity;
		expect(await severity(renamed)).toBe('warning');
		// Another event the host offers, with no rename: running on it needs a new spec.
		const other = { ...renamed, migrations: [] };
		other.hash = await hashSurface(other);
		build.surface.hash = other.hash;
		expect(await severity(other)).toBe('error');
	});

	it('refuses a trigger that is both scheduled and on an event', async () => {
		const build = await triggerBuild();
		build.triggers!['close-stale']!.event = 'item.reopened';
		const result = await validateBuild(build, surface);
		expect(result.ok).toBe(false);
		expect(new Set(result.diagnostics.map((d) => d.code))).toEqual(new Set(['build-schema']));
	});

	it("asks for approval when a trigger needs a scope beyond its grant", async () => {
		const build = await triggerBuild();
		const target = to((s) => {
			s.scopes['items.close:write'] = { title: 'Close items' };
			s.capabilities['items.close']!.scopes = ['items.close:write'];
		});
		const result = await upgradeBuild({
			build,
			spec,
			specHash,
			grant: ['items:read', 'items:write'],
			from: surface,
			to: target,
			verify: async (candidate, grant, triggerGrant) => {
				expect(triggerGrant).toEqual({ 'close-stale': ['items:read', 'items:write', 'items.close:write'], 'close-reopened': ['items:write', 'items.close:write'] });
				return { passed: true, results: [], unchecked: [], spec: candidate.spec, surface: { host: 'acme', hostVersion: '2.0', hash: '' }, verifiedAt: '' };
			},
		});
		expect(result.outcome).toBe('needs_approval');
		expect(result.extraTriggerScopes).toEqual({ 'close-stale': ['items.close:write'], 'close-reopened': ['items.close:write'] });
	});
});

describe('compiling triggers', () => {
	it('asks for the triggers next to the UI, and keeps them in the build', async () => {
		const build = await triggerBuild();
		const answers = modelAnswers(build);
		const requests: Array<{ system: string; schema: Record<string, unknown> }> = [];
		const model: ModelClient = {
			async generate(request) {
				requests.push(request);
				return { output: request.purpose === 'checks' ? answers.checks : answers.ui, model: 'scripted' };
			},
		};
		const result = await compileSpec({
			spec,
			specHash,
			surface,
			model,
			host: { fixtures: '', assertions: '', ui: 'A2UI' },
			verify: (candidate) => verifyBuild({ build: candidate, spec, surface, sandbox: triggerSandbox(), createCan }),
		});
		expect(result.ok).toBe(true);
		expect(result.build!.triggers).toEqual(build.triggers);
		expect(requests[0]!.system).toContain('{"trigger": "<trigger id>"}');
		expect(requests[1]!.system).toContain('Trigger "close-stale" runs every day at 09:00 and may use');
		expect((requests[1]!.schema.required as string[]).at(-1)).toBe('triggers_json');
	});
});
