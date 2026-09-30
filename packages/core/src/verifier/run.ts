import { evaluate, isAction, type EvalContext } from '../build/evaluate.ts';
import { removeRow } from '../build/rows.ts';
import type { FunctionRunner } from '../build/functions.ts';
import { validateWidgetTree } from '../build/validate.ts';
import { inputEvent, updateArgs } from '../build/widgets.ts';
import type { Build, BuildCode, Check } from '../build/types.ts';
import type { Spec } from '../spec/types.ts';
import { canonicalJson } from '../surface/hash.ts';
import type { Surface } from '../surface/types.ts';
import { SandboxCallError, type Sandbox } from './sandbox.ts';
import { allActions, snapshotTree, type ComponentSemantics, type Snapshot, type SnapshotAction, type SnapshotInput } from './snapshot.ts';

export interface VerifyOptions {
	build: Build;
	spec: Spec;
	surface: Surface;
	sandbox: Sandbox;
	semantics: ComponentSemantics;
	/**
	 * Host permission check from the scopes the user can use, the same
	 * function the host's renderer uses (with per-object refinement).
	 */
	createCan(usable: Record<string, boolean>): EvalContext['can'];
	/** The grant to simulate. Default: the permissions the spec requests. */
	grant?: string[];
	/** Starts the host's sandbox for a build with code. Required to verify such builds. */
	loadFunctions?(code: BuildCode, limits: NonNullable<Surface['functions']>['limits']): Promise<FunctionRunner>;
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
	/** Widget states by node path; a widget without one is in its initial state. */
	widgets: Record<string, unknown>;
	/** What the viewer entered in widgets' inputs: widget path, then input id. */
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
	let functions: FunctionRunner | undefined;
	let unavailable: string | undefined;
	if (build.code) {
		if (!options.surface.functions) {
			unavailable = `${options.surface.host} does not run build functions.`;
		} else if (!options.loadFunctions) {
			unavailable = 'The build has code, and this verifier has no sandbox to run it.';
		} else {
			try {
				functions = await options.loadFunctions(build.code, options.surface.functions.limits);
			} catch (error) {
				unavailable = `The build's code does not load: ${describeError(error)}.`;
			}
		}
	}
	try {
		if (!unavailable) {
			await options.sandbox.prepare?.(options.surface);
		}
		for (const [index, check] of build.checks.entries()) {
			results.push(unavailable ? { criterion: check.criterion, check: index, passed: false, failures: [unavailable] } : await runCheck(options, check, index, functions));
		}
	} finally {
		functions?.dispose?.();
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

async function runCheck(options: VerifyOptions, check: Check, index: number, functions?: FunctionRunner): Promise<CheckResult> {
	const { build, spec, sandbox, semantics } = options;
	const failures: string[] = [];
	const result = (): CheckResult => ({ criterion: check.criterion, check: index, passed: failures.length === 0, failures });

	await sandbox.reset();
	const { users } = await sandbox.seed(check.fixtures ?? {});
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
	// Functions run synchronously here; a failed call shows as null, as in the host, and fails the check.
	const fn = functions
		? (name: string, args: unknown[]): unknown => {
				try {
					// Code sees the check's clock, like $daysSince.
					return functions.call(name, args, now);
				} catch (error) {
					const failure = `Function "${name}" failed: ${describeError(error)}.`;
					if (!failures.includes(failure)) {
						failures.push(failure);
					}
					return null;
				}
			}
		: undefined;

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
				next[name] = await call(source.call, evaluate(source.input, { data: {}, slot, can, now, fn }) ?? null);
			} catch (error) {
				delete next[name];
				failures.push(`Loading "${name}" failed: ${describeError(error)}.`);
			}
		}
		return next;
	};

	const widgetLimits = options.surface.functions?.widgets;
	const snap = (instance: Omit<Instance, 'snapshot'>): Instance => {
		const snapshot = snapshotTree(
			build.tree,
			{ data: instance.data, slot: instance.slot, can, now, fn },
			semantics,
			widgetLimits
				? {
						limits: widgetLimits,
						state: (path) => (Object.hasOwn(instance.widgets, path) ? { has: true, value: instance.widgets[path] } : { has: false }),
						validate: (tree) => validateWidgetTree(tree, options.surface),
						entered: (path) => instance.entered[path] ?? {},
					}
				: undefined,
		);
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
			instances.push(snap({ slot, data: await loadData(slot), widgets: {}, entered: {} }));
		}
		return instances;
	};

	let view = await render();

	for (const [i, step] of (check.steps ?? []).entries()) {
		if ('fill' in step) {
			// Typing into an input: it now shows the value, and its change event (if any) updates the widget.
			const target = findInput(view, step.fill, step.row);
			if (!target) {
				failures.push(`Step ${i + 1}: no "${step.fill}" input${step.row ? ` for ${describeMatcher(step.row)}` : ''}.`);
				return result();
			}
			const { instance, input } = target;
			const entered = { ...instance.entered, [input.widget]: { ...instance.entered[input.widget], [input.id]: step.value } };
			let widgets = instance.widgets;
			const drawn = instance.snapshot.widgets?.[input.widget];
			const event = drawn?.inputs[input.id] ? inputEvent(drawn.inputs[input.id]!, step.value) : undefined;
			if (drawn && event && drawn.props.update && fn) {
				widgets = { ...widgets, [input.widget]: fn(drawn.props.update, updateArgs(drawn.props, drawn.state, event)) };
			}
			view = view.map((item) => (item === instance ? snap({ slot: item.slot, data: item.data, widgets, entered }) : item));
			continue;
		}
		const found = findAction(view, step.action, step.row);
		if (!found) {
			failures.push(`Step ${i + 1}: no available "${step.action}" action${step.row ? ` for ${describeMatcher(step.row)}` : ''}.`);
			return result();
		}
		const { instance, action } = found;
		if (action.event) {
			// A widget's button: its update function computes the widget's next state.
			const drawn = instance.snapshot.widgets?.[action.event.widget];
			if (!drawn?.props.update || !fn) {
				failures.push(`Step ${i + 1}: "${step.action}" does nothing.`);
				return result();
			}
			const next = fn(drawn.props.update, updateArgs(drawn.props, drawn.state, { $event: action.event.name, payload: action.event.payload }));
			const widgets = { ...instance.widgets, [action.event.widget]: next };
			view = view.map((item) => (item === instance ? snap({ slot: item.slot, data: item.data, widgets, entered: item.entered }) : item));
			continue;
		}
		if (!isAction(action.action)) {
			failures.push(`Step ${i + 1}: "${step.action}" does nothing.`);
			return result();
		}
		try {
			await call(action.action.capability, action.action.input ?? null);
		} catch (error) {
			failures.push(`Step ${i + 1}: "${step.action}" was refused: ${describeError(error)}.`);
			return result();
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
		view = reload ? await render() : view.map((item) => (item === instance ? snap({ slot: item.slot, data, widgets: item.widgets, entered: item.entered }) : item));
	}

	const merged: Snapshot = {
		texts: view.flatMap((i) => i.snapshot.texts),
		tables: view.flatMap((i) => i.snapshot.tables),
		actions: view.flatMap((i) => i.snapshot.actions),
		inputs: view.flatMap((i) => i.snapshot.inputs ?? []),
	};
	for (const expectation of check.expect) {
		const failure = await evaluateExpectation(expectation, merged, sandbox);
		if (failure) {
			failures.push(failure);
		}
	}
	return result();
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

function findAction(view: Instance[], id: string, matcher?: Record<string, unknown>): { instance: Instance; action: SnapshotAction } | undefined {
	for (const instance of view) {
		for (const action of allActions(instance.snapshot)) {
			if (action.id === id && action.available && (!matcher || matchesRecord(matcher, action.row))) {
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
		const expected = expectation.rows as string[];
		const table = snapshot.tables[0];
		const actual = table ? table.rows.map((row) => row.label) : [];
		if (!table && expected.length > 0) {
			return `Expected rows ${list(expected)}, but nothing lists rows.`;
		}
		return sameSet(expected, actual) ? undefined : `Expected rows ${list(expected)}, found ${list(actual)}.`;
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
