import { canonicalJson } from '../surface/hash.ts';
import { getPath, isAnd, isCall, isCan, isDataRef, isEq, isFieldRef, isNot, isOr, isSlotRef } from './expressions.ts';
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
