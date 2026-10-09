import { describe, expect, it } from 'vitest';
import {
	compileSpec,
	describeSurface,
	hashSpec,
	hashSurface,
	verifyBuild,
	type Build,
	type ModelClient,
	type ModelRequest,
} from '../src/index.ts';
import { answerA2UI, type A2UIBuild } from '../../a2ui/src/index.ts';
import { createCan, fakeSandbox, fixtures, pageBuild, spec, specSource, surface as baseSurface } from './fixtures/acme.ts';

const surface = { ...baseSurface, hash: await hashSurface(baseSurface) };
const specHash = await hashSpec(specSource);
const host = { fixtures: 'users: [{as, role}], items: [{title, status}]', assertions: '{"item": {"title", "status"}}', ui: 'A2UI' };

/** A model that answers from a script, recording what it was asked. */
function scripted(answers: Record<ModelRequest['purpose'], unknown[]>): ModelClient & { requests: ModelRequest[] } {
	const requests: ModelRequest[] = [];
	return {
		requests,
		async generate(request) {
			requests.push(request);
			const output = answers[request.purpose].shift();
			if (output === undefined) {
				throw new Error(`No scripted answer left for ${request.purpose}`);
			}
			return { output, model: 'scripted-model' };
		},
	};
}

const check = (criterion: string, expect: unknown[], steps: unknown[] = [], view_as = 'm', items = fixtures.items) => ({
	criterion,
	fixtures_json: JSON.stringify({ ...fixtures, items }),
	view_as,
	steps_json: JSON.stringify(steps),
	expect_json: JSON.stringify(expect),
});

const goodChecks = {
	unverifiable: [],
	checks: [
		check('open-only', [{ rows: ['Open A'] }]),
		check('close', [{ rows: [] }, { item: { title: 'Open A', status: 'done' } }], [{ action: 'close', row: { title: 'Open A' } }]),
		check('clerks', [{ action: 'close', row: { title: 'Open A' }, available: false }], [], 'c'),
		check('empty', [{ text: 'All done' }], [], 'm', []),
	],
};

const page = (await pageBuild()) as unknown as A2UIBuild;

/** The page build as the model's UI answer, with the given data input. */
const ui = (input: unknown) => answerA2UI(page, { open: input });

const verify = (build: Build) => verifyBuild({ build, spec, surface, sandbox: fakeSandbox(), createCan });

