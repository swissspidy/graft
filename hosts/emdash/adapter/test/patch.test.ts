import { describe, expect, it } from 'vitest';
import { baseSlot, patchSurface, resolveCall } from '../src/host/patch.ts';
import { hostSurface } from '../src/host/surface.ts';

const surface = hostSurface('1.0.1');

describe('host patches', () => {
	it('rename and remove capabilities, and calls follow', () => {
		const patch = { capabilities: { rename: { 'content.list': 'content.query' }, remove: ['content.publish'] } };
		const patched = patchSurface(surface, patch);
		expect(Object.keys(patched.capabilities).sort()).toEqual(['content.get', 'content.query', 'content.unpublish']);
		expect(resolveCall(patch, 'content.query', { status: 'draft' })).toEqual({ name: 'content.list', input: { status: 'draft' } });
		expect(resolveCall(patch, 'content.list', {})).toBeUndefined();
		expect(resolveCall(patch, 'content.publish', { id: '1' })).toBeUndefined();
	});

	it('turn "status" into "statuses"', () => {
		const patch = { capabilities: { statuses: true } };
		const input = patchSurface(surface, patch).capabilities['content.list']!.input as { properties: Record<string, unknown> };
		expect(Object.keys(input.properties)).toContain('statuses');
		expect(Object.keys(input.properties)).not.toContain('status');
		expect(resolveCall(patch, 'content.list', { statuses: ['draft'] })).toEqual({ name: 'content.list', input: { status: 'draft' } });
		expect(resolveCall(patch, 'content.list', { statuses: ['draft', 'scheduled'] })).toEqual({ name: 'content.list', input: {}, statuses: ['draft', 'scheduled'] });
		expect(resolveCall(patch, 'content.list', { status: 'draft' })).toBeUndefined();
	});

	it('move a slot and re-scope a capability', () => {
		const patch = {
			slots: { alias: { 'content.editor.sidebar': 'content.editor.panel' }, deprecate: { 'content.editor.panel': 'content.editor.sidebar' } },
			scopes: { add: { 'content.publish:write': { title: 'Publish content', host: ['content:publish_any'] } } },
			capabilities: { scopes: { 'content.publish': ['content.publish:write'] } },
		};
		const patched = patchSurface(surface, patch);
		expect(patched.slots['content.editor.panel']).toMatchObject({ deprecated: true, successor: 'content.editor.sidebar' });
		expect(patched.slots['content.editor.sidebar']?.kind).toBe('extension');
		expect(baseSlot(patch, 'content.editor.sidebar')).toBe('content.editor.panel');
		expect(patched.capabilities['content.publish']!.scopes).toEqual(['content.publish:write']);
		expect(patched.scopes['content.publish:write']).toBeDefined();
		// The input surface is untouched.
		expect(surface.slots['content.editor.panel']?.deprecated).toBeUndefined();
	});
});
