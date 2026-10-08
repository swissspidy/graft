import type { Surface } from '../surface/types.ts';
import { isCall, isCan, walkTree, walkValue } from './expressions.ts';
import { requireUiFormat } from './format.ts';
import type { Build, Refs } from './types.ts';

/**
 * Computes every surface symbol a build uses. This is what the upgrade
 * static check diffs, so it is always derived from the build's content and
 * never taken from the build's own `refs`.
 */
export function extractRefs(build: Pick<Build, 'mount' | 'tree' | 'data'> & Partial<Build>, surface: Surface): Refs {
	const components = new Map<string, Set<string>>();
	const capabilities = new Set<string>();
	const scopes = new Set<string>();

	const visitValue = (value: unknown) => {
		if (isCall(value)) {
			capabilities.add(value.$call);
		} else if (isCan(value)) {
			scopes.add(value.$can);
		}
	};

	let catalog: Refs['catalog'];
	if (build.tree) {
		walkTree(build.tree, '/tree', (node) => {
			const props = components.get(node.type) ?? new Set<string>();
			components.set(node.type, props);
			for (const [name, value] of Object.entries(node.props ?? {})) {
				props.add(name);
				walkValue(value, '', visitValue);
			}
		});
	} else {
		// Another UI format: it says what its UI calls and checks.
		const used = requireUiFormat(build as Build).refs(build as Build, surface);
		used.capabilities.forEach((name) => capabilities.add(name));
		used.scopes.forEach((name) => scopes.add(name));
		catalog = used.catalog;
	}
	for (const source of Object.values(build.data)) {
		capabilities.add(source.call);
		walkValue(source.input, '', visitValue);
	}
	for (const capability of capabilities) {
		for (const scope of surface.capabilities[capability]?.scopes ?? []) {
			scopes.add(scope);
		}
	}

	return {
		slot: build.mount.slot,
		components: Object.fromEntries(
			[...components.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, props]) => [name, [...props].sort()]),
		),
		capabilities: [...capabilities].sort(),
		scopes: [...scopes].sort(),
		...(catalog ? { catalog } : {}),
	};
}
