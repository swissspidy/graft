const ID_MARKER = /\s*\{#([^}\s]*)\}\s*$/;
export const CRITERION_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_DERIVED_LENGTH = 48;

/** Splits a trailing `{#id}` marker off a criterion. */
export function splitIdMarker(text: string): { text: string; id?: string } {
	const match = ID_MARKER.exec(text);
	if (!match) {
		return { text: text.trim() };
	}
	return { text: text.slice(0, match.index).trim(), id: match[1] ?? '' };
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
