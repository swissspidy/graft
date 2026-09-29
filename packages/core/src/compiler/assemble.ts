import type { Check, DataSource, TreeNode, Value } from '../build/types.ts';

export interface Assembled<T> {
	value?: T;
	problems: string[];
}

function parseJson(text: unknown, what: string, problems: string[]): unknown {
	if (typeof text !== 'string') {
		problems.push(`${what} must be a JSON string.`);
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		problems.push(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Criteria the model flagged as not objectively checkable. */
export function assembleUnverifiable(output: unknown): Array<{ criterion: string; reason: string }> {
	const items = isObject(output) && Array.isArray(output.unverifiable) ? output.unverifiable : [];
	return items
		.filter((item): item is { criterion: string; reason: string } => isObject(item) && typeof item.criterion === 'string')
		.map((item) => ({ criterion: item.criterion, reason: String(item.reason ?? '') }));
}

/** Turns the model's checks output into checks. */
export function assembleChecks(output: unknown): Assembled<Check[]> {
	const problems: string[] = [];
	const items = isObject(output) && Array.isArray(output.checks) ? output.checks : null;
	if (!items) {
		return { problems: ['The output must be an object with a "checks" array.'] };
	}
	const checks: Check[] = [];
	items.forEach((item: Record<string, unknown>, i: number) => {
		const where = `Check ${i + 1} (${String(item.criterion)})`;
		const fixtures = parseJson(item.fixtures_json, `${where} fixtures_json`, problems);
		const steps = parseJson(item.steps_json, `${where} steps_json`, problems);
		const expect = parseJson(item.expect_json, `${where} expect_json`, problems);
		if (fixtures !== undefined && !isObject(fixtures)) {
			problems.push(`${where}: fixtures must be an object.`);
		}
		if (steps !== undefined && !Array.isArray(steps)) {
			problems.push(`${where}: steps must be an array.`);
		}
		if (expect !== undefined && (!Array.isArray(expect) || expect.length === 0 || !expect.every(isObject))) {
			problems.push(`${where}: expect must be a non-empty array of objects.`);
		}
		const check: Check = { criterion: String(item.criterion), expect: (expect ?? []) as Check['expect'] };
		if (isObject(fixtures)) {
			check.fixtures = fixtures;
		}
		if (typeof item.view_as === 'string' && item.view_as) {
			check.view_as = item.view_as;
		}
		if (typeof item.advance_days === 'number' && item.advance_days > 0) {
			check.clock = { advanceDays: item.advance_days };
		}
		if (Array.isArray(steps) && steps.length > 0) {
			check.steps = steps as Check['steps'];
		}
		checks.push(check);
	});
	return problems.length > 0 ? { problems } : { value: checks, problems };
}

interface FlatNode {
	id: string;
	parent: string | null;
	type: string;
	props_json: string;
	text: string | null;
}

/** Turns the model's flat node list and data sources into a tree. */
export function assembleTree(output: unknown): Assembled<{ tree: TreeNode; data: Record<string, DataSource> }> {
	const problems: string[] = [];
	if (!isObject(output) || !Array.isArray(output.nodes) || !Array.isArray(output.data)) {
		return { problems: ['The output must be an object with "nodes" and "data" arrays.'] };
	}
	const flat = output.nodes as FlatNode[];
	const nodes = new Map<string, TreeNode>();
	const children = new Map<string, TreeNode[]>();
	for (const item of flat) {
		if (nodes.has(item.id)) {
			problems.push(`Node id "${item.id}" is used twice.`);
			continue;
		}
		const props = parseJson(item.props_json, `Props of node "${item.id}"`, problems);
		if (props !== undefined && !isObject(props)) {
			problems.push(`Props of node "${item.id}" must be an object.`);
		}
		const node: TreeNode = { type: item.type };
		if (isObject(props) && Object.keys(props).length > 0) {
			node.props = props as Record<string, Value>;
		}
		if (typeof item.text === 'string') {
			node.children = item.text;
		}
		nodes.set(item.id, node);
	}
	const roots = flat.filter((item) => item.parent === null);
	if (roots.length !== 1) {
		problems.push(`There must be exactly one root node (parent null), found ${roots.length}.`);
	}
	for (const item of flat) {
		if (item.parent === null) {
			continue;
		}
		const parent = nodes.get(item.parent);
		if (!parent) {
			problems.push(`Node "${item.id}" names unknown parent "${item.parent}".`);
			continue;
		}
		if (typeof parent.children === 'string') {
			problems.push(`Node "${item.parent}" has text and child nodes; use one or the other.`);
			continue;
		}
		const list = children.get(item.parent) ?? [];
		list.push(nodes.get(item.id)!);
		children.set(item.parent, list);
	}
	for (const [id, list] of children) {
		nodes.get(id)!.children = list;
	}
	// Every node must hang off the root (catches cycles).
	const reachable = new Set<TreeNode>();
	const walk = (node: TreeNode) => {
		if (reachable.has(node)) {
			return;
		}
		reachable.add(node);
		if (Array.isArray(node.children)) {
			node.children.forEach(walk);
		}
	};
	const root = roots[0] ? nodes.get(roots[0].id) : undefined;
	if (root) {
		walk(root);
		const orphans = flat.filter((item) => nodes.has(item.id) && !reachable.has(nodes.get(item.id)!)).map((item) => item.id);
		if (orphans.length > 0) {
			problems.push(`Nodes not connected to the root: ${orphans.join(', ')}.`);
		}
	}

	const data: Record<string, DataSource> = {};
	for (const item of output.data as Array<{ name: string; call: string; input_json: string }>) {
		if (!/^[a-z][a-zA-Z0-9_-]*$/.test(item.name)) {
			problems.push(`Data source name "${item.name}" must start with a lowercase letter and use letters, digits, _ or -.`);
		} else if (data[item.name]) {
			problems.push(`Data source "${item.name}" is declared twice.`);
		}
		const input = parseJson(item.input_json, `Input of data source "${item.name}"`, problems);
		data[item.name] = input === null || input === undefined ? { call: item.call } : { call: item.call, input: input as Value };
	}

	if (problems.length > 0 || !root) {
		return { problems };
	}
	return { value: { tree: root, data }, problems };
}
