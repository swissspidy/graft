import { readFile } from 'node:fs/promises';
import { validateSpec, type Build } from '@graft/core';
import '../host/a2ui.ts';
import { loadSurface, ROOT } from './examples.ts';
import { startSandbox, verifyInEmDash } from './sandbox.ts';
import { asUser, contentApi, login, pluginRoute, startEmDash } from './server.ts';

/**
 * The EmDash examples built as A2UI surfaces (examples/emdash/a2ui/builds),
 * against a real EmDash: verified, installed, approved, and served through
 * the plugin's Block Kit routes like trees. The publish queue publishes
 * through the gateway; the status board switches lists with a local `set`,
 * its state riding in the buttons' values. Exit code 1 if any check fails.
 *
 *   tsx a2ui-smoke.ts
 */

type Block = Record<string, unknown> & { type: string };

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: ok ? undefined : detail });

const flatten = (blocks: Block[] = []): Block[] => blocks.flatMap((block) => [block, ...(block.type === 'tab' ? (block.panels as Array<{ blocks: Block[] }>).flatMap((p) => flatten(p.blocks)) : [])]);
/** One customization's blocks: its tab when the page has several. */
const panel = (blocks: Block[] | undefined, label: string) =>
	(flatten(blocks).find((b) => b.type === 'tab')?.panels as Array<{ label: string; blocks: Block[] }> | undefined)?.find((p) => p.label === label)?.blocks ?? blocks;
/** A table's rows as { title, buttons }, its first column the title. */
function rows(blocks?: Block[]) {
	const table = flatten(blocks).find((b) => b.type === 'table') as (Block & { rows: Array<Record<string, unknown>>; columns: Array<{ key: string }> }) | undefined;
	return table?.rows.map((row) => ({
		title: row[table.columns[0]!.key],
		buttons: Object.values(row).filter((v): v is Block => typeof v === 'object' && v !== null && (v as Block).type === 'button'),
	}));
}
/** Buttons outside tables. */
const buttons = (blocks?: Block[]) => flatten(blocks).flatMap((b) => (b.type === 'actions' ? (b.elements as Block[]) : []));

