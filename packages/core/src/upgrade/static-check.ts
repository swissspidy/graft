import { requireUiFormat } from '../build/format.ts';
import { isSlotRef, walkValue } from '../build/expressions.ts';
import type { Build } from '../build/types.ts';
import { canonicalJson } from '../surface/hash.ts';
import type { Migration, Surface } from '../surface/types.ts';

export type RefKind = 'slot' | 'capability' | 'scope';

export interface RefChange {
	kind: RefKind;
	/** The symbol's name. */
	symbol: string;
	change: 'removed' | 'changed' | 'deprecated';
	/** Only permission metadata changed (a capability's scopes); the UI is unaffected. */
	refsOnly?: boolean;
	/**
	 * The schemas changed compatibly: the capability or slot accepts at
	 * least what it did and still provides everything it did (for example a
	 * new optional field). The build is re-verified as it is.
	 */
	compatible?: boolean;
	/** A migration in the target surface covers this change. */
	migration?: Migration;
}

export type LadderStart = 'reverify' | 'migrate' | 'reanchor' | 'regenerate';

export interface StaticCheck {
	changes: RefChange[];
	/** Where the upgrade ladder starts (ADR 0001, section 7). */
	start: LadderStart;
}

// Structural parts only: titles and descriptions change with translations
// and copy edits without changing what a build can rely on.
const slotContract = (slot: Surface['slots'][string]) => ({ kind: slot.kind, options: slot.options, provides: slot.provides });
const slotCompatible = (before: Surface['slots'][string], after: Surface['slots'][string]) =>
	before.kind === after.kind &&
	compatibleSchema(before.options ?? {}, after.options ?? {}, 'accepts') &&
	compatibleSchema(before.provides ?? {}, after.provides ?? {}, 'provides');
function findMigration(migrations: Migration[], kind: RefKind, symbol: string): Migration | undefined {
	return migrations.find((m) => m.op === 'rename' && m.kind === kind && m.from === symbol);
}

/**
 * Diffs every surface symbol a build uses between the surface it was built
 * for and a new one. Pure and cheap: this decides where the upgrade ladder
 * starts.
 */
export function staticCheck(build: Build, from: Surface, to: Surface): StaticCheck {
	const migrations = to.migrations ?? [];
	const changes: RefChange[] = [];
	const add = (change: RefChange) => {
		const migration = findMigration(migrations, change.kind, change.symbol);
		changes.push(migration ? { ...change, migration } : change);
	};

	// Slot, including the slot props the build reads.
	const slotId = build.mount.slot;
	const oldSlot = from.slots[slotId];
	const newSlot = to.slots[slotId];
	if (!newSlot) {
		add({ kind: 'slot', symbol: slotId, change: 'removed' });
	} else if (newSlot.deprecated) {
		add({ kind: 'slot', symbol: slotId, change: 'deprecated' });
	} else if (!oldSlot || canonicalJson(slotContract(oldSlot)) !== canonicalJson(slotContract(newSlot))) {
		add({ kind: 'slot', symbol: slotId, change: 'changed', ...(oldSlot && slotCompatible(oldSlot, newSlot) ? { compatible: true } : {}) });
	}

	// Capabilities.
	for (const name of build.refs.capabilities) {
		const before = from.capabilities[name];
		const after = to.capabilities[name];
		if (!after) {
			add({ kind: 'capability', symbol: name, change: 'removed' });
		} else if (before && canonicalJson({ ...before, description: null, binding: null }) !== canonicalJson({ ...after, description: null, binding: null })) {
			const sameShape =
				before.kind === after.kind && canonicalJson(before.input) === canonicalJson(after.input) && canonicalJson(before.output) === canonicalJson(after.output);
			const compatible =
				!sameShape && before.kind === after.kind && compatibleSchema(before.input, after.input, 'accepts') && compatibleSchema(before.output, after.output, 'provides');
			add({ kind: 'capability', symbol: name, change: 'changed', ...(sameShape ? { refsOnly: true } : {}), ...(compatible ? { compatible: true } : {}) });
		}
	}

	// Scopes used by permission checks.
	for (const scope of build.refs.scopes) {
		if (!to.scopes[scope]) {
			add({ kind: 'scope', symbol: scope, change: 'removed' });
		}
	}

	return { changes, start: classify(changes) };
}

