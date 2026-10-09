// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Build } from '@swissspidy/graft-core';
import { GraftRoot, removeRow, type Gateway, type UiRootProps } from '../src/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A minimal format renderer: the queue's rows, each with a Close button where the viewer may close it. */
function Ui({ data, can, invoke }: UiRootProps) {
	const rows = (data.queue as { items: Array<{ id: number; title: string }> } | undefined)?.items;
	if (!rows) {
		return <p>Loading</p>;
	}
	if (rows.length === 0) {
		return <p>Nothing left</p>;
	}
	return (
		<ul>
			{rows.map((row) => (
				<li key={row.id}>
					{row.title}
					{can('items:write', row) ? (
						<button onClick={() => void invoke({ $action: true, capability: 'items.close', input: { id: row.id }, then: ['remove-row:queue'], notice: 'Closed.', row })}>Close</button>
					) : null}
				</li>
			))}
		</ul>
	);
}

const build = {
	graft: 1,
	spec: { id: 'queue', hash: 'sha256:x' },
	surface: { host: 'acme', hash: 'sha256:y' },
	mount: { slot: 'page' },
	data: { queue: { call: 'items.list', input: { status: ['open'], owner: { $slot: 'user' } } } },
	ui: { protocol: 'test/1', catalogId: 'test' },
	events: {},
	checks: [],
	refs: { slot: 'page', capabilities: [], scopes: [], catalog: {} },
	provenance: { compiler: 'test' },
} as unknown as Build;

let container: HTMLElement;
afterEach(() => container?.remove());

async function render(gateway: Gateway, can = (_: string, on: unknown) => (on as { id?: number } | undefined)?.id !== 2) {
	container = document.createElement('div');
	document.body.append(container);
	const onNotice = vi.fn();
	await act(async () => {
		createRoot(container).render(<GraftRoot build={build} ui={Ui} gateway={gateway} slot={{ user: 5 }} can={can} onNotice={onNotice} />);
	});
	return onNotice;
}

describe('GraftRoot', () => {
	it('loads data with evaluated input and hands it to the format renderer', async () => {
		const call = vi.fn(async () => ({ items: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] }));
		await render({ call });
		expect(call).toHaveBeenCalledWith('items.list', { status: ['open'], owner: 5 });
		expect(container.textContent).toBe('OneCloseTwo');
	});

	it('invokes actions, shows the notice and removes the row', async () => {
		const call = vi.fn(async (capability: string) => (capability === 'items.list' ? { items: [{ id: 1, title: 'One' }] } : {}));
		const onNotice = await render({ call });
		await act(async () => container.querySelector('button')!.click());
		expect(call).toHaveBeenLastCalledWith('items.close', { id: 1 });
		expect(onNotice).toHaveBeenCalledWith({ status: 'success', message: 'Closed.' });
		expect(container.textContent).toBe('Nothing left');
	});

	it('reports gateway errors and keeps the row', async () => {
		const call = vi.fn(async (capability: string) => {
			if (capability === 'items.close') {
				throw { code: 'graft_not_granted', message: 'Not allowed.' };
			}
			return { items: [{ id: 1, title: 'One' }] };
		});
		const onNotice = await render({ call });
		await act(async () => container.querySelector('button')!.click());
		expect(onNotice).toHaveBeenCalledWith({ status: 'error', message: 'Not allowed.' });
		expect(container.textContent).toBe('OneClose');
	});
});

describe('removeRow', () => {
	it('removes by identity or id without touching rows that stay', () => {
		const keep = { id: 2, tags: [{ id: 1 }] };
		expect(removeRow({ items: [{ id: 1 }, keep], total: 2 }, { id: 1 })).toEqual({ items: [keep], total: 2 });
	});
});
