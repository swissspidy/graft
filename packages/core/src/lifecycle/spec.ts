import machine from '../../../../schemas/spec-lifecycle.json' with { type: 'json' };

export type SpecState =
	| 'draft'
	| 'building'
	| 'needs_approval'
	| 'active'
	| 'rejected'
	| 'upgrading'
	| 'suspended'
	| 'superseded'
	| 'archived';

export type SpecEvent =
	| 'submit'
	| 'verified_within_grant'
	| 'verified_needs_grant'
	| 'failed'
	| 'edit'
	| 'approve'
	| 'decline'
	| 'host_changed'
	| 'upgraded'
	| 'upgrade_needs_grant'
	| 'upgrade_failed'
	| 'retry'
	| 'supersede'
	| 'archive';

/** The shared transition table (schemas/spec-lifecycle.json). */
export const specLifecycle = machine as {
	initial: SpecState;
	states: Record<SpecState, string>;
	transitions: Array<{ from: SpecState; event: SpecEvent; to: SpecState }>;
};

/** The state after `event`, or undefined when the event is not allowed in `state`. */
export function nextSpecState(state: SpecState, event: SpecEvent): SpecState | undefined {
	return specLifecycle.transitions.find((t) => t.from === state && t.event === event)?.to;
}

/** Events allowed in a state. */
export function specEvents(state: SpecState): SpecEvent[] {
	return specLifecycle.transitions.filter((t) => t.from === state).map((t) => t.event);
}
