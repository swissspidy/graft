import type { ViewNode } from '../host/a2ui.ts';
import type { Anchor } from '../host/surface.ts';

/**
 * Messages between the content script, the options page and the service
 * worker. Content scripts only ever name a customization, a button key and
 * the state they were given; the service worker decides the rest.
 */

export type ContentMessage =
	| { type: 'mounts' }
	| { type: 'render'; id: string; state?: Record<string, unknown> }
	| { type: 'act'; id: string; key: string; state?: Record<string, unknown> }
	| { type: 'anchor'; slot: string; status: 'moved' | 'broken'; reason: string };

export type OptionsMessage = { type: 'list' } | { type: 'approve'; id: string } | { type: 'revoke'; id: string };

export interface MountInfo {
	id: string;
	title: string;
	slot: string;
	anchor: Anchor;
}

export interface RenderReply {
	view: ViewNode[];
	state: Record<string, unknown>;
	notice?: { tone: 'success' | 'error'; text: string };
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
