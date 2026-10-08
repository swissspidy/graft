/** Replaces `{"$context": key}` in an event's input with the event's resolved context. */
export function withContext(value: unknown, context: Record<string, unknown>): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => withContext(item, context));
	}
	if (value && typeof value === 'object') {
		const object = value as Record<string, unknown>;
		if (typeof object.$context === 'string' && Object.keys(object).length === 1) {
			return context[object.$context] ?? null;
		}
		return Object.fromEntries(Object.entries(object).map(([key, inner]) => [key, withContext(inner, context)]));
	}
	return value;
}
