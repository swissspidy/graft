import { describe, expect, it } from 'vitest';
import { applyMigrations, compileSpec, extractRefs, hashSurface, modelAnswers, registerUiFormat, validateBuild, verifyBuild, type Build, type CompileOptions } from '@graft/core';
import { createCan, fakeSandbox, fixtures, format, pageBuild, spec, surface } from '../../core/test/fixtures/acme.ts';
import { answerA2UI, assembleA2UI, createA2UIFormat, type A2UIBuild } from '../src/index.ts';

/** The acme page build (an A2UI surface), changed by `change`. */
async function a2uiBuild(change?: (build: A2UIBuild) => void): Promise<Build> {
	const build = (await pageBuild()) as unknown as A2UIBuild;
	change?.(build);
	const result = build as unknown as Build;
	result.refs = extractRefs(result, surface);
	return result;
}

const components = (build: Build) => (build as unknown as A2UIBuild).ui.components as Array<Record<string, unknown>>;

describe('A2UI builds', () => {
	it('validate, with refs from their event bindings and catalog', async () => {
		const build = await a2uiBuild();
		const validation = await validateBuild(build, surface);
		expect(validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		expect(build.refs).toEqual({
			slot: 'page',
			capabilities: ['items.close', 'items.list'],
			scopes: ['items:read', 'items:write'],
			catalog: { Column: ['children'], Table: ['empty', 'fields', 'rowActions', 'rows'], Text: ['text', 'variant'] },
		});
	});

	it('pass their frozen checks, and fail the one a mistake breaks', async () => {
		const good = await verifyBuild({ build: await a2uiBuild(), spec, surface, sandbox: fakeSandbox(), createCan });
		expect(good.results.filter((r) => !r.passed)).toEqual([]);

		const everyone = await a2uiBuild((b) => {
			delete ((b.ui.components[2]!.rowActions as Array<Record<string, unknown>>)[0]!).visible;
		});
		const broken = await verifyBuild({ build: everyone, spec, surface, sandbox: fakeSandbox(), createCan });
		expect(broken.results.filter((r) => !r.passed).map((r) => [r.criterion, r.failures])).toEqual([
			['clerks', ['Expected "close" not to be available for title "Open A", but it is.']],
		]);
	});

	it('keep local state: set actions and computed lists', async () => {
		const build = await a2uiBuild((b) => {
			b.data.open = { call: 'items.list', input: {} };
			b.ui.initial = { form: { status: 'open' } };
			b.ui.computed = { shown: { call: 'filter', args: { items: { path: '/open/items' }, by: 'status', equals: { path: '/form/status' } } } };
			(b.ui.components[0]!.children as string[]).push('done');
			b.ui.components.push({ id: 'done', component: 'Button', child: 'done-label', action: { functionCall: { call: 'set', args: { target: '/form/status', value: 'done' } } } });
			b.ui.components.push({ id: 'done-label', component: 'Text', text: 'Show done' });
			b.ui.components[2]!.rows = { path: '/shown' };
		});
		build.checks = [
			{ criterion: 'open-only', fixtures, view_as: 'm', expect: [{ rows: ['Open A'] }, { text: 'Show done' }] },
			{ criterion: 'open-only', fixtures, view_as: 'm', steps: [{ action: 'done' }], expect: [{ rows: ['Done B'] }] },
			// Each check starts from the build as written: what one set never leaks into the next.
			{ criterion: 'open-only', fixtures, view_as: 'm', expect: [{ rows: ['Open A'] }] },
		];
		expect((await validateBuild(build, surface)).diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		const result = await verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), createCan });
		expect(result.results.flatMap((r) => r.failures)).toEqual([]);
		expect((build as unknown as A2UIBuild).ui.initial).toEqual({ form: { status: 'open' } });
	});

	it('are refused for unknown components and functions, wrong props and arguments, and unbound events', async () => {
		const build = await a2uiBuild((b) => {
			b.ui.components.push({ id: 'x', component: 'Marquee' });
			(b.ui.components[0]!.children as string[]).push('x');
			b.ui.components[1]!.text = { call: 'shout', args: {} };
			b.ui.components[1]!.variant = 'huge';
			const action = (b.ui.components[2]!.rowActions as Array<Record<string, unknown>>)[0]!;
			action.visible = { call: 'can', args: { scope: 7 } };
			action.action = { event: { name: 'finish', context: { id: { path: 'item.id' } } } };
		});
		const codes = (await validateBuild(build, surface)).diagnostics.map((d) => `${d.code} ${d.path}`);
		expect(codes).toEqual(
			expect.arrayContaining([
				'a2ui-unknown-component /ui/components/3/component',
				'a2ui-unknown-function /ui/components/1/text',
				'a2ui-props /ui/components/1/variant',
				'a2ui-function-args /ui/components/2/rowActions/0/visible/args/scope',
				'a2ui-dotted-pointer /ui/components/2/rowActions/0/action/event/context/id',
				'a2ui-unbound-event /events',
				'a2ui-unused-event /events/close',
			]),
		);
	});

	it('are refused when what a row writes starts as a literal row value', async () => {
		const choose = (initial: unknown) =>
			a2uiBuild((b) => {
				b.ui.initial = { form: { chosen: initial } };
				const action = (b.ui.components[2]!.rowActions as Array<Record<string, unknown>>)[0]!;
				action.action = { functionCall: { call: 'set', args: { target: '/form/chosen', value: { path: 'id' } } } };
				b.events = {};
			});
		const codes = async (initial: unknown) => (await validateBuild(await choose(initial), surface)).diagnostics.map((d) => `${d.code} ${d.path}`);
		// A submit-for-review compile opened at post 41's confirm step wherever post 41 was a draft.
		expect(await codes(41)).toContain('a2ui-initial-row-value /ui/initial/form/chosen');
		expect(await codes(null)).not.toContain('a2ui-initial-row-value /ui/initial/form/chosen');
		expect(await codes(0)).not.toContain('a2ui-initial-row-value /ui/initial/form/chosen');
	});

	it('need approval, not rejection, when an upgrade makes their calls need more scopes', async () => {
		const build = await a2uiBuild();
		const narrow = { ...spec, manifest: { ...spec.manifest, permissions: ['items:read'] } };
		const upgrade = await validateBuild(build, surface, { spec: { spec: narrow, hash: build.spec.hash }, upgrade: true });
		expect(upgrade.diagnostics.filter((d) => d.code === 'build-scope-not-requested').map((d) => d.severity)).toEqual(['warning']);
		const fresh = await validateBuild(build, surface, { spec: { spec: narrow, hash: build.spec.hash } });
		expect(fresh.diagnostics.filter((d) => d.code === 'build-scope-not-requested').map((d) => d.severity)).toEqual(['error']);
	});

	it('have a UI', async () => {
		const { ui: _ui, ...rest } = await a2uiBuild();
		expect((await validateBuild(rest, surface)).diagnostics.map((d) => d.code)).toContain('build-schema');
	});

	it('migrate: capability renames reach event bindings, scope renames reach can calls', async () => {
		const build = await a2uiBuild();
		const migrated = applyMigrations(build, [
			{ op: 'rename', kind: 'capability', from: 'items.close', to: 'items.finish' },
			{ op: 'rename', kind: 'capability', from: 'items.list', to: 'items.query' },
			{ op: 'rename', kind: 'scope', from: 'items:write', to: 'items:manage' },
		]) as unknown as A2UIBuild;
		expect(migrated.events.close!.call).toBe('items.finish');
		expect(migrated.data.open!.call).toBe('items.query');
		expect((components(migrated as unknown as Build)[2]!.rowActions as Array<{ visible: unknown }>)[0]!.visible).toEqual({ call: 'can', args: { scope: 'items:manage' } });
		// Removing what the build uses cannot be migrated.
		expect(applyMigrations(build, [{ op: 'remove', kind: 'capability', symbol: 'items.close' }])).toBeUndefined();
	});
});

