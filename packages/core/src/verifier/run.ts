import { evaluate, isAction, type EvalContext } from '../build/evaluate.ts';
import { removeRow } from '../build/rows.ts';
import type { Build, Check, CheckStep } from '../build/types.ts';
import type { Spec } from '../spec/types.ts';
import { canonicalJson } from '../surface/hash.ts';
import type { Surface } from '../surface/types.ts';
import { triggerLimit, type TriggerRun } from '../build/triggers.ts';
import { FixtureError, SandboxCallError, type Sandbox } from './sandbox.ts';
import { requireUiFormat } from '../build/format.ts';
import { allActions, type Snapshot, type SnapshotAction, type SnapshotInput } from './snapshot.ts';

export interface VerifyOptions {
	build: Build;
	spec: Spec;
	surface: Surface;
	sandbox: Sandbox;
	/**
	 * Host permission check from the scopes the user can use, the same
	 * function the host's renderer uses (with per-object refinement).
	 */
	createCan(usable: Record<string, boolean>): EvalContext['can'];
	/** The grant to simulate. Default: the permissions the spec requests. */
	grant?: string[];
	/** The grant of each trigger's service identity to simulate. Default: the permissions the spec lists for it. */
	triggerGrant?: Record<string, string[]>;
	/**
	 * Reads the build's UI into a snapshot instead of asking its registered
	 * UI format. `entered` is what the viewer typed so far: input group,
	 * then input id, as the snapshot's `inputs` name them.
	 */
	snapshot?(build: Build, ctx: EvalContext, entered: Record<string, Record<string, unknown>>): Snapshot;
}

export interface CheckResult {
	criterion: string;
	/** Index of the check in the build. */
	check: number;
	passed: boolean;
	/** Plain-language reasons, empty when passed. */
	failures: string[];
}

export interface Verification {
	passed: boolean;
	spec: { id: string; hash: string };
	surface: { host: string; hostVersion: string; hash: string };
	results: CheckResult[];
	/** Criteria without any check; they are not verified. */
	unchecked: string[];
	verifiedAt: string;
}

/** One place the build renders: a slot instance with its data and snapshot. */
interface Instance {
	slot: Record<string, unknown>;
	data: Record<string, unknown>;
	/** What the viewer entered (and what local events set): input group, then id. */
	entered: Record<string, Record<string, unknown>>;
	snapshot: Snapshot;
}

/**
 * Runs every check of a build against a sandbox. Each check starts from a
 * clean sandbox with its own fixtures, renders the build headlessly for the
 * `view_as` user through real capability calls, performs its steps and
 * evaluates its expectations over the resulting snapshot.
 *
 * The grant is simulated as the spec's requested permissions: verification
 * answers "does this build meet the criteria once approved".
 */
export async function verifyBuild(options: VerifyOptions): Promise<Verification> {
	const { build, spec } = options;
	const results: CheckResult[] = [];
	await options.sandbox.prepare?.(options.surface);
	for (const [index, check] of build.checks.entries()) {
		results.push(await runCheck(options, check, index));
	}
	const checked = new Set(build.checks.map((c) => c.criterion));
	const unchecked = spec.criteria.map((c) => c.id).filter((id) => !checked.has(id));
	return {
		passed: results.every((r) => r.passed) && unchecked.length === 0,
		spec: { id: build.spec.id, hash: build.spec.hash },
		surface: { host: options.surface.host, hostVersion: options.surface.hostVersion, hash: build.surface.hash },
		results,
		unchecked,
		verifiedAt: new Date().toISOString(),
	};
}

