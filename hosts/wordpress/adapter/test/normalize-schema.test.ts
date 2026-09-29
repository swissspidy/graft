import { describe, expect, it } from 'vitest';
import { normalizeWordPressSchema, playgroundVersion } from '../src/index.ts';

describe('normalizeWordPressSchema', () => {
	it('turns empty PHP arrays that stand for objects into objects', () => {
		expect(normalizeWordPressSchema({ type: 'object', properties: [], default: [] })).toEqual({
			type: 'object',
			properties: {},
			default: {},
		});
		expect(normalizeWordPressSchema({ type: 'array', default: [] })).toEqual({ type: 'array', default: [] });
		expect(normalizeWordPressSchema([])).toEqual({});
	});

	it('hoists property-level required flags', () => {
		expect(
			normalizeWordPressSchema({
				type: 'object',
				required: ['a'],
				properties: { a: { type: 'string' }, b: { type: 'string', required: true }, c: { type: 'string', required: false } },
			}),
		).toEqual({
			type: 'object',
			required: ['a', 'b'],
			properties: { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } },
		});
	});

	it('converts draft-04 exclusive bounds and tuple items', () => {
		expect(normalizeWordPressSchema({ type: 'number', minimum: 0, exclusiveMinimum: true, maximum: 9, exclusiveMaximum: false })).toEqual({
			type: 'number',
			exclusiveMinimum: 0,
			maximum: 9,
		});
		expect(normalizeWordPressSchema({ type: 'array', items: [{ type: 'string' }, { type: 'integer' }] })).toEqual({
			type: 'array',
			prefixItems: [{ type: 'string' }, { type: 'integer' }],
		});
	});

	it('drops WordPress-only keywords and recurses into subschemas', () => {
		expect(
			normalizeWordPressSchema({
				type: 'object',
				context: ['view'],
				properties: {
					id: { type: 'integer', readonly: true, context: ['view', 'edit'] },
					tags: { type: 'array', items: { type: 'object', properties: [], arg_options: {} } },
				},
				additionalProperties: { anyOf: [{ type: 'string', sanitize_callback: 'x' }] },
			}),
		).toEqual({
			type: 'object',
			properties: {
				id: { type: 'integer', readOnly: true },
				tags: { type: 'array', items: { type: 'object', properties: {} } },
			},
			additionalProperties: { anyOf: [{ type: 'string' }] },
		});
	});
});

describe('playgroundVersion', () => {
	it('maps WordPress versions to Playground channels', () => {
		expect(playgroundVersion('7.1.2')).toBe('7.1');
		expect(playgroundVersion('7.1.2+move-row-actions')).toBe('7.1');
		expect(playgroundVersion('7.2-alpha-63987')).toBe('nightly');
		expect(playgroundVersion('7.2-beta1')).toBe('beta');
		expect(playgroundVersion('7.2-RC2')).toBe('beta');
	});
});
