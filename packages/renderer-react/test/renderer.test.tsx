// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AsyncFunctionRunner, Build, FunctionCall, FunctionResult } from '@graft/core';
import { GraftRoot, removeRow, type ComponentRegistry, type Gateway } from '../src/index.ts';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const components: ComponentRegistry = {
	stack: ({ children }) => <div>{children}</div>,
	text: ({ children }) => <p>{children}</p>,
	list: ({ props, raw, evaluate, invoke }) => {
		const rows = props.rows as Array<{ id: number; title: string }> | undefined;
		if (!rows) {
			return <p>Loading</p>;
		}
		if (rows.length === 0) {
			return <p>{String(props.empty)}</p>;
		}
		const actions = (raw.actions ?? []) as Array<Record<string, never>>;
		return (
			<ul>
				{rows.map((row) => (
					<li key={row.id}>
						{row.title}
						{actions.map((action) => {
							const a = evaluate(action, row) as { label: string; visible?: boolean; onClick: unknown };
							return a.visible === false ? null : (
								<button key={a.label} onClick={() => void invoke(a.onClick)}>
									{a.label}
								</button>
							);
						})}
					</li>
				))}
			</ul>
		);
	},
};

const build = {
	graft: 1,
	spec: { id: 'queue', hash: 'sha256:x' },
	surface: { host: 'acme', hash: 'sha256:y' },
	mount: { slot: 'page' },
	data: { queue: { call: 'items.list', input: { status: ['open'], owner: { $slot: 'user' } } } },
	tree: {
		type: 'stack',
		children: [
			{ type: 'text', children: 'Queue' },
			{ type: 'chart' },
			{
				type: 'list',
				props: {
					rows: { $data: 'queue.items' },
					empty: 'Nothing left',
					actions: [
						{
							label: 'Close',
							visible: { $can: 'items:write' },
							onClick: { $call: 'items.close', input: { id: { $field: 'id' } }, then: ['remove-row:queue'], notice: 'Closed.' },
						},
					],
				},
			},
		],
	},
	checks: [],
	refs: { slot: 'page', components: {}, capabilities: [], scopes: [] },
	provenance: { compiler: 'test' },
} as unknown as Build;

let container: HTMLElement;
afterEach(() => container?.remove());

async function render(gateway: Gateway, can = (_: string, on: unknown) => (on as { id?: number } | undefined)?.id !== 2) {
	container = document.createElement('div');
	document.body.append(container);
	const onNotice = vi.fn();
	await act(async () => {
		createRoot(container).render(<GraftRoot build={build} components={components} gateway={gateway} slot={{ user: 5 }} can={can} onNotice={onNotice} />);
	});
	return onNotice;
}

describe('GraftRoot', () => {
	it('loads data with evaluated input and renders rows with per-row actions', async () => {
		const call = vi.fn(async () => ({ items: [{ id: 1, title: 'One' }, { id: 2, title: 'Two' }] }));
		await render({ call });
		expect(call).toHaveBeenCalledWith('items.list', { status: ['open'], owner: 5 });
		expect(container.textContent).toBe('QueueOneCloseTwo');
	});

	it('invokes actions, shows the notice and removes the row', async () => {
		const call = vi.fn(async (capability: string) => (capability === 'items.list' ? { items: [{ id: 1, title: 'One' }] } : {}));
		const onNotice = await render({ call });
		await act(async () => container.querySelector('button')!.click());
		expect(call).toHaveBeenLastCalledWith('items.close', { id: 1 });
		expect(onNotice).toHaveBeenCalledWith({ status: 'success', message: 'Closed.' });
		expect(container.textContent).toBe('QueueNothing left');
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
		expect(container.textContent).toBe('QueueOneClose');
	});
});

