import type { SpecLocation } from '../diagnostics.ts';
import type { Spec } from './types.ts';

/**
 * Where a frontmatter key is in the spec: its pointer, and its line when
 * the spec was parsed from a file. A key the spec does not have points at
 * the nearest key above it that it does have (`/permissions/3` at
 * `/permissions`), which is where it would be added.
 */
export function specKey(spec: Spec, pointer: string): SpecLocation {
	const location: SpecLocation = { path: pointer };
	for (let at = pointer; at !== ''; at = at.slice(0, at.lastIndexOf('/'))) {
		const line = spec.lines?.[at];
		if (line !== undefined) {
			location.line = line;
			break;
		}
	}
	return location;
}

/** Where an acceptance criterion is in the spec, or nothing for an id the spec does not have. */
export function specCriterion(spec: Spec, id: string): SpecLocation | undefined {
	const criterion = spec.criteria.find((c) => c.id === id);
	return criterion ? { line: criterion.line } : undefined;
}
