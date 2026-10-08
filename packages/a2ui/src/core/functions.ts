/**
 * Client-side functions of the A2UI basic catalog: validation checks,
 * formatting helpers, logic, and the `openUrl` local action.
 */

import { parseTemplate } from './expression-parser';
import { formatDatePattern } from './format-date';
import type { DynamicValue } from './types';

export interface FunctionContext {
	/** Resolves a dynamic value in the calling component's scope. */
	resolve: ( value: DynamicValue ) => unknown;
	locale?: string;
}

/** Receives already-resolved arguments. */
export type FunctionImplementation = (
	args: Record< string, unknown >,
	context: FunctionContext
) => unknown;

export type FunctionRegistry = Record< string, FunctionImplementation >;

export interface BasicFunctionOptions {
	locale?: string;
	/** Override how `openUrl` opens links. Defaults to `window.open` with `noopener`. */
	openUrl?: ( url: string ) => void;
}

/**
 * Coerces a value to a string per the protocol's type conversion rules.
 * @param value Any value.
 */
export function coerceToString( value: unknown ): string {
	if ( value === null || value === undefined ) {
		return '';
	}
	if ( typeof value === 'object' ) {
		try {
			return JSON.stringify( value ) ?? String( value );
		} catch {
			return String( value );
		}
	}
	return String( value );
}

const toNumber = ( value: unknown ) =>
	typeof value === 'number' ? value : Number( value );

function defaultOpenUrl( raw: string ) {
	if ( typeof window === 'undefined' ) {
		return;
	}
	let url: URL;
	try {
		url = new URL( raw, window.location.href );
	} catch {
		throw new Error( `Invalid URL: ${ raw }` );
	}
	if ( url.protocol !== 'http:' && url.protocol !== 'https:' ) {
		throw new Error( `Unsupported URL scheme: ${ url.protocol }` );
	}
	window.open( url.href, '_blank', 'noopener,noreferrer' );
}

export function createBasicFunctions(
	options: BasicFunctionOptions = {}
): FunctionRegistry {
	const { locale } = options;
	const openUrl = options.openUrl ?? defaultOpenUrl;

	return {
		// Arithmetic
		add: ( { a, b } ) => toNumber( a ) + toNumber( b ),
		subtract: ( { a, b } ) => toNumber( a ) - toNumber( b ),
		multiply: ( { a, b } ) => toNumber( a ) * toNumber( b ),
		divide: ( { a, b } ) => {
			const x = toNumber( a );
			const y = toNumber( b );
			if ( Number.isNaN( x ) || Number.isNaN( y ) ) {
				return NaN;
			}
			return y === 0 ? Infinity : x / y;
		},

		// Comparison
		equals: ( { a, b } ) => a === b,
		notEquals: ( { a, b } ) => a !== b,
		greaterThan: ( { a, b } ) => toNumber( a ) > toNumber( b ),
		lessThan: ( { a, b } ) => toNumber( a ) < toNumber( b ),

		// Logic
		and: ( { values } ) =>
			Array.isArray( values ) && values.every( Boolean ),
		or: ( { values } ) => Array.isArray( values ) && values.some( Boolean ),
		not: ( { value } ) => ! value,

		// Strings
		contains: ( { string, substring } ) =>
			coerceToString( string ).includes( coerceToString( substring ) ),
		startsWith: ( { string, prefix } ) =>
			coerceToString( string ).startsWith( coerceToString( prefix ) ),
		endsWith: ( { string, suffix } ) =>
			coerceToString( string ).endsWith( coerceToString( suffix ) ),

		// Validation
		required: ( { value } ) => {
			if ( value === null || value === undefined ) {
				return false;
			}
			if ( typeof value === 'string' ) {
				return value !== '';
			}
			if ( Array.isArray( value ) ) {
				return value.length > 0;
			}
			return true;
		},
		regex: ( { value, pattern } ) => {
			try {
				return new RegExp( coerceToString( pattern ) ).test(
					coerceToString( value )
				);
			} catch {
				throw new Error(
					`Invalid regular expression: ${ coerceToString( pattern ) }`
				);
			}
		},
		length: ( { value, min, max } ) => {
			const length =
				typeof value === 'string' || Array.isArray( value )
					? value.length
					: 0;
			if ( min !== undefined && length < toNumber( min ) ) {
				return false;
			}
			if ( max !== undefined && length > toNumber( max ) ) {
				return false;
			}
			return true;
		},
		numeric: ( { value, min, max } ) => {
			const n = toNumber( value );
			if ( Number.isNaN( n ) ) {
				return false;
			}
			if ( min !== undefined && n < toNumber( min ) ) {
				return false;
			}
			if ( max !== undefined && n > toNumber( max ) ) {
				return false;
			}
			return true;
		},
		email: ( { value } ) =>
			/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(
				coerceToString( value )
			),

		// Formatting
		formatString: ( { value }, context ) =>
			parseTemplate( coerceToString( value ) )
				.map( ( part ) => coerceToString( context.resolve( part ) ) )
				.join( '' ),
		formatNumber: ( { value, decimals, grouping } ) => {
			const n = toNumber( value );
			if ( Number.isNaN( n ) ) {
				return '';
			}
			const digits =
				decimals === undefined ? undefined : toNumber( decimals );
			return new Intl.NumberFormat( locale, {
				minimumFractionDigits: digits,
				maximumFractionDigits: digits,
				useGrouping:
					grouping === undefined ? true : Boolean( grouping ),
			} ).format( n );
		},
		formatCurrency: ( { value, currency, decimals, grouping } ) => {
			const n = toNumber( value );
			if ( Number.isNaN( n ) ) {
				return '';
			}
			const digits =
				decimals === undefined ? undefined : toNumber( decimals );
			try {
				return new Intl.NumberFormat( locale, {
					style: 'currency',
					currency: coerceToString( currency ) || 'USD',
					minimumFractionDigits: digits,
					maximumFractionDigits: digits,
					useGrouping:
						grouping === undefined ? true : Boolean( grouping ),
				} ).format( n );
			} catch {
				return n.toFixed( digits ?? 2 );
			}
		},
		formatDate: ( { value, format } ) => {
			if ( value === null || value === undefined || value === '' ) {
				return '';
			}
			const date = new Date( value as string | number );
			if ( Number.isNaN( date.getTime() ) ) {
				return '';
			}
			const pattern = coerceToString( format );
			return pattern === 'ISO' || ! pattern
				? date.toISOString()
				: formatDatePattern( date, pattern, locale );
		},
		pluralize: ( args ) => {
			const n = toNumber( args.value );
			try {
				const category = new Intl.PluralRules( locale ).select( n );
				return coerceToString( args[ category ] ?? args.other ?? '' );
			} catch {
				return coerceToString( args.other ?? '' );
			}
		},

		// Actions
		openUrl: ( { url } ) => {
			if ( url ) {
				openUrl( coerceToString( url ) );
			}
		},
	};
}
