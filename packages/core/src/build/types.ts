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

export type Binding = DataRef | FieldRef | SlotRef;
export type Logic = EqExpr | AndExpr | OrExpr | NotExpr | CompareExpr;
/** Expressions whose value is computed at render time from other values. */
export type Computed = IfExpr | DaysSinceExpr | CompareExpr;
export type Expression = Binding | CanExpr | CallExpr | Logic | Computed;

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

export interface Check {
	criterion: string;
	fixtures?: Record<string, unknown>;
	/** When the check looks, relative to when its fixtures were seeded. */
	clock?: { advanceDays: number };
	view_as?: string;
	steps?: Array<{ action: string; row?: Record<string, unknown> }>;
	expect: Array<Record<string, unknown>>;
}

export interface Refs {
	slot: string;
	/** Component name to the sorted prop names the build uses. */
	components: Record<string, string[]>;
	capabilities: string[];
	scopes: string[];
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
	provenance: {
		compiler: string;
		model?: string;
		promptHash?: string;
		strategy?: 'handwritten' | 'compiled' | 'migrated' | 'reanchored' | 'regenerated';
		replaces?: string;
		[key: string]: unknown;
	};
}
