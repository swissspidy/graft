/** `{ $data: "queue.items" }`: a path into a named data source. */
export interface DataRef {
	$data: string;
}
/** `{ $field: "author.name" }`: a path into the current row. */
export interface FieldRef {
	$field: string;
}
/** `{ $slot: "post.id" }`: a path into the props the slot provides. */
export interface SlotRef {
	$slot: string;
}
/** `{ $can: "posts.status:write", on }`: whether the viewer may use a scope, optionally on an object (default: the current row). */
export interface CanExpr {
	$can: string;
	on?: Value;
}
/** `{ $call: "posts.update_status", input, then, notice }`: a capability call run on interaction. */
export interface CallExpr {
	$call: string;
	input?: Value;
	then?: string[];
	notice?: string;
}

/** `{ $eq: [a, b] }`: strict JSON equality. */
export interface EqExpr {
	$eq: [Value, Value];
}
export interface AndExpr {
	$and: Value[];
}
export interface OrExpr {
	$or: Value[];
}
export interface NotExpr {
	$not: Value;
}

/** `{ $gt: [a, b] }` and $gte, $lt, $lte: numeric (or string) comparison. */
export type CompareOp = '$gt' | '$gte' | '$lt' | '$lte';
export type CompareExpr = { [K in CompareOp]: { [P in K]: [Value, Value] } }[CompareOp];
/** `{ $if: [condition, then, else] }`: then when the condition is true, else otherwise. */
export interface IfExpr {
	$if: [Value, Value, Value];
}
/** `{ $daysSince: date }`: whole days from a date (ISO 8601) to now; null when it is not a date. */
export interface DaysSinceExpr {
	$daysSince: Value;
}

/**
 * `{ $input: "title" }`: what the viewer sees in one of a widget's input
 * components, by its id. Only in a widget's declared actions, so an action
 * sends what is on screen, never a value the code keeps out of sight.
 */
export interface InputRef {
	$input: string;
}

export type Binding = DataRef | FieldRef | SlotRef;
export type Logic = EqExpr | AndExpr | OrExpr | NotExpr | CompareExpr;
/** Expressions whose value is computed at render time from other values. */
/**
 * A call to one of the build's own pure functions (see Build.code). It only
 * computes a value to show: code reads nothing and invokes nothing, and
 * what it returns is inert data.
 */
export interface FnExpr {
	$fn: string;
	args?: Value[];
}

export type Computed = IfExpr | DaysSinceExpr | CompareExpr | FnExpr;
export type Expression = Binding | InputRef | CanExpr | CallExpr | Logic | Computed;

export type Value = null | string | number | boolean | Value[] | Expression | { [key: string]: Value };

export interface TreeNode {
	type: string;
	key?: string;
	props?: Record<string, Value>;
	children?: string | TreeNode[];
}

export interface DataSource {
	call: string;
	input?: Value;
}

/**
 * What a check does before its expectations: use an action (a button, a
 * row action), or type a value into an input component. `row` picks the
 * row (or slot instance, e.g. the post) the action or input belongs to.
 */
export type CheckStep = { action: string; row?: Record<string, unknown> } | { fill: string; value: string | boolean; row?: Record<string, unknown> };

export interface Check {
	criterion: string;
	fixtures?: Record<string, unknown>;
	/** When the check looks, relative to when its fixtures were seeded. */
	clock?: { advanceDays: number };
	view_as?: string;
	steps?: CheckStep[];
	expect: Array<Record<string, unknown>>;
}

export interface Refs {
	slot: string;
	/** Component name to the sorted prop names the build uses. */
	components: Record<string, string[]>;
	capabilities: string[];
	scopes: string[];
}

export interface BuildCode {
	language: 'javascript';
	/** A script declaring each function at top level: `function name(a, b) { ... }`. */
	source: string;
	/** The functions `$fn` may call, declared in `source`. */
	functions: string[];
}

export interface Build {
	graft: 1;
	spec: { id: string; hash: string };
	surface: { host: string; hostVersion?: string; hash: string };
	mount: { slot: string; [option: string]: unknown };
	tree: TreeNode;
	data: Record<string, DataSource>;
	checks: Check[];
	refs: Refs;
	/** Pure functions for `$fn`, run in the host's sandbox. Only on surfaces with `functions`. */
	code?: BuildCode;
	provenance: {
		compiler: string;
		model?: string;
		promptHash?: string;
		strategy?: 'handwritten' | 'compiled' | 'migrated' | 'reanchored' | 'regenerated';
		replaces?: string;
		[key: string]: unknown;
	};
}
