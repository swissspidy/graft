/**
 * A Table field as the cells read it: `id` is a JSON Pointer into the row
 * ("author/name"), so its value is that binding unless it computes one.
 */
export function tableField<T extends { id: string; value?: unknown }>(field: T): T {
	return field.value === undefined ? { ...field, value: { path: field.id } } : field;
}
