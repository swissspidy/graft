import type { Listed, OptionsMessage, Reply } from './messages.ts';

/**
 * The options page: every customization the extension has, what it may do
 * in plain language (its permissions, and each check next to its
 * criterion), and approving or revoking it. Nothing is served before
 * someone approves it here.
 */

async function send<T>(message: OptionsMessage): Promise<T> {
	const reply = (await chrome.runtime.sendMessage(message)) as Reply<T>;
	if (!reply.ok) {
		throw new Error(reply.error);
	}
	return reply.value;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	if (text !== undefined) {
		node.textContent = text;
	}
	return node;
}

/**
 * Redraws the list. `fallback` is the customization whose button keeps focus
 * if focus is on the page itself when the controls are replaced.
 */
async function draw(fallback?: string): Promise<void> {
	const root = document.getElementById('customizations')!;
	let list: Listed[];
	try {
		list = await send<Listed[]>({ type: 'list' });
	} catch (error) {
		const alert = el('p', `Could not load the customizations: ${(error as Error).message}`);
		alert.className = 'error';
		alert.setAttribute('role', 'alert');
		root.replaceChildren(alert);
		return;
	}
	// Read focus just before the controls are replaced, not before the list was asked for:
	// it may have moved while the reply was out. Keep it on whichever customization's button
	// has it now; fall back only if it is on the page itself, and leave it alone otherwise.
	const active = document.activeElement;
	const focus =
		active instanceof HTMLButtonElement && root.contains(active)
			? active.closest('section')?.dataset.id
			: active === null || active === document.body
				? fallback
				: undefined;
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
		section.append(permissions, el('h3', 'Checked before it was shipped'));
		const criteria = el('ul');
		for (const criterion of item.criteria) {
			const li = el('li', criterion.text);
			const checks = el('ul');
			criterion.checks.forEach((check) => checks.append(el('li', check)));
			li.append(checks);
			criteria.append(li);
		}
		section.append(criteria);
		const status = el('p', item.approved ? (item.blocked ? `Approved, but not shown: ${item.blocked}` : 'Approved: shown in the app.') : 'Waiting for approval.');
		status.className = 'status';
		status.id = `customization-${index}-status`;
		const button = el('button', item.approved ? 'Revoke' : 'Approve');
		button.type = 'button';
		// Every section has the same two button labels: which customization it is for, and its state, describe it.
		button.setAttribute('aria-describedby', `${heading.id} ${status.id}`);
		let busy = false;
		button.addEventListener('click', async () => {
			// Not disabled while it waits: a disabled button drops focus.
			if (busy) {
				return;
			}
			busy = true;
			try {
				await send({ type: item.approved ? 'revoke' : 'approve', id: item.id });
			} catch (error) {
				status.setAttribute('role', 'alert');
				status.classList.add('error');
				status.textContent = (error as Error).message;
				busy = false;
				return;
			}
			await draw(item.id);
		});
		section.append(status, button);
		root.append(section);
		// Redrawing removes the button that was pressed: focus goes to its replacement, not to the page.
		if (item.id === focus) {
			button.focus();
		}
	});
}

void draw();
