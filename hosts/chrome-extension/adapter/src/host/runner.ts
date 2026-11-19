import {
	compileSchema,
	describeWhen,
	extractRefs,
	intervalSeconds,
	runTrigger,
	triggerCallRefusal,
	triggerLimit,
	triggerScopes,
	type Schedule,
	type Surface,
	type TriggerRun,
} from '@swissspidy/graft-core';
import { guarded, unservable, type GatewayHooks, type Installed, type Perform } from './gateway.ts';
import { CallError } from './http.ts';

/**
 * Triggers in the extension (ADR 0010, ADR 0015): a build's scheduled
 * triggers run from the service worker, woken by `chrome.alarms`. There
 * is no other identity in a browser profile than the person's, so a
 * trigger acts with the extension's access, but only as far as the grant
 * approved for that trigger, through the same gateway checks as on
 * WordPress: the trigger uses the capability, the surface lets triggers
 * use it, the grant covers its scopes, the input matches.
 *
 * Everything here is pure or takes its I/O as arguments, so the schedule
 * and the bounds are unit-tested without Chrome.
 */

/** What the extension keeps per trigger. */
export interface TriggerState {
	/** The spec version the state is for: a new version starts afresh. */
	specHash: string;
	lastRun?: number;
	nextRun?: number;
	/** Failed runs in a row. */
	failures: number;
	paused?: { at: string; reason: string };
	/** Ids of targets acted on, for `once`. */
	handled: string[];
}

/** Failed runs in a row after which a trigger pauses itself. */
export const PAUSE_AFTER_FAILURES = 3;

const DAY = 24 * 60 * 60 * 1000;

/** The key of a customization's trigger in the extension's state. */
export const triggerKey = (customization: string, trigger: string) => `${customization}/${trigger}`;

/**
 * When a schedule next runs after `from`: an interval later; for days `at`
 * a time (the browser's time zone), that time on the day the interval
 * lands on, or the first such time after `from` when it never ran.
 */
export function nextRun(schedule: Schedule, from: number, ranBefore: boolean): number {
	const seconds = intervalSeconds(schedule);
	if (!schedule.at) {
		return from + seconds * 1000;
	}
	const [hours, minutes] = schedule.at.split(':').map(Number) as [number, number];
	const at = new Date(from);
	at.setHours(hours, minutes, 0, 0);
	if (ranBefore) {
		at.setDate(at.getDate() + Math.max(1, Math.round((seconds * 1000) / DAY)));
	} else if (at.getTime() <= from) {
		at.setDate(at.getDate() + 1);
	}
	return at.getTime();
}

/** A trigger's state, fresh or carried over from the same spec version. */
export function stateFor(installed: Installed, trigger: string, states: Record<string, TriggerState>): TriggerState {
	const previous = states[triggerKey(installed.id, trigger)];
	return previous && previous.specHash === installed.specHash ? previous : { specHash: installed.specHash, failures: 0, handled: [] };
}

/** Why a customization's trigger may not run on this surface now, or undefined when it may. */
export async function unrunnable(installed: Installed, surface: Surface, id: string): Promise<string | undefined> {
	if (!surface.triggers) {
		return 'This app does not run customizations on their own.';
	}
	const trigger = installed.build.triggers?.[id];
	if (!trigger || !installed.manifest.triggers?.[id]) {
		return `It has no trigger "${id}".`;
	}
	const blocked = await unservable(installed, surface);
	if (blocked) {
		return blocked;
	}
	if (!trigger.schedule) {
		return 'Only scheduled triggers run in the browser yet.';
	}
	const grant = installed.triggerGrants?.[id] ?? [];
	const missing = triggerScopes(trigger, surface).filter((scope) => !grant.includes(scope));
	if (missing.length > 0) {
		return `It needs permissions that were not approved for it: ${missing.join(', ')}.`;
	}
	const refs = extractRefs(installed.build, surface).triggers;
	const unattended = (refs?.capabilities ?? []).filter((name) => !surface.triggers!.capabilities.includes(name));
	if (unattended.length > 0) {
		return `It calls what may not run on its own: ${unattended.join(', ')}.`;
	}
	return undefined;
}

