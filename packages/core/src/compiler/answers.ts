import { isTreeBuild, requireUiFormat } from '../build/format.ts';
import type { Build, Check, TreeNode } from '../build/types.ts';

/**
 * A build expressed as the compiler's model output (checks, and the UI as
 * flat nodes or in the build's format), for scripted models in tests.
 * `dataInput` replaces data source inputs by name.
 */
export function modelAnswers(build: Build, dataInput?: Record<string, unknown>) {
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
		tree: isTreeBuild(build) ? treeAnswer(build, dataInput) : formatAnswer(build, dataInput),
	};
}

function treeAnswer(build: Build & { tree: TreeNode }, dataInput?: Record<string, unknown>) {
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
		nodes,
		data: Object.entries(build.data).map(([name, source]) => ({
			name,
			call: source.call,
			input_json: JSON.stringify(dataInput?.[name] ?? source.input ?? null),
		})),
		code: build.code ? { source: build.code.source, functions: build.code.functions } : null,
	};
}

function formatAnswer(build: Build, dataInput?: Record<string, unknown>): unknown {
	const format = requireUiFormat(build);
	if (!format.compiler?.answer) {
		throw new Error(`The ${format.name} format cannot express a build as model output.`);
	}
	return format.compiler.answer(build, dataInput);
}
