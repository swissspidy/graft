import type { Surface } from '@swissspidy/graft-core';
import type { CallRecord } from './gateway.ts';
import { CallError } from './http.ts';
import { undoCall, type UndoCall } from './undo.ts';

/**
 * The extension's activity log: what customizations did and what the
 * gateway refused them, newest last, kept in the extension's storage and
 * shown on the options page. Every write is recorded, with how to undo it
 * when its capability says how; so is every refusal and every failed
 * call. Reads that went through are not: every page view makes them, and
 * the options page already says what each customization may read.
 */

/** Who made a call: the person, through a customization's view; a trigger; or the person undoing an earlier call. */
export type ActivitySource = { kind: 'view' } | { kind: 'trigger'; trigger: string } | { kind: 'undo'; of: string };

export interface Activity {
	id: string;
	/** ISO 8601. */
	at: string;
	customization: string;
	title: string;
	source: ActivitySource;
	/** The surface the call was made on, by hash; an undo runs on the same one. */
	surface: string;
	/** For an app, the origin the request went to; an undo goes there too. */
	origin?: string;
	capability: string;
	kind: 'read' | 'write';
	/** The capability's description, as the surface words it. */
	description?: string;
	/** The call's input as the log shows it, web addresses shortened; Undo uses `undo.input`, never this. */
	input: unknown;
	outcome: CallRecord['outcome'];
	code?: string;
	error?: string;
	/**
	 * How to put it back; `done` once it was, `error` when that failed.
	 * `started` marks an undo that ran and may have changed something,
	 * whose outcome was not saved: it is not offered again.
	 */
	undo?: UndoCall & { done?: string; error?: string; started?: string };
}

/** Most entries kept. */
export const ACTIVITY_LIMIT = 200;

/** Whether a call belongs in the log. */
export function worthRecording(record: CallRecord): boolean {
	return record.kind === 'write' || record.outcome !== 'ok';
}

let counter = 0;

/** A log entry for a call the gateway reported. */
export function activityFrom(
	record: CallRecord,
	where: { customization: string; title: string; source: ActivitySource; surface: Surface; origin?: string },
	now: number = Date.now(),
): Activity {
	const declared = where.surface.capabilities[record.capability];
	const undo = record.outcome === 'ok' && record.kind === 'write' ? undoCall(declared, record.input, record.output, where.surface.capabilities) : undefined;
	counter = (counter + 1) % 1_000_000;
	return {
		id: `${now.toString(36)}-${counter.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
		at: new Date(now).toISOString(),
		customization: where.customization,
		title: where.title,
		source: where.source,
		surface: where.surface.hash ?? '',
		...(where.origin ? { origin: where.origin } : {}),
		capability: record.capability,
		kind: record.kind,
		...(declared?.description ? { description: declared.description } : {}),
		// Kept as shown: an Undo has its own input (`undo`), so nothing needs the raw one.
		input: shown(record.input),
		outcome: record.outcome,
		...(record.code ? { code: record.code } : {}),
		...(record.error ? { error: record.error } : {}),
		...(undo ? { undo } : {}),
	};
}

/** The log with an entry added, the oldest dropped past the limit. */
export function appendActivity(log: Activity[], entry: Activity, limit: number = ACTIVITY_LIMIT): Activity[] {
	return [...log, entry].slice(-limit);
}

/** Why an entry cannot be undone now, or undefined when it can. */
export function undoRefusal(entry: Activity | undefined, surface: Surface | undefined): string | undefined {
	if (!entry?.undo) {
		return 'There is nothing to undo there.';
	}
	if (entry.undo.done) {
		return 'It was undone already.';
	}
	if (entry.undo.started) {
		return 'It is being undone, or was, and the result could not be saved.';
	}
	if (!surface || surface.hash !== entry.surface) {
		return 'The extension no longer has the version of the app this was done on.';
	}
	const original = surface.capabilities[entry.capability];
	const reverse = surface.capabilities[entry.undo.capability];
	if (!original || !reverse || reverse.kind !== 'write') {
		return 'This version of the app has no way to undo it.';
	}
	// Never more than the original needed, which was approved when the call was made.
	if (!reverse.scopes.every((scope) => original.scopes.includes(scope))) {
		return 'Undoing it would need a permission the original did not.';
	}
	return undefined;
}

/** A web address as the log shows it: without its query and fragment, which can hold tokens. */
function shortUrl(value: string): string {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:' ? `${url.origin}${url.pathname}${url.search || url.hash ? '…' : ''}` : value;
	} catch {
		return value;
	}
}

/** An input with its web addresses shortened, as the log keeps inputs nothing needs in full. */
export const shownInput = (value: Record<string, unknown>): Record<string, unknown> => shown(value) as Record<string, unknown>;

const shown = (value: unknown): unknown =>
	typeof value === 'string' ? shortUrl(value) : Array.isArray(value) ? value.map(shown) : typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shown(v)])) : value;

/** A call in words: the capability's description and its input, with web addresses shortened. */
export function describeActivity(entry: Pick<Activity, 'description' | 'capability' | 'input'>): string {
	const what = entry.description ?? entry.capability;
	const input = JSON.stringify(shown(entry.input));
	return input && input !== '{}' && input !== 'null' ? `${what} (${input})` : what;
}

/** Refusals by the host that are known to change nothing: the app said no before acting, or the tab was gone. */
const HOST_REFUSALS = new Set(['host_unauthorized', 'host_forbidden', 'host_not_found']);

/**
 * Whether a failed call is known to have changed nothing, so it may be
 * tried again: the gateway's own refusals (before any request), and the
 * host's refusals above. Not an unreachable host, an answer that does not
 * match (drift), or any other host error such as a 500, which can come
 * after the change took effect.
 */
export function changedNothing(error: unknown): boolean {
	if (!(error instanceof CallError)) {
		return false;
	}
	return (error.code.startsWith('graft_') && error.code !== 'graft_drift') || HOST_REFUSALS.has(error.code);
}
