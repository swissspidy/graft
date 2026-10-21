import type { SpecTrigger } from '../spec/types.ts';
import type { Surface } from '../surface/types.ts';
import { evaluate } from './evaluate.ts';
import { getPath } from './expressions.ts';
import type { Build, Schedule, Trigger, TriggerRefs } from './types.ts';

/**
 * Triggers (ADR 0010): what a build does without a viewer. This module is
 * host-agnostic and has no I/O: intervals, the scopes and refs a trigger
 * needs, the gateway's checks for a trigger's calls, plain-language
 * descriptions, and one run of a trigger over an injected `call`. Hosts
 * written in TypeScript run triggers with it; the verifier's fake hosts do
 * too. The WordPress plugin runs the same steps in PHP.
 */

const HOUR = 60 * 60;
const DAY = 24 * HOUR;

/** Seconds between runs of a schedule (`"6h"`, `"1d"`), or NaN when it is not one. */
export function intervalSeconds(schedule: Schedule): number {
	const match = /^([1-9][0-9]{0,2})([hd])$/.exec(schedule.every);
	return match ? Number(match[1]) * (match[2] === 'd' ? DAY : HOUR) : Number.NaN;
}

/** Capabilities a trigger calls: its targets' read and its action. */
export function triggerCapabilities(trigger: Trigger): string[] {
	return [...new Set([...(trigger.targets ? [trigger.targets.call] : []), trigger.call])].sort();
}

/** Scopes a trigger's calls need, from the surface's capabilities. */
export function triggerScopes(trigger: Trigger, surface: Surface): string[] {
	return [...new Set(triggerCapabilities(trigger).flatMap((name) => surface.capabilities[name]?.scopes ?? []))].sort();
}

/** What a build's triggers use, or undefined when it has none. */
export function triggerRefs(build: Build, surface: Surface): TriggerRefs | undefined {
	const triggers = Object.values(build.triggers ?? {});
	if (triggers.length === 0) {
		return undefined;
	}
	return {
		events: [...new Set(triggers.flatMap((t) => (t.event ? [t.event] : [])))].sort(),
		capabilities: [...new Set(triggers.flatMap(triggerCapabilities))].sort(),
		scopes: [...new Set(triggers.flatMap((t) => triggerScopes(t, surface)))].sort(),
	};
}

/** The per-run cap: the spec's limit, at most the surface's. */
export function triggerLimit(specTrigger: SpecTrigger | undefined, surface: Surface): number {
	const max = surface.triggers?.maxPerRun ?? 1;
	return Math.min(specTrigger?.limit ?? max, max);
}

/**
 * The gateway's checks for a call a trigger makes, in order: the trigger
 * uses the capability, the host lets triggers use it, and the trigger's
 * grant covers its scopes. Returns the refusal code, or undefined when the
 * call may go ahead (the host's own permission check still runs).
 */
export function triggerCallRefusal(trigger: Trigger, capability: string, surface: Surface, grant: string[]): string | undefined {
	if (!triggerCapabilities(trigger).includes(capability)) {
		return 'graft_capability_not_in_trigger';
	}
	const declared = surface.capabilities[capability];
	if (!declared || !surface.triggers?.capabilities.includes(capability)) {
		return 'graft_capability_not_unattended';
	}
	if (!declared.scopes.every((scope) => grant.includes(scope))) {
		return 'graft_not_granted';
	}
	return undefined;
}

/** When a trigger runs, in plain language: "every day at 09:00", "when a post is published". */
export function describeWhen(trigger: Pick<Trigger, 'schedule' | 'event'>, surface?: Surface): string {
	if (trigger.event) {
		const title = surface?.triggers?.events[trigger.event]?.title;
		return title ? `when ${title.charAt(0).toLowerCase()}${title.slice(1)}` : `on "${trigger.event}"`;
	}
	const schedule = trigger.schedule;
	const match = schedule ? /^(\d+)([hd])$/.exec(schedule.every) : null;
	if (!schedule || !match) {
		return 'never';
	}
	const n = Number(match[1]);
	const unit = match[2] === 'd' ? 'day' : 'hour';
	const every = n === 1 ? `every ${unit}` : `every ${n} ${unit}s`;
	return schedule.at ? `${every} at ${schedule.at}` : every;
}

/** A target as a run reports it: its id and title, when it has them. */
export interface RunTarget {
	id?: string | number;
	title?: string;
}

export interface TriggerCall {
	target: RunTarget;
	input: unknown;
	ok: boolean;
	/** Why the call failed: the refusal or host error. */
	error?: string;
}