describe('GraftRoot with build functions', () => {
	const withCode = {
		...build,
		code: { language: 'javascript', source: 'function shout(s) { return s.toUpperCase(); }', functions: ['shout'] },
		tree: { type: 'stack', children: [{ type: 'label', props: { text: { $fn: 'shout', args: [{ $slot: 'name' }] } } }] },
	} as unknown as Build;
	const withLabel: ComponentRegistry = { ...components, label: ({ props }) => <p>{props.text === undefined ? '…' : String(props.text)}</p> };

	async function mount(b: Build, functions?: () => AsyncFunctionRunner) {
		container = document.createElement('div');
		document.body.append(container);
		await act(async () => {
			createRoot(container).render(<GraftRoot build={b} components={withLabel} gateway={{ call: async () => ({ items: [] }) }} slot={{ name: 'ada' }} can={() => true} functions={functions} />);
		});
	}

	it('runs $fn through the runner in one batch, then renders the result', async () => {
		const call = vi.fn(async (calls: FunctionCall[]): Promise<FunctionResult[]> => calls.map((c) => ({ ok: true, value: String(c.args[0]).toUpperCase() })));
		const factory = vi.fn(() => ({ call }));
		await mount(withCode, factory);
		expect(factory).toHaveBeenCalledTimes(1);
		expect(call).toHaveBeenCalledWith([{ name: 'shout', args: ['ada'] }]);
		expect(container.textContent).toBe('ADA');
	});

	it('shows a failed call as nothing', async () => {
		await mount(withCode, () => ({ call: async (calls) => calls.map(() => ({ ok: false, kind: 'timeout', message: 'too slow' })) }));
		expect(container.textContent).toBe('null');
	});

	it('never starts the runner for a build without code', async () => {
		const factory = vi.fn(() => ({ call: async () => [] }));
		await mount(build, factory);
		expect(factory).not.toHaveBeenCalled();
	});
});

describe('GraftRoot with widgets', () => {
	// A counter drawn by code: render and update run in a fake runner.
	const counter = {
		...build,
		code: { language: 'javascript', source: '', functions: ['draw', 'step'] },
		tree: { type: 'widget', props: { render: 'draw', update: 'step', input: { $slot: 'name' }, state: 0 } },
	} as unknown as Build;
	const draw = (name: string, n: number) => ({
		type: 'stack',
		children: [
			{ type: 'text', children: `${name}: ${n}` },
			{ type: 'button', props: { label: 'Add', onClick: { $event: 'add', payload: { by: 2 } } } },
			{ type: 'button', props: { label: 'Sneak', onClick: { $call: 'items.close', input: { id: 1 } } } },
			{ type: 'script', children: 'alert(1)' },
		],
	});
	const run = (calls: FunctionCall[]): FunctionResult[] =>
		calls.map(({ name, args }) =>
			name === 'draw'
				? { ok: true, value: draw(args[0] as string, args[1] as number) }
				: { ok: true, value: (args[0] as number) + (args[2] as { by: number }).by },
		);
	const withButtons: ComponentRegistry = {
		...components,
		button: ({ props, invoke }) => <button onClick={() => void invoke(props.onClick)}>{String(props.label)}</button>,
		script: ({ children }) => <b>{children}</b>,
	};

	async function mount(gateway: Gateway) {
		container = document.createElement('div');
		document.body.append(container);
		await act(async () => {
			createRoot(container).render(
				<GraftRoot
					build={counter}
					components={withButtons}
					gateway={gateway}
					slot={{ name: 'ada' }}
					can={() => true}
					functions={() => ({ call: async (calls) => run(calls) })}
					widgets={{ components: ['stack', 'text', 'button'], maxNodes: 20 }}
				/>,
			);
		});
	}

	it('draws what render returns, with the allow-listed components only', async () => {
		await mount({ call: async () => ({}) });
		expect(container.textContent).toBe('ada: 0AddSneak');
	});

	it('updates its state on its own events, and never reaches the gateway', async () => {
		const call = vi.fn(async () => ({}));
		await mount({ call });
		const [add, sneak] = [...container.querySelectorAll('button')];
		await act(async () => add!.click());
		expect(container.textContent).toBe('ada: 2AddSneak');
		await act(async () => sneak!.click());
		expect(call).not.toHaveBeenCalledWith('items.close', expect.anything());
		expect(container.textContent).toBe('ada: 2AddSneak');
	});
});

describe('removeRow', () => {
	it('removes by identity or id without touching rows that stay', () => {
		const keep = { id: 2, tags: [{ id: 1 }] };
		expect(removeRow({ items: [{ id: 1 }, keep], total: 2 }, { id: 1 })).toEqual({ items: [keep], total: 2 });
	});
});
