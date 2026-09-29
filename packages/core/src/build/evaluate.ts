import { canonicalJson } from '../surface/hash.ts';
import { compareOp, getPath, isAnd, isCall, isCan, isDataRef, isDaysSince, isEq, isFieldRef, isFn, isIf, isNot, isOr, isSlotRef } from './expressions.ts';
import type { Value } from './types.ts';

export interface EvalContext {
	/** Loaded data sources by name; a source that is still loading is absent. */
	data: Record<string, unknown>;
	/** Props the slot provides. */
	slot: Record<string, unknown>;
	/** The current row, inside per-row props such as table actions. */
	row?: unknown;
	/** Host-specific permission check. `on` defaults to the current row. */
	can(scope: string, on: unknown): boolean;
	/** The time `$daysSince` counts to, in ms since the epoch. Default: now. */
	now?: number;
	/**
	 * Runs one of the build's pure functions (`$fn`) in the host's sandbox.
	 * Returns undefined while a result is pending. Without it, `$fn` is null.
	 */
	fn?(name: string, args: unknown[]): unknown;
}

/**
 * What a function returned, as inert data: JSON values only, and no object
 * keys starting with "$", so a result can never become an expression or an
 * action. Anything else is null.
 */
export function inert(value: unknown, depth = 0): unknown {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'number') {
		return Number.isFinite(value) ? value : null;
	}
	if (depth >= 8 || typeof value !== 'object') {
		return null;
	}
	if (Array.isArray(value)) {
		return value.map((item) => inert(item, depth + 1));
	}
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		return null;
	}
	const entries = Object.entries(value);
	if (entries.some(([key]) => key.startsWith('$'))) {
		return null;
	}
	return Object.fromEntries(entries.map(([key, item]) => [key, inert(item, depth + 1)]));
}

const DAY = 24 * 60 * 60 * 1000;

function compare(op: string, a: unknown, b: unknown): boolean {
	const comparable = (typeof a === 'number' && typeof b === 'number') || (typeof a === 'string' && typeof b === 'string');
	if (!comparable) {
		return false;
	}
	const [x, y] = [a as number | string, b as number | string];
	switch (op) {
		case '$gt':
			return x > y;
		case '$gte':
			return x >= y;
		case '$lt':
			return x < y;
		default:
			return x <= y;
	}
}

/** A `$call` with its input resolved, ready for the renderer to invoke. */
export interface Action {
	$action: true;
	capability: string;
	input: unknown;
	then: string[];
	notice?: string;
	/** The row the action was resolved for, used by remove-row. */
	row?: unknown;
}

export function isAction(value: unknown): value is Action {
	return typeof value === 'object' && value !== null && (value as { $action?: unknown }).$action === true;
}

/**
 * Resolves a prop value against a context: bindings become their values,
 * `$can` and the logic operators become booleans (only `true` counts as
 * true) and `$call` becomes an Action. Pure; the
 * renderer calls it again whenever data changes.
 */
export function evaluate(value: Value | undefined, ctx: EvalContext): unknown {
	if (value === null || value === undefined || typeof value !== 'object') {
		return value;
	}
	if (Array.isArray(value)) {
		return value.map((item) => evaluate(item, ctx));
	}
	if (isDataRef(value)) {
		return getPath(ctx.data, value.$data);
	}
	if (isFieldRef(value)) {
		return getPath(ctx.row, value.$field);
	}
	if (isSlotRef(value)) {
		return getPath(ctx.slot, value.$slot);
	}
	if (isCan(value)) {
		const on = value.on === undefined ? ctx.row : evaluate(value.on, ctx);
		return ctx.can(value.$can, on);
	}
	if (isEq(value)) {
		const [a, b] = value.$eq.map((item) => evaluate(item, ctx));
		return canonicalJson(a ?? null) === canonicalJson(b ?? null);
	}
	const op = compareOp(value);
	if (op) {
		const [a, b] = (value as unknown as Record<string, Value[]>)[op]!.map((item) => evaluate(item, ctx));
		return compare(op, a, b);
	}
	if (isIf(value)) {
		const [condition, then, otherwise] = value.$if;
		return evaluate(evaluate(condition, ctx) === true ? then : otherwise, ctx);
	}
	if (isDaysSince(value)) {
		const date = evaluate(value.$daysSince, ctx);
		const time = typeof date === 'string' ? Date.parse(date) : Number.NaN;
		return Number.isNaN(time) ? null : Math.floor(((ctx.now ?? Date.now()) - time) / DAY);
	}
	if (isFn(value)) {
		if (!ctx.fn) {
			return null;
		}
		const result = ctx.fn(value.$fn, (value.args ?? []).map((arg) => inert(evaluate(arg, ctx) ?? null)));
		return result === undefined ? undefined : inert(result);
	}
	if (isAnd(value)) {
		return value.$and.every((item) => evaluate(item, ctx) === true);
	}
	if (isOr(value)) {
		return value.$or.some((item) => evaluate(item, ctx) === true);
	}
	if (isNot(value)) {
		return evaluate(value.$not, ctx) !== true;
	}
	if (isCall(value)) {
		const action: Action = {
			$action: true,
			capability: value.$call,
			input: evaluate(value.input, ctx),
			then: value.then ?? [],
		};
		if (value.notice !== undefined) {
			action.notice = value.notice;
		}
		if (ctx.row !== undefined) {
			action.row = ctx.row;
		}
		return action;
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item as Value, ctx)]));
}