async function runCheck(options: VerifyOptions, check: Check, index: number): Promise<CheckResult> {
	const { build, spec, sandbox } = options;
	const failures: string[] = [];
	const result = (): CheckResult => ({ criterion: check.criterion, check: index, passed: failures.length === 0, failures });

	await sandbox.reset();
	let users: Record<string, string[]>;
	try {
		({ users } = await sandbox.seed(check.fixtures ?? {}));
	} catch (error) {
		if (!(error instanceof FixtureError)) {
			throw error;
		}
		failures.push(`The check's fixtures cannot be created: ${error.message}`);
		return result();
	}
	const viewer = check.view_as ?? Object.keys(users)[0];
	if (!viewer || !users[viewer]) {
		failures.push(`The check views as "${viewer ?? '(nobody)'}", who is not in its fixtures.`);
		return result();
	}

	const permissions = options.grant ?? spec.manifest.permissions;
	const audience = spec.manifest.audience ?? [];
	const applies = audience.length === 0 || users[viewer].some((role) => audience.includes(role));
	const can = options.createCan(await sandbox.scopes(viewer, permissions));
	// The check's clock: now, or later than the fixtures by `clock.advanceDays`.
	const now = Date.now() + (check.clock?.advanceDays ?? 0) * 24 * 60 * 60 * 1000;
	const call = async (capability: string, input: unknown): Promise<unknown> => {
		// The gateway's checks, as the host runtime applies them.
		const declared = options.surface.capabilities[capability];
		if (!build.refs.capabilities.includes(capability) || !declared) {
			throw new SandboxCallError('graft_capability_not_in_build', `The build does not use "${capability}".`);
		}
		if (!declared.scopes.every((scope) => permissions.includes(scope))) {
			throw new SandboxCallError('graft_not_granted', `"${capability}" needs scopes the spec does not request.`);
		}
		return sandbox.call(viewer, capability, input);
	};

	const loadData = async (slot: Record<string, unknown>, names = Object.keys(build.data), data: Record<string, unknown> = {}) => {
		const next = { ...data };
		for (const name of names) {
			const source = build.data[name];
			if (!source) {
				continue;
			}
			try {
				next[name] = await call(source.call, evaluate(source.input, { data: {}, slot, can, now }) ?? null);
			} catch (error) {
				delete next[name];
				failures.push(`Loading "${name}" failed: ${describeError(error)}.`);
			}
		}
		return next;
	};

	const snap = (instance: Omit<Instance, 'snapshot'>): Instance => {
		const ctx = { data: instance.data, slot: instance.slot, can, now };
		const snapshot = options.snapshot ? options.snapshot(build, ctx, instance.entered) : requireUiFormat(build).snapshot(build, ctx, instance.entered);
		for (const problem of snapshot.problems ?? []) {
			if (!failures.includes(problem)) {
				failures.push(problem);
			}
		}
		// Actions outside tables apply to the slot instance (e.g. the row's post).
		snapshot.actions = snapshot.actions.map((action) => (action.row === undefined ? { ...action, row: instance.slot } : action));
		if (snapshot.inputs) {
			snapshot.inputs = snapshot.inputs.map((input) => ({ ...input, row: instance.slot }));
		}
		return { ...instance, snapshot };
	};

	const render = async (): Promise<Instance[]> => {
		if (!applies) {
			return [];
		}
		const instances: Instance[] = [];
		const { slot: slotId, ...mountOptions } = build.mount;
		for (const slot of await sandbox.slotInstances(viewer, slotId, mountOptions)) {
			instances.push(snap({ slot, data: await loadData(slot), entered: {} }));
		}
		return instances;
	};

	let view = await render();
	// Direct calls: whether each was refused, by action id and row.
	const direct: Array<{ id: string; row: unknown; refused?: string }> = [];
	// What each trigger run did, latest last, for "run" expectations.
	const runs: TriggerRun[] = [];

	for (const [i, written] of (check.steps ?? []).entries()) {
		let step: CheckStep = written;
		if ('trigger' in step) {
			const trigger = build.triggers?.[step.trigger];
			if (!trigger) {
				failures.push(`Step ${i + 1}: the build has no trigger "${step.trigger}".`);
				return result();
			}
			if (!sandbox.fire) {
				failures.push(`Step ${i + 1}: this host's sandbox cannot run triggers.`);
				return result();
			}
			const declared = spec.manifest.triggers?.[step.trigger];
			const grant = options.triggerGrant?.[step.trigger] ?? declared?.permissions ?? [];
			const fire = { build, trigger: step.trigger, grant, limit: triggerLimit(declared, options.surface), now };
			runs.push(await sandbox.fire(step.target ? { ...fire, target: step.target } : fire));
			// What the viewer sees afterwards.
			view = await render();
			continue;
		}
		if ('fill' in step) {
			// Typing into an input: it now shows the value.
			const target = findInput(view, step.fill, step.row);
			if (!target) {
				failures.push(`Step ${i + 1}: no "${step.fill}" input${step.row ? ` for ${describeMatcher(step.row)}` : ''}.`);
				return result();
			}
			const { instance, input } = target;
			const entered = { ...instance.entered, [input.group]: { ...instance.entered[input.group], [input.id]: step.value } };
			view = view.map((item) => (item === instance ? snap({ slot: item.slot, data: item.data, entered }) : item));
			continue;
		}
		if ('drop' in step) {
			// Dragging is pressing the action the record has for where it lands.
			const dropped = findDrop(view, step.drop, step.on);
			if (!dropped) {
				failures.push(`Step ${i + 1}: ${describeMatcher(step.drop)} cannot be dropped on "${step.on}".`);
				return result();
			}
			step = { action: dropped.action.id, row: step.drop };
		}
		const found = findAction(view, step.action, step.row, step.direct === true);
		if (!found) {
			failures.push(`Step ${i + 1}: no ${step.direct ? '' : 'available '}"${step.action}" action${step.row ? ` for ${describeMatcher(step.row)}` : ''}.`);
			return result();
		}
		const { instance, action } = found;
		if (step.direct && !isAction(action.action)) {
			failures.push(`Step ${i + 1}: "${step.action}" calls no capability, so it cannot be called directly.`);
			return result();
		}
		if (action.event) {
			// A local action: what it sets is kept with what the viewer entered (latest last), and the snapshot draws it.
			const { group, name, payload } = action.event;
			const { [name]: _previous, ...rest } = instance.entered[group] ?? {};
			const entered = { ...instance.entered, [group]: { ...rest, [name]: payload } };
			view = view.map((item) => (item === instance ? snap({ slot: item.slot, data: item.data, entered }) : item));
			continue;
		}
		if (!isAction(action.action)) {
			failures.push(`Step ${i + 1}: "${step.action}" does nothing.`);
			return result();
		}
		try {
			await call(action.action.capability, action.action.input ?? null);
			if (step.direct) {
				direct.push({ id: step.action, row: action.row });
			}
		} catch (error) {
			if (!step.direct) {
				failures.push(`Step ${i + 1}: "${step.action}" was refused: ${describeError(error)}.`);
				return result();
			}
			// Refused: nothing changed, so nothing to refresh.
			direct.push({ id: step.action, row: action.row, refused: describeError(error) });
			continue;
		}
		let reload = false;
		let data = instance.data;
		for (const op of action.action.then) {
			const [kind, target = ''] = op.split(':');
			if (kind === 'refresh') {
				data = await loadData(instance.slot, [target], data);
			} else if (kind === 'remove-row') {
				data = { ...data, [target]: removeRow(data[target], action.action.row) };
			} else if (kind === 'reload') {
				reload = true;
			}
		}
		view = reload ? await render() : view.map((item) => (item === instance ? snap({ slot: item.slot, data, entered: item.entered }) : item));
	}

	const merged: Snapshot = {
		texts: view.flatMap((i) => i.snapshot.texts),
		tables: view.flatMap((i) => i.snapshot.tables),
		actions: view.flatMap((i) => i.snapshot.actions),
		inputs: view.flatMap((i) => i.snapshot.inputs ?? []),
	};
	for (const expectation of check.expect) {
		const failure =
			'run' in expectation
				? expectRun(expectation.run, runs)
				: 'refused' in expectation
					? refusedFailure(expectation, direct)
					: await evaluateExpectation(expectation, merged, sandbox);
		if (failure) {
			failures.push(failure);
		}
	}
	return result();
}