describe('compiling to A2UI', () => {
	it('builds the UI phase in the format, sends problems back, and verifies against the frozen checks', async () => {
		const target = (await a2uiBuild()) as unknown as A2UIBuild;
		// The target's UI as model output, its table bound to `pointer`.
		const answer = (pointer: string) =>
			answerA2UI({ ...target, ui: { ...target.ui, components: target.ui.components.map((c) => (c.component === 'Table' ? { ...c, rows: { path: pointer } } : c)) } });
		const prompts: string[] = [];
		const outputs = [answer('/open.items'), answer('/open/items')];
		const model = {
			async generate({ purpose, prompt }: { purpose: string; prompt: string }) {
				expect(purpose).toBe('ui');
				prompts.push(prompt);
				return { output: outputs.shift(), model: 'scripted' };
			},
		};
		const result = await compileSpec({
			spec,
			specHash: target.spec.hash,
			surface: { ...surface, hash: await hashSurface(surface) },
			model,
			host: { fixtures: '', assertions: '', ui: 'A2UI' },
			checks: target.checks,
			format,
			verify: (build) => verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), createCan }),
		});
		expect(result.ok).toBe(true);
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain('"/open.items" is not a JSON Pointer');
		expect((result.build as unknown as A2UIBuild).ui.catalogId).toBe('graft:acme');
		expect(result.verification!.passed).toBe(true);
	});
});

