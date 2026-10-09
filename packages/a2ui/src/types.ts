import type { Build, EventBinding } from '@graft/core';

export type { EventBinding };

/** One A2UI component as written in a build: an id, its type, its properties. */
export interface A2UIComponent {
	id: string;
	component: string;
	[property: string]: unknown;
}

/** A build's UI as an A2UI v0.9 surface. */
export interface A2UISurface {
	protocol: string;
	catalogId: string;
	/** Data model values set when the surface is drawn, as A2UI values (a form seeded from the slot). */
	initial?: Record<string, unknown>;
	/** Data model values recomputed whenever the model changes (a filtered list), as A2UI values. */
	computed?: Record<string, unknown>;
	components: A2UIComponent[];
	[key: string]: unknown;
}

/**
 * A Graft build with its UI as an A2UI surface (`ui`), and `events`
 * binding each action event to a capability call. No agent runs: the
 * Graft runtime plays the A2UI server.
 */
export interface A2UIBuild extends Omit<Build, 'ui'> {
	ui: A2UISurface;
	events: Record<string, EventBinding>;
}

export const isA2UIBuild = (build: unknown): build is A2UIBuild =>
	typeof build === 'object' && build !== null && 'ui' in build && typeof (build as { ui?: unknown }).ui === 'object';
