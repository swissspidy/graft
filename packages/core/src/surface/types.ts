/** An embedded JSON Schema (draft 2020-12). */
export type JsonSchema = Record<string, unknown> | boolean;

export interface Slot {
	/** owned: its own space. extension: attaches to an existing host screen. */
	kind: 'owned' | 'extension';
	title: string;
	description?: string;
	screen?: string;
	/** Host hook or component the slot attaches to. */
	anchor?: string;
	/** Schema for the spec's `mount` options (everything except `slot`). */
	options?: JsonSchema;
	/** Props the slot passes into the tree. */
	provides?: JsonSchema;
	/** Components allowed at the root of a tree mounted here. */
	accepts?: string[];
	successor?: string;
	deprecated?: boolean;
}

export interface Component {
	description?: string;
	props: JsonSchema;
	children?: 'none' | 'any' | 'text';
}

export interface Capability {
	kind: 'read' | 'write';
	description?: string;
	input: JsonSchema;
	output: JsonSchema;
	/** Scopes a grant must include to call this capability. */
	scopes: string[];
	/** Host-specific binding, opaque to the core. */
	binding?: Record<string, unknown>;
}

export interface Scope {
	/** Plain-language description an admin approves. */
	title: string;
	/** Host permissions the scope maps to. */
	host?: string[];
}

export type Migration =
	| { op: 'rename'; kind: 'slot' | 'component' | 'capability' | 'scope'; from: string; to: string }
	| { op: 'rename-prop'; component: string; from: string; to: string; values?: Record<string, unknown> }
	| { op: 'remove'; kind: 'slot' | 'component' | 'capability' | 'scope' | 'prop'; symbol: string };

export interface Surface {
	graft: 1;
	host: string;
	hostVersion: string;
	/** Content hash, see hashSurface(). Optional in files; verified when present. */
	hash?: string;
	/** Host-computed fingerprint of the host half; provenance, not hashed. */
	fingerprint?: string;
	previous?: string;
	slots: Record<string, Slot>;
	components: Record<string, Component>;
	capabilities: Record<string, Capability>;
	scopes: Record<string, Scope>;
	audiences?: string[];
	migrations?: Migration[];
	/** Present when builds may carry pure functions (`code`, `$fn`), and the limits they run under. */
	functions?: SurfaceFunctions;
}

export interface SurfaceFunctions {
	runtime: 'quickjs';
	limits: {
		/** CPU time per call, in milliseconds. */
		timeMs: number;
		/** Heap of the whole sandbox, in bytes. */
		memoryBytes: number;
		/** Largest JSON result of one call, in bytes. */
		outputBytes: number;
		/** Largest `code.source`, in bytes. */
		sourceBytes: number;
	};
	/** Present when builds may use interactive widgets: what their functions may draw with. */
	widgets?: {
		/** Components a widget's tree may use. */
		components: string[];
		/** Which of those are inputs: they have an id and show a value the viewer can change ($input). */
		inputs?: string[];
		/** Most nodes one render may return. */
		maxNodes: number;
	};
}
