// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { A2UIBuild } from '@swissspidy/graft-a2ui/client';
import { A2UIRenderer, type ActionMessage } from '@swissspidy/a2ui-wp';
import { catalog, createProcessor, surfaceId } from '../src/client/a2ui.tsx';
import { DragProvider } from '../src/client/drag.tsx';
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

const lane = (name: string) => container.querySelector<HTMLElement>(`[data-graft-drop-target="${name}"]`)!;
const card = (title: string) => [...container.querySelectorAll<HTMLElement>('[data-graft-draggable]')].find((el) => el.textContent?.includes(title))!;
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

/** The kanban example as a viewer with these scopes sees it, and the action events it sends. */
function draw(usable: Record<string, boolean>, publishable: boolean): ActionMessage[] {
	const build = JSON.parse(readFileSync(`${process.cwd()}/examples/builds/kanban-board.json`, 'utf8')) as A2UIBuild;
	const now = new Date().toISOString();
	const post = (id: number, title: string, status: string) => ({ id, title, status, author: { id: 2, name: 'Ada' }, date: now, modified: now, can: { edit: true, publish: publishable } });
	const processor = createProcessor(build, {}, createCan(usable));
	processor.processMessage({
		version: 'v0.9',
		updateDataModel: { surfaceId, path: '/posts', value: { items: [post(1, 'Outline', 'draft'), post(2, 'Interview', 'pending')] } },
	});
	const actions: ActionMessage[] = [];
	act(() =>
		root.render(
			<DragProvider>
				<A2UIRenderer processor={processor} catalog={catalog} onAction={(message) => void actions.push(message)} />
			</DragProvider>,
		),
	);
	return actions;
}

const contributor = { 'posts:read': true, 'posts.review:write': true, 'posts.status:write': false };
const editor = { 'posts:read': true, 'posts.review:write': true, 'posts.status:write': true };

describe('dragging cards (the kanban example)', () => {
	it('draws each card in its column with the moves the viewer may make, and empty columns with their line', () => {
		draw(contributor, false);
		expect(lane('draft').contains(card('Outline'))).toBe(true);
		expect(lane('pending').contains(card('Interview'))).toBe(true);
		expect(buttons(card('Outline'))).toEqual(['Pending review →']);
		expect(buttons(card('Interview'))).toEqual(['← Draft']);
		expect(lane('publish').textContent).toContain('Nothing published yet.');
		expect(card('Outline').textContent).toContain('today');
	});

	it('presses a move from its button, with the card’s id', () => {
		const actions = draw(contributor, false);
		act(() => card('Outline').querySelector('button')!.click());
		expect(actions.map(({ action }) => [action.name, action.context])).toEqual([['send-for-review', { id: 1 }]]);
	});

	it('takes a dragged card only where it has a button, and presses that button on drop', () => {
		const actions = draw(contributor, false);
		drag('dragstart', card('Interview'));
		expect(lane('draft').dataset.graftDrop).toBe('accepts');
		// A contributor has no Published button, so that column refuses the card.
		expect(lane('publish').dataset.graftDrop).toBe('refuses');
		expect(drag('dragover', lane('publish')).defaultPrevented).toBe(false);
		expect(drag('dragover', lane('draft')).defaultPrevented).toBe(true);

		drag('drop', lane('publish'));
		expect(actions).toEqual([]);
		drag('drop', lane('draft'));
		expect(actions.map(({ action }) => [action.name, action.context])).toEqual([['back-to-draft', { id: 2 }]]);
		expect(lane('draft').dataset.graftDrop).toBeUndefined();
	});

	it('lets an editor drag a pending card to Published', () => {
		const actions = draw(editor, true);
		expect(buttons(card('Interview'))).toEqual(['← Draft', 'Published →']);
		drag('dragstart', card('Interview'));
		expect(lane('publish').dataset.graftDrop).toBe('accepts');
		drag('drop', lane('publish'));
		expect(actions.map(({ action }) => [action.name, action.context])).toEqual([['publish', { id: 2 }]]);
	});
});
