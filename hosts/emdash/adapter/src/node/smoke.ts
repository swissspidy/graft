import type { Verification } from '@graft/core';
import { loadExamples } from './examples.ts';
import { startSandbox, verifyInEmDash } from './sandbox.ts';
import { asUser, contentApi, login, pluginRoute, startEmDash } from './server.ts';

/**
 * Plugin smoke test against a real EmDash: verifies the examples (in a
 * separate, throwaway EmDash), installs them on a site, approves them, and
 * serves them to real editor and contributor sessions through the Block Kit
 * routes, including refused and forged interactions. Exit code 1 if any
 * check fails.
 *
 *   tsx smoke.ts [--format native|sandboxed]
 *
 * With --format sandboxed the site runs Graft in EmDash's plugin sandbox
 * (build it first: pnpm build:emdash).
 */

const format = process.argv.includes('--format') ? (process.argv[process.argv.indexOf('--format') + 1] as 'native' | 'sandboxed') : 'native';

type Block = Record<string, unknown> & { type: string };

const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: ok ? undefined : detail });

/** Every block, descending into tabs. */
function flatten(blocks: Block[] = []): Block[] {
	return blocks.flatMap((block) => [block, ...(block.type === 'tab' ? (block.panels as Array<{ blocks: Block[] }>).flatMap((p) => flatten(p.blocks)) : [])]);
}

const tables = (blocks?: Block[]) => flatten(blocks).filter((b) => b.type === 'table') as Array<Block & { rows: Array<Record<string, unknown>>; columns: Array<{ key: string; label: string }> }>;
const texts = (blocks?: Block[]) => JSON.stringify(blocks ?? []);

/** A table's rows as { title, buttons }, using its first column as the title. */
function rows(blocks?: Block[]) {
	const table = tables(blocks).find((t) => t.page_action_id !== undefined && !String(t.page_action_id).startsWith('graft:checks'));
	if (!table) {
		return undefined;
	}
	const first = table.columns[0]!.key;
	return table.rows.map((row) => ({
		title: row[first],
		buttons: Object.values(row).filter((v): v is Block => typeof v === 'object' && v !== null && (v as Block).type === 'button'),
	}));
}

