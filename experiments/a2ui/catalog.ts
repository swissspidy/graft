import { createBasicFunctions, type FunctionRegistry } from '../../packages/a2ui/src/core/index.ts';

/**
 * The `graft:wordpress` A2UI catalog: the parts of A2UI's basic catalog a
 * Graft build may use, a Table, and what Graft needs on top. The basic
 * catalog cannot hide a component or branch on a value, so this catalog
 * adds `visible` to every component and an `if` function; `can` is the
 * host's permission check, `count` a length to show.
 */

export const CATALOG_ID = 'graft:wordpress';
export const PROTOCOL = 'a2ui/v0.9.1';

/** Component types the snapshot and the client draw. */
export const COMPONENTS = ['Column', 'Row', 'Card', 'Divider', 'Text', 'Button', 'TextField', 'CheckBox', 'Table'] as const;

/** Values every function gets besides its arguments. */
export interface GraftFunctionContext {
	can(scope: string, on: unknown): boolean;
	now: Date;
	/** The record in scope (a table row), which `can` refines on by default. */
	row?: unknown;
	/** Writes the data model, for the local `set` action. Without it, `set` does nothing. */
	set?(pointer: string, value: unknown): void;
}

const DAY = 86_400_000;

/** Reads a relative JSON Pointer ("author/name") from a value. */
export function readPointer(value: unknown, pointer: string): unknown {
	if (pointer === '' || pointer === '/') {
		return value;
	}
	return pointer
		.replace(/^\//, '')
		.split('/')
		.map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'))
		.reduce<unknown>((inner, key) => (inner && typeof inner === 'object' ? (inner as Record<string, unknown>)[key] : undefined), value);
}

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

export function graftFunctions({ can, now, row, set }: GraftFunctionContext): FunctionRegistry {
	return {
		...createBasicFunctions({ locale: 'en-US' }),
		can: ({ scope, on }) => can(String(scope), on ?? row),
		if: (args) => (args.condition ? args.then : args.else),
		count: ({ value }) => (typeof value === 'string' || Array.isArray(value) ? value.length : 0),
		daysSince: ({ value }) => {
			const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
			return Number.isNaN(time) ? null : Math.floor((now.getTime() - time) / DAY);
		},
		// Lists.
		filter: ({ items, by, equals }) => list(items).filter((item) => readPointer(item, String(by ?? '')) === equals),
		map: ({ items, by }) => list(items).map((item) => readPointer(item, String(by ?? '')) ?? null),
		distinct: ({ items, by }) => {
			const seen = new Set<string>();
			return list(items).filter((item) => {
				const key = JSON.stringify(readPointer(item, String(by ?? '')) ?? null);
				return seen.has(key) ? false : (seen.add(key), true);
			});
		},
		sort: ({ items, by, descending }) =>
			[...list(items)].sort((a, b) => {
				const x = readPointer(a, String(by ?? ''));
				const y = readPointer(b, String(by ?? ''));
				const order = typeof x === 'number' && typeof y === 'number' ? x - y : text(x).localeCompare(text(y));
				return descending ? -order : order;
			}),
		slice: ({ items, start, end }) => list(items).slice(Number(start ?? 0), end === undefined || end === null ? undefined : Number(end)),
		// Strings.
		join: ({ values, separator }) => list(values).map(text).filter(Boolean).join(separator === undefined ? ', ' : text(separator)),
		lower: ({ value }) => text(value).toLowerCase(),
		upper: ({ value }) => text(value).toUpperCase(),
		replace: ({ value, pattern, with: replacement }) => text(value).replace(new RegExp(text(pattern), 'g'), text(replacement)),
		// The local action: writes a value into the data model.
		set: ({ target, value }) => {
			set?.(String(target), value);
		},
	};
}

/** The catalog as the compiler describes it to the model. */
export const CATALOG_GUIDE = `The UI is an A2UI v0.9 surface: a flat list of components, each with a unique "id" and a "component" type. The component with id "root" is drawn first; containers name their children by id.

Values (anywhere a property is dynamic):
- a literal (string, number, boolean);
- a data binding {"path": "/queue/items"}: a JSON Pointer into the data model, with "/" between keys (never "."): /slot/post/can/publish. Inside a template or table row, a pointer without a leading "/" is relative to the row, e.g. {"path": "author/name"};
- a function call {"call": "<name>", "args": {...}}, whose args are values again.

The data model holds:
- /<source>: each data source's result, e.g. /queue/items for a source "queue" returning {items: [...]};
- /slot: what the slot provides, e.g. /slot/post/title;
- whatever "initial" sets when the surface is drawn, e.g. {"form": {"title": {"path": "/slot/post/title"}}} puts the saved title at /form/title. Inputs bind their "value" to a path and write what the viewer enters there, so everything bound to that path follows as they type. Bind inputs under /form (seeded through "initial"), never directly to /slot or a data source, so the saved values stay available for comparison.
- whatever "computed" sets: like "initial", but recomputed every time the data model changes, each key seeing the ones before it. Use it for lists derived from others, e.g. {"shown": {"call": "filter", "args": {"items": {"path": "/queue/items"}, "by": "author/name", "equals": {"path": "/form/author"}}}}, then bind a table or template to /shown. Templates and tables only take pointers, so anything they draw that is computed goes here.

Functions:
- logic: and {"values": [...]}, or {"values": [...]}, not {"value": v}, equals {"a", "b"}, notEquals {"a", "b"}, greaterThan {"a", "b"}, lessThan {"a", "b"}, if {"condition": c, "then": v, "else": w};
- strings: contains {"string", "substring"}, startsWith {"string", "prefix"}, endsWith {"string", "suffix"}, regex {"value", "pattern"} (true when the JavaScript pattern matches), length {"value", "min", "max"} (true when the length is within bounds), count {"value"} (the length of a string or list, a number), required {"value"} (true unless empty);
- numbers: add, subtract, multiply, divide {"a", "b"};
- formatting: formatString {"value": "Text with \${/path} or \${count(value: \${/form/title})}"} interpolates paths and function calls, formatNumber {"value", "decimals"}, formatDate {"value", "format"}, pluralize {"value", "one", "other"};
- lists ("by" is a relative JSON Pointer into each item, "" for the item itself): filter {"items", "by", "equals"} (items whose value equals), map {"items", "by"} (the values), distinct {"items", "by"} (first item per distinct value), sort {"items", "by", "descending"}, slice {"items", "start", "end"}, join {"values", "separator"} (non-empty values joined, default ", ");
- more strings: lower {"value"}, upper {"value"}, replace {"value", "pattern", "with"} (every match of a JavaScript pattern);
- can {"scope": "<permission scope>"} (optionally "on": <record>): whether the viewer may use that scope; inside a table row it refines on the row's post, outside it on nothing (pass "on": {"path": "/slot/post"} for the slot's post);
- daysSince {"value": <ISO date>}: whole days from that date to now.

Components (every component also takes "visible": <boolean value>; false hides it and everything in it):
- Column / Row {"children": ["id", ...]} or a template {"children": {"componentId": "<id>", "path": "/list"}} drawing that component once per item, with paths relative to the item.
- Card {"child": "<id>"}. Divider {}.
- Text {"text": <string value>, "variant": "h1"|"h2"|"h3"|"body"|"caption"}.
- Button {"child": "<id of a Text with the label>", "variant": "primary"|"default", "action": <action>, "checks": [{"condition": <boolean value>, "message": "<why not>"}], "actionId": <string value>}. Checks name the button by "actionId", which defaults to its component id; give buttons drawn by a template an "actionId" computed from the item, e.g. {"call": "formatString", "args": {"value": "author-\${lower(value: \${author/name})}"}}. A button whose checks do not all pass is disabled and does not count as available.
  The action is either {"event": {"name": "<event>", "context": {"<key>": <value>, ...}}}, which runs a capability (see Events), or the local {"functionCall": {"call": "set", "args": {"target": "/form/<key>", "value": <value>}}}, which only writes a value into the data model (e.g. which author is chosen); "target" is an absolute pointer string, not a binding.
- TextField {"label": "...", "value": {"path": "/form/<field>"}, "variant": "shortText"|"longText"}; CheckBox {"label": "...", "value": {"path": "/form/<field>"}}. Checks name inputs by their component id.
- Table {"rows": {"path": "/<source>/items"}, "fields": [{"id": "<relative JSON Pointer into the row, e.g. author/name>", "label": "<column label>", "type": "string"|"user"|"datetime"|"integer"|"boolean", "primary": true for the row label}], "rowActions": [{"id": "<action id>", "label": "...", "variant": "primary"|"default", "visible": <boolean value in the row's scope>, "action": {"event": {"name": "<event>", "context": {"id": {"path": "id"}}}}}], "empty": "<text when there are no rows>"}. A field may compute its value in the row's scope with "value": <value>, and its mark with "tone": <"success"|"warning"|"error"|"info" value>; "id" then just names it.

Events: a button or row action sends an event with its resolved context; "events" binds each event name to a capability call:
{"call": "<capability>", "input": <JSON where {"$context": "<key>"} is replaced by the event's context value>, "then": ["refresh:<source>" | "remove-row:<source>" | "reload:page"], "notice": "<text shown after it succeeded>"}.
An event has no other effect: only capabilities change anything.`;
