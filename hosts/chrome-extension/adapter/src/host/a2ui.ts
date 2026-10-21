import { createA2UIFormat, INPUT_GROUP, walkA2UI, type A2UIBuild, type A2UIFormatHost, type DrawnButton } from '@swissspidy/graft-a2ui';
import { registerUiFormat, type Action, type Build, type EvalContext } from '@swissspidy/graft-core';

/**
 * A2UI in the browser host: the Graft catalog as `graft:browser`, drawn
 * in the extension's service worker into a plain view (text, buttons,
 * tables; no markup) that the content script draws with DOM APIs.
 *
 * Buttons in the view carry only a key. What a key does stays in the
 * service worker, which finds it again in a fresh render when the content
 * script sends it back, so the page never names a capability or its
 * input (the same design as the EmDash host's Block Kit).
 *
 * The content script keeps no data of its own, so there are no inputs
 * here yet; a local `set` is a round trip whose state the content script
 * holds and sends back with the next render.
 */
export const browserA2UI: A2UIFormatHost = {
	host: 'browser',
	catalogId: 'graft:browser',
	without: ['TextField', 'CheckBox'],
};

export const browserA2UIFormat = createA2UIFormat(browserA2UI);

registerUiFormat(browserA2UIFormat);

export type Tone = 'success' | 'warning' | 'error' | 'info';

/** A button as the content script draws it. */
export interface ViewButton {
	key: string;
	label: string;
	primary?: boolean;
}

/** What the content script draws, with DOM APIs only. */
export type ViewNode =
	| { type: 'text'; variant: string; text: string }
	| { type: 'divider' }
	| { type: 'button'; button: ViewButton }
	| { type: 'table'; columns: string[]; rows: Array<{ cells: Array<{ text: string; tone?: Tone }>; buttons: ViewButton[] }>; empty: string }
	| { type: 'group'; kind: 'Column' | 'Row' | 'Card'; children: ViewNode[] }
	| { type: 'notice'; tone: Tone; text: string };

/** A button a render produced: its key, and what it does. Stays in the service worker. */
export interface RenderedAction {
	key: string;
	id: string;
	available: boolean;
	action?: Action;
	/** A local action: it sets `value` at `target` in the state. */
	set?: { target: string; value: unknown };
}

export interface Rendered {
	view: ViewNode[];
	actions: RenderedAction[];
	problems: string[];
}

const TONES = new Set(['success', 'warning', 'error', 'info']);

/** The value that identifies a row in a key: its id, else its position. */
export function rowKey(row: unknown, index: number): string {
	const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
	return typeof id === 'string' || typeof id === 'number' ? String(id) : `#${index}`;
}

/**
 * Renders an A2UI build for a context into a view, with the state its
 * local actions set (pointer to value, in order). Unavailable buttons are
 * not drawn. `prefix` namespaces keys, so several customizations can share
 * a page.
 */
export function renderA2UI(build: Build, ctx: EvalContext, prefix: string, state: Record<string, unknown> = {}): Rendered {
	const rendered: Rendered = { view: [], actions: [], problems: [] };
	let out = rendered.view;
	let n = 0;
	const record = (drawn: DrawnButton, key: string): ViewButton | undefined => {
		const available = drawn.available && (drawn.action !== undefined || drawn.set !== undefined);
		rendered.actions.push({ key, id: drawn.id, available, ...(drawn.action ? { action: drawn.action } : {}), ...(drawn.set ? { set: drawn.set } : {}) });
		return available ? { key, label: drawn.label, ...(drawn.variant === 'primary' ? { primary: true } : {}) } : undefined;
	};
	walkA2UI(build as unknown as A2UIBuild, ctx, { [INPUT_GROUP]: state }, browserA2UI, {
		text: (text, variant) => {
			if (variant === 'divider') {
				out.push({ type: 'divider' });
			} else if (text.trim()) {
				out.push({ type: 'text', variant: variant ?? 'body', text });
			}
		},
		button: (drawn) => {
			const button = record(drawn, `${prefix}:b${n++}`);
			if (button) {
				out.push({ type: 'button', button });
			}
		},
		input: ({ id }) => rendered.problems.push(`"${id}" is an input; the browser host has none yet.`),
		table: (table) => {
			const t = n++;
			out.push({
				type: 'table',
				columns: table.columns,
				empty: table.empty,
				rows: table.rows.map((row, index) => ({
					cells: table.columns.map((column) => {
						const cell = row.cells[column] ?? { text: '' };
						return { text: cell.text, ...(cell.tone && TONES.has(cell.tone) ? { tone: cell.tone as Tone } : {}) };
					}),
					buttons: row.actions.flatMap((drawn, i) => record(drawn, `${prefix}:t${t}:${i}:${rowKey(row.record, index)}`) ?? []),
				})),
			});
		},
		group: (kind, draw) => {
			const before = out;
			const children: ViewNode[] = [];
			out = children;
			draw();
			out = before;
			out.push({ type: 'group', kind, children });
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
export function nextState(state: Record<string, unknown>, set: { target: string; value: unknown }): Record<string, unknown> {
	const { [set.target]: _previous, ...rest } = state;
	return { ...rest, [set.target]: set.value ?? null };
}

/** What the compiler should know about the browser host when building A2UI surfaces. */
export const a2uiNotes = `Browser host specifics:
- The customization is drawn inside a page of a web app the customer does not own, by a browser extension. It is drawn with the extension's own plain components: Text variants become headings, body text or captions; Buttons; Tables with per-row buttons; Row, Column and Card group them. There are no inputs: TextField and CheckBox do not exist here.
- Buttons a viewer cannot use are not drawn at all.
- A table field's "tone" ("success", "warning", "error", "info") marks the cell.
- Slots on a page provide one {"id"} per page parameter, e.g. /slot/project/id on a project page. Pass them to data source inputs with {"$slot": "project.id"}.
- Every capability is a call to the app's own API as the viewer; the app may still refuse it for their account. Its output is exactly the declared schema.
- After an action, use "then": ["refresh:<source>"] to load the data again, or "remove-row:<source>".`;