async function main(): Promise<number> {
	const examples = await loadExamples();
	const [sandbox, server] = await Promise.all([startSandbox(), startEmDash({ format, testLogin: true })]);
	const content = contentApi(server);
	try {
		const verifications = await verifyInEmDash(examples, { sandbox });
		verifications.forEach((v, i) => check(`${examples[i]!.name} passes its checks`, v.passed, v.results.filter((r) => !r.passed)));
		const verification = (name: string) => verifications[examples.findIndex((e) => e.name === name)]!;
		const example = (name: string) => examples.find((e) => e.name === name)!;

		const surface = await pluginRoute<{ hash: string }>(server, 'surface');
		check('the plugin serves the committed surface', surface.hash === examples[0]!.surface.hash, surface.hash);

		// Install: verified builds wait for approval (nothing is granted yet).
		for (const name of ['publish-queue', 'drafts-glance', 'go-live']) {
			const { source, build } = example(name);
			const installed = await pluginRoute<{ state: string; scopes: string[] }>(server, 'install', { source, build, verification: verification(name) });
			check(`${name}: a verified build waits for approval`, installed.state === 'needs_approval', installed);
		}

		// Refusals at install.
		const stale: Verification = { ...verification('publish-queue'), surface: { ...verification('publish-queue').surface, hash: 'sha256:0' } };
		const unverified = await pluginRoute<{ state: string }>(server, 'install', { source: example('publish-queue').source, build: example('publish-queue').build, verification: stale });
		check('a verification for another surface leaves the version a draft', unverified.state === 'draft', unverified);
		const failing = { ...verification('publish-queue'), passed: false };
		const failed = await pluginRoute<{ state: string }>(server, 'install', { source: example('publish-queue').source, build: example('publish-queue').build, verification: failing });
		check('a failed verification leaves the version a draft', failed.state === 'draft', failed);
		const wrongScopes = structuredClone(example('drafts-glance').build);
		(wrongScopes.data.drafts as { call: string }).call = 'content.publish';
		const refused = await pluginRoute(server, 'install', { source: example('drafts-glance').source, build: wrongScopes }).then(
			() => 'accepted',
			(error: Error) => error.message,
		);
		// The sandbox reports route errors as 500s with the message.
		check('a build that does not match its spec is refused', refused.includes('not valid for this spec'), refused);

		// People.
		const editor = await login(server, 'editor', 40);
		const contributor = await login(server, 'contributor', 20);
		const nonAdminInstall = await asUser(server, editor.cookie, '/_emdash/api/plugins/graft/install', { source: example('publish-queue').source });
		check('editors cannot install customizations', nonAdminInstall.status === 403, nonAdminInstall);

		const admin = (body: unknown) => asUser<{ blocks: Block[]; toast?: { message: string; type: string } }>(server, server.cookie, '/_emdash/api/plugins/graft/admin', body);
		const page = (cookie: string, body: unknown) => asUser<{ blocks: Block[]; toast?: { message: string; type: string } }>(server, cookie, '/_emdash/api/plugins/graft/admin', body);

		// Before approval nothing is served.
		const before = await page(editor.cookie, { type: 'page_load', page: '/customizations' });
		check('nothing is served before approval', before.status === 200 && texts(before.data?.blocks).includes('No customizations for you yet'), before);
		const manage = await admin({ type: 'page_load', page: '/customizations' });
		check('admins see what waits for approval', texts(manage.data?.blocks).includes('Waiting for approval') && texts(manage.data?.blocks).includes('Only draft posts are listed'), manage);

		// Approve from the admin screen, as an administrator would.
		for (const id of ['publish-queue', 'drafts-glance', 'go-live']) {
			const approved = await admin({ type: 'block_action', page: '/customizations', action_id: 'graft:approve', value: id });
			check(`${id}: approved from the Manage tab`, approved.data?.toast?.type === 'success', approved);
		}
		const editorApproves = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: 'graft:approve', value: 'publish-queue' });
		check('editors cannot approve', editorApproves.data?.toast?.type === 'error', editorApproves);

		// Content, through EmDash's own API.
		await content.seed([{ title: 'Draft A', status: 'draft' }, { title: 'Post B', status: 'published' }]);

		// The publish queue, as an editor.
		const queue = await page(editor.cookie, { type: 'page_load', page: '/customizations' });
		const editorRows = rows(queue.data?.blocks);
		check('editors see the draft in the publish queue', editorRows?.length === 1 && editorRows[0]!.title === 'Draft A', queue);
		const publish = editorRows?.[0]?.buttons[0];
		check('editors get a Publish button', publish?.label === 'Publish', editorRows);

		// As a contributor: the row, no button.
		const contributorRows = rows((await page(contributor.cookie, { type: 'page_load', page: '/customizations' })).data?.blocks);
		check('contributors see the draft without a Publish button', contributorRows?.length === 1 && contributorRows[0]!.buttons.length === 0, contributorRows);

		// Forged and refused interactions.
		const forgedByContributor = await page(contributor.cookie, { type: 'block_action', page: '/customizations', action_id: publish?.action_id, value: publish?.value });
		check("a contributor replaying an editor's button is refused", forgedByContributor.data?.toast?.type === 'error', forgedByContributor);
		const forgedValue = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: publish?.action_id, value: 'not-an-entry' });
		check('an action for a row that is not listed is refused', forgedValue.data?.toast?.type === 'error', forgedValue);
		const draftStill = await content.find('Draft A');
		check('refused actions change nothing', draftStill?.status === 'draft', draftStill);

		// Publish for real.
		const published = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: publish?.action_id, value: publish?.value });
		check('Publish shows its notice', published.data?.toast?.message === 'Published.', published);
		check('the published post leaves the queue', rows(published.data?.blocks)?.length === 0 && texts(published.data?.blocks).includes('Nothing waiting'), published);
		const isLive = await content.find('Draft A');
		check('the post is published in EmDash', isLive?.status === 'published', isLive);

		// The dashboard widget.
		await content.seed([{ title: 'Draft C', status: 'draft' }]);
		const widget = await page(editor.cookie, { type: 'page_load', page: 'widget:customizations' });
		check('the dashboard widget lists drafts under its title', texts(widget.data?.blocks).includes('"text":"Drafts"') && rows(widget.data?.blocks)?.[0]?.title === 'Draft C', widget);
		const contributorWidget = await page(contributor.cookie, { type: 'page_load', page: 'widget:customizations' });
		check('the widget is not shown outside its audience', contributorWidget.status === 200 && texts(contributorWidget.data?.blocks).includes('No customizations here yet.'), contributorWidget);

		// The editor panel, through EmDash's own editor-extension route.
		const entries = await fetch(`${server.url}/_emdash/api/content/posts?status=draft`, { headers: { Cookie: server.cookie } }).then((r) => r.json() as Promise<{ data: { items: Array<{ id: string; data: { title: string } }> } }>);
		const draftC = entries.data.items.find((i) => i.data.title === 'Draft C');
		const panelPath = `/_emdash/api/content/posts/${draftC?.id}/plugin-extensions/graft/panel/customizations`;
		const panel = await asUser<{ blocks: Block[]; toast?: { message: string } }>(server, editor.cookie, panelPath, { type: 'panel_load' });
		const goLive = flatten(panel.data?.blocks).find((b) => b.type === 'actions');
		check('the editor panel shows "Not live" and Go live', texts(panel.data?.blocks).includes('Not live') && texts(goLive ? [goLive] : []).includes('Go live'), panel);
		const button = (goLive?.elements as Block[] | undefined)?.[0];
		const wentLive = await asUser<{ blocks: Block[]; toast?: { message: string } }>(server, editor.cookie, panelPath, { type: 'block_action', action_id: button?.action_id });
		check('Go live publishes from the panel and shows "Live"', wentLive.data?.toast?.message === 'The post is live.' && texts(wentLive.data?.blocks).includes('"title":"Live"'), wentLive);
		const contributorPanel = await asUser<{ blocks: Block[] }>(server, contributor.cookie, panelPath, { type: 'panel_load' });
		// EmDash itself refuses contributors the panel of someone else's entry.
		check("contributors do not get the panel of others' entries", contributorPanel.status === 403 && !texts(contributorPanel.data?.blocks).includes('Go live'), contributorPanel);
		const author = await login(server, 'author', 30);
		const authorPanel = await asUser<{ blocks: Block[] }>(server, author.cookie, panelPath, { type: 'panel_load' });
		check('the panel is not shown outside its audience', authorPanel.status === 200 ? texts(authorPanel.data?.blocks).includes('No customizations for this entry.') : authorPanel.status === 403, authorPanel);

		// A widget: its code draws on the server, and its state travels in the buttons.
		const board = example('status-board');
		await pluginRoute(server, 'install', { source: board.source, build: board.build, verification: verification('status-board') });
		await admin({ type: 'block_action', page: '/customizations', action_id: 'graft:approve', value: 'status-board' });
		await content.seed([{ title: 'Draft D', status: 'draft' }]);
		const tab = (blocks: Block[] | undefined, label: string) => (flatten(blocks).find((b) => b.type === 'tab')?.panels as Array<{ label: string; blocks: Block[] }> | undefined)?.find((p) => p.label === label)?.blocks;
		const buttons = (blocks?: Block[]) => flatten(blocks).flatMap((b) => (b.type === 'actions' ? (b.elements as Block[]) : []));
		const drafts = tab((await page(editor.cookie, { type: 'page_load', page: '/customizations' })).data?.blocks, 'Status board');
		check('the widget draws the drafts and counts', rows(drafts)?.map((r) => r.title).join() === 'Draft D' && texts(drafts).includes('Drafts: 1 · Published: 3'), drafts);
		const showPublished = buttons(drafts).find((b) => b.label === 'Published (3)');
		check('the widget draws a button per status', buttons(drafts).some((b) => b.label === 'Drafts (1)') && showPublished !== undefined, buttons(drafts));
		const switched = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: showPublished?.action_id, value: showPublished?.value });
		const publishedView = tab(switched.data?.blocks, 'Status board');
		check('an event updates the widget: it lists the published posts', !switched.data?.toast && rows(publishedView)?.map((r) => r.title).sort().join() === 'Draft A,Draft C,Post B', switched);
		const unpublish = rows(publishedView)?.find((r) => r.title === 'Post B')?.buttons[0];
		check('rows the widget offers an action on get its button', unpublish?.label === 'Unpublish', rows(publishedView));
		const forgedRow = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: unpublish?.action_id, value: String(unpublish?.value).replace(/"v":"[^"]*"/, '"v":"not-an-entry"') });
		check('an action on a row the widget was not given is refused', forgedRow.data?.toast?.type === 'error', forgedRow);
		const byContributor = await page(contributor.cookie, { type: 'block_action', page: '/customizations', action_id: unpublish?.action_id, value: unpublish?.value });
		check("a contributor replaying the widget's action is refused", byContributor.data?.toast?.type === 'error' && (await content.find('Post B'))?.status === 'published', byContributor);
		const offline = await page(editor.cookie, { type: 'block_action', page: '/customizations', action_id: unpublish?.action_id, value: unpublish?.value });
		const afterOffline = tab(offline.data?.blocks, 'Status board');
		check("the widget's action runs, and the widget keeps its state", offline.data?.toast?.message === 'Taken offline.' && rows(afterOffline)?.map((r) => r.title).sort().join() === 'Draft A,Draft C', offline);
		check('the post is a draft again in EmDash', (await content.find('Post B'))?.status === 'draft');
		const contributorBoard = tab((await page(contributor.cookie, { type: 'page_load', page: '/customizations' })).data?.blocks, 'Status board');
		check('contributors see the widget without Publish buttons', (rows(contributorBoard)?.length ?? 0) > 0 && rows(contributorBoard)!.every((r) => r.buttons.length === 0), contributorBoard);
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
	console.log(failed ? `\n${failed} check(s) failed (${format})` : `\nAll ${checks.length} checks passed (${format})`);
	return failed ? 1 : 0;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error);
		process.exitCode = 1;
	},
);
