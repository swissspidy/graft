import type { ComponentApi } from '@a2ui/web_core/v0_9';
import { z } from 'zod';
import { action, dynamicBoolean, dynamicString, tableField } from './catalog.ts';

/**
 * A board: the items of a list as cards in columns, one column per value
 * of a field (a post's status), with moves between columns. A host that
 * can draw it adds it to its catalog (`components: [BOARD_COMPONENT]`).
 *
 * A move is a row action with a `from` and a `to` column: the cards in
 * `from` offer it when its `visible` holds in the card's scope, and using
 * it sends its action, an event bound to a capability like any other.
 * Dragging a card onto a column is the same move, so the board adds a
 * gesture, not a way to change anything.
 */

const boardColumn = z.object({ id: z.string(), title: z.string(), empty: dynamicString.optional() }).strict();
export const boardMove = z
	.object({
		id: z.string(),
		label: z.string(),
		from: z.string(),
		to: z.string(),
		variant: z.enum(['primary', 'default', 'secondary']).optional(),
		visible: dynamicBoolean.optional(),
		action,
	})
	.strict();

export const BOARD_COMPONENT: ComponentApi = {
	name: 'Board',
	schema: z
		.object({
			visible: dynamicBoolean.optional(),
			accessibility: z.record(z.any()).optional(),
			items: z.object({ path: z.string() }).strict(),
			columnBy: z.string(),
			columns: z.array(boardColumn).min(1),
			fields: z.array(tableField).min(1),
			moves: z.array(boardMove).optional(),
		})
		.strict(),
};

export interface BoardColumn {
	id: string;
	title: string;
	empty?: unknown;
}

export interface BoardMove {
	id: string;
	label: string;
	from: string;
	to: string;
	variant?: string;
	visible?: unknown;
	action: unknown;
}

/** One column of a board as drawn: its cards, each with its index in `items` (its scope). */
export interface BoardLane<T> {
	column: BoardColumn;
	cards: Array<{ item: T; index: number }>;
}

/** The value at a relative JSON Pointer into an item ("status", "author/name"). */
function valueAt(item: unknown, pointer: string): unknown {
	return pointer
		.split('/')
		.filter(Boolean)
		.reduce<unknown>((at, key) => (at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined), item);
}

/**
 * The cards of each column, in the columns' order and the items' order.
 * Items whose value names no column are not drawn: the board shows what
 * its columns say it shows.
 */
export function boardLanes<T>(items: readonly T[], columnBy: string, columns: readonly BoardColumn[]): Array<BoardLane<T>> {
	return columns.map((column) => ({
		column,
		cards: items.flatMap((item, index) => (String(valueAt(item, columnBy) ?? '') === column.id ? [{ item, index }] : [])),
	}));
}

/** The moves a card in a column may offer, before `visible` is resolved for it. */
export const movesFrom = (moves: readonly BoardMove[] | undefined, column: string): BoardMove[] => (moves ?? []).filter((move) => move.from === column);

/** The board for the compiler's prompt, in the catalog guide's style. */
export const BOARD_GUIDE = `- Board {"items": {"path": "/<source>/items"}, "columnBy": "<relative JSON Pointer into each item, e.g. status>", "columns": [{"id": "<the value of columnBy for this column>", "title": "<heading>", "empty": "<text when the column has no cards>"}], "fields": [<Table fields: the primary one is the card's title, the others are lines on the card>], "moves": [{"id": "<action id>", "label": "<button text, e.g. Pending review →>", "from": "<column id>", "to": "<column id>", "visible": <boolean value in the card's scope, e.g. {"call": "can", "args": {"scope": "..."}}>, "action": {"event": {"name": "<event>", "context": {"id": {"path": "id"}}}}}]}.
  Draws each item as a card in the column whose id equals its "columnBy" value (items matching no column are not shown) and every column even when it is empty. A card offers the moves whose "from" is its column and whose "visible" holds, as buttons; dragging a card onto a column uses its move to that column, so only those moves can be dragged. A move's event changes the item (e.g. its status) through a capability; end it with "then": ["refresh:<source>"] so the card lands in its new column. Checks see each column as a table of its cards (the first column is the first table), with the moves as row actions named by their ids.`;
