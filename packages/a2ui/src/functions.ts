/**
 * The Graft catalog's functions as plain JavaScript, without A2UI's
 * function machinery: what a renderer bundles (a2ui-wp takes these as they
 * are) and what the catalog wraps with argument schemas for the verifier.
 * `can` and `set` need the live surface and are bound by whoever draws it.
 */

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
const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const DAY = 86_400_000;

export type PureFunction = (args: Record<string, unknown>) => unknown;

/** Every function of the catalog that only computes, for one moment (`daysSince` counts to `now`). */
export function pureFunctions(now: Date): Record<string, PureFunction> {
	return {
		// Comparisons and arithmetic.
		equals: ({ a, b }) => same(a, b),
		notEquals: ({ a, b }) => !same(a, b),
		greaterThan: ({ a, b }) => number(a) > number(b),
		lessThan: ({ a, b }) => number(a) < number(b),
		add: ({ a, b }) => number(a) + number(b),
		subtract: ({ a, b }) => number(a) - number(b),
		multiply: ({ a, b }) => number(a) * number(b),
		divide: ({ a, b }) => (number(b) === 0 ? null : number(a) / number(b)),
		if: (args) => (args.condition ? args.then : args.else),
		// Strings.
		contains: ({ string, substring }) => text(string).includes(text(substring)),
		startsWith: ({ string, prefix }) => text(string).startsWith(text(prefix)),
		endsWith: ({ string, suffix }) => text(string).endsWith(text(suffix)),
		lower: ({ value }) => text(value).toLowerCase(),
		upper: ({ value }) => text(value).toUpperCase(),
		replace: ({ value, pattern, with: replacement }) => text(value).replace(new RegExp(String(pattern), 'g'), text(replacement)),
		count: ({ value }) => (typeof value === 'string' || Array.isArray(value) ? value.length : 0),
		join: ({ values, separator }) => list(values).map(text).filter(Boolean).join(separator === undefined ? ', ' : text(separator)),
		// Lists; "by" is a JSON Pointer into each item ("" for the item itself).
		filter: ({ items, by, equals }) => list(items).filter((item) => same(readPointer(item, String(by ?? '')), equals)),
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
		slice: ({ items, start, end }) => list(items).slice(number(start ?? 0), end === undefined || end === null ? undefined : number(end)),
		daysSince: ({ value }) => {
			const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
			return Number.isNaN(time) ? null : Math.floor((now.getTime() - time) / DAY);
		},
	};
}
