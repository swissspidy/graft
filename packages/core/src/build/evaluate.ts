import { canonicalJson } from '../surface/hash.ts';
import { compareOp, getPath, isAnd, isCan, isDataRef, isDaysSince, isEq, isIf, isNot, isOr, isSlotRef } from './expressions.ts';
import type { Value } from './types.ts';

export interface EvalContext {
	/** Loaded data sources by name; a source that is still loading is absent. */
	data: Record<string, unknown>;
	/** Props the slot provides. */
	slot: Record<string, unknown>;
	/** Host-specific permission check, on an object (e.g. a post) or none. */
	can(scope: string, on: unknown): boolean;
	/** The time `$daysSince` counts to, in ms since the epoch. Default: now. */
	now?: number;
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

/** A capability call with its input resolved (an action event's binding), ready to invoke. */
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
 * Resolves a value (a data source's input) against a context: bindings
 * become their values, `$can` and the logic operators become booleans
 * (only `true` counts as true). Pure.
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
	if (isSlotRef(value)) {
		return getPath(ctx.slot, value.$slot);
	}
	if (isCan(value)) {
		return ctx.can(value.$can, value.on === undefined ? undefined : evaluate(value.on, ctx));
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
	if (isAnd(value)) {
		return value.$and.every((item) => evaluate(item, ctx) === true);
	}
	if (isOr(value)) {
		return value.$or.some((item) => evaluate(item, ctx) === true);
	}
	if (isNot(value)) {
		return evaluate(value.$not, ctx) !== true;
	}
	return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluate(item as Value, ctx)]));
}
