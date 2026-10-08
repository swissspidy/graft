import { describe, expect, it } from 'vitest';
import { DataModel } from '../src/core/data-model';
import { createBasicFunctions } from '../src/core/functions';
import {
	resolveDynamicValue,
	type ResolveScope,
} from '../src/core/resolver';

const scope = (
	data: Record< string, unknown >,
	scopePath?: string
): ResolveScope => ( {
	dataModel: new DataModel( data as never ),
	functions: createBasicFunctions( { locale: 'en-US' } ),
	scopePath,
} );

describe( 'basic functions', () => {
	it( 'resolves literals, paths and relative paths', () => {
		const s = scope(
			{ user: { name: 'Ada' }, items: [ { n: 1 }, { n: 2 } ] },
			'/items/1'
		);
		expect( resolveDynamicValue( 'x', s ) ).toBe( 'x' );
		expect( resolveDynamicValue( { path: '/user/name' }, s ) ).toBe(
			'Ada'
		);
		expect( resolveDynamicValue( { path: 'n' }, s ) ).toBe( 2 );
	} );

	it( 'formatString interpolates paths and nested calls', () => {
		const s = scope( {
			user: { first: 'Ada' },
			count: 2,
			now: '2026-09-21T09:30:00Z',
		} );
		expect(
			resolveDynamicValue(
				{
					call: 'formatString',
					args: { value: 'Hello ${/user/first}!' },
				},
				s
			)
		).toBe( 'Hello Ada!' );
		expect(
			resolveDynamicValue(
				{
					call: 'formatString',
					args: {
						value: "${/count} ${pluralize(value: ${/count}, one: 'item', other: 'items')}",
					},
				},
				s
			)
		).toBe( '2 items' );
		expect(
			resolveDynamicValue(
				{
					call: 'formatString',
					args: {
						value: "${formatDate(value: ${/now}, format: 'yyyy-MM-dd')}",
					},
				},
				s
			)
		).toMatch( /^2026-09-2[01]$/ );
	} );

	it( 'formats numbers and currency', () => {
		const s = scope( {} );
		expect(
			resolveDynamicValue(
				{
					call: 'formatCurrency',
					args: { value: 12.5, currency: 'USD' },
				},
				s
			)
		).toBe( '$12.50' );
		expect(
			resolveDynamicValue(
				{
					call: 'formatNumber',
					args: { value: 1234.567, decimals: 1 },
				},
				s
			)
		).toBe( '1,234.6' );
	} );

	it( 'runs validation checks', () => {
		const s = scope( { email: 'a@b.co', zip: '1234', empty: '' } );
		expect(
			resolveDynamicValue(
				{ call: 'email', args: { value: { path: '/email' } } },
				s
			)
		).toBe( true );
		expect(
			resolveDynamicValue(
				{
					call: 'regex',
					args: { value: { path: '/zip' }, pattern: '^[0-9]{5}$' },
				},
				s
			)
		).toBe( false );
		expect(
			resolveDynamicValue(
				{ call: 'required', args: { value: { path: '/empty' } } },
				s
			)
		).toBe( false );
		expect(
			resolveDynamicValue(
				{ call: 'required', args: { value: { path: '/missing' } } },
				s
			)
		).toBe( false );
		expect(
			resolveDynamicValue(
				{
					call: 'and',
					args: {
						values: [
							true,
							{ call: 'not', args: { value: false } },
						],
					},
				},
				s
			)
		).toBe( true );
	} );

	it( 'throws on unknown functions', () => {
		expect( () =>
			resolveDynamicValue( { call: 'nope', args: {} }, scope( {} ) )
		).toThrow( /Unknown function/ );
	} );
} );
