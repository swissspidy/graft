import type { Check } from '../build/types.ts';

export interface Assembled<T> {
	value?: T;
	problems: string[];
}

function parseJson(text: unknown, what: string, problems: string[]): unknown {
	if (typeof text !== 'string') {
		problems.push(`${what} must be a JSON string.`);
		return undefined;
	}
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		problems.push(`${what} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
		return undefined;
	}
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Criteria the model flagged as not objectively checkable. */
export function assembleUnverifiable(output: unknown): Array<{ criterion: string; reason: string }> {
	const items = isObject(output) && Array.isArray(output.unverifiable) ? output.unverifiable : [];
	return items
		.filter((item): item is { criterion: string; reason: string } => isObject(item) && typeof item.criterion === 'string')
		.map((item) => ({ criterion: item.criterion, reason: String(item.reason ?? '') }));
}

/** Turns the model's checks output into checks. */
export function assembleChecks(output: unknown): Assembled<Check[]> {
	const problems: string[] = [];
	const items = isObject(output) && Array.isArray(output.checks) ? output.checks : null;
	if (!items) {
		return { problems: ['The output must be an object with a "checks" array.'] };
	}
	const checks: Check[] = [];
	items.forEach((item: Record<string, unknown>, i: number) => {
		const where = `Check ${i + 1} (${String(item.criterion)})`;
		const fixtures = parseJson(item.fixtures_json, `${where} fixtures_json`, problems);
		const steps = parseJson(item.steps_json, `${where} steps_json`, problems);
		const expect = parseJson(item.expect_json, `${where} expect_json`, problems);
		if (fixtures !== undefined && !isObject(fixtures)) {
			problems.push(`${where}: fixtures must be an object.`);
		}
		if (steps !== undefined && !Array.isArray(steps)) {
			problems.push(`${where}: steps must be an array.`);
		}
		if (expect !== undefined && (!Array.isArray(expect) || expect.length === 0 || !expect.every(isObject))) {
			problems.push(`${where}: expect must be a non-empty array of objects.`);
		}
		const check: Check = { criterion: String(item.criterion), expect: (expect ?? []) as Check['expect'] };
		if (isObject(fixtures)) {
			check.fixtures = fixtures;
		}
		if (typeof item.view_as === 'string' && item.view_as) {
			check.view_as = item.view_as;
		}
		if (typeof item.advance_days === 'number' && item.advance_days > 0) {
			check.clock = { advanceDays: item.advance_days };
		}
		if (Array.isArray(steps) && steps.length > 0) {
			check.steps = steps as Check['steps'];
		}
		checks.push(check);
	});
	return problems.length > 0 ? { problems } : { value: checks, problems };
}
