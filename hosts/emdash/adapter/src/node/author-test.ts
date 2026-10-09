import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { modelAnswers } from '@swissspidy/graft-core';
import { loadExamples, ROOT } from './examples.ts';
import { saveSettings, startModelStub } from './model-stub.ts';
import { asUser, login, pluginRoute, startEmDash } from './server.ts';

/**
 * Writing a customization in the EmDash admin, end to end, with the Claude
 * API stubbed (test-model.ts in the site routes the plugin's requests to
 * it). The stub replays the publish-queue build (an A2UI surface, the
 * host's format for new builds) as the compiler's model output, but its
 * first answer asks for a status content.list does not have:
 * the compiler must reject it and try again, one model call per step.
 * Then graft site verify verifies the draft, the admin approves it and
 * editors get it.
 *
 *   tsx author-test.ts [--format native|sandboxed]
 */

const format = process.argv.includes('--format') ? (process.argv[process.argv.indexOf('--format') + 1] as 'native' | 'sandboxed') : 'native';
const checks: Array<{ name: string; ok: boolean; detail?: unknown }> = [];
const check = (name: string, ok: boolean, detail?: unknown) => checks.push({ name, ok, detail: ok ? undefined : detail });

type Block = Record<string, unknown> & { type: string };
const texts = (blocks?: Block[]) => JSON.stringify(blocks ?? []);

const example = (await loadExamples()).find((e) => e.name === 'publish-queue')!;
const target = example.build;
const wrong = modelAnswers(target, { queue: { collection: 'posts', status: 'pending', order: 'asc' } }).ui;
const outputs = [modelAnswers(target).checks, wrong, modelAnswers(target).ui];

const stub = await startModelStub(outputs);
const { requests } = stub;

const site = await startEmDash({ format, testLogin: true, env: { GRAFT_TEST_MODEL_URL: stub.url } });
const admin = (body: unknown) => asUser<{ blocks: Block[]; toast?: { message: string; type: string } }>(site, site.cookie, '/_emdash/api/plugins/graft/admin', body);
const submit = (source: string) => admin({ type: 'form_submit', action_id: 'graft:author', block_id: 'graft-author', values: { source }, page: '/customizations' });
const continueJob = () => admin({ type: 'block_action', action_id: 'graft:job-continue', value: 'publish-queue', page: '/customizations' });

try {
	const before = await admin({ type: 'page_load', page: '/customizations' });
	check('without a key, the Manage tab asks for one', texts(before.data?.blocks).includes('Set an Anthropic API key'), before);

	const saved = await saveSettings(site, { anthropicApiKey: 'sk-test-key', model: 'claude-opus-5-5', effort: 'low' });
	check('the key is saved in the plugin settings', saved.ok, await saved.text());

	const editor = await login(site, 'editor', 40);
	const editorTry = await asUser<{ blocks: Block[]; toast?: { message: string } }>(site, editor.cookie, '/_emdash/api/plugins/graft/admin', {
		type: 'form_submit',
		action_id: 'graft:author',
		values: { source: example.source },
		page: '/customizations',
	});
	check('editors cannot build customizations', requests.length === 0 && !texts(editorTry.data?.blocks).includes('graft-author'), editorTry);

	const invalid = await submit(example.source.replace('slot: admin.page', 'slot: nowhere'));
	check('an invalid spec is sent back with its problems, and no model call', invalid.data?.toast?.type === 'error' && texts(invalid.data?.blocks).includes('does not exist') && requests.length === 0, invalid);
	check('the editor keeps what was written', texts(invalid.data?.blocks).includes('slot: nowhere'), invalid);

	const first = await submit(example.source);
	check('Build it writes the checks (one model call)', requests.length === 1 && first.data?.toast?.message === 'Step 1 done. Continue to take the next step.', { toast: first.data?.toast, calls: requests.length });
	check('the job is shown as building', texts(first.data?.blocks).includes('Continue building'), first);

	const second = await continueJob();
	check('the next step builds the UI, which is rejected', requests.length === 2 && second.data?.toast?.message?.includes('Step 2 done') === true && texts(second.data?.blocks).includes('Retrying after'), { toast: second.data?.toast, calls: requests.length });

	const third = await continueJob();
	check('the corrected UI is built and stored as a draft', requests.length === 3 && third.data?.toast?.type === 'success' && texts(third.data?.blocks).includes('Built (not verified)'), { toast: third.data?.toast, calls: requests.length });

	const request = requests[0]!;
	const body = request.body as { model?: string; output_config?: { effort?: string; format?: { type?: string } }; system?: unknown };
	check('requests carry the key, model, effort and a JSON schema', request.headers['x-api-key'] === 'sk-test-key' && body.model === 'claude-opus-5-5' && body.output_config?.effort === 'low' && body.output_config?.format?.type === 'json_schema', { headers: request.headers, body: { ...body, system: '…' } });
	check('refusals fall back server-side', String(request.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), request.headers);
	const retryPrompt = JSON.stringify((requests[2]!.body as { messages?: unknown }).messages);
	check('the rejection is fed back to the model', retryPrompt.includes('must be one of') && !JSON.stringify((requests[1]!.body as { messages?: unknown }).messages).includes('must be one of'), retryPrompt.slice(0, 2000));

	const { specs } = await pluginRoute<{ specs: Array<{ id: string; versions: Array<{ state: string; build?: { ui?: { catalogId?: string } } }> }> }>(site, 'specs');
	const draft = specs.find((s) => s.id === 'publish-queue')?.versions.at(-1);
	check('the draft holds the compiled build, an A2UI surface', draft?.state === 'draft' && draft.build?.ui?.catalogId === 'graft:emdash', draft);

	const verified = await promisify(execFile)('pnpm', ['-s', 'graft', 'site', 'verify', '--site', site.url, '--token', site.token], { cwd: ROOT, maxBuffer: 1 << 24 }).then(
		(r) => r.stdout,
		(e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`,
	);
	check('graft site verify verifies it; it waits for approval', verified.includes('publish-queue v1  ✔ verified → needs approval'), verified);

	const approved = await admin({ type: 'block_action', page: '/customizations', action_id: 'graft:approve', value: 'publish-queue' });
	check('the admin approves it', approved.data?.toast?.message === 'Approved.', approved.data?.toast);
	const served = await asUser<{ blocks: Block[] }>(site, editor.cookie, '/_emdash/api/plugins/graft/admin', { type: 'page_load', page: '/customizations' });
	check('editors get the customization', texts(served.data?.blocks).includes('Nothing waiting'), served);
} finally {
	await site.close();
	stub.close();
}

for (const c of checks) {
	console.log(`  ${c.ok ? '✔' : '✖'} ${c.name}`);
	if (!c.ok) {
		console.log(`      ${String(JSON.stringify(c.detail)).slice(0, 3000)}`);
	}
}
const failed = checks.filter((c) => !c.ok).length;
console.log(failed ? `\n${failed} check(s) failed (${format})` : `\nAll ${checks.length} checks passed (${format})`);
process.exitCode = failed ? 1 : 0;
