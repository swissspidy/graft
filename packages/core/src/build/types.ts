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

export type Binding = DataRef | FieldRef | SlotRef;
export type Logic = EqExpr | AndExpr | OrExpr | NotExpr;
export type Expression = Binding | CanExpr | CallExpr | Logic;

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
