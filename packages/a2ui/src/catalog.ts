import { BASIC_FUNCTIONS, Catalog, createFunctionImplementation, type ComponentApi, type DataContext, type FunctionImplementation } from '@a2ui/web_core/v0_9';
import { z } from 'zod';

/**
 * The Graft A2UI catalog: the parts of A2UI's basic catalog a Graft build
 * may use, a Table, and what Graft needs on top of A2UI:
 *
 * - `visible` on every component (A2UI cannot hide anything);
 * - functions: comparisons, arithmetic, strings and lists; `if` (A2UI has
 *   no conditional); `can`, the host's permission check; `daysSince`;
 * - `set`, a local action that writes a value into the data model;
 * - `actionId` on Button, so buttons a template draws get ids checks name.
 *
 * Hosts extend it with their own components and give it its id (e.g.
 * `graft:wordpress`). Functions and components carry zod schemas, so a
 * wrong argument or prop is caught before anything runs.
 */

export const PROTOCOL = 'a2ui/v0.9';

/** What functions need from the host and the moment they are drawn in. */
export interface CatalogContext {
	/** The host's permission check; `on` refines on an object (a post). */
	can(scope: string, on: unknown): boolean;
	now: Date;
}

// Dynamic values: a literal, a binding or a function call.
const binding = z.object({ path: z.string() }).strict();
const call = z.object({ call: z.string(), args: z.record(z.any()).optional(), returnType: z.string().optional() }).strict();
const dynamic = <T extends z.ZodTypeAny>(literal: T) => z.union([literal, binding, call]);
export const dynamicString = dynamic(z.string());
export const dynamicNumber = dynamic(z.number());
export const dynamicBoolean = dynamic(z.boolean());
const dynamicAny = z.any();

const eventAction = z.object({ event: z.object({ name: z.string(), context: z.record(dynamicAny).optional() }).strict() }).strict();
const setAction = z
	.object({ functionCall: z.object({ call: z.literal('set'), args: z.object({ target: z.string().startsWith('/'), value: dynamicAny }).strict() }).strict() })
	.strict();
export const action = z.union([eventAction, setAction]);
const childList = z.union([z.array(z.string()), z.object({ componentId: z.string(), path: z.string() }).strict()]);
const checks = z.array(z.object({ condition: dynamicBoolean, message: z.string() }).strict());

/** Properties every component takes. */
const common = { id: z.string(), component: z.string(), visible: dynamicBoolean.optional(), accessibility: z.record(dynamicAny).optional() };
const component = (name: string, props: z.ZodRawShape): ComponentApi => ({ name, schema: z.object({ ...common, ...props }).strict() });

export const tableField = z
	.object({
		id: z.string(),
		label: z.string(),
		type: z.string().optional(),
		primary: z.boolean().optional(),
		value: dynamicAny.optional(),
		tone: dynamicAny.optional(),
	})
	.strict();
export const rowAction = z
	.object({ id: z.string(), label: z.string(), variant: z.enum(['primary', 'default', 'secondary']).optional(), visible: dynamicBoolean.optional(), action: eventAction })
	.strict();

export const BASE_COMPONENTS: ComponentApi[] = [
	component('Column', { children: childList, align: z.string().optional(), justify: z.string().optional() }),
	component('Row', { children: childList, align: z.string().optional(), justify: z.string().optional() }),
	component('Card', { child: z.string() }),
	component('Divider', { axis: z.enum(['horizontal', 'vertical']).optional() }),
	component('Text', { text: dynamicString, variant: z.enum(['h1', 'h2', 'h3', 'h4', 'h5', 'body', 'caption']).optional() }),
	component('Button', { child: z.string(), action, variant: z.enum(['primary', 'default', 'secondary', 'borderless']).optional(), checks: checks.optional(), actionId: dynamicString.optional() }),
	component('TextField', { label: dynamicString, value: binding, variant: z.enum(['shortText', 'longText', 'number', 'obscured']).optional(), validationRegexp: z.string().optional(), checks: checks.optional() }),
	component('CheckBox', { label: dynamicString, value: binding, checks: checks.optional() }),
	component('Table', { rows: binding, fields: z.array(tableField), rowActions: z.array(rowAction).optional(), empty: z.string().optional() }),
];

/** Component types that take what the viewer enters. */
export const INPUT_COMPONENTS = new Set(['TextField', 'CheckBox']);

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
const number = (value: unknown): number => (typeof value === 'number' ? value : Number(value));
const DAY = 86_400_000;

const fn = (name: string, returnType: string, shape: z.ZodRawShape, run: (args: Record<string, unknown>, context: DataContext) => unknown, description?: string): FunctionImplementation =>
	createFunctionImplementation({ name, returnType, schema: z.object(shape).strict(), ...(description ? { description } : {}) }, run as never);

const ab = { a: dynamicAny, b: dynamicAny };
const items = { items: dynamicAny, by: z.string().optional() };

/** The record a function is evaluated for: the row or template item in scope, if any. */
function rowOf(context: DataContext): unknown {
	return context.path === '/' || context.path === '' ? undefined : context.dataModel.get(context.path);
}

