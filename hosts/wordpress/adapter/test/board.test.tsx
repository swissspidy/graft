// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { A2UIBuild } from '@swissspidy/graft-a2ui/client';
import { A2UIRenderer, type ActionMessage } from '@swissspidy/a2ui-wp';
import { catalog, createProcessor, surfaceId } from '../src/client/a2ui.tsx';
import { BoardView, type BoardViewProps } from '../src/client/board.tsx';
import { createCan } from '../src/client/mount.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	container = document.createElement('div');
	document.body.append(container);
	root = createRoot(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
});

const render = (element: React.ReactElement) => act(() => root.render(element));
const column = (id: string) => container.querySelector<HTMLElement>(`[data-graft-column="${id}"]`)!;
const card = (title: string) => container.querySelector<HTMLElement>(`[data-graft-card="${title}"]`)!;
const buttons = (scope: HTMLElement) => [...scope.querySelectorAll('button')].map((button) => button.textContent);

/** A drag event as the browser sends it, with a data transfer jsdom does not have. */
function drag(type: string, target: HTMLElement): Event {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, 'dataTransfer', { value: { setData() {}, effectAllowed: '', dropEffect: '' } });
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

describe('BoardView', () => {
	const publish = vi.fn();
	const props: BoardViewProps = {
		columns: [
			{ id: 'draft', title: 'Draft', empty: 'No drafts.', cards: [] },
			{
				id: 'pending',
				title: 'Pending review',
				empty: 'Nothing waiting.',
				cards: [
					{
						key: '1',
						title: 'Interview',
						lines: [{ label: 'Author', text: 'Ada' }],
						moves: [{ id: 'publish', label: 'Published →', to: 'publish', primary: true, run: publish }],
					},
					{ key: '2', title: 'Notes', lines: [], moves: [] },
				],
			},
			{ id: 'publish', title: 'Published', empty: 'Nothing published.', cards: [] },
		],
	};
	beforeEach(() => {
		publish.mockReset();
	});

	it('draws every column, empty ones with their line, and each card with its moves as buttons', () => {
		render(<BoardView {...props} />);
		expect([...container.querySelectorAll('h2')].map((h) => h.textContent)).toEqual(['Draft (0)', 'Pending review (2)', 'Published (0)']);
		expect(column('draft').textContent).toContain('No drafts.');
		expect(card('Interview').textContent).toContain('Ada');
		expect(buttons(card('Interview'))).toEqual(['Published →']);
		expect(card('Interview').querySelector('button')!.getAttribute('aria-label')).toBe('Published →: Interview');
		// A card with no moves has no buttons and cannot be dragged.
		expect(buttons(card('Notes'))).toEqual([]);
		expect(card('Notes').getAttribute('draggable')).toBe('false');
	});

	it('runs a move from its button', () => {
		render(<BoardView {...props} />);
		act(() => card('Interview').querySelector('button')!.click());
		expect(publish).toHaveBeenCalledTimes(1);
	});

	it('takes a dragged card only in a column it has a move to, and runs that move on drop', () => {
		render(<BoardView {...props} />);
		drag('dragstart', card('Interview'));
		expect(column('publish').dataset.graftDrop).toBe('accepts');
		expect(column('draft').dataset.graftDrop).toBe('refuses');
		// Only an accepting column lets the browser drop there.
		expect(drag('dragover', column('draft')).defaultPrevented).toBe(false);
		expect(drag('dragover', column('publish')).defaultPrevented).toBe(true);

		drag('drop', column('draft'));
		expect(publish).not.toHaveBeenCalled();
		drag('dragstart', card('Interview'));
		drag('drop', column('publish'));
		expect(publish).toHaveBeenCalledTimes(1);
		expect(column('publish').dataset.graftDrop).toBeUndefined();
	});
});

describe('the A2UI Board', () => {
	const build = JSON.parse(readFileSync(`${process.cwd()}/examples/builds/kanban-board.json`, 'utf8')) as A2UIBuild;
	const now = new Date().toISOString();
	const post = (id: number, title: string, status: string, can: { edit: boolean; publish: boolean }) => ({ id, title, status, author: { id: 2, name: 'Ada' }, date: now, modified: now, can });

	function draw(usable: Record<string, boolean>, publishable: boolean) {
		const processor = createProcessor(build, {}, createCan(usable));
		const actions: ActionMessage[] = [];
		processor.processMessage({
			version: 'v0.9',
			updateDataModel: {
				surfaceId,
				path: '/posts',
				value: {
					items: [
						post(1, 'Outline', 'draft', { edit: true, publish: publishable }),
						post(2, 'Interview', 'pending', { edit: true, publish: publishable }),
						post(3, 'Old news', 'private', { edit: true, publish: publishable }),
					],
				},
			},
		});
		render(<A2UIRenderer processor={processor} catalog={catalog} onAction={(message) => void actions.push(message)} />);
		return actions;
	}

	it('offers a contributor the review moves only, and sends the move as its event with the card’s id', () => {
		const actions = draw({ 'posts:read': true, 'posts.review:write': true, 'posts.status:write': false }, false);
		expect(buttons(card('Outline'))).toEqual(['Pending review →']);
		expect(buttons(card('Interview'))).toEqual(['← Draft']);
		expect(column('publish').textContent).toContain('Nothing published yet.');
		// A status with no column is not drawn.
		expect(container.querySelector('[data-graft-card="Old news"]')).toBeNull();
		expect(card('Outline').textContent).toContain('today');

		act(() => card('Outline').querySelector('button')!.click());
		expect(actions.map(({ action }) => [action.name, action.context])).toEqual([['send-for-review', { id: 1 }]]);
	});

	it('offers an editor publishing, by button and by dragging', () => {
		const actions = draw({ 'posts:read': true, 'posts.review:write': true, 'posts.status:write': true }, true);
		expect(buttons(card('Interview'))).toEqual(['← Draft', 'Published →']);
		drag('dragstart', card('Interview'));
		drag('drop', column('publish'));
		expect(actions.map(({ action }) => [action.name, action.context])).toEqual([['publish', { id: 2 }]]);
	});
});