/**
 * A "run" expectation: what the latest run (of a trigger, when named) did.
 * `calls` counts the calls that went through, `failed` those refused or
 * failing, `skipped` matched targets over the cap.
 */
function expectRun(expected: unknown, runs: TriggerRun[]): string | undefined {
	const want = (expected ?? {}) as { trigger?: string; calls?: number; failed?: number; skipped?: number; matched?: number; status?: string };
	const run = runs.filter((r) => !want.trigger || r.trigger === want.trigger).at(-1);
	const which = want.trigger ? `"${want.trigger}"` : 'a trigger';
	if (!run) {
		return `Expected ${which} to have run, but it did not.`;
	}
	const actual = {
		calls: run.calls.filter((c) => c.ok).length,
		failed: run.calls.filter((c) => !c.ok).length,
		skipped: run.skipped,
		matched: run.matched,
		status: run.status,
	};
	const wrong = (['calls', 'failed', 'skipped', 'matched', 'status'] as const).filter((key) => want[key] !== undefined && want[key] !== actual[key]);
	if (wrong.length === 0) {
		return undefined;
	}
	const errors = [...new Set(run.calls.flatMap((c) => (c.error ? [c.error] : [])).concat(run.error ? [run.error] : []))];
	return `Expected the run of ${which} to have ${wrong.map((key) => `${key} ${JSON.stringify(want[key])}`).join(', ')}, found ${wrong.map((key) => `${key} ${JSON.stringify(actual[key])}`).join(', ')}${errors.length ? ` (${errors.join('; ')})` : ''}.`;
}