/** Functions on top of A2UI's basic ones, for one viewer at one moment. */
export function graftFunctions({ can, now }: CatalogContext): FunctionImplementation[] {
	return [
		// Comparisons and arithmetic.
		fn('equals', 'boolean', ab, ({ a, b }) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)),
		fn('notEquals', 'boolean', ab, ({ a, b }) => JSON.stringify(a ?? null) !== JSON.stringify(b ?? null)),
		fn('greaterThan', 'boolean', ab, ({ a, b }) => number(a) > number(b)),
		fn('lessThan', 'boolean', ab, ({ a, b }) => number(a) < number(b)),
		fn('add', 'number', ab, ({ a, b }) => number(a) + number(b)),
		fn('subtract', 'number', ab, ({ a, b }) => number(a) - number(b)),
		fn('multiply', 'number', ab, ({ a, b }) => number(a) * number(b)),
		fn('divide', 'number', ab, ({ a, b }) => (number(b) === 0 ? null : number(a) / number(b))),
		fn('if', 'any', { condition: dynamicAny, then: dynamicAny, else: dynamicAny }, (args) => (args.condition ? args.then : args.else)),
		// Strings.
		fn('contains', 'boolean', { string: dynamicAny, substring: dynamicAny }, ({ string, substring }) => text(string).includes(text(substring))),
		fn('startsWith', 'boolean', { string: dynamicAny, prefix: dynamicAny }, ({ string, prefix }) => text(string).startsWith(text(prefix))),
		fn('endsWith', 'boolean', { string: dynamicAny, suffix: dynamicAny }, ({ string, suffix }) => text(string).endsWith(text(suffix))),
		fn('lower', 'string', { value: dynamicAny }, ({ value }) => text(value).toLowerCase()),
		fn('upper', 'string', { value: dynamicAny }, ({ value }) => text(value).toUpperCase()),
		fn('replace', 'string', { value: dynamicAny, pattern: z.string(), with: dynamicAny }, ({ value, pattern, with: replacement }) =>
			text(value).replace(new RegExp(String(pattern), 'g'), text(replacement)),
		),
		fn('count', 'number', { value: dynamicAny }, ({ value }) => (typeof value === 'string' || Array.isArray(value) ? value.length : 0)),
		fn('join', 'string', { values: dynamicAny, separator: dynamicAny.optional() }, ({ values, separator }) =>
			list(values).map(text).filter(Boolean).join(separator === undefined ? ', ' : text(separator)),
		),
		// Lists; "by" is a JSON Pointer into each item ("" for the item itself).
		fn('filter', 'array', { ...items, equals: dynamicAny }, ({ items: all, by, equals }) =>
			list(all).filter((item) => JSON.stringify(readPointer(item, String(by ?? '')) ?? null) === JSON.stringify(equals ?? null)),
		),
		fn('map', 'array', items, ({ items: all, by }) => list(all).map((item) => readPointer(item, String(by ?? '')) ?? null)),
		fn('distinct', 'array', items, ({ items: all, by }) => {
			const seen = new Set<string>();
			return list(all).filter((item) => {
				const key = JSON.stringify(readPointer(item, String(by ?? '')) ?? null);
				return seen.has(key) ? false : (seen.add(key), true);
			});
		}),
		fn('sort', 'array', { ...items, descending: dynamicAny.optional() }, ({ items: all, by, descending }) =>
			[...list(all)].sort((a, b) => {
				const x = readPointer(a, String(by ?? ''));
				const y = readPointer(b, String(by ?? ''));
				const order = typeof x === 'number' && typeof y === 'number' ? x - y : text(x).localeCompare(text(y));
				return descending ? -order : order;
			}),
		),
		fn('slice', 'array', { items: dynamicAny, start: dynamicAny.optional(), end: dynamicAny.optional() }, ({ items: all, start, end }) =>
			list(all).slice(number(start ?? 0), end === undefined || end === null ? undefined : number(end)),
		),
		// The host.
		fn('can', 'boolean', { scope: z.string(), on: dynamicAny.optional() }, ({ scope, on }, context) => can(String(scope), on ?? rowOf(context)), 'Whether the viewer may use a permission scope; in a row it refines on the row.'),
		fn('daysSince', 'number', { value: dynamicAny }, ({ value }) => {
			const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
			return Number.isNaN(time) ? null : Math.floor((now.getTime() - time) / DAY);
		}),
		// The local action: writes the data model, where the surface is live.
		fn('set', 'void', { target: z.string().startsWith('/'), value: dynamicAny }, ({ target, value }, context) => {
			context.set(String(target), value ?? null);
		}),
	];
}

export interface CatalogOptions extends CatalogContext {
	/** The catalog id builds name, e.g. `graft:wordpress`. */
	id: string;
	/** Host components beyond the base ones (they may replace one by name). */
	components?: ComponentApi[];
}

/** The Graft catalog for one host, viewer and moment. */
export function createGraftCatalog({ id, components = [], ...context }: CatalogOptions): Catalog<ComponentApi> {
	const byName = new Map(BASE_COMPONENTS.map((c) => [c.name, c]));
	for (const extra of components) {
		byName.set(extra.name, extra);
	}
	const ours = graftFunctions(context);
	const names = new Set(ours.map((f) => f.name));
	return new Catalog(id, '0.9', [...byName.values()], [...BASIC_FUNCTIONS.filter((f) => !names.has(f.name)), ...ours]);
}
