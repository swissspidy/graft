/**
 * Parser for the `${ ... }` interpolation syntax used by `formatString`.
 *
 * A template is split into literal strings and expressions. An expression is
 * a string/number/boolean literal, a data path (`/abs/path` or `relative`),
 * or a function call with named arguments: `fn(arg: value, other: 'x')`.
 * Expressions can nest: `${formatDate(value: ${/now}, format: 'yyyy')}`.
 * A literal `${` is written as `\${`.
 */

import type { DynamicValue, FunctionCall } from './types';

const MAX_DEPTH = 100;
const NUMBER_LITERAL = /^\d+\.?\d*$/;

export class ExpressionError extends Error {
	constructor( message: string ) {
		super( message );
		this.name = 'ExpressionError';
	}
}

class Scanner {
	pos = 0;
	constructor( public readonly input: string ) {}
	isAtEnd() {
		return this.pos >= this.input.length;
	}
	peek( offset = 0 ) {
		return this.pos + offset < this.input.length
			? this.input[ this.pos + offset ]
			: '\0';
	}
	advance( count = 1 ) {
		const slice = this.input.slice( this.pos, this.pos + count );
		this.pos += count;
		return slice;
	}
	startsWith( text: string ) {
		return this.input.startsWith( text, this.pos );
	}
	match( char: string ) {
		if ( this.peek() === char ) {
			this.pos++;
			return true;
		}
		return false;
	}
	matchKeyword( keyword: string ) {
		if (
			this.startsWith( keyword ) &&
			! /[A-Za-z0-9_]/.test( this.peek( keyword.length ) )
		) {
			this.pos += keyword.length;
			return true;
		}
		return false;
	}
	skipWhitespace() {
		while ( ! this.isAtEnd() && /\s/.test( this.peek() ) ) {
			this.pos++;
		}
	}
}

const isAlnum = ( c: string ) => /[A-Za-z0-9]/.test( c );
const isDigit = ( c: string ) => c >= '0' && c <= '9';

/**
 * Splits a template into literal strings and dynamic parts.
 * @param input Template string.
 * @param depth Current nesting depth.
 */
export function parseTemplate( input: string, depth = 0 ): DynamicValue[] {
	if ( depth > MAX_DEPTH ) {
		throw new ExpressionError(
			'Maximum expression nesting depth exceeded.'
		);
	}
	if ( ! input || ! input.includes( '${' ) ) {
		return input ? [ input ] : [];
	}

	const parts: DynamicValue[] = [];
	const scanner = new Scanner( input );
	while ( ! scanner.isAtEnd() ) {
		if ( scanner.startsWith( '${' ) ) {
			scanner.advance( 2 );
			const content = extractInterpolation( scanner );
			parts.push( parseExpression( content, depth + 1 ) );
		} else if ( scanner.startsWith( '\\${' ) ) {
			scanner.advance( 3 );
			parts.push( '${' );
		} else {
			const start = scanner.pos;
			while (
				! scanner.isAtEnd() &&
				! scanner.startsWith( '${' ) &&
				! scanner.startsWith( '\\${' )
			) {
				scanner.advance();
			}
			parts.push( scanner.input.slice( start, scanner.pos ) );
		}
	}
	return parts.filter( ( part ) => part !== '' );
}

function extractInterpolation( scanner: Scanner ): string {
	const start = scanner.pos;
	let balance = 1;
	while ( ! scanner.isAtEnd() && balance > 0 ) {
		const char = scanner.advance();
		if ( char === '{' ) {
			balance++;
		} else if ( char === '}' ) {
			balance--;
		} else if ( char === "'" || char === '"' ) {
			while ( ! scanner.isAtEnd() ) {
				const c = scanner.advance();
				if ( c === '\\' ) {
					scanner.advance();
				} else if ( c === char ) {
					break;
				}
			}
		}
	}
	if ( balance > 0 ) {
		throw new ExpressionError( "Unclosed interpolation: missing '}'." );
	}
	return scanner.input.slice( start, scanner.pos - 1 );
}

/**
 * Parses a single expression (the inside of `${...}`).
 * @param expression Expression text, without the surrounding `${` and `}`.
 * @param depth      Current nesting depth.
 */
