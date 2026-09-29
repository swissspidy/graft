/**
 * Removes a row from the arrays in a data source result, matching by
 * identity or by `id`. Rows that stay are not searched, so nested records
 * that happen to share the id are left alone. Used for `remove-row:` by
 * renderers and the verifier alike.
 */
export function removeRow(value: unknown, row: unknown): unknown {
	const id = typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined;
	const matches = (item: unknown) =>
		item === row || (id !== undefined && typeof item === 'object' && item !== null && (item as { id?: unknown }).id === id);
	if (Array.isArray(value)) {
		return value.filter((item) => !matches(item));
	}
	if (typeof value === 'object' && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, removeRow(item, row)]));
	}
	return value;
}
