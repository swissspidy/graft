import type { Surface } from '../surface/types.ts';
import { isCan, walkValue } from './expressions.ts';
import { requireUiFormat } from './format.ts';
import type { Build, Refs } from './types.ts';

/**
 * Computes every surface symbol a build uses. This is what the upgrade
 * static check diffs, so it is always derived from the build's content and
 * never taken from the build's own `refs`.
 */
export function extractRefs(build: Build, surface: Surface): Refs {
	// The UI's format says what it calls, checks and draws.
	const used = requireUiFormat(build).refs(build, surface);
	const capabilities = new Set<string>(used.capabilities);
	const scopes = new Set<string>(used.scopes);
	for (const source of Object.values(build.data)) {
		capabilities.add(source.call);
		walkValue(source.input, '', (value) => {
			if (isCan(value)) {
				scopes.add(value.$can);
			}
		});
	}
	for (const capability of capabilities) {
		for (const scope of surface.capabilities[capability]?.scopes ?? []) {
			scopes.add(scope);
		}
	}

	return {
		slot: build.mount.slot,
		capabilities: [...capabilities].sort(),
		scopes: [...scopes].sort(),
		catalog: used.catalog,
	};
}
