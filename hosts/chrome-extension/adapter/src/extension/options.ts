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

async function draw(): Promise<void> {
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
		const button = el('button', item.approved ? 'Revoke' : 'Approve');
		button.type = 'button';
		button.addEventListener('click', async () => {
			await send({ type: item.approved ? 'revoke' : 'approve', id: item.id });
			await draw();
		});
		section.append(status, button);
		root.append(section);
	}
}

void draw();
