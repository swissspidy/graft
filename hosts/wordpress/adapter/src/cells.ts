/**
 * Table cells, shared by the client components and the verifier's
 * semantics so both read a row the same way.
 */

export interface Field {
	id: string;
	label: string;
	type?: string;
	primary?: boolean;
	/** Computed per row, instead of reading `id` from it. */
	value?: unknown;
	/** Computed per row: success, warning, error or info. */
	tone?: unknown;
}

export type Tone = 'success' | 'warning' | 'error' | 'info';

const tones = new Set<unknown>(['success', 'warning', 'error', 'info']);

const statusLabels: Record<string, string> = {
	publish: 'Published',
	future: 'Scheduled',
	draft: 'Draft',
	pending: 'Pending',
	private: 'Private',
};

export function readPath(row: unknown, path: string): unknown {
	return path.split('.').reduce<unknown>((value, key) => (value && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined), row);
}

export function formatValue(value: unknown, type = 'text', locale?: string): string {
	if (value === undefined || value === null || value === '') {
		return '—';
	}
	if ((type === 'date' || type === 'datetime') && typeof value === 'string') {
		const date = new Date(value);
		if (!Number.isNaN(date.getTime())) {
			return new Intl.DateTimeFormat(locale, {
				dateStyle: 'medium',
				...(type === 'datetime' ? { timeStyle: 'short' } : {}),
			}).format(date);
		}
	}
	if (type === 'status' && typeof value === 'string') {
		return statusLabels[value] ?? value;
	}
	return String(value);
}

/**
 * One cell of a row. `field` is the field as written in the build, so its
 * `value` and `tone` are still expressions, evaluated here against the row.
 */
export function cell(field: Field, row: unknown, evaluate: (value: unknown, row: unknown) => unknown, locale?: string): { text: string; tone?: Tone } {
	const value = field.value === undefined ? readPath(row, field.id) : evaluate(field.value, row);
	const tone = field.tone === undefined ? undefined : evaluate(field.tone, row);
	return { text: formatValue(value, field.type, locale), ...(tones.has(tone) ? { tone: tone as Tone } : {}) };
}