describe('the format a build is compiled in', () => {
	/** Compiles the acme spec with frozen checks, the model answering with `answers` (one per UI attempt). */
	const compile = async (answers: unknown[], options: Partial<CompileOptions> = {}) => {
		const target = await pageBuild();
		const result = await compileSpec({
			spec,
			specHash: target.spec.hash,
			surface: { ...surface, hash: await hashSurface(surface) },
			model: { generate: async () => ({ output: answers.shift(), model: 'scripted' }) },
			host: { fixtures: '', assertions: '', ui: 'A2UI' },
			checks: target.checks,
			...options,
		});
		return result.build;
	};

	it("is the host's when nothing else decides", async () => {
		const build = await compile([modelAnswers(await a2uiBuild()).ui]);
		expect((build as unknown as A2UIBuild).ui.catalogId).toBe('graft:acme');
	});

	it("is the previous build's when regenerating, and the caller's when given", async () => {
		const previous = await a2uiBuild();
		const regenerated = await compile([modelAnswers(previous).ui], { previous, host: { fixtures: '', assertions: '', ui: 'Nope' } });
		expect((regenerated as unknown as A2UIBuild).ui.catalogId).toBe('graft:acme');
		expect(regenerated?.provenance.strategy).toBe('regenerated');
		const asked = await compile([modelAnswers(previous).ui], { format, host: { fixtures: '', assertions: '', ui: 'Nope' } });
		expect((asked as unknown as A2UIBuild).ui.catalogId).toBe('graft:acme');
	});

	it('must be registered', async () => {
		await expect(compile([], { host: { fixtures: '', assertions: '', ui: 'Nope' } })).rejects.toThrow('No UI format "Nope" is registered for acme.');
	});
});

describe('model answers for an A2UI build', () => {
	it('assemble back into the same UI, data and events', async () => {
		const build = (await a2uiBuild((b) => {
			b.ui.initial = { form: { status: 'open' } };
			b.ui.computed = { count: { call: 'count', args: { items: { path: '/open/items' } } } };
		})) as unknown as A2UIBuild;
		expect(assembleA2UI(answerA2UI(build), 'graft:acme')).toEqual({ value: { ui: build.ui, data: build.data, events: build.events }, problems: [] });
	});
});
