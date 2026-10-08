/**
 * A small Unicode TR35 date pattern formatter covering the tokens agents
 * commonly emit (`yyyy`, `MMMM`, `EEEE`, `h:mm a`, ...). Literal text goes in
 * single quotes. Unknown letters are passed through unchanged.
 */

const pad = ( n: number, width = 2 ) => String( n ).padStart( width, '0' );

const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
];
const DAYS = [
	'Sunday',
	'Monday',
	'Tuesday',
	'Wednesday',
	'Thursday',
	'Friday',
	'Saturday',
];

function truncateName( name: string, style: 'long' | 'short' | 'narrow' ) {
	if ( style === 'long' ) {
		return name;
	}
	return name.slice( 0, style === 'short' ? 3 : 1 );
}

function formatToken( token: string, date: Date, locale?: string ): string {
	const letter = token[ 0 ];
	const count = token.length;
	const monthName = ( style: 'long' | 'short' | 'narrow' ) => {
		if ( locale ) {
			return date.toLocaleString( locale, { month: style } );
		}
		return truncateName( MONTHS[ date.getMonth() ], style );
	};
	const dayName = ( style: 'long' | 'short' | 'narrow' ) => {
		if ( locale ) {
			return date.toLocaleString( locale, { weekday: style } );
		}
		return truncateName( DAYS[ date.getDay() ], style );
	};

	switch ( letter ) {
		case 'y':
		case 'Y':
			return count === 2
				? pad( date.getFullYear() % 100 )
				: pad( date.getFullYear(), count );
		case 'M':
		case 'L':
			if ( count >= 5 ) {
				return monthName( 'narrow' );
			}
			if ( count === 4 ) {
				return monthName( 'long' );
			}
			if ( count === 3 ) {
				return monthName( 'short' );
			}
			return count === 2
				? pad( date.getMonth() + 1 )
				: String( date.getMonth() + 1 );
		case 'd':
			return count === 2
				? pad( date.getDate() )
				: String( date.getDate() );
		case 'E':
		case 'c':
			if ( count >= 5 ) {
				return dayName( 'narrow' );
			}
			if ( count === 4 ) {
				return dayName( 'long' );
			}
			return dayName( 'short' );
		case 'H':
			return count === 2
				? pad( date.getHours() )
				: String( date.getHours() );
		case 'h': {
			const h = date.getHours() % 12 || 12;
			return count === 2 ? pad( h ) : String( h );
		}
		case 'm':
			return count === 2
				? pad( date.getMinutes() )
				: String( date.getMinutes() );
		case 's':
			return count === 2
				? pad( date.getSeconds() )
				: String( date.getSeconds() );
		case 'S':
			return pad( date.getMilliseconds(), 3 ).slice( 0, count );
		case 'a':
			return date.getHours() < 12 ? 'AM' : 'PM';
		case 'D': {
			const start = new Date( date.getFullYear(), 0, 0 );
			return String(
				Math.floor( ( date.getTime() - start.getTime() ) / 86400000 )
			);
		}
		case 'z':
		case 'Z':
		case 'X':
		case 'x': {
			const offset = -date.getTimezoneOffset();
			const sign = offset >= 0 ? '+' : '-';
			return `${ sign }${ pad( Math.floor( Math.abs( offset ) / 60 ) ) }:${ pad( Math.abs( offset ) % 60 ) }`;
		}
		default:
			return token;
	}
}

export function formatDatePattern(
	date: Date,
	pattern: string,
	locale?: string
): string {
	let out = '';
	let i = 0;
	while ( i < pattern.length ) {
		const char = pattern[ i ];
		if ( char === "'" ) {
			if ( pattern[ i + 1 ] === "'" ) {
				out += "'";
				i += 2;
				continue;
			}
			const end = pattern.indexOf( "'", i + 1 );
			out +=
				end === -1
					? pattern.slice( i + 1 )
					: pattern.slice( i + 1, end );
			i = end === -1 ? pattern.length : end + 1;
			continue;
		}
		if ( /[A-Za-z]/.test( char ) ) {
			let j = i;
			while ( j < pattern.length && pattern[ j ] === char ) {
				j++;
			}
			out += formatToken( pattern.slice( i, j ), date, locale );
			i = j;
			continue;
		}
		out += char;
		i++;
	}
	return out;
}
