import type { TriggerRun } from '@swissspidy/graft-core';
import type { ViewNode } from '../host/a2ui.ts';
import type { Activity } from '../host/activity.ts';
import type { Anchor } from '../host/surface.ts';

/**
 * Messages between the content script, the extension's pages (options,
 * side panel) and the service worker. Content scripts only ever name a
 * customization, a button key and the state they were given; the service
 * worker decides the rest. The extension's own pages may also approve,
 * undo and control triggers, which no content script can.
 */

export type ContentMessage =
	| { type: 'mounts' }
	| { type: 'render'; id: string; state?: Record<string, unknown> }
	| { type: 'act'; id: string; key: string; state?: Record<string, unknown> }
	| { type: 'anchor'; slot: string; status: 'moved' | 'broken'; reason: string };

export type PanelMessage =
	| { type: 'panel-mounts' }
	| { type: 'panel-render'; id: string; state?: Record<string, unknown> }
	| { type: 'panel-act'; id: string; key: string; state?: Record<string, unknown> };

export type OptionsMessage =
	| { type: 'list' }
	| { type: 'approve'; id: string }
	| { type: 'revoke'; id: string }
	| { type: 'activity' }
	| { type: 'undo'; entry: string }
	| { type: 'trigger'; id: string; trigger: string; op: 'pause' | 'resume' | 'run' | 'dry-run' }
	| { type: 'pause-all'; paused: boolean };

export type PageMessage = PanelMessage | OptionsMessage;

export interface MountInfo {
	id: string;
	title: string;
	slot: string;
	anchor: Anchor;
}

export interface PanelInfo {
	id: string;
	title: string;
}

export interface RenderReply {
	view: ViewNode[];
	state: Record<string, unknown>;
	notice?: { tone: 'success' | 'error'; text: string };
}

/** A trigger as the options page lists it. */
export interface ListedTrigger {
	id: string;
	/** "every day", in words. */
	when: string;
	limit: number;
	/** The permissions approved for it, in words. */
	may: string[];
	/** Why it does not run, when it does not (waiting for approval, paused, ...). */
	blocked?: string;
	paused?: string;
	lastRun?: string;
	nextRun?: string;
}

/** A customization as the options page lists it. */
export interface Listed {
	id: string;
	title: string;
	/** Where it came from. */
	from: string;
	slot: string;
	permissions: Array<{ scope: string; title: string }>;
	criteria: Array<{ text: string; checks: string[] }>;
	approved: boolean;
	/** Why it is not served, if it is not. */
	blocked?: string;
	triggers: ListedTrigger[];
	/** Who its triggers act as, in words. */
	identity?: string;
}

/** One run of a trigger, as the extension records it. */
export interface RunRecord {
	at: string;
	customization: string;
	title: string;
	trigger: string;
	how: 'schedule' | 'manual' | 'dry-run';
	run: TriggerRun;
}

/** The activity page of the options page: newest first. */
export interface ActivityReply {
	activity: Array<Activity & { canUndo: boolean; text: string }>;
	runs: RunRecord[];
	paused: boolean;
}

/** What the service worker noticed about the app drifting from its surface. */
export interface DriftEvent {
	at: string;
	kind: 'slot' | 'capability';
	symbol: string;
	url: string;
	details: string[];
}

export type Reply<T> = { ok: true; value: T } | { ok: false; error: string };
