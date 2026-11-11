// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { resolveAnchor } from '../src/host/anchor.ts';
import { appSurface, appModel } from '../src/host/surface.ts';
import { tasklet } from '../src/apps/tasklet.ts';
import type { Anchor } from '../src/host/surface.ts';

const page = (html: string) => {
	document.body.innerHTML = html;
	return document;
};
const anchor: Anchor = { pages: ['/'], selectors: ['[data-testid="details"]'], landmark: { role: 'complementary', name: 'Details' }, insert: 'append', locked: ['form.payment', '#legal'] };

describe('an anchor and the locked areas of an app', () => {
	it('resolves outside them as before', () => {
		expect(resolveAnchor(anchor, page('<main><aside data-testid="details" aria-label="Details"></aside><form class="payment"></form></main>')).status).toBe('ok');
	});

	it('is broken when the app moved it into one, by selector or by landmark', () => {
		const bySelector = resolveAnchor(anchor, page('<form class="payment"><aside data-testid="details" aria-label="Details"></aside></form>'));
		expect(bySelector).toMatchObject({ status: 'broken' });
		expect(bySelector.reason).toContain('form.payment');
		expect(bySelector.element).toBeUndefined();
		// Every selector broke and the landmark is found again, inside the legal text: not re-anchored there.
		expect(resolveAnchor(anchor, page('<section id="legal"><aside aria-label="Details"></aside></section>')).status).toBe('broken');
	});

	it("counts the parent's area for what is drawn beside the anchor, the anchor's own for what is drawn in it", () => {
		const html = '<main><form class="payment" data-testid="details" role="complementary" aria-label="Details"></form></main>';
		expect(resolveAnchor({ ...anchor, insert: 'after' }, page(html)).status).toBe('ok');
		expect(resolveAnchor({ ...anchor, insert: 'append' }, page(html)).status).toBe('broken');
	});

	it('is part of the surface only for an app that declares locked areas', () => {
		expect(appModel(appSurface(tasklet)).anchors['project.sidebar']).not.toHaveProperty('locked');
		expect(appModel(appSurface({ ...tasklet, locked: ['#billing'] })).anchors['project.sidebar']!.locked).toEqual(['#billing']);
	});
});