/** The scheduled triggers that are due at `now`, with the state each runs from. */
export async function dueTriggers(
	list: Installed[],
	surfaceFor: (installed: Installed) => Surface | undefined,
	states: Record<string, TriggerState>,
	now: number,
): Promise<Array<{ installed: Installed; surface: Surface; trigger: string; state: TriggerState }>> {
	const due = [];
	for (const installed of list) {
		const surface = surfaceFor(installed);
		for (const [trigger, declared] of Object.entries(installed.build.triggers ?? {})) {
			if (!surface || !declared.schedule || (await unrunnable(installed, surface, trigger))) {
				continue;
			}
			const state = stateFor(installed, trigger, states);
			if (state.paused) {
				continue;
			}
			// A new trigger waits for its first slot after it was approved, instead of running at once.
			const next = state.nextRun ?? nextRun(declared.schedule, Date.parse(installed.approvedAt ?? new Date(now).toISOString()), false);
			if (next <= now) {
				due.push({ installed, surface, trigger, state });
			}
		}
	}
	return due;
}

export interface RunOptions extends GatewayHooks {
	installed: Installed;
	surface: Surface;
	trigger: string;
	perform: Perform;
	state: TriggerState;
	now: number;
	dryRun?: boolean;
}

/** Runs a trigger once through the gateway, and returns the run with the trigger's state after it. */
export async function runInstalledTrigger(options: RunOptions): Promise<{ run: TriggerRun; state: TriggerState }> {
	const { installed, surface, now } = options;
	const trigger = installed.build.triggers![options.trigger]!;
	const grant = installed.triggerGrants?.[options.trigger] ?? [];
	const handled = new Set(options.state.handled);
	const run = await runTrigger({
		id: options.trigger,
		trigger,
		limit: triggerLimit(installed.manifest.triggers?.[options.trigger], surface),
		now,
		handled,
		...(options.dryRun ? { dryRun: true } : {}),
		call: (capability, input) => {
			const declared = surface.capabilities[capability];
			const value = input ?? {};
			const code = triggerCallRefusal(trigger, capability, surface, grant);
			const refusal = code
				? new CallError(code, `"${options.trigger}" may not call "${capability}".`)
				: declared && !compileSchema(declared.input as object)(value)
					? new CallError('graft_invalid_input', `Invalid input for "${capability}".`)
					: undefined;
			return guarded(capability, declared, value, refusal, options.perform, options);
		},
	});
	if (options.dryRun) {
		return { run, state: options.state };
	}
	const failures = run.status === 'failed' ? options.state.failures + 1 : 0;
	const state: TriggerState = {
		...options.state,
		lastRun: now,
		nextRun: trigger.schedule ? nextRun(trigger.schedule, now, true) : now,
		failures,
		handled: [...handled],
		...(failures >= PAUSE_AFTER_FAILURES ? { paused: { at: new Date(now).toISOString(), reason: `It failed ${failures} times in a row: ${run.error ?? run.calls.find((c) => !c.ok)?.error ?? 'see its runs'}` } } : {}),
	};
	return { run, state };
}

/** A trigger as the options page shows it, in plain language. */
export function describeTrigger(installed: Installed, surface: Surface | undefined, id: string): { when: string; limit: number; may: string[] } {
	const trigger = installed.build.triggers?.[id];
	const declared = installed.manifest.triggers?.[id];
	return {
		when: trigger ? describeWhen(trigger, surface) : 'never',
		limit: surface ? triggerLimit(declared, surface) : (declared?.limit ?? 0),
		may: (declared?.permissions ?? []).map((scope) => surface?.scopes[scope]?.title ?? scope),
	};
}
