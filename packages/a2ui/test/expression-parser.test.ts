import { describe, expect, it } from 'vitest';
import { parseTemplate } from '../src/core/expression-parser';

describe( 'parseTemplate', () => {
	it( 'returns plain strings untouched', () => {
		expect( parseTemplate( 'hello' ) ).toEqual( [ 'hello' ] );
	} );

	it( 'splits literals and paths', () => {
		expect( parseTemplate( 'Hi ${/user/name}!' ) ).toEqual( [
			'Hi ',
			{ path: '/user/name' },
			'!',
		] );
		expect( parseTemplate( '${name}' ) ).toEqual( [ { path: 'name' } ] );
	} );

	it( 'parses function calls with named args and nesting', () => {
		expect(
			parseTemplate( "${formatDate(value: ${/now}, format: 'yyyy')}" )
		).toEqual( [
			{
				call: 'formatDate',
				args: { value: { path: '/now' }, format: 'yyyy' },
				returnType: 'any',
			},
		] );
		expect( parseTemplate( '${add(a: 1, b: 2.5)}' ) ).toEqual( [
			{ call: 'add', args: { a: 1, b: 2.5 }, returnType: 'any' },
		] );
		expect( parseTemplate( '${not(value: true)}' ) ).toEqual( [
			{ call: 'not', args: { value: true }, returnType: 'any' },
		] );
	} );

	it( 'supports escaping', () => {
		expect( parseTemplate( 'cost: \\${5}' ) ).toEqual( [
			'cost: ',
			'${',
			'5}',
		] );
	} );

	it( 'throws on unclosed interpolation', () => {
		expect( () => parseTemplate( '${/a' ) ).toThrow( /Unclosed/ );
	} );
} );
