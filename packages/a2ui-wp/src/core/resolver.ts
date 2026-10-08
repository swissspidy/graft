/**
 * Resolves `DynamicValue`s (literals, data bindings, function calls) against
 * a surface data model within a scope, e.g. inside a list template.
 */

import type { DataModel } from './data-model';
import { joinPointer } from './json-pointer';
import type { FunctionRegistry } from './functions';
import type { DataBinding, DynamicValue, FunctionCall } from './types';

export interface ResolveScope {
	dataModel: DataModel;
	functions: FunctionRegistry;
	/** Absolute pointer that relative paths resolve against. */
	scopePath?: string;
	locale?: string;
}

export function isDataBinding( value: unknown ): value is DataBinding {
	return (
		typeof value === 'object' &&
		value !== null &&
		! Array.isArray( value ) &&
		typeof ( value as DataBinding ).path === 'string' &&
		Object.keys( value ).length === 1
	);
}

export function isFunctionCall( value: unknown ): value is FunctionCall {
	return (
		typeof value === 'object' &&
		value !== null &&
		! Array.isArray( value ) &&
		typeof ( value as FunctionCall ).call === 'string'
	);
}

/**
 * Turns a possibly relative binding path into an absolute pointer.
 * @param path  JSON Pointer.
 * @param scope Resolution scope.
 */
export function resolvePath(
	path: string,
	scope: Pick< ResolveScope, 'scopePath' >
): string {
	return joinPointer( scope.scopePath, path );
}

export function resolveDynamicValue(
	value: unknown,
	scope: ResolveScope
): unknown {
	if ( value === null || value === undefined || typeof value !== 'object' ) {
		return value;
	}
	if ( Array.isArray( value ) ) {
		return value.map( ( item ) => resolveDynamicValue( item, scope ) );
	}
	if ( isDataBinding( value ) ) {
		return scope.dataModel.get( resolvePath( value.path, scope ) );
	}
	if ( isFunctionCall( value ) ) {
		return invokeFunction( value, scope );
	}
	// A literal object argument is passed through untouched.
	return value;
}

export function invokeFunction(
	call: FunctionCall,
	scope: ResolveScope
): unknown {
	const implementation = scope.functions[ call.call ];
	if ( ! implementation ) {
		throw new Error( `Unknown function '${ call.call }'.` );
	}
	const args: Record< string, unknown > = {};
	for ( const [ name, raw ] of Object.entries( call.args ?? {} ) ) {
		args[ name ] = resolveDynamicValue( raw, scope );
	}
	return implementation( args, {
		resolve: ( inner: DynamicValue ) => resolveDynamicValue( inner, scope ),
		locale: scope.locale,
	} );
}

/**
 * Convenience wrappers with type coercion.
 * @param value Value to resolve.
 * @param scope Resolution scope.
 */
export function resolveString( value: unknown, scope: ResolveScope ): string {
	const resolved = resolveDynamicValue( value, scope );
	if ( resolved === null || resolved === undefined ) {
		return '';
	}
	return typeof resolved === 'object'
		? JSON.stringify( resolved )
		: String( resolved );
}

export function resolveNumber(
	value: unknown,
	scope: ResolveScope,
	fallback = 0
): number {
	const resolved = resolveDynamicValue( value, scope );
	const n = typeof resolved === 'number' ? resolved : Number( resolved );
	return Number.isNaN( n ) ||
		resolved === '' ||
		resolved === null ||
		resolved === undefined
		? fallback
		: n;
}

export function resolveBoolean( value: unknown, scope: ResolveScope ): boolean {
	return Boolean( resolveDynamicValue( value, scope ) );
}

export function resolveStringList(
	value: unknown,
	scope: ResolveScope
): string[] {
	const resolved = resolveDynamicValue( value, scope );
	if ( Array.isArray( resolved ) ) {
		return resolved.map( ( item ) => String( item ) );
	}
	if ( typeof resolved === 'string' && resolved !== '' ) {
		return [ resolved ];
	}
	return [];
}
