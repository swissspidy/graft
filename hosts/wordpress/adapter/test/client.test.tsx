// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { formatValue } from '../src/client/components.tsx';
import { createCan } from '../src/client/mount.tsx';

describe('createCan', () => {
	const can = createCan({ 'posts:read': true, 'posts.status:write': true, 'site:read': false });

	it('requires the scope to be granted and usable', () => {
		expect(can('posts:read', undefined)).toBe(true);
		expect(can('site:read', undefined)).toBe(false);
		expect(can('users.current:read', undefined)).toBe(false);
	});

	it('refines post scopes with the post\'s own can flags', () => {
		expect(can('posts.status:write', { id: 1, can: { publish: true, edit: true } })).toBe(true);
		expect(can('posts.status:write', { id: 1, can: { publish: false, edit: true } })).toBe(false);
		expect(can('posts.status:write', { id: 1 })).toBe(true);
		expect(createCan({})('posts.status:write', { can: { publish: true } })).toBe(false);
	});
});

describe('formatValue', () => {
	it('formats statuses, empties and dates', () => {
		expect(formatValue('pending', 'status')).toBe('Pending');
		expect(formatValue(undefined)).toBe('—');
		expect(formatValue('2026-09-28T10:00:00Z', 'date')).toMatch(/2026/);
		expect(formatValue('not a date', 'date')).toBe('not a date');
	});
});
