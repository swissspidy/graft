import { requireUiFormat } from '../build/format.ts';
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

	if (!build.tree) {
		// Another UI format: core moves the mount and data sources, the format its UI.
		let base = build;
		if (migration.op === 'rename' && migration.kind === 'slot' && build.mount.slot === migration.from) {
			base = { ...build, mount: { ...build.mount, slot: migration.to } };
		} else if (migration.op === 'rename' && (migration.kind === 'capability' || migration.kind === 'scope')) {
			base = { ...build, data: renameInData(build.data, migration.kind, migration.from, migration.to) };
		}
		return requireUiFormat(build).migrate(base, migration);
	}
	const tree = build.tree;

	if (migration.op === 'rename-prop') {
		return {
			...build,
			tree: mapTree(tree, (node) => {
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
			return { ...build, tree: mapTree(tree, (node) => (node.type === from ? { ...node, type: to } : node)) };
		case 'capability':
		case 'scope': {
			const rename = renamer(kind, from, to);
			return {
				...build,
				tree: mapTree(tree, (node) => (node.props ? { ...node, props: mapValue(node.props as Value, rename) as Record<string, Value> } : node)),
				data: renameInData(build.data, kind, from, to),
			};
		}
	}
}

/** Renames a capability's `$call`s or a scope's `$can`s in a value. */
function renamer(kind: 'capability' | 'scope', from: string, to: string): (value: Value) => Value {
	const key = kind === 'capability' ? '$call' : '$can';
	return (value) =>
		value !== null && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>)[key] === from ? ({ ...value, [key]: to } as Value) : value;
}

/** Renames a capability or scope in data sources: what they call, and expressions in their inputs. */
function renameInData(data: Build['data'], kind: 'capability' | 'scope', from: string, to: string): Build['data'] {
	const rename = renamer(kind, from, to);
	return Object.fromEntries(
		Object.entries(data).map(([name, source]) => {
			const call = kind === 'capability' && source.call === from ? to : source.call;
			const input = mapValue(source.input, rename);
			return [name, input === undefined ? { call } : { call, input }];
		}),
	);
}