export function parseExpression( expression: string, depth = 0 ): DynamicValue {
	const trimmed = expression.trim();
	if ( ! trimmed ) {
		return '';
	}
	const scanner = new Scanner( trimmed );
	const result = parseInternal( scanner, depth );
	scanner.skipWhitespace();
	if ( ! scanner.isAtEnd() ) {
		throw new ExpressionError(
			`Unexpected characters at end of expression: '${ scanner.input.slice( scanner.pos ) }'.`
		);
	}
	return result;
}

function parseInternal( scanner: Scanner, depth: number ): DynamicValue {
	if ( depth > MAX_DEPTH ) {
		throw new ExpressionError(
			'Maximum expression nesting depth exceeded.'
		);
	}
	scanner.skipWhitespace();
	if ( scanner.isAtEnd() ) {
		return '';
	}
	if ( scanner.startsWith( '${' ) ) {
		scanner.advance( 2 );
		return parseExpression( extractInterpolation( scanner ), depth + 1 );
	}
	if ( scanner.peek() === "'" || scanner.peek() === '"' ) {
		return parseStringLiteral( scanner );
	}
	if ( isDigit( scanner.peek() ) ) {
		return parseNumberLiteral( scanner );
	}
	if ( scanner.matchKeyword( 'true' ) ) {
		return true;
	}
	if ( scanner.matchKeyword( 'false' ) ) {
		return false;
	}
	if ( scanner.matchKeyword( 'null' ) ) {
		return '';
	}

	const start = scanner.pos;
	while (
		! scanner.isAtEnd() &&
		( isAlnum( scanner.peek() ) || '/._-'.includes( scanner.peek() ) )
	) {
		scanner.advance();
	}
	const token = scanner.input.slice( start, scanner.pos );
	scanner.skipWhitespace();
	if ( scanner.peek() === '(' ) {
		return parseFunctionCall( token, scanner, depth );
	}
	return token ? { path: token } : '';
}

function parseFunctionCall(
	name: string,
	scanner: Scanner,
	depth: number
): FunctionCall {
	scanner.match( '(' );
	scanner.skipWhitespace();
	const args: Record< string, DynamicValue > = {};
	while ( ! scanner.isAtEnd() && scanner.peek() !== ')' ) {
		const start = scanner.pos;
		while (
			! scanner.isAtEnd() &&
			( isAlnum( scanner.peek() ) || scanner.peek() === '_' )
		) {
			scanner.advance();
		}
		const argName = scanner.input.slice( start, scanner.pos );
		scanner.skipWhitespace();
		if ( ! scanner.match( ':' ) ) {
			throw new ExpressionError(
				`Expected ':' after argument '${ argName }' in '${ name }()'.`
			);
		}
		args[ argName ] = parseInternal( scanner, depth + 1 );
		scanner.skipWhitespace();
		if ( scanner.peek() === ',' ) {
			scanner.advance();
			scanner.skipWhitespace();
		}
	}
	if ( ! scanner.match( ')' ) ) {
		throw new ExpressionError( `Expected ')' to close '${ name }()'.` );
	}
	return { call: name, args, returnType: 'any' };
}

const ESCAPES: Record< string, string > = { n: '\n', t: '\t', r: '\r' };

function parseStringLiteral( scanner: Scanner ): string {
	const quote = scanner.advance();
	let result = '';
	while ( ! scanner.isAtEnd() ) {
		const c = scanner.advance();
		if ( c === '\\' ) {
			const next = scanner.advance();
			result += ESCAPES[ next ] ?? next;
		} else if ( c === quote ) {
			return result;
		} else {
			result += c;
		}
	}
	return result;
}

function parseNumberLiteral( scanner: Scanner ): number {
	const start = scanner.pos;
	while (
		! scanner.isAtEnd() &&
		( isDigit( scanner.peek() ) || scanner.peek() === '.' )
	) {
		scanner.advance();
	}
	const text = scanner.input.slice( start, scanner.pos );
	if ( ! NUMBER_LITERAL.test( text ) ) {
		throw new ExpressionError( `Invalid number literal '${ text }'.` );
	}
	return Number( text );
}
