import { requireUiFormat } from '../build/format.ts';
import type { Build, Value } from '../build/types.ts';
import type { Migration } from '../surface/types.ts';

function mapValue(value: Value | undefined, fn: (value: Value) => Value): Value | undefined {
	if (value === undefined) {
		return undefined;
	}
	const mapped = fn(value);
	if (Array.isArray(mapped)) {
		return mapped.map((item) => mapValue(item, fn)!);
	}
	if (mapped !== null && typeof mapped === 'object') {
		return Object.fromEntries(Object.entries(mapped).map(([key, item]) => [key, mapValue(item as Value, fn)!])) as Value;
	}
	return mapped;
}

/**
 * Applies a surface's declared migrations to a build: deterministic, no
 * model. Returns undefined when a migration cannot be applied (a removal:
 * there is nothing to rename to).
 */
export function applyMigrations(build: Build, migrations: Migration[]): Build | undefined {
	let result: Build = structuredClone(build);
	for (const migration of migrations) {
		const next = applyOne(result, migration);
		if (!next) {
			return undefined;
		}
		result = next;
	}
	return result;
}

function applyOne(build: Build, migration: Migration): Build | undefined {
	if (migration.op === 'remove') {
		const used =
			(migration.kind === 'slot' && build.mount.slot === migration.symbol) ||
			(migration.kind === 'capability' && (build.refs.capabilities.includes(migration.symbol) || build.refs.triggers?.capabilities.includes(migration.symbol) === true)) ||
			(migration.kind === 'scope' && (build.refs.scopes.includes(migration.symbol) || build.refs.triggers?.scopes.includes(migration.symbol) === true)) ||
			(migration.kind === 'event' && build.refs.triggers?.events.includes(migration.symbol) === true);
		return used ? undefined : build;
	}

	// Core moves the mount, data sources and triggers, the UI format its UI.
	let base = build.triggers ? { ...build, triggers: renameInTriggers(build.triggers, migration) } : build;
	if (migration.kind === 'event') {
		return base;
	}
	if (migration.kind === 'slot' && build.mount.slot === migration.from) {
		base = { ...base, mount: { ...build.mount, slot: migration.to } };
	} else if (migration.kind === 'capability' || migration.kind === 'scope') {
		base = { ...base, data: renameInData(build.data, migration.kind, migration.from, migration.to) };
	}
	return requireUiFormat(build).migrate(base, migration);
}

/** Renames a capability or event in triggers: what they read and call, and what they run on. */
function renameInTriggers(triggers: NonNullable<Build['triggers']>, migration: Extract<Migration, { op: 'rename' }>): NonNullable<Build['triggers']> {
	const { kind, from, to } = migration;
	return Object.fromEntries(
		Object.entries(triggers).map(([id, trigger]) => {
			const next = { ...trigger };
			if (kind === 'capability') {
				if (next.call === from) {
					next.call = to;
				}
				if (next.targets?.call === from) {
					next.targets = { ...next.targets, call: to };
				}
			}
			if (kind === 'event' && next.event === from) {
				next.event = to;
			}
			return [id, next];
		}),
	);
}

/** Renames a scope's `$can`s in a value. */
function renamer(from: string, to: string): (value: Value) => Value {
	return (value) =>
		value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).$can === from ? ({ ...value, $can: to } as Value) : value;
}

/** Renames a capability or scope in data sources: what they call, and expressions in their inputs. */
function renameInData(data: Build['data'], kind: 'capability' | 'scope', from: string, to: string): Build['data'] {
	const rename = renamer(from, to);
	return Object.fromEntries(
		Object.entries(data).map(([name, source]) => {
			const call = kind === 'capability' && source.call === from ? to : source.call;
			const input = kind === 'scope' ? mapValue(source.input, rename) : source.input;
			return [name, input === undefined ? { call } : { call, input }];
		}),
	);
}
