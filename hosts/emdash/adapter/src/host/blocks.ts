import type { Action } from '@swissspidy/graft-core/runtime';

/**
 * EmDash Block Kit for a customization (the A2UI renderer, ./a2ui.ts,
 * draws with these). The admin draws the blocks; interactions come back to
 * the plugin as `block_action` with the action id and value set here, and
 * the plugin resolves them against a fresh render (`findAction`), so the
 * browser never supplies a capability or its input.
 *
 * The admin keeps no state, so what the surface's local actions set rides
 * in the value of each of its buttons (`withState`); a click re-renders
 * with that state and finds the button again, and a local action's value
 * comes from that render, never from the browser. A forged state only
 * changes what the surface draws: actions still resolve against the rows
 * the server loaded, and pass their `visible` condition and the gateway.
 */

/** A Block Kit block or element, as JSON. */
export type Block = Record<string, unknown> & { type: string };

/** A button a render produced, keyed by the id and value the admin sends back. */
export interface RenderedAction {
	/** The action id from the build (e.g. "approve"). */
	id: string;
	label: string;
	available: boolean;
	/** The capability call it makes. */
	action?: Action;
	/** The table row the action belongs to. */
	row?: unknown;
	/** A local action instead: using it keeps `payload` under `name` in the state. */
	event?: { group: string; name: string; payload?: unknown };
	/** Block Kit `action_id` and `value` of the button. */
	actionId: string;
	value?: string;
}

export type Tone = 'success' | 'warning' | 'error' | 'info';

/**
 * Block Kit cannot color a table cell, so a tone shows as a marker before
 * the value. Relative times are left unmarked: the admin formats them.
 */
export const toneMarkers: Record<Tone, string> = { success: '🟢', warning: '🟡', error: '🔴', info: '🔵' };

export const str = (value: unknown): string => (value === null || value === undefined ? '' : typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));

/** The value that identifies a row in an action: its id, else its position. */
export function rowKey(row: unknown, index: number): string {
	const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
	return typeof id === 'string' || typeof id === 'number' ? String(id) : `#${index}`;
}

/** What a button is: its id and label, whether the viewer may use it, and what it does. */
export interface ButtonSpec {
	id: string;
	label: string;
	available: boolean;
	action?: Action;
	event?: RenderedAction['event'];
	style?: 'primary' | 'danger';
}

/** A button as a Block Kit element (none when unavailable) and the action it stands for. */
export function button(spec: ButtonSpec, actionId: string, value?: string, row?: unknown): { element?: Block; action: RenderedAction } {
	const available = spec.available && (spec.action !== undefined || spec.event !== undefined);
	const action: RenderedAction = { id: spec.id, label: spec.label, available, actionId };
	if (spec.action) {
		action.action = spec.action;
	}
	if (spec.event) {
		action.event = spec.event;
	}
	if (value !== undefined) {
		action.value = value;
	}
	if (row !== undefined) {
		action.row = row;
	}
	if (!available) {
		return { action };
	}
	const element: Block = { type: 'button', action_id: actionId, label: action.label };
	if (spec.style) {
		element.style = spec.style;
	}
	if (value !== undefined) {
		element.value = value;
	}
	return { element, action };
}

export interface Rendered {
	blocks: Block[];
	/** Every button, available or not, in document order. */
	actions: RenderedAction[];
	/** What the surface's local actions set, by pointer (latest last): carried in its buttons' values. */
	state: Record<string, unknown>;
	/** What went wrong while drawing. */
	problems: string[];
}

/** Marks a button value that carries the state. */
const STATES = 'w|';

/**
 * Puts a render's state into the value of each of its buttons (those with
 * the render's prefix), so a click brings it back.
 */
export function withState(rendered: Rendered, prefix: string): Rendered {
	const rewrite = (item: unknown): void => {
		if (Array.isArray(item)) {
			item.forEach(rewrite);
			return;
		}
		if (typeof item !== 'object' || item === null) {
			return;
		}
		const block = item as Block;
		if (block.type === 'button' && typeof block.action_id === 'string' && block.action_id.startsWith(`${prefix}:`)) {
			const value = typeof block.value === 'string' ? block.value : undefined;
			block.value = STATES + JSON.stringify(value === undefined ? { w: rendered.state } : { v: value, w: rendered.state });
			return;
		}
		Object.values(block).forEach(rewrite);
	};
	rewrite(rendered.blocks);
	return rendered;
}

/** A button value as the admin sent it back: the button's own value and the state it carried. */
export function readValue(value: unknown): { value: unknown; state: Record<string, unknown> } {
	if (typeof value === 'string' && value.startsWith(STATES)) {
		try {
			const parsed = JSON.parse(value.slice(STATES.length)) as { v?: unknown; w?: unknown };
			const state = typeof parsed.w === 'object' && parsed.w !== null && !Array.isArray(parsed.w) ? (parsed.w as Record<string, unknown>) : {};
			return { value: typeof parsed.v === 'string' ? parsed.v : undefined, state };
		} catch {
			// Not ours: a row id that happens to look like it.
		}
	}
	return { value, state: {} };
}

/** The action a `block_action` refers to, if the fresh render still offers it. */
export function findAction(rendered: Rendered, actionId: string, value: unknown): RenderedAction | undefined {
	return rendered.actions.find((a) => a.available && a.actionId === actionId && (a.value ?? undefined) === (value ?? undefined));
}