async function main(): Promise<number> {
	const surface = await loadSurface();
	const examples = await Promise.all(
		['publish-queue', 'status-board'].map(async (name) => {
			const source = await readFile(`${ROOT}examples/emdash/specs/${name}.md`, 'utf8');
			const build = JSON.parse(await readFile(`${ROOT}examples/emdash/a2ui/builds/${name}.json`, 'utf8')) as Build;
			return { name, source, build, spec: validateSpec(source, { surface }).spec!, surface };
		}),
	);
	const [sandbox, server] = await Promise.all([startSandbox(), startEmDash({ format: 'native', testLogin: true })]);
	const content = contentApi(server);
	try {
		const verifications = await verifyInEmDash(examples, { sandbox });
		verifications.forEach((v, i) => check(`${examples[i]!.name} (A2UI) passes its checks`, v.passed, v.results.filter((r) => !r.passed)));
		check('the builds have no tree', examples.every((e) => e.build.tree === undefined && e.build.ui !== undefined));

		for (const [i, { name, source, build }] of examples.entries()) {
			const installed = await pluginRoute<{ state: string }>(server, 'install', { source, build, verification: verifications[i] });
			check(`${name}: an A2UI build installs and waits for approval`, installed.state === 'needs_approval', installed);
		}
		const admin = (body: unknown) => asUser<{ blocks: Block[]; toast?: { message: string; type: string } }>(server, server.cookie, '/_emdash/api/plugins/graft/admin', body);
		for (const { name } of examples) {
			const approved = await admin({ type: 'block_action', page: '/customizations', action_id: 'graft:approve', value: name });
			check(`${name}: approved`, approved.data?.toast?.type === 'success', approved);
		}

		const editor = await login(server, 'editor', 40);
		const contributor = await login(server, 'contributor', 20);
		const page = (cookie: string, body: unknown) => asUser<{ blocks: Block[]; toast?: { message: string; type: string } }>(server, cookie, '/_emdash/api/plugins/graft/admin', body);
		await content.seed([
			{ title: 'Draft A', status: 'draft' },
			{ title: 'Post B', status: 'published' },
		]);

		// The publish queue: rows, Publish for editors only, and the gateway behind it.
		const loaded = await page(editor.cookie, { type: 'page_load', page: '/customizations' });
		const queue = panel(loaded.data?.blocks, 'Publish queue');
		const draftA = rows(queue)?.find((r) => r.title === 'Draft A');
		check('the publish queue lists the draft', rows(queue)?.map((r) => r.title).join() === 'Draft A', queue);
		const publish = draftA?.buttons.find((b) => /publish/i.test(String(b.label)));
		check('editors get Publish', publish !== undefined, draftA);
		const contributorQueue = panel((await page(contributor.cookie, { type: 'page_load', page: '/customizations' })).data?.blocks, 'Publish queue');
		check('contributors see the draft without Publish', rows(contributorQueue)?.[0]?.buttons.length === 0, contributorQueue);
		const replayed = await page(contributor.cookie, { type: 'block_action', page: '/customizations', action_id: publish?.action_id, value: publish?.value });
		check("a contributor replaying the editor's Publish is refused", replayed.data?.toast?.type === 'error' && (await content.find('Draft A'))?.status === 'draft', replayed);
		const published = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: publish?.action_id, value: publish?.value });
		check('Publish publishes through the gateway', published.data?.toast?.type === 'success' && (await content.find('Draft A'))?.status === 'published', published);
		check('and the post leaves the queue', !rows(panel(published.data?.blocks, 'Publish queue'))?.some((r) => r.title === 'Draft A'), published);

		// The status board: a local `set` switches lists; its state rides in the buttons.
		await content.seed([{ title: 'Draft C', status: 'draft' }]);
		const board = panel((await page(editor.cookie, { type: 'page_load', page: '/customizations' })).data?.blocks, 'Status board');
		check('the status board shows the drafts first', rows(board)?.map((r) => r.title).join() === 'Draft C', board);
		const toPublished = buttons(board).find((b) => /published/i.test(String(b.label)));
		check('it has a button for the published posts', toPublished !== undefined, buttons(board));
		const switched = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: toPublished?.action_id, value: toPublished?.value });
		const publishedView = panel(switched.data?.blocks, 'Status board');
		check('a local action switches to the published posts, with no call', !switched.data?.toast && rows(publishedView)?.map((r) => String(r.title)).sort().join() === 'Draft A,Post B', switched);
		const unpublish = rows(publishedView)?.find((r) => r.title === 'Post B')?.buttons.find((b) => /unpublish|offline/i.test(String(b.label)));
		check('published rows offer Unpublish', unpublish !== undefined, rows(publishedView));
		const offline = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: unpublish?.action_id, value: unpublish?.value });
		check('Unpublish takes the post offline', offline.data?.toast?.type === 'success' && (await content.find('Post B'))?.status === 'draft', offline);
		check('and the board keeps showing the published posts', rows(panel(offline.data?.blocks, 'Status board'))?.map((r) => r.title).join() === 'Draft A', offline);
		const toDrafts = buttons(panel(offline.data?.blocks, 'Status board')).find((b) => /draft/i.test(String(b.label)));
		const back = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: toDrafts?.action_id, value: toDrafts?.value });
		check('Drafts switches back', rows(panel(back.data?.blocks, 'Status board'))?.map((r) => String(r.title)).sort().join() === 'Draft C,Post B', back);
		const contributorBoard = panel((await page(contributor.cookie, { type: 'page_load', page: '/customizations' })).data?.blocks, 'Status board');
		check('contributors see the board without row buttons', (rows(contributorBoard)?.length ?? 0) > 0 && rows(contributorBoard)!.every((r) => r.buttons.length === 0), contributorBoard);
	} finally {
		await Promise.all([sandbox.close(), server.close()]);
	}

	for (const c of checks) {
		console.log(`  ${c.ok ? '✔' : '✖'} ${c.name}`);
		if (!c.ok) {
			console.log(`      ${String(JSON.stringify(c.detail)).slice(0, 2000)}`);
		}
	}
	const failed = checks.filter((c) => !c.ok).length;
	console.log(failed ? `\n${failed} check(s) failed` : `\nAll ${checks.length} checks passed`);
	return failed ? 1 : 0;
}

main().then(
	(code) => process.exit(code),
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
