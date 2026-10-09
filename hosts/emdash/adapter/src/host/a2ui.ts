import { createA2UIFormat, INPUT_GROUP, walkA2UI, type A2UIBuild, type A2UIFormatHost, type DrawnButton } from '@graft/a2ui';
import { registerUiFormat, type Build, type EvalContext } from '@graft/core';
import { button, rowKey, toneMarkers, type Block, type Rendered, type RenderedAction, type Tone } from './blocks.ts';

/**
 * A2UI on EmDash: the Graft catalog as `graft:emdash`, drawn on the server
 * as Block Kit. Block Kit has no inputs here, so the catalog has none; a
 * local `set` is a round trip whose state rides in the buttons' values
 * (blocks.ts).
 */
export const emdashA2UI: A2UIFormatHost = {
	host: 'emdash',
	catalogId: 'graft:emdash',
	without: ['TextField', 'CheckBox'],
	// The admin formats cells by the column's format; Graft only marks tones.
	cell: (field, _record, evaluate) => {
		const value = evaluate(field.value);
		const tone = field.tone === undefined ? undefined : evaluate(field.tone);
		return { text: value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value), ...(typeof tone === 'string' ? { tone } : {}) };
	},
};

export const emdashA2UIFormat = createA2UIFormat(emdashA2UI);

registerUiFormat(emdashA2UIFormat);

/** What the compiler should know about EmDash when building A2UI surfaces. */
export const a2uiNotes = `EmDash specifics:
- The surface renders as EmDash Block Kit on the server: Text "h1"/"h2"/"h3" become headers, "caption" context, other text sections; buttons in a Row (or next to each other) share one actions block. There are no inputs: TextField and CheckBox do not exist here.
- content.list returns {items: [{id, collection, title, slug, status, author: {id, name} | null, createdAt, updatedAt, publishedAt, can: {publish}}], hasMore}. Bind table rows to /<source>/items.
- A table field's "type" is the admin's column format: "text" (default), "badge", "relative_time", "number" or "code". Tones show as a marker before the value, never on "relative_time".
- Per-entry permission: {"call": "can", "args": {"scope": "content.status:write"}} in a table row uses that row's entry; in the editor panel pass "on": {"path": "/slot/entry"}.
- The content.editor.panel slot renders once per saved entry with /slot/entry = {...same fields as content.list items}; checks match its actions with "row": {"title": ...}.
- The server re-renders from fresh data after every action: use "then": ["refresh:<source>"] (or "reload:page" in the editor panel), not "remove-row".
- Fixture entries are created and updated when the check starts. To see them older, give the check "advance_days".`;

const formats = new Set(['text', 'badge', 'relative_time', 'number', 'code']);

/** A drawn A2UI button as a Block Kit button (or nothing, when unavailable) and the action it stands for. */
function toBlock(drawn: DrawnButton, actionId: string, value?: string): { element?: Block; action: RenderedAction } {
	return button(
		{
			id: drawn.id,
			label: drawn.label,
			available: drawn.available,
			...(drawn.set ? { event: { group: INPUT_GROUP, name: drawn.set.target, payload: drawn.set.value } } : drawn.action ? { action: drawn.action } : {}),
			...(drawn.variant === 'primary' ? { style: 'primary' as const } : {}),
		},
		actionId,
		value,
		drawn.row,
	);
}

/**
 * Renders an A2UI build to Block Kit for a context, with the state its
 * local actions set (pointer to value, in order). `prefix` namespaces
 * action ids, so several customizations can share a page.
 */
export function renderA2UI(build: Build, ctx: EvalContext, prefix: string, state: Record<string, unknown> = {}): Rendered {
	const rendered: Rendered = { blocks: [], actions: [], state, problems: [] };
	let out: Block[] = rendered.blocks;
	let buttons = 0;
	/** Buttons next to each other share one actions block. */
	const element = (block: Block) => {
		const last = out.at(-1);
		if (last?.type === 'actions') {
			(last.elements as Block[]).push(block);
		} else {
			out.push({ type: 'actions', elements: [block] });
		}
	};
	walkA2UI(build as unknown as A2UIBuild, ctx, { [INPUT_GROUP]: state }, emdashA2UI, {
		text: (text, variant) => {
			if (variant === 'divider') {
				out.push({ type: 'divider' });
			} else if (text.trim()) {
				out.push({ type: variant === 'h1' || variant === 'h2' || variant === 'h3' ? 'header' : variant === 'caption' ? 'context' : 'section', text: text.trim() });
			}
		},
		button: (drawn) => {
			const { element: block, action } = toBlock(drawn, `${prefix}:b${buttons++}`);
			rendered.actions.push(action);
			if (block) {
				element(block);
			}
		},
		input: ({ id }) => rendered.problems.push(`"${id}" is an input; EmDash has none.`),
		table: (table) => {
			const id = `${prefix}:t${buttons++}`;
			const columns: Block[] = table.fields.map((field, i) => ({ key: `c${i}`, label: field.label, ...(field.type && formats.has(field.type) && field.type !== 'text' ? { format: field.type } : {}) }) as unknown as Block);
			const actionIds = (table.rows[0]?.actions ?? []).map((_, i) => `${id}:${i}`);
			for (const actionId of actionIds) {
				columns.push({ key: actionId, label: '', format: 'element' } as unknown as Block);
			}
			const rows = table.rows.map((row, index) => {
				const cells: Record<string, unknown> = {};
				table.fields.forEach((field, i) => {
					const cell = row.cells[field.label] ?? { text: '' };
					const tone = cell.tone as Tone | undefined;
					cells[`c${i}`] = tone && Object.hasOwn(toneMarkers, tone) && field.type !== 'relative_time' && cell.text !== '' ? `${toneMarkers[tone]} ${cell.text}` : cell.text;
				});
				row.actions.forEach((drawn, i) => {
					const { element: block, action } = toBlock(drawn, `${id}:${i}`, rowKey(row.record, index));
					rendered.actions.push(action);
					if (block) {
						cells[`${id}:${i}`] = block;
					}
				});
				return cells;
			});
			out.push({ type: 'table', columns, rows, page_action_id: `${id}:page`, empty_text: table.empty });
		},
		group: (kind, draw) => {
			if (kind !== 'Row') {
				draw();
				return;
			}
			// A row draws its buttons in one actions block, after whatever came before.
			const before = out;
			out = [];
			draw();
			const drawn = out;
			out = before;
			const elements = drawn.filter((block) => block.type === 'actions').flatMap((block) => block.elements as Block[]);
			out.push(...drawn.filter((block) => block.type !== 'actions'));
			if (elements.length > 0) {
				out.push({ type: 'actions', elements });
			}
		},
		problem: (text) => {
			if (!rendered.problems.includes(text)) {
				rendered.problems.push(text);
			}
		},
	});
	return rendered;
}

/** The state after a local action: what it sets, latest last. */
export function nextA2UIState(state: Record<string, unknown>, event: { name: string; payload?: unknown }): Record<string, unknown> {
	const { [event.name]: _previous, ...rest } = state;
	return { ...rest, [event.name]: event.payload ?? null };
}
