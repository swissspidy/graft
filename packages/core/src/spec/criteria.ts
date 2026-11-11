/**
 * A `{#id}` marker at the end of a text, and the text before it. Scanned
 * from the end: one pattern for "spaces, marker, spaces, end" backtracks
 * badly on a long run of spaces that no marker follows.
 */
export function trailingIdMarker(text: string): { head: string; id: string; marker: string } | undefined {
	const trimmed = text.trimEnd();
	const start = trimmed.endsWith('}') ? trimmed.lastIndexOf('{#') : -1;
	const id = start < 0 ? undefined : trimmed.slice(start + 2, -1);
	return id === undefined || /[}\s]/.test(id) ? undefined : { head: trimmed.slice(0, start).trimEnd(), id, marker: trimmed.slice(start) };
}
export const CRITERION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DERIVED_LENGTH = 48;

/** Splits a trailing `{#id}` marker off a criterion. */
export function splitIdMarker(text: string): { text: string; id?: string } {
	const found = trailingIdMarker(text);
	return found ? { text: found.head.trim(), id: found.id } : { text: text.trim() };
}

/**
 * Derives an id from normalized criterion text: lowercase ASCII words joined
 * by dashes, cut at a word boundary.
 */
export function deriveCriterionId(text: string): string {
	const words = text
		.normalize('NFKD')
		.replace(/[̀-ͯ]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
	let id = '';
	for (const word of words) {
		const next = id ? `${id}-${word}` : word;
		if (next.length > MAX_DERIVED_LENGTH) {
			break;
		}
		id = next;
	}
	return id || (words[0] ?? 'criterion').slice(0, MAX_DERIVED_LENGTH);
}