describe('compileSpec', () => {
	it('retries each phase with the problems until the build passes verification', async () => {
		const model = scripted({
			checks: [{ unverifiable: [], checks: goodChecks.checks.slice(0, 3) }, goodChecks],
			ui: [{ ...ui({ status: 'open' }), events: [{ name: 'close', call: 'items.delete', input_json: '{}', then: [], notice: null }] }, ui({}), ui({ status: 'open' })],
		});
		const result = await compileSpec({ spec, specHash, surface, model, host, verify });
		expect(result.ok).toBe(true);
		expect(result.attempts.map((a) => [a.phase, a.problems.length > 0])).toEqual([
			['checks', true],
			['checks', false],
			['ui', true],
			['ui', true],
			['ui', false],
		]);
		expect(result.attempts[0]!.problems).toEqual(['Criterion "empty" has no check.']);
		expect(result.attempts[2]!.problems[0]).toContain('items.delete');
		expect(result.attempts[3]!.problems).toContain('Check for "open-only": Expected rows "Open A", found "Open A", "Done B".');

		// Feedback reaches the model; the checks are frozen across UI attempts.
		expect(model.requests[1]!.prompt).toContain('Criterion "empty" has no check.');
		expect(model.requests[4]!.prompt).toContain('Check for "open-only"');
		const frozen = JSON.stringify(result.checks);
		for (const request of model.requests.slice(2)) {
			expect(request.prompt).toContain(`Checks: ${frozen}`);
		}

		const build = result.build!;
		expect(build.spec).toEqual({ id: 'open-items', hash: specHash });
		expect(build.mount).toEqual({ slot: 'page' });
		expect(build.refs.capabilities).toEqual(['items.close', 'items.list']);
		expect(build.provenance).toMatchObject({ compiler: 'graft-compiler/0.1.0', model: 'scripted-model', strategy: 'compiled' });
		expect(result.verification?.passed).toBe(true);
	});

	it('constrains the output schema to the surface and spec', async () => {
		const model = scripted({ checks: [goodChecks], ui: [ui({ status: 'open' })] });
		await compileSpec({ spec, specHash, surface, model, host });
		const [checksRequest, uiRequest] = model.requests;
		const items = (checksRequest!.schema as { properties: { checks: { items: { properties: { criterion: { enum: string[] } } } } } }).properties.checks.items;
		expect(items.properties.criterion.enum).toEqual(['open-only', 'close', 'clerks', 'empty']);
		const uiSchema = uiRequest!.schema as { properties: { data: { items: { properties: { call: { enum: string[] } } } } } };
		expect(uiSchema.properties.data.items.properties.call.enum).toEqual(['items.list']);
		expect(uiRequest!.system).toContain('items.close (write, scopes items:write)');
		expect(JSON.stringify(checksRequest!.schema)).not.toContain('"$ref"');
	});

	it('reuses frozen checks and references the previous build when regenerating', async () => {
		const first = await compileSpec({ spec, specHash, surface, model: scripted({ checks: [goodChecks], ui: [ui({ status: 'open' })] }), host });
		const model = scripted({ checks: [], ui: [ui({ status: 'open' })] });
		const result = await compileSpec({ spec, specHash, surface, model, host, checks: first.checks!, previous: first.build! });
		expect(model.requests.map((r) => r.purpose)).toEqual(['ui']);
		expect(model.requests[0]!.prompt).toContain('This replaces an earlier build');
		expect(result.build!.provenance).toMatchObject({ strategy: 'regenerated', replaces: expect.stringMatching(/^sha256:/) });
		expect(result.build!.checks).toEqual(first.checks);
	});

	it('rejects checks that view as a user missing from their fixtures, before any UI', async () => {
		const model = scripted({
			checks: [{ unverifiable: [], checks: [...goodChecks.checks.slice(0, 3), check('empty', [{ text: 'All done' }], [], 'admin', [])] }, goodChecks],
			ui: [ui({ status: 'open' })],
		});
		const result = await compileSpec({ spec, specHash, surface, model, host, verify });
		expect(result.ok).toBe(true);
		expect(result.attempts[0]!.problems).toEqual([
			'Check 4 (empty) views as "admin", who is not in its fixtures\' users; add that user or view as one of them.',
		]);
		expect(result.attempts.filter((a) => a.phase === 'ui')).toHaveLength(1);
	});

	it('rejects checks that view as someone when their fixtures have no users at all', async () => {
		const noUsers = { ...check('empty', [{ text: 'All done' }], [], 'm', []), fixtures_json: JSON.stringify({ items: [] }) };
		const model = scripted({
			checks: [{ unverifiable: [], checks: [...goodChecks.checks.slice(0, 3), noUsers] }, goodChecks],
			ui: [ui({ status: 'open' })],
		});
		const result = await compileSpec({ spec, specHash, surface, model, host, verify });
		expect(result.ok).toBe(true);
		expect(result.attempts[0]!.problems).toEqual([
			'Check 4 (empty) views as "m", who is not in its fixtures\' users; add that user or view as one of them.',
		]);
	});

	it('gives up after the attempt budget and returns the last candidate', async () => {
		const model = scripted({ checks: [goodChecks], ui: [ui({}), ui({})] });
		const result = await compileSpec({ spec, specHash, surface, model, host, verify, maxAttempts: 2 });
		expect(result.ok).toBe(false);
		expect(result.build).toBeDefined();
		expect(result.verification?.passed).toBe(false);
	});

	it('stops when a criterion cannot be checked objectively', async () => {
		const model = scripted({
			checks: [{ unverifiable: [{ criterion: 'empty', reason: '"say so" does not name the text to show.' }], checks: goodChecks.checks }],
			ui: [],
		});
		const result = await compileSpec({ spec, specHash, surface, model, host });
		expect(result.ok).toBe(false);
		expect(result.unverifiable).toEqual([{ criterion: 'empty', reason: '"say so" does not name the text to show.' }]);
		expect(result.attempts[0]!.problems).toEqual(['Criterion "empty" cannot be checked: "say so" does not name the text to show.']);
		expect(model.requests.map((r) => r.purpose)).toEqual(['checks']);
		const schema = model.requests[0]!.schema as { required: string[] };
		expect(schema.required).toContain('unverifiable');
	});

	it('rejects malformed UI output with specific problems', async () => {
		const bad = { ...ui({ status: 'open' }), data: [{ name: 'Bad Name', call: 'items.list', input_json: 'nope' }] };
		const model = scripted({ checks: [goodChecks], ui: [bad] });
		const result = await compileSpec({ spec, specHash, surface, model, host, maxAttempts: 1 });
		expect(result.ok).toBe(false);
		expect(result.attempts[1]!.problems).toEqual([
			'Data source name "Bad Name" must start with a lowercase letter, use letters, digits, _ or -, and not be "slot".',
			expect.stringContaining('Input of data source "Bad Name" is not valid JSON'),
		]);
	});
});

describe('describeSurface', () => {
	it("shows the host's content model when the surface has one", () => {
		expect(describeSurface(spec, surface)).not.toContain('content model');
		const withModel = describeSurface(spec, { ...surface, model: { postTypes: { event: { fields: { venue: { type: 'string' } } } } } });
		expect(withModel).toContain("The host's content model");
		expect(withModel).toContain('"venue":{"type":"string"}');
	});
});
