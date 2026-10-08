import { BASIC_FUNCTIONS, Catalog, createFunctionImplementation, type ComponentApi, type DataContext, type FunctionImplementation } from '@a2ui/web_core/v0_9';
import { z } from 'zod';
import { pureFunctions } from './functions.ts';

export { readPointer } from './functions.ts';

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
	.object({ id: z.string(), label: z.string(), variant: z.enum(['primary', 'default', 'secondary']).optional(), visible: dynamicBoolean.optional(), action })
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
	component('Table', { rows: binding, fields: z.array(tableField), rowActions: z.array(rowAction).optional(), empty: dynamicString.optional() }),
];

/** Component types that take what the viewer enters. */
export const INPUT_COMPONENTS = new Set(['TextField', 'CheckBox']);

const ab = { a: dynamicAny, b: dynamicAny };
const items = { items: dynamicAny, by: z.string().optional() };

/** Argument schemas of the pure functions (see functions.ts). */
const ARGS: Record<string, z.ZodRawShape> = {
	equals: ab,
	notEquals: ab,
	greaterThan: ab,
	lessThan: ab,
	add: ab,
	subtract: ab,
	multiply: ab,
	divide: ab,
	if: { condition: dynamicAny, then: dynamicAny, else: dynamicAny },
	contains: { string: dynamicAny, substring: dynamicAny },
	startsWith: { string: dynamicAny, prefix: dynamicAny },
	endsWith: { string: dynamicAny, suffix: dynamicAny },
	lower: { value: dynamicAny },
	upper: { value: dynamicAny },
	replace: { value: dynamicAny, pattern: z.string(), with: dynamicAny },
	count: { value: dynamicAny },
	join: { values: dynamicAny, separator: dynamicAny.optional() },
	filter: { ...items, equals: dynamicAny },
	map: items,
	distinct: items,
	sort: { ...items, descending: dynamicAny.optional() },
	slice: { items: dynamicAny, start: dynamicAny.optional(), end: dynamicAny.optional() },
	daysSince: { value: dynamicAny },
};

const fn = (name: string, shape: z.ZodRawShape, run: (args: Record<string, unknown>, context: DataContext) => unknown, description?: string): FunctionImplementation =>
	createFunctionImplementation({ name, returnType: 'any', schema: z.object(shape).strict(), ...(description ? { description } : {}) }, run as never);

/** The record a function is evaluated for: the row or template item in scope, if any. */
function rowOf(context: DataContext): unknown {
	return context.path === '/' || context.path === '' ? undefined : context.dataModel.get(context.path);
}

/** Functions on top of A2UI's basic ones, for one viewer at one moment. */
export function graftFunctions({ can, now }: CatalogContext): FunctionImplementation[] {
	const pure = pureFunctions(now);
	return [
		...Object.entries(pure).map(([name, run]) => fn(name, ARGS[name] ?? {}, (args) => run(args))),
		fn('can', { scope: z.string(), on: dynamicAny.optional() }, ({ scope, on }, context) => can(String(scope), on ?? rowOf(context)), 'Whether the viewer may use a permission scope; in a row it refines on the row.'),
		// The local action: writes the data model, where the surface is live.
		fn('set', { target: z.string().startsWith('/'), value: dynamicAny }, ({ target, value }, context) => {
			context.set(String(target), value ?? null);
		}),
	];
}

export interface CatalogOptions extends CatalogContext {
	/** The catalog id builds name, e.g. `graft:wordpress`. */
	id: string;
	/** Host components beyond the base ones (they may replace one by name). */
	components?: ComponentApi[];
	/** Base components the host cannot draw. */
	without?: string[];
}

/** The Graft catalog for one host, viewer and moment. */
export function createGraftCatalog({ id, components = [], without = [], ...context }: CatalogOptions): Catalog<ComponentApi> {
	const byName = new Map(BASE_COMPONENTS.filter((c) => !without.includes(c.name)).map((c) => [c.name, c]));
	for (const extra of components) {
		byName.set(extra.name, extra);
	}
	const ours = graftFunctions(context);
	const names = new Set(ours.map((f) => f.name));
	return new Catalog(id, '0.9', [...byName.values()], [...BASIC_FUNCTIONS.filter((f) => !names.has(f.name)), ...ours]);
}
