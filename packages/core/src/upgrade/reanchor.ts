import type { Build } from '../build/types.ts';
import '../ajv.ts';
import { compileSchema } from '../schema.ts';
import type { Slot, Surface } from '../surface/types.ts';
import { slotPropsUsed } from './static-check.ts';


/** Slots in `to` that could host this build instead of its current one. */
export function reanchorCandidates(build: Build, from: Surface, to: Surface): string[] {
	const current = build.mount.slot;
	const before = from.slots[current];
	const successor = to.slots[current]?.successor;
	if (successor && to.slots[successor]) {
		return [successor];
	}
	const needed = slotPropsUsed(build);
	const { slot: _slot, ...options } = build.mount;
	return Object.entries(to.slots)
		.filter(([id, slot]) => id !== current && !slot.deprecated && fits(slot, before, build, needed, options))
		.map(([id]) => id)
		.sort();
}

function fits(slot: Slot, before: Slot | undefined, build: Build, needed: string[], options: Record<string, unknown>): boolean {
	if (before && slot.kind !== before.kind) {
		return false;
	}
	// Only a tree's root is a host component; other formats draw from their catalog.
	if (build.tree && slot.accepts && !slot.accepts.includes(build.tree.type)) {
		return false;
	}
	const provides = typeof slot.provides === 'object' ? ((slot.provides.properties as Record<string, unknown> | undefined) ?? {}) : {};
	if (!needed.every((prop) => prop in provides)) {
		return false;
	}
	return slot.options === undefined || compileSchema(slot.options)(options) === true;
}

/**
 * Moves a build to another slot: the slot's declared successor, or the one
 * compatible slot in the new surface. With several candidates, `choose`
 * (for example a model) picks one; without it the rung does not apply.
 */
export async function reanchor(
	build: Build,
	from: Surface,
	to: Surface,
	choose?: (candidates: string[]) => Promise<string | undefined>,
): Promise<Build | undefined> {
	const candidates = reanchorCandidates(build, from, to);
	let target: string | undefined;
	if (candidates.length === 1) {
		target = candidates[0];
	} else if (candidates.length > 1 && choose) {
		const chosen = await choose(candidates);
		target = chosen && candidates.includes(chosen) ? chosen : undefined;
	}
	return target ? { ...structuredClone(build), mount: { ...build.mount, slot: target } } : undefined;
}