function classify(changes: RefChange[]): LadderStart {
	const relevant = changes.filter((c) => !c.refsOnly && !c.compatible);
	if (relevant.length === 0) {
		return 'reverify';
	}
	if (relevant.every((c) => c.migration)) {
		return 'migrate';
	}
	if (relevant.every((c) => c.kind === 'slot')) {
		return 'reanchor';
	}
	return 'regenerate';
}

// Keywords that document a schema without constraining it.
const ANNOTATIONS = new Set(['title', 'description', 'default', 'examples', '$comment']);

const typesOf = (schema: unknown): string[] => (typeof schema === 'string' ? [schema] : Array.isArray(schema) ? schema.map(String) : []);
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const subset = (small: unknown[], large: unknown[]) => {
	const keys = new Set(large.map((v) => canonicalJson(v)));
	return small.every((v) => keys.has(canonicalJson(v)));
};

/**
 * Whether a schema change keeps what a build relies on, conservatively.
 * `accepts` (inputs, slot options): the new schema accepts every value the
 * old one did: types and enums may grow, required properties may not, and
 * no property goes away. `provides` (outputs, slot props): every value the
 * new one describes has what the old one promised: every property is still
 * there and still required where it was, and types and enums may only
 * shrink. Anything else (other keywords, combinators) must stay the same.
 */
export function compatibleSchema(before: unknown, after: unknown, mode: 'accepts' | 'provides'): boolean {
	if (canonicalJson(before ?? null) === canonicalJson(after ?? null)) {
		return true;
	}
	if (!isObject(before) || !isObject(after)) {
		return false;
	}
	const grows = (b: unknown[], a: unknown[]) => (mode === 'accepts' ? subset(b, a) : subset(a, b));
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (ANNOTATIONS.has(key)) {
			continue;
		}
		const b = before[key];
		const a = after[key];
		if (key === 'type' || key === 'enum') {
			// No type or enum allows anything: dropping one widens, adding one narrows.
			const list = (value: unknown) => (key === 'type' ? typesOf(value) : (value as unknown[]));
			const widened = a === undefined;
			const narrowed = b === undefined;
			if (widened || narrowed ? (mode === 'accepts') !== widened : !grows(list(b), list(a))) {
				return false;
			}
		} else if (key === 'required') {
			const br = (b as unknown[] | undefined) ?? [];
			const ar = (a as unknown[] | undefined) ?? [];
			if (!(mode === 'accepts' ? subset(ar, br) : subset(br, ar))) {
				return false;
			}
		} else if (key === 'properties') {
			const bp = isObject(b) ? b : {};
			const ap = isObject(a) ? a : {};
			for (const [name, schema] of Object.entries(bp)) {
				if (!Object.hasOwn(ap, name) || !compatibleSchema(schema, ap[name], mode)) {
					return false;
				}
			}
		} else if (key === 'additionalProperties') {
			// Inputs may not start refusing unknown fields; outputs may gain or lose the promise freely.
			if (mode === 'accepts' && b !== false && a === false) {
				return false;
			}
		} else if (key === 'items') {
			if (!compatibleSchema(b ?? {}, a ?? {}, mode)) {
				return false;
			}
		} else if (canonicalJson(b ?? null) !== canonicalJson(a ?? null)) {
			return false;
		}
	}
	return true;
}

/** The slot props a build reads (first path segment of every `$slot`). */
export function slotPropsUsed(build: Build): string[] {
	const used = new Set<string>();
	const visit = (value: unknown) => {
		if (isSlotRef(value)) {
			used.add(value.$slot.split('.')[0] ?? '');
		}
	};
	requireUiFormat(build).slotPropsUsed(build).forEach((prop) => used.add(prop));
	for (const source of Object.values(build.data)) {
		walkValue(source.input, '', visit);
	}
	return [...used].sort();
}
