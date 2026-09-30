import type { Check } from '../build/types.ts';

/**
 * Renders a check as plain language, so an owner can confirm it matches
 * the criterion without reading JSON (ADR 0001, open question 1). Host
 * fixtures and assertions are described generically; hosts may pass
 * describers for their own kinds.
 */
export interface CheckDescribers {
	fixtures?(fixtures: Record<string, unknown>): string | undefined;
	assertion?(kind: string, expected: unknown): string | undefined;
}

function quote(value: unknown): string {
	return typeof value === 'string' ? `"${value}"` : JSON.stringify(value);
}

function list(items: string[]): string {
	if (items.length <= 1) {
		return items.join('');
	}
	return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function row(matcher: unknown): string {
	if (!matcher || typeof matcher !== 'object') {
		return '';
	}
	const entries = Object.entries(matcher as Record<string, unknown>);
	return entries.length ? ` on ${list(entries.map(([k, v]) => (k === 'title' ? quote(v) : `${k} ${quote(v)}`)))}` : '';
}

export function describeCheck(check: Check, describers: CheckDescribers = {}): string {
	const parts: string[] = [];
	const given = check.fixtures ? describers.fixtures?.(check.fixtures) : undefined;
	if (given) {
		parts.push(`Given ${given}`);
	}
	const later = check.clock?.advanceDays ? ` ${check.clock.advanceDays} day${check.clock.advanceDays === 1 ? '' : 's'} later` : '';
	parts.push(`${parts.length ? 'when' : 'When'} ${check.view_as ? `"${check.view_as}"` : 'the viewer'} opens it${later}`);
	for (const step of check.steps ?? []) {
		parts.push('fill' in step ? `and types ${quote(step.value)} into "${step.fill}"${row(step.row)}` : `and uses "${step.action}"${row(step.row)}`);
	}
	const outcomes = check.expect.map((e) => {
		if ('rows' in e) {
			const rows = e.rows as string[];
			return rows.length ? `the list shows exactly ${list(rows.map(quote))}` : 'the list is empty';
		}
		if ('columns' in e) {
			return `the columns are ${list((e.columns as string[]).map(quote))}`;
		}
		if ('text' in e) {
			return `the page says ${quote(e.text)}`;
		}
		if ('cell' in e) {
			const cell = e.cell as { row?: Record<string, unknown>; column?: string; text?: string; tone?: string };
			const shows = [cell.text !== undefined ? `shows ${quote(cell.text)}` : '', cell.tone !== undefined ? `is marked ${quote(cell.tone)}` : ''].filter(Boolean);
			return `the ${quote(cell.column)} cell${row(cell.row)} ${list(shows)}`;
		}
		if ('input' in e) {
			return `the "${String(e.input)}" field${row(e.row as Record<string, unknown> | undefined)} shows ${quote(e.value)}`;
		}
		if ('action' in e) {
			return `"${String(e.action)}"${row(e.row)} is ${e.available === false ? 'not available' : 'available'}`;
		}
		const [kind] = Object.keys(e);
		return (kind && describers.assertion?.(kind, e[kind])) ?? `${kind} matches ${JSON.stringify(e[kind!])}`;
	});
	return `${parts.join(', ')}, then ${list(outcomes)}.`;
}