/** What one run of a trigger did. */
export interface TriggerRun {
	trigger: string;
	/** ok: every call went through; partial: some failed; failed: the targets could not be read, or every call failed. */
	status: 'ok' | 'partial' | 'failed' | 'dry-run';
	/** Targets read (or 1, the event's subject). */
	targets: number;
	/** Targets the condition held for and that were not acted on before (`once`). */
	matched: number;
	/** Matched targets over the per-run cap, left for the next run. */
	skipped: number;
	/** The calls made (or, in a dry run, planned), in order. */
	calls: TriggerCall[];
	error?: string;
}

export interface RunTriggerOptions {
	id: string;
	trigger: Trigger;
	/** Calls a capability through the host's gateway as the service identity; rejects when refused. */
	call(capability: string, input: unknown): Promise<unknown>;
	/** Most calls this run makes. */
	limit: number;
	/** The run's clock, in ms since the epoch (`$daysSince` counts to it). Default: now. */
	now?: number;
	/** An event trigger's subject: its one target. */
	subject?: unknown;
	/** Ids of targets acted on before, for `once`; ids acted on in this run are added. */
	handled?: Set<string>;
	/** Plan the calls without making them. */
	dryRun?: boolean;
	/** Describes a rejected call. Default: the error's message. */
	describeError?(error: unknown): string;
}

/**
 * Runs a trigger once: reads its targets (or takes the event's subject),
 * keeps those its condition holds for, and calls its capability once per
 * target, up to the cap. A failed call does not stop the run.
 */
export async function runTrigger(options: RunTriggerOptions): Promise<TriggerRun> {
	const { id, trigger, limit } = options;
	const describe = options.describeError ?? ((error: unknown) => (error instanceof Error ? error.message : String(error)));
	const now = options.now ?? Date.now();
	const ctx = (target: unknown) => ({ data: {}, slot: {}, can: () => false, now, target });
	const run: TriggerRun = { trigger: id, status: options.dryRun ? 'dry-run' : 'ok', targets: 0, matched: 0, skipped: 0, calls: [] };

	let targets: unknown[];
	if (trigger.targets) {
		try {
			const result = await options.call(trigger.targets.call, evaluate(trigger.targets.input, ctx(undefined)) ?? null);
			const items = getPath(result, trigger.targets.items ?? 'items');
			if (!Array.isArray(items)) {
				throw new Error(`"${trigger.targets.call}" did not return a list at "${trigger.targets.items ?? 'items'}"`);
			}
			targets = items;
		} catch (error) {
			return { ...run, status: 'failed', error: `Reading the targets failed: ${describe(error)}` };
		}
	} else {
		targets = options.subject === undefined ? [] : [options.subject];
	}
	run.targets = targets.length;

	const matched = targets.filter((target) => {
		if (trigger.once && options.handled?.has(targetKey(target))) {
			return false;
		}
		return trigger.where === undefined || evaluate(trigger.where, ctx(target)) === true;
	});
	run.matched = matched.length;
	run.skipped = Math.max(0, matched.length - limit);

	for (const target of matched.slice(0, Math.max(0, limit))) {
		const input = evaluate(trigger.input, ctx(target)) ?? null;
		const entry: TriggerCall = { target: describeTarget(target), input, ok: true };
		if (!options.dryRun) {
			try {
				await options.call(trigger.call, input);
				if (trigger.once) {
					options.handled?.add(targetKey(target));
				}
			} catch (error) {
				entry.ok = false;
				entry.error = describe(error);
			}
		}
		run.calls.push(entry);
	}

	if (!options.dryRun) {
		const failed = run.calls.filter((c) => !c.ok).length;
		run.status = failed === 0 ? 'ok' : failed === run.calls.length ? 'failed' : 'partial';
	}
	return run;
}

/** The key `once` remembers a target by: its id. */
export function targetKey(target: unknown): string {
	const id = typeof target === 'object' && target !== null ? (target as { id?: unknown }).id : undefined;
	return id === undefined || id === null ? JSON.stringify(target) : String(id);
}

function describeTarget(target: unknown): RunTarget {
	if (typeof target !== 'object' || target === null) {
		return {};
	}
	const { id, title } = target as { id?: unknown; title?: unknown };
	const out: RunTarget = {};
	if (typeof id === 'string' || typeof id === 'number') {
		out.id = id;
	}
	if (typeof title === 'string') {
		out.title = title;
	}
	return out;
}
