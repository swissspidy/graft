import type { Build, Check, TreeNode } from '../build/types.ts';

/**
 * A build expressed as the compiler's model output (flat nodes, JSON
 * strings), for scripted models in tests.
 */
export function modelAnswers(build: Build, dataInput?: Record<string, unknown>) {
	const nodes: Array<{ id: string; parent: string | null; type: string; props_json: string; text: string | null }> = [];
	const visit = (node: TreeNode, parent: string | null) => {
		const id = `n${nodes.length}`;
		nodes.push({ id, parent, type: node.type, props_json: JSON.stringify(node.props ?? {}), text: typeof node.children === 'string' ? node.children : null });
		if (Array.isArray(node.children)) {
			node.children.forEach((child) => visit(child, id));
		}
	};
	visit(build.tree, null);
	return {
		checks: {
			unverifiable: [],
			checks: build.checks.map((c: Check) => ({
				criterion: c.criterion,
				fixtures_json: JSON.stringify(c.fixtures ?? {}),
				view_as: c.view_as ?? '',
				advance_days: c.clock?.advanceDays ?? 0,
				steps_json: JSON.stringify(c.steps ?? []),
				expect_json: JSON.stringify(c.expect),
			})),
		},
		tree: {
			nodes,
			data: Object.entries(build.data).map(([name, source]) => ({
				name,
				call: source.call,
				input_json: JSON.stringify(dataInput?.[name] ?? source.input ?? null),
			})),
		},
	};
}
