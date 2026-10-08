/**
 * RFC 6901 JSON Pointer helpers, following the semantics the A2UI reference
 * implementation uses (prototype-pollution guards, container auto-creation
 * on set, `undefined` removes a key).
 */

import type { JsonValue } from './types';

const FORBIDDEN_SEGMENTS = new Set( [
	'__proto__',
	'constructor',
	'prototype',
] );

const isIndex = ( segment: string ) => /^(0|[1-9]\d*)$/.test( segment );

export class JsonPointerError extends Error {
	constructor(
		message: string,
		public readonly path?: string
	) {
		super( message );
		this.name = 'JsonPointerError';
	}
}

/**
 * Splits a pointer into unescaped segments. `/` and `` both mean the root.
 * @param path JSON Pointer, absolute or relative.
 */
export function parsePointer( path: string ): string[] {
	if ( path === '' || path === '/' ) {
		return [];
	}
	return path
		.split( '/' )
		.slice( path.startsWith( '/' ) ? 1 : 0 )
		.map( ( raw ) => {
			const segment = raw.replace( /~1/g, '/' ).replace( /~0/g, '~' );
			if ( FORBIDDEN_SEGMENTS.has( segment ) ) {
				throw new JsonPointerError(
					`Forbidden path segment '${ segment }' in '${ path }'.`,
					path
				);
			}
			return segment;
		} );
}

export function escapeSegment( segment: string ): string {
	return segment.replace( /~/g, '~0' ).replace( /\//g, '~1' );
}

/**
 * Joins a base pointer and a relative path (or another absolute pointer).
 * @param base Absolute pointer of the current scope.
 * @param path JSON Pointer, absolute or relative.
 */
export function joinPointer( base: string | undefined, path: string ): string {
	if ( path.startsWith( '/' ) ) {
		return path;
	}
	if ( ! base || base === '/' ) {
		return `/${ path }`;
	}
	return `${ base.endsWith( '/' ) ? base.slice( 0, -1 ) : base }/${ path }`;
}

export function getAtPointer( data: unknown, path: string ): unknown {
	let current: unknown = data;
	for ( const segment of parsePointer( path ) ) {
		if ( current === null || typeof current !== 'object' ) {
			return undefined;
		}
		if ( Array.isArray( current ) ) {
			if ( ! isIndex( segment ) ) {
				return undefined;
			}
			current = current[ Number( segment ) ];
		} else {
			if ( ! Object.prototype.hasOwnProperty.call( current, segment ) ) {
				return undefined;
			}
			current = ( current as Record< string, unknown > )[ segment ];
		}
	}
	return current;
}

/**
 * Sets `value` at `path`, mutating `data`, and returns the (possibly new) root.
 * Missing intermediate containers are created: an array when the next
 * segment is numeric, an object otherwise. `undefined` removes the key.
 * @param data  Root value.
 * @param path  JSON Pointer, absolute or relative.
 * @param value New value, or `undefined` to remove the key.
 */
export function setAtPointer(
	data: unknown,
	path: string,
	value: JsonValue | undefined
): unknown {
	const segments = parsePointer( path );
	if ( segments.length === 0 ) {
		return value;
	}

	let root = data;
	if ( root === undefined || root === null ) {
		root = isIndex( segments[ 0 ] ) ? [] : {};
	} else if ( typeof root !== 'object' ) {
		throw new JsonPointerError(
			`Cannot set '${ path }': the data model root is a primitive.`,
			path
		);
	}

	const last = segments[ segments.length - 1 ];
	let current = root as Record< string, unknown > | unknown[];

	for ( let i = 0; i < segments.length - 1; i++ ) {
		const segment = segments[ i ];
		const next = segments[ i + 1 ];
		const container = Array.isArray( current );
		if ( container && ! isIndex( segment ) ) {
			throw new JsonPointerError(
				`Non-numeric segment '${ segment }' on an array in '${ path }'.`,
				path
			);
		}
		const key = container ? Number( segment ) : segment;
		let child = ( current as Record< string | number, unknown > )[ key ];
		if (
			child !== undefined &&
			child !== null &&
			typeof child !== 'object'
		) {
			throw new JsonPointerError(
				`Cannot set '${ path }': segment '${ segment }' is a primitive.`,
				path
			);
		}
		if ( child === undefined || child === null ) {
			child = isIndex( next ) ? [] : {};
			( current as Record< string | number, unknown > )[ key ] = child;
		}
		current = child as Record< string, unknown > | unknown[];
	}

	if ( Array.isArray( current ) ) {
		if ( ! isIndex( last ) ) {
			throw new JsonPointerError(
				`Non-numeric segment '${ last }' on an array in '${ path }'.`,
				path
			);
		}
		current[ Number( last ) ] = value;
	} else if ( value === undefined ) {
		delete current[ last ];
	} else {
		current[ last ] = value;
	}
	return root;
}
