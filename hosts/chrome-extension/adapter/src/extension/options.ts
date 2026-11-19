import type { ActivityReply, Listed, ListedTrigger, OptionsMessage, Reply, RunRecord } from './messages.ts';

/**
 * The options page: every customization the extension has, what it may do
 * in plain language (its permissions, and each check next to its
 * criterion), what it does on its own and when, and approving or revoking
 * it. Nothing is served or run before someone approves it here. Below,
 * the activity log: every change customizations made, with an Undo button
 * where the change can be put back, every refusal, and every trigger run.
 */

async function send<T>(message: OptionsMessage): Promise<T> {
	const reply = (await chrome.runtime.sendMessage(message)) as Reply<T>;
	if (!reply.ok) {
		throw new Error(reply.error);
	}
	return reply.value;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) {
		node.textContent = text;
	}
	if (className) {
		node.className = className;
	}
	return node;
}

function button(label: string, onClick: () => Promise<unknown>, secondary = false): HTMLButtonElement {
	const node = el('button', label, secondary ? 'secondary' : undefined);
	node.type = 'button';
	node.addEventListener('click', async () => {
		node.disabled = true;
		const message = document.getElementById('message')!;
		message.textContent = '';
		try {
			await onClick();
		} catch (error) {
			message.textContent = (error as Error).message;
		}
		await draw();
	});
	return node;
}

const time = (iso: string) => new Date(iso).toLocaleString();

function runText(record: RunRecord): string {
	const { run } = record;
	const how = record.how === 'dry-run' ? 'Dry run' : record.how === 'manual' ? 'Run by you' : 'Ran on schedule';
	if (run.error) {
		return `${how}: ${run.error}`;
	}
	const verb = record.how === 'dry-run' ? 'would act on' : 'acted on';
	const failed = run.calls.filter((c) => !c.ok).length;
	const names = run.calls.map((c) => c.target.title ?? String(c.target.id ?? '')).filter(Boolean);
	return `${how}: ${verb} ${run.calls.length} of ${run.matched}${names.length ? ` (${names.join(', ')})` : ''}${run.skipped ? `, ${run.skipped} left for the next run` : ''}${failed ? `, ${failed} failed` : ''}.`;
}

function drawTrigger(item: Listed, trigger: ListedTrigger): HTMLLIElement {
	const li = el('li');
	li.dataset.trigger = trigger.id;
	li.append(el('span', `${trigger.when.charAt(0).toUpperCase()}${trigger.when.slice(1)}, at most ${trigger.limit} at a time (${trigger.id}). It may: ${trigger.may.join('; ')}.`));
	const state = trigger.blocked
		? `Not running: ${trigger.blocked}`
		: trigger.paused
			? `Paused: ${trigger.paused}`
			: `Running${trigger.nextRun ? `; next run ${time(trigger.nextRun)}` : ''}${trigger.lastRun ? `; last run ${time(trigger.lastRun)}` : ''}.`;
	li.append(el('p', state, 'status trigger-state'));
	if (!trigger.blocked) {
		const op = (name: 'pause' | 'resume' | 'run' | 'dry-run') => () => send({ type: 'trigger', id: item.id, trigger: trigger.id, op: name });
		li.append(trigger.paused ? button('Resume', op('resume'), true) : button('Pause', op('pause'), true), button('Dry run', op('dry-run'), true));
		if (!trigger.paused) {
			li.append(button('Run now', op('run'), true));
		}
	}
	return li;
}

async function drawCustomizations(): Promise<void> {
	const root = document.getElementById('customizations')!;
	const list = await send<Listed[]>({ type: 'list' });
	root.replaceChildren();
	if (list.length === 0) {
		root.append(el('p', 'No customizations.'));
		return;
	}
	for (const item of list) {
		const section = el('section');
		section.dataset.id = item.id;
		section.append(el('h2', item.title), el('p', `In ${item.slot}. From: ${item.from === 'packaged' ? 'shipped with the extension' : item.from}.`));
		section.append(el('h3', 'It may'));
		const permissions = el('ul');
		item.permissions.forEach((p) => permissions.append(el('li', p.title)));
		section.append(permissions);
		if (item.triggers.length > 0) {
			section.append(el('h3', 'Runs on its own'));
			if (item.identity) {
				section.append(el('p', `As ${item.identity}. You can pause it at any time, and undo what it did below.`, 'muted'));
			}
			const triggers = el('ul');
			item.triggers.forEach((trigger) => triggers.append(drawTrigger(item, trigger)));
			section.append(triggers);
		}
		section.append(el('h3', 'Checked before it was shipped'));
		const criteria = el('ul');
		for (const criterion of item.criteria) {
			const li = el('li', criterion.text);
			const checks = el('ul');
			criterion.checks.forEach((check) => checks.append(el('li', check)));
			li.append(checks);
			criteria.append(li);
		}
		section.append(criteria);
		const status = el('p', item.approved ? (item.blocked ? `Approved, but not shown: ${item.blocked}` : 'Approved: shown in the app.') : 'Waiting for approval.', 'status');
		section.append(status, button(item.approved ? 'Revoke' : 'Approve', () => send({ type: item.approved ? 'revoke' : 'approve', id: item.id })));
		root.append(section);
	}
}

async function drawActivity(): Promise<void> {
	const root = document.getElementById('activity')!;
	const { activity, runs, paused } = await send<ActivityReply>({ type: 'activity' });
	root.replaceChildren();
	const all = el('p', paused ? 'Nothing runs on its own: you paused every customization’s triggers. ' : 'Customizations may run on their own as approved. ', 'status');
	all.append(button(paused ? 'Resume all' : 'Pause all', () => send({ type: 'pause-all', paused: !paused }), true));
	root.append(all);

	root.append(el('h2', 'Changes and refusals'));
	if (activity.length === 0) {
		root.append(el('p', 'Nothing yet.', 'muted'));
	}
	const list = el('ul', undefined, 'activity');
	for (const entry of activity) {
		const li = el('li');
		li.dataset.entry = entry.id;
		const who = entry.source.kind === 'trigger' ? `on its own (${entry.source.trigger})` : entry.source.kind === 'undo' ? 'undone by you' : 'by you';
		const outcome = entry.outcome === 'ok' ? '' : entry.outcome === 'refused' ? ` Refused: ${entry.error ?? entry.code}` : ` Failed: ${entry.error ?? entry.code}`;
		li.append(el('span', `${time(entry.at)}, ${entry.title}, ${who}: ${entry.text}.${outcome}`));
		if (entry.undo?.done) {
			li.append(el('span', ` Undone ${time(entry.undo.done)}.`, 'muted'));
		} else if (entry.undo?.error) {
			li.append(el('span', ` Undoing it failed: ${entry.undo.error}`, 'error'));
		}
		if (entry.canUndo) {
			li.append(' ', button('Undo', () => send({ type: 'undo', entry: entry.id }), true));
		}
		list.append(li);
	}
	root.append(list);

	root.append(el('h2', 'Runs'));
	if (runs.length === 0) {
		root.append(el('p', 'No customization has run on its own yet.', 'muted'));
	}
	const runList = el('ul', undefined, 'runs');
	runs.forEach((record) => runList.append(el('li', `${time(record.at)}, ${record.title} (${record.trigger}): ${runText(record)}`)));
	root.append(runList);
}

async function draw(): Promise<void> {
	await Promise.all([drawCustomizations(), drawActivity()]);
}

void draw();
