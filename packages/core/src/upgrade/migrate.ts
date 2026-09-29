import type { Build, TreeNode, Value } from '../build/types.ts';
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

function mapTree(node: TreeNode, fn: (node: TreeNode) => TreeNode): TreeNode {
	const mapped = fn({ ...node });
	if (Array.isArray(mapped.children)) {
		mapped.children = mapped.children.map((child) => mapTree(child, fn));
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
			(migration.kind === 'component' && migration.symbol in build.refs.components) ||
			(migration.kind === 'capability' && build.refs.capabilities.includes(migration.symbol)) ||
			(migration.kind === 'scope' && build.refs.scopes.includes(migration.symbol)) ||
			(migration.kind === 'prop' && Object.entries(build.refs.components).some(([c, props]) => props.some((p) => `${c}.${p}` === migration.symbol)));
		return used ? undefined : build;
	}

	if (migration.op === 'rename-prop') {
		return {
			...build,
			tree: mapTree(build.tree, (node) => {
				if (node.type !== migration.component || !node.props || !(migration.from in node.props)) {
					return node;
				}
				const props = { ...node.props };
				const value = props[migration.from]!;
				delete props[migration.from];
				const key = typeof value === 'string' || typeof value === 'number' ? String(value) : undefined;
				props[migration.to] = key !== undefined && migration.values && key in migration.values ? (migration.values[key] as Value) : value;
				return { ...node, props };
			}),
		};
	}

	const { kind, from, to } = migration;
	switch (kind) {
		case 'slot':
			return build.mount.slot === from ? { ...build, mount: { ...build.mount, slot: to } } : build;
		case 'component':
			return { ...build, tree: mapTree(build.tree, (node) => (node.type === from ? { ...node, type: to } : node)) };
		case 'capability':
		case 'scope': {
			const key = kind === 'capability' ? '$call' : '$can';
			const rename = (value: Value): Value =>
				value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)[key] === from
					? ({ ...value, [key]: to } as Value)
					: value;
			const tree = mapTree(build.tree, (node) => (node.props ? { ...node, props: mapValue(node.props as Value, rename) as Record<string, Value> } : node));
			const data = Object.fromEntries(
				Object.entries(build.data).map(([name, source]) => {
					const call = kind === 'capability' && source.call === from ? to : source.call;
					const input = mapValue(source.input, rename);
					return [name, input === undefined ? { call } : { call, input }];
				}),
			);
			return { ...build, tree, data };
		}
	}
}
