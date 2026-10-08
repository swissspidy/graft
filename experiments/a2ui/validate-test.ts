import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type { Surface } from '../../packages/core/src/index.ts';
import { validateA2UI } from './compiler.ts';
import type { A2UIBuild } from './snapshot.ts';

/**
 * The compiler's static checks on compiled builds: the accepted ones pass,
 * and each broken variant is caught with a message the model can act on.
 *
 *   npx tsx experiments/a2ui/validate-test.ts
 */

const root = new URL('../../', import.meta.url);
const read = async (path: string) => JSON.parse(await readFile(new URL(path, root), 'utf8')) as unknown;
const surface = (await read('hosts/wordpress/plugin/surfaces/7.1.json')) as Surface;

for (const spec of ['review-queue', 'publish-checklist', 'pending-by-author', 'headline-check', 'quick-approve', 'stale-drafts', 'waiting-posts']) {
	assert.deepEqual(validateA2UI((await read(`experiments/a2ui/compiled/${spec}.a2ui.json`)) as A2UIBuild, surface), [], spec);
}

const queue = (await read('experiments/a2ui/compiled/review-queue.a2ui.json')) as A2UIBuild;
const broken = (change: (build: A2UIBuild) => void) => {
	const build = structuredClone(queue);
	change(build);
	return validateA2UI(build, surface);
};
const expectProblem = (problems: string[], pattern: RegExp) => assert.ok(problems.some((p) => pattern.test(p)), `${pattern} not in:\n${problems.join('\n')}`);
const table = (build: A2UIBuild) => build.ui.components.find((c) => c.component === 'Table') as unknown as { fields: Array<{ id: string }>; rowActions: Array<{ visible: unknown }> };

// Event inputs against the capability's input schema; {"$context": ...} stands for anything.
expectProblem(broken((b) => (b.events.approve!.input = { id: { $context: 'id' }, status: 'published' })), /Event "approve" \(posts.update_status\).*status/);
expectProblem(broken((b) => (b.events.approve!.input = { id: { $context: 'id' } })), /Event "approve".*status/);
expectProblem(broken((b) => (b.events.approve!.input = { id: { $context: 'id' }, status: 'publish', sticky: true })), /Event "approve".*sticky/);
assert.deepEqual(broken((b) => (b.events.approve!.input = { id: { $context: 'id' }, status: { $context: 'status' } })), []);
// Data source inputs too.
expectProblem(broken((b) => (b.data.queue!.input = { status: ['waiting'] })), /Data source "queue" \(posts.list\)/);
// Dotted pointers, in bindings and in table field ids.
expectProblem(broken((b) => (table(b).rowActions[0]!.visible = { path: 'can.publish' })), /JSON Pointers separate keys with "\/", e.g. "can\/publish"/);
expectProblem(broken((b) => (table(b).fields[1]!.id = 'author.name')), /should be a JSON Pointer into the row, e.g. "author\/name"/);
// Local actions only set, at an absolute pointer.
expectProblem(
	broken((b) => b.ui.components.push({ id: 'reset', component: 'Button', action: { functionCall: { call: 'openUrl', args: { url: 'https://example.com' } } } })),
	/local action must be/,
);
// Keys sharing the top of the data model.
expectProblem(broken((b) => (b.ui.computed = { queue: [] })), /"queue" is used twice/);

console.log('✔ static validation');
