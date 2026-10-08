import type { Migration, Surface } from '../../packages/core/src/index.ts';
import type { A2UIBuild } from './snapshot.ts';

/**
 * The migrate rung for an A2UI build: a host surface's declared renames,
 * deterministic and without a model, as `applyMigrations` does for trees.
 *
 * What a host migration can touch moves: capabilities are in `data` and
 * `events`, scopes in `can` calls, the slot in `mount`. Component and prop
 * migrations name the host's Graft components, which an A2UI build does
 * not use: its components belong to the catalog, which is versioned on its
 * own (a new catalog id), not by host releases. Those migrations do not
 * apply, and a removal of something the build uses fails the rung.
 */
export function migrateA2UI(build: A2UIBuild, migrations: Migration[]): A2UIBuild | undefined {
	let result = structuredClone(build);
	for (const migration of migrations) {
		const next = applyOne(result, migration);
		if (!next) {
			return undefined;
		}
		result = next;
	}
	return result;
}

/** Every `can` call's scope, wherever it is in the surface. */
function mapCan(value: unknown, rename: (scope: string) => string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => mapCan(item, rename));
	}
	if (value && typeof value === 'object') {
		const object = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapCan(inner, rename)])) as Record<string, unknown>;
		const args = object.args as Record<string, unknown> | undefined;
		if (object.call === 'can' && args && typeof args.scope === 'string') {
			object.args = { ...args, scope: rename(args.scope) };
		}
		return object;
	}
	return value;
}

function applyOne(build: A2UIBuild, migration: Migration): A2UIBuild | undefined {
	if (migration.op === 'remove') {
		const used =
			(migration.kind === 'slot' && build.mount.slot === migration.symbol) ||
			(migration.kind === 'capability' && build.refs.capabilities.includes(migration.symbol)) ||
			(migration.kind === 'scope' && build.refs.scopes.includes(migration.symbol));
		return used ? undefined : build;
	}
	if (migration.op === 'rename-prop') {
		return build;
	}
	const { kind, from, to } = migration;
	switch (kind) {
		case 'slot':
			return build.mount.slot === from ? { ...build, mount: { ...build.mount, slot: to } } : build;
		case 'component':
			return build;
		case 'capability': {
			const call = (name: string) => (name === from ? to : name);
			return {
				...build,
				data: Object.fromEntries(Object.entries(build.data).map(([name, source]) => [name, { ...source, call: call(source.call) }])),
				events: Object.fromEntries(Object.entries(build.events).map(([name, binding]) => [name, { ...binding, call: call(binding.call) }])),
			};
		}
		case 'scope': {
			const rename = (scope: string) => (scope === from ? to : scope);
			return {
				...build,
				ui: { ...build.ui, components: mapCan(build.ui.components, rename) as A2UIBuild['ui']['components'], ...(build.ui.initial ? { initial: mapCan(build.ui.initial, rename) as Record<string, unknown> } : {}), ...(build.ui.computed ? { computed: mapCan(build.ui.computed, rename) as Record<string, unknown> } : {}) },
			};
		}
	}
}

/** The slot props an A2UI build reads: the first key of every /slot/... pointer. */
export function slotPropsUsedA2UI(build: A2UIBuild): string[] {
	const used = new Set<string>();
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(walk);
		} else if (value && typeof value === 'object') {
			const object = value as Record<string, unknown>;
			if (typeof object.path === 'string' && object.path.startsWith('/slot/')) {
				used.add(object.path.split('/')[2]!);
			}
			if (typeof object.$slot === 'string') {
				used.add(object.$slot.split('.')[0]!);
			}
			Object.values(object).forEach(walk);
		}
	};
	walk([build.ui, build.data, build.events]);
	return [...used].sort();
}

/**
 * The re-anchor rung for an A2UI build, as core's `reanchor` does for trees:
 * the slot's declared successor, or the one other slot of the same kind
 * that provides every slot prop the surface reads. A slot's `accepts`
 * (Graft component types for the root) does not apply to A2UI surfaces.
 */
export function reanchorA2UI(build: A2UIBuild, from: Surface, to: Surface): A2UIBuild | undefined {
	const current = build.mount.slot;
	const successor = to.slots[current]?.successor;
	let target: string | undefined = successor && to.slots[successor] ? successor : undefined;
	if (!target) {
		const kind = from.slots[current]?.kind;
		const needed = slotPropsUsedA2UI(build);
		const candidates = Object.entries(to.slots).filter(([id, slot]) => {
			const provides = (typeof slot.provides === 'object' ? (slot.provides.properties as Record<string, unknown> | undefined) : undefined) ?? {};
			return id !== current && !slot.deprecated && slot.kind === kind && needed.every((prop) => prop in provides);
		});
		target = candidates.length === 1 ? candidates[0]![0] : undefined;
	}
	return target ? { ...structuredClone(build), mount: { ...build.mount, slot: target } } : undefined;
}
