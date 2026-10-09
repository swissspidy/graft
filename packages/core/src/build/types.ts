/** `{ $data: "queue.items" }`: a path into a named data source. */
export interface DataRef {
	$data: string;
}
/** `{ $slot: "post.id" }`: a path into the props the slot provides. */
export interface SlotRef {
	$slot: string;
}
/** `{ $can: "posts.status:write", on }`: whether the viewer may use a scope, optionally on an object. */
export interface CanExpr {
	$can: string;
	on?: Value;
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

export type Binding = DataRef | SlotRef;
export type Logic = EqExpr | AndExpr | OrExpr | NotExpr | CompareExpr;
/** Expressions whose value is computed from other values. */
export type Computed = IfExpr | DaysSinceExpr | CompareExpr;
/** What a data source's input may compute from: the slot's props, the viewer's permissions, the clock. */
export type Expression = Binding | CanExpr | Logic | Computed;

export type Value = null | string | number | boolean | Value[] | Expression | { [key: string]: Value };

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
	capabilities: string[];
	scopes: string[];
	/** Component type to the sorted properties the UI uses, in its format's catalog (`ui.catalogId`). */
	catalog: Record<string, string[]>;
}

/** What an action event of the UI does: a capability call. */
export interface EventBinding {
	call: string;
	/** The call's input; `{"$context": "<key>"}` stands for a value of the event's context. */
	input?: unknown;
	then?: string[];
	notice?: string;
}

/**
 * A build's UI (an A2UI surface): the protocol, the catalog it draws from,
 * and the format's own content. A registered `UiFormat` reads it.
 */
export interface BuildUi {
	protocol: string;
	catalogId: string;
	[key: string]: unknown;
}

export interface Build {
	graft: 1;
	spec: { id: string; hash: string };
	surface: { host: string; hostVersion?: string; hash: string };
	mount: { slot: string; [option: string]: unknown };
	/** The UI, an A2UI surface, with `events` binding its action events to capabilities. */
	ui: BuildUi;
	events: Record<string, EventBinding>;
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
