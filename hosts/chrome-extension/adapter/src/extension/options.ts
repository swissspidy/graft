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

/**
 * A button that sends something and redraws the page. `key` names it across
 * redraws, so focus can go to its replacement; `describedBy` says what it
 * acts on, since many buttons share a label.
 */
function button(label: string, key: string, onClick: () => Promise<unknown>, options: { secondary?: boolean; describedBy?: string } = {}): HTMLButtonElement {
	const node = el('button', label, options.secondary ? 'secondary' : undefined);
	node.type = 'button';
	node.dataset.key = key;
	if (options.describedBy) {
		node.setAttribute('aria-describedby', options.describedBy);
	}
	let busy = false;
	node.addEventListener('click', async () => {
		// Not disabled while it waits: a disabled button drops focus.
		if (busy) {
			return;
		}
		busy = true;
		const message = document.getElementById('message')!;
		message.textContent = '';
		try {
			await onClick();
		} catch (error) {
			message.textContent = (error as Error).message;
		}
		await draw(key);
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

function drawTrigger(item: Listed, trigger: ListedTrigger, index: number): HTMLLIElement {
	const li = el('li');
	li.dataset.trigger = trigger.id;
	const what = el('span', `${trigger.when.charAt(0).toUpperCase()}${trigger.when.slice(1)}, at most ${trigger.limit} at a time (${trigger.id}). It may: ${trigger.may.join('; ')}.`);
	what.id = `customization-${index}-trigger-${trigger.id}`;
	li.append(what);
	const state = trigger.blocked
		? `Not running: ${trigger.blocked}`
		: trigger.paused
			? `Paused: ${trigger.paused}`
			: `Running${trigger.nextRun ? `; next run ${time(trigger.nextRun)}` : ''}${trigger.lastRun ? `; last run ${time(trigger.lastRun)}` : ''}.`;
	li.append(el('p', state, 'status trigger-state'));
	if (!trigger.blocked) {
		const op = (name: 'pause' | 'resume' | 'run' | 'dry-run') => () => send({ type: 'trigger', id: item.id, trigger: trigger.id, op: name });
		const key = (name: string) => `${item.id}/${trigger.id}/${name}`;
		const options = { secondary: true, describedBy: what.id };
		li.append(
			trigger.paused ? button('Resume', key('pause'), op('resume'), options) : button('Pause', key('pause'), op('pause'), options),
			button('Dry run', key('dry-run'), op('dry-run'), options),
		);
		if (!trigger.paused) {
			li.append(button('Run now', key('run'), op('run'), options));
		}
	}
	return li;
}

function drawPreview(item: Listed, index: number): HTMLElement {
	const preview = item.preview!;
	const box = el('div', undefined, 'preview');
	const text = el(
		'p',
		preview.until
			? `Previewing in ${item.slot} until ${new Date(preview.until).toLocaleTimeString()}: it reads with your account and changes nothing.`
			: `Try it with your data before you approve it: for ${preview.minutes} minutes, it is shown in ${item.slot} without its buttons that change anything. ${preview.reads.length ? `It may read: ${preview.reads.join('; ')}.` : 'It reads nothing.'}`,
	);
	text.id = `customization-${index}-preview`;
	box.append(text);
	const key = `${item.id}/preview`;
	box.append(
		preview.until
			? button('Stop the preview', key, () => send({ type: 'preview', id: item.id, on: false }), { secondary: true, describedBy: `customization-${index} ${text.id}` })
			: button('Preview', key, () => send({ type: 'preview', id: item.id, on: true }), { secondary: true, describedBy: `customization-${index} ${text.id}` }),
	);
	return box;
}

function drawSafeMode(on: boolean): void {
	const root = document.getElementById('safe-mode')!;
	const text = el(
		'p',
		on
			? 'Safe mode is on: no customization is shown, previewed or run. You can still approve, revoke and undo here.'
			: 'If a customization gets in your way, safe mode stops all of them at once, until you turn it off.',
		on ? 'status error' : 'muted',
	);
	text.id = 'safe-mode-status';
	root.replaceChildren(text, button(on ? 'Turn off safe mode' : 'Turn on safe mode', 'safe-mode', () => send({ type: 'safe-mode', on: !on }), { secondary: !on, describedBy: text.id }));
}

async function drawCustomizations(): Promise<void> {
	const root = document.getElementById('customizations')!;
	let list: Listed[];
	try {
		list = await send<Listed[]>({ type: 'list' });
	} catch (error) {
		root.replaceChildren(el('p', `Could not load the customizations: ${(error as Error).message}`, 'error'));
		root.firstElementChild!.setAttribute('role', 'alert');
		return;
	}
	root.replaceChildren();
	if (list.length === 0) {
		root.append(el('p', 'No customizations.'));
		return;
	}
	list.forEach((item, index) => {
		const section = el('section');
		section.dataset.id = item.id;
		const heading = el('h2', item.title);
		heading.id = `customization-${index}`;
		section.append(heading, el('p', `In ${item.slot}. From: ${item.from === 'packaged' ? 'shipped with the extension' : item.from}.`));
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
			item.triggers.forEach((trigger) => triggers.append(drawTrigger(item, trigger, index)));
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
		if (item.preview) {
			section.append(drawPreview(item, index));
		}
		const status = el('p', item.approved ? (item.blocked ? `Approved, but not shown: ${item.blocked}` : 'Approved: shown in the app.') : 'Waiting for approval.', 'status');
		status.id = `customization-${index}-status`;
		// Every section has the same button labels: which customization it is for, and its state, describe it.
		section.append(
			status,
			button(item.approved ? 'Revoke' : 'Approve', `${item.id}/approval`, () => send({ type: item.approved ? 'revoke' : 'approve', id: item.id }), { describedBy: `${heading.id} ${status.id}` }),
		);
		root.append(section);
	});
}

async function drawActivity(): Promise<void> {
	const root = document.getElementById('activity')!;
	let reply: ActivityReply;
	try {
		reply = await send<ActivityReply>({ type: 'activity' });
	} catch (error) {
		root.replaceChildren(el('p', `Could not load the activity: ${(error as Error).message}`, 'error'));
		root.firstElementChild!.setAttribute('role', 'alert');
		return;
	}
	const { activity, runs, paused } = reply;
	drawSafeMode(reply.safeMode);
	root.replaceChildren();
	const all = el('p', paused ? 'Nothing runs on its own: you paused every customization’s triggers. ' : 'Customizations may run on their own as approved. ', 'status');
	all.append(button(paused ? 'Resume all' : 'Pause all', 'pause-all', () => send({ type: 'pause-all', paused: !paused }), { secondary: true }));
	root.append(all);

	root.append(el('h3', 'Changes and refusals'));
	if (activity.length === 0) {
		root.append(el('p', 'Nothing yet.', 'muted'));
	}
	const list = el('ul', undefined, 'activity');
	for (const entry of activity) {
		const li = el('li');
		li.dataset.entry = entry.id;
		const who = entry.source.kind === 'trigger' ? `on its own (${entry.source.trigger})` : entry.source.kind === 'undo' ? 'undone by you' : 'by you';
		const outcome = entry.outcome === 'ok' ? '' : entry.outcome === 'refused' ? ` Refused: ${entry.error ?? entry.code}` : ` Failed: ${entry.error ?? entry.code}`;
		const text = el('span', `${time(entry.at)}, ${entry.title}, ${who}: ${entry.text}.${outcome}`);
		text.id = `entry-${entry.id}`;
		li.append(text);
		if (entry.undo?.done) {
			li.append(el('span', ` Undone ${time(entry.undo.done)}.`, 'muted'));
		} else if (entry.undo?.error) {
			li.append(el('span', ` Undoing it failed: ${entry.undo.error}`, 'error'));
		}
		if (entry.canUndo) {
			li.append(' ', button('Undo', `undo/${entry.id}`, () => send({ type: 'undo', entry: entry.id }), { secondary: true, describedBy: text.id }));
		}
		list.append(li);
	}
	root.append(list);

	root.append(el('h3', 'Runs'));
	if (runs.length === 0) {
		root.append(el('p', 'No customization has run on its own yet.', 'muted'));
	}
	const runList = el('ul', undefined, 'runs');
	runs.forEach((record) => runList.append(el('li', `${time(record.at)}, ${record.title} (${record.trigger}): ${runText(record)}`)));
	root.append(runList);
}

/**
 * Redraws the page. Focus stays on whichever button has it when the
 * controls are replaced (read then, not before the replies came: it may have
 * moved meanwhile); `fallback` is the button that was pressed, focused again
 * only if focus fell to the page itself.
 */
async function draw(fallback?: string): Promise<void> {
	const active = () => document.activeElement;
	const before = active();
	const wanted = before instanceof HTMLButtonElement && before.dataset.key ? before.dataset.key : undefined;
	await Promise.all([drawCustomizations(), drawActivity()]);
	const now = active();
	const key = wanted ?? (now === null || now === document.body ? fallback : undefined);
	if (key && (now === null || now === document.body || !now.isConnected)) {
		[...document.querySelectorAll<HTMLButtonElement>('button[data-key]')].find((b) => b.dataset.key === key)?.focus();
	}
}

void draw();
