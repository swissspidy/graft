import { describe, expect, it } from 'vitest';
import {
	getAtPointer,
	joinPointer,
	parsePointer,
	setAtPointer,
} from '../src/core/json-pointer';

describe( 'json-pointer', () => {
	it( 'parses and unescapes segments', () => {
		expect( parsePointer( '/' ) ).toEqual( [] );
		expect( parsePointer( '' ) ).toEqual( [] );
		expect( parsePointer( '/a/b~1c/~0d' ) ).toEqual( [ 'a', 'b/c', '~d' ] );
	} );

	it( 'rejects prototype-polluting segments', () => {
		expect( () => parsePointer( '/__proto__/x' ) ).toThrow();
		expect( () =>
			setAtPointer( {}, '/constructor/prototype/x', 1 )
		).toThrow();
	} );

	it( 'gets nested values including array indices', () => {
		const data = { items: [ { name: 'a' }, { name: 'b' } ] };
		expect( getAtPointer( data, '/items/1/name' ) ).toBe( 'b' );
		expect( getAtPointer( data, '/items/5/name' ) ).toBeUndefined();
		expect( getAtPointer( data, '/items/x' ) ).toBeUndefined();
		expect( getAtPointer( data, '/' ) ).toBe( data );
	} );

	it( 'creates intermediate containers on set', () => {
		const data = setAtPointer( {}, '/a/0/b', 1 ) as {
			a: Array< { b: number } >;
		};
		expect( data ).toEqual( { a: [ { b: 1 } ] } );
	} );

	it( 'removes keys when value is undefined', () => {
		const data = setAtPointer( { a: 1, b: 2 }, '/a', undefined );
		expect( data ).toEqual( { b: 2 } );
	} );

	it( 'joins relative paths against a scope', () => {
		expect( joinPointer( '/items/0', 'name' ) ).toBe( '/items/0/name' );
		expect( joinPointer( '/items/0', '/abs' ) ).toBe( '/abs' );
		expect( joinPointer( undefined, 'name' ) ).toBe( '/name' );
	} );
} );