function findInput(view: Instance[], id: string, matcher?: Record<string, unknown>): { instance: Instance; input: SnapshotInput } | undefined {
	for (const instance of view) {
		for (const input of instance.snapshot.inputs ?? []) {
			if (input.id === id && (!matcher || matchesRecord(matcher, input.row))) {
				return { instance, input };
			}
		}
	}
	return undefined;
}

/** {"refused": "<action id>", "row": {...}}: a direct call of that action (for that row) was refused. */
function refusedFailure(expectation: Record<string, unknown>, direct: Array<{ id: string; row: unknown; refused?: string }>): string | undefined {
	const id = String(expectation.refused);
	const matcher = expectation.row as Record<string, unknown> | undefined;
	const calls = direct.filter((call) => call.id === id && (!matcher || matchesRecord(matcher, call.row)));
	const where = `"${id}"${matcher ? ` for ${describeMatcher(matcher)}` : ''}`;
	if (calls.length === 0) {
		return `Expected a direct call of ${where} to be refused, but the check makes none (a step {"action": "${id}", "direct": true}).`;
	}
	return calls.every((call) => call.refused !== undefined) ? undefined : `Expected a direct call of ${where} to be refused, but it went through.`;
}

/** The action a record uses when it is dropped on `zone`, if the viewer can use it. */
function findDrop(view: Instance[], matcher: Record<string, unknown>, zone: string): { instance: Instance; action: SnapshotAction } | undefined {
	for (const instance of view) {
		for (const action of allActions(instance.snapshot)) {
			if (action.dropTarget === zone && action.available && matchesRecord(matcher, action.row)) {
				return { instance, action };
			}
		}
	}
	return undefined;
}

/** An action by id (and row): one the viewer can use, or with `direct`, any that calls a capability. */
function findAction(view: Instance[], id: string, matcher?: Record<string, unknown>, direct = false): { instance: Instance; action: SnapshotAction } | undefined {
	for (const instance of view) {
		for (const action of allActions(instance.snapshot)) {
			if (action.id === id && (action.available || direct) && (!matcher || matchesRecord(matcher, action.row))) {
				return { instance, action };
			}
		}
	}
	return undefined;
}

/**
 * Evaluates one expectation. Known kinds: rows, columns, text, action.
 * Anything else is a host assertion handed to the sandbox.
 */
