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

	it('applies every click in order, even when they come faster than the runner', async () => {
		container = document.createElement('div');
		document.body.append(container);
		// The runner answers a tick later, so both clicks land before the first update returns.
		const slow = { call: (calls: FunctionCall[]) => new Promise<FunctionResult[]>((resolve) => setTimeout(() => resolve(run(calls)), 5)) };
		await act(async () => {
			createRoot(container).render(
				<GraftRoot build={counter} components={withButtons} gateway={{ call: async () => ({}) }} slot={{ name: 'ada' }} can={() => true} functions={() => slow} widgets={{ components: ['stack', 'text', 'button'], maxNodes: 20 }} />,
			);
		});
		for (let i = 0; i < 10 && !container.querySelector('button'); i++) {
			await act(async () => {
				await new Promise((r) => setTimeout(r, 10));
			});
		}
		const add = container.querySelector('button')!;
		await act(async () => {
			add.click();
			add.click();
		});
		for (let i = 0; i < 20 && container.textContent !== 'ada: 4AddSneak'; i++) {
			await act(async () => {
				await new Promise((r) => setTimeout(r, 10));
			});
		}
		expect(container.textContent).toBe('ada: 4AddSneak');
	});

	it('runs a declared action on a row of its input, and nothing else', async () => {
		const withActions = {
			...build,
			data: { queue: { call: 'items.list' } },
			code: { language: 'javascript', source: '', functions: ['draw'] },
			tree: {
				type: 'widget',
				props: {
					render: 'draw',
					input: { $data: 'queue.items' },
					actions: { close: { call: { $call: 'items.close', input: { id: { $field: 'id' } }, then: ['refresh:queue'] } } },
				},
			},
		} as unknown as Build;
		const drawn = {
			type: 'stack',
			children: [
				{ type: 'button', props: { label: 'Close two', onClick: { $use: 'close', row: 2 } } },
				{ type: 'button', props: { label: 'Close a row it made up', onClick: { $use: 'close', row: { id: 99 } } } },
				{ type: 'button', props: { label: 'Use an undeclared action', onClick: { $use: 'delete', row: 1 } } },
			],
		};
		const call = vi.fn(async (capability: string) => (capability === 'items.list' ? { items: [{ id: 1 }, { id: 2 }] } : {}));
		container = document.createElement('div');
		document.body.append(container);
		await act(async () => {
			createRoot(container).render(
				<GraftRoot
					build={withActions}
					components={withButtons}
					gateway={{ call }}
					can={() => true}
					functions={() => ({ call: async (calls) => calls.map(() => ({ ok: true, value: drawn })) })}
					widgets={{ components: ['stack', 'button'], maxNodes: 20 }}
				/>,
			);
		});
		for (const button of [...container.querySelectorAll('button')]) {
			await act(async () => button.click());
		}
		expect(call.mock.calls.filter(([capability]) => capability === 'items.close')).toEqual([['items.close', { id: 2 }]]);
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

describe('GraftRoot with widget inputs', () => {
	const renaming = {
		...build,
		code: { language: 'javascript', source: '', functions: ['draw', 'typed'] },
		tree: {
			type: 'widget',
			props: {
				render: 'draw',
				update: 'typed',
				input: [{ id: 7, title: 'Old' }],
				state: '',
				actions: { rename: { call: { $call: 'items.rename', input: { id: { $field: 'id' }, title: { $input: 'title' } } } } },
			},
		},
	} as unknown as Build;
	// The code echoes what it was told was typed, and redraws the field with another value to try to hide it.
	const run = (calls: FunctionCall[]): FunctionResult[] =>
		calls.map(({ name, args }) =>
			name === 'typed'
				? { ok: true, value: args[2] }
				: {
						ok: true,
						value: {
							type: 'stack',
							children: [
								{ type: 'text', children: `Told: ${String(args[1])}` },
								{ type: 'field', props: { id: 'title', label: 'Title', value: args[1] ? 'Hidden' : (args[0] as Array<{ title: string }>)[0]!.title, onChange: { $event: 'typed' } } },
								{ type: 'button', props: { label: 'Rename', onClick: { $use: 'rename', row: 7 } } },
							],
						},
					},
		);
	const withField: ComponentRegistry = {
		...components,
		button: ({ props, invoke }) => <button onClick={() => void invoke(props.onClick)}>{String(props.label)}</button>,
		field: ({ field }) => (field ? <input aria-label="Title" value={String(field.value ?? '')} onChange={(e) => field.change(e.target.value)} /> : null),
	};

	it('shows what the viewer types, tells update, and sends what is on screen', async () => {
		const call = vi.fn(async () => ({}));
		container = document.createElement('div');
		document.body.append(container);
		await act(async () => {
			createRoot(container).render(
				<GraftRoot
					build={renaming}
					components={withField}
					gateway={{ call }}
					can={() => true}
					functions={() => ({ call: async (calls) => run(calls) })}
					widgets={{ components: ['stack', 'text', 'button', 'field'], inputs: ['field'], maxNodes: 20 }}
				/>,
			);
		});
		const input = container.querySelector('input')!;
		expect(input.value).toBe('Old');
		await act(async () => {
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
			setValue.call(input, 'New');
			input.dispatchEvent(new Event('input', { bubbles: true }));
		});
		for (let i = 0; i < 10 && !container.textContent?.includes('Told: New'); i++) {
			await act(async () => {
				await new Promise((r) => setTimeout(r, 5));
			});
		}
		expect(container.textContent).toContain('Told: New');
		// The code redrew the field with "Hidden"; it keeps showing what the viewer typed.
		expect(container.querySelector('input')!.value).toBe('New');
		await act(async () => container.querySelector('button')!.click());
		expect(call).toHaveBeenCalledWith('items.rename', { id: 7, title: 'New' });
	});
});

describe('removeRow', () => {
	it('removes by identity or id without touching rows that stay', () => {
		const keep = { id: 2, tags: [{ id: 1 }] };
		expect(removeRow({ items: [{ id: 1 }, keep], total: 2 }, { id: 1 })).toEqual({ items: [keep], total: 2 });
	});
});