async function evaluateExpectation(expectation: Record<string, unknown>, snapshot: Snapshot, sandbox: Sandbox): Promise<string | undefined> {
	if ('rows' in expectation) {
		// The first list, or with "in", the lists drawn in the place of that name (e.g. a column's drop target).
		const expected = expectation.rows as string[];
		const zone = typeof expectation.in === 'string' ? expectation.in : undefined;
		const tables = zone === undefined ? snapshot.tables.slice(0, 1) : snapshot.tables.filter((t) => t.zone === zone);
		const actual = tables.flatMap((table) => table.rows.map((row) => row.label));
		const where = zone === undefined ? '' : ` in "${zone}"`;
		if (tables.length === 0 && expected.length > 0) {
			return `Expected rows ${list(expected)}${where}, but nothing${where} lists rows.`;
		}
		return sameSet(expected, actual) ? undefined : `Expected rows ${list(expected)}${where}, found ${list(actual)}.`;
	}
	if ('columns' in expectation) {
		const expected = expectation.columns as string[];
		const actual = snapshot.tables[0]?.columns ?? [];
		return canonicalJson(expected) === canonicalJson(actual) ? undefined : `Expected columns ${list(expected)}, found ${list(actual)}.`;
	}
	if ('text' in expectation) {
		const expected = String(expectation.text);
		return snapshot.texts.some((text) => text.includes(expected)) ? undefined : `Expected the text "${expected}" to be shown.`;
	}
	if ('cell' in expectation) {
		const cell = (expectation.cell ?? {}) as { row?: Record<string, unknown>; column?: string; text?: string; tone?: string };
		const row = snapshot.tables.flatMap((t) => t.rows).find((r) => !cell.row || matchesRecord(cell.row, r.record));
		const where = `the "${cell.column}" cell${cell.row ? ` for ${describeMatcher(cell.row)}` : ''}`;
		if (!row) {
			return `Expected ${where}, but no such row is listed.`;
		}
		const actual = row.cells?.[String(cell.column)];
		if (!actual) {
			return `Expected ${where}, but the row has no such column.`;
		}
		if (cell.text !== undefined && !actual.text.includes(String(cell.text))) {
			return `Expected ${where} to show "${cell.text}", found "${actual.text}".`;
		}
		if (cell.tone !== undefined && actual.tone !== cell.tone) {
			return `Expected ${where} to be marked "${cell.tone}", found ${actual.tone ? `"${actual.tone}"` : 'no mark'}.`;
		}
		return undefined;
	}
	if ('input' in expectation) {
		// What an input shows: {"input": "title", "value": "...", "row": {...}}.
		const id = String(expectation.input);
		const matcher = expectation.row as Record<string, unknown> | undefined;
		const input = (snapshot.inputs ?? []).find((i) => i.id === id && (!matcher || matchesRecord(matcher, i.row)));
		const where = matcher ? ` for ${describeMatcher(matcher)}` : '';
		if (!input) {
			return `Expected a "${id}" input${where}, but there is none.`;
		}
		if (canonicalJson(input.value ?? null) !== canonicalJson(expectation.value ?? null)) {
			return `Expected the "${id}" input${where} to show ${canonicalJson(expectation.value ?? null)}, found ${canonicalJson(input.value ?? null)}.`;
		}
		return undefined;
	}
	if ('action' in expectation) {
		const id = String(expectation.action);
		const matcher = expectation.row as Record<string, unknown> | undefined;
		const wanted = expectation.available !== false;
		const available = allActions(snapshot).some((a) => a.id === id && a.available && (!matcher || matchesRecord(matcher, a.row)));
		if (available === wanted) {
			return undefined;
		}
		const where = matcher ? ` for ${describeMatcher(matcher)}` : '';
		return wanted ? `Expected "${id}" to be available${where}, but it is not.` : `Expected "${id}" not to be available${where}, but it is.`;
	}
	const kinds = Object.keys(expectation);
	if (kinds.length !== 1) {
		return `Unknown expectation ${canonicalJson(expectation)}.`;
	}
	const [kind] = kinds as [string];
	const { ok, actual } = await sandbox.assert(kind, expectation[kind]);
	return ok ? undefined : `Expected ${kind} ${canonicalJson(expectation[kind])}, found ${canonicalJson(actual ?? null)}.`;
}

/**
 * Whether a record matches a matcher: every matcher key equals the
 * record's, directly or on one of the record's object values (so
 * `{ title }` matches a slot instance `{ post: { title } }`).
 */
export function matchesRecord(matcher: Record<string, unknown>, record: unknown): boolean {
	if (typeof record !== 'object' || record === null) {
		return false;
	}
	const direct = Object.entries(matcher).every(
		([key, value]) => canonicalJson((record as Record<string, unknown>)[key] ?? null) === canonicalJson(value),
	);
	return direct || Object.values(record).some((value) => typeof value === 'object' && value !== null && !Array.isArray(value) && matchesRecord(matcher, value));
}

function sameSet(a: string[], b: string[]): boolean {
	return canonicalJson([...a].sort()) === canonicalJson([...b].sort());
}

function list(items: string[]): string {
	return items.length ? items.map((i) => `"${i}"`).join(', ') : '(none)';
}

function describeMatcher(matcher: Record<string, unknown>): string {
	return Object.entries(matcher)
		.map(([key, value]) => `${key} ${JSON.stringify(value)}`)
		.join(', ');
}

function describeError(error: unknown): string {
	if (error instanceof SandboxCallError) {
		return `${error.message} (${error.code})`;
	}
	return error instanceof Error ? error.message : String(error);
}
