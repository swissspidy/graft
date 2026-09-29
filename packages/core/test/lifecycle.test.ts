import { describe, expect, it } from 'vitest';
import { nextSpecState, specEvents, specLifecycle, type SpecState } from '../src/index.ts';

describe('spec lifecycle', () => {
	it('follows the happy path and the approval path', () => {
		expect(nextSpecState('draft', 'submit')).toBe('building');
		expect(nextSpecState('building', 'verified_within_grant')).toBe('active');
		expect(nextSpecState('building', 'verified_needs_grant')).toBe('needs_approval');
		expect(nextSpecState('needs_approval', 'approve')).toBe('active');
		expect(nextSpecState('active', 'supersede')).toBe('superseded');
	});

	it('rejects events that are not allowed', () => {
		expect(nextSpecState('draft', 'approve')).toBeUndefined();
		expect(nextSpecState('superseded', 'host_changed')).toBeUndefined();
		expect(specEvents('archived')).toEqual([]);
	});

	it('only uses declared states and reaches every state from the initial one', () => {
		const states = Object.keys(specLifecycle.states) as SpecState[];
		const reached = new Set<SpecState>([specLifecycle.initial]);
		for (let changed = true; changed; ) {
			changed = false;
			for (const t of specLifecycle.transitions) {
				expect(states).toContain(t.from);
				expect(states).toContain(t.to);
				if (reached.has(t.from) && !reached.has(t.to)) {
					reached.add(t.to);
					changed = true;
				}
			}
		}
		expect([...reached].sort()).toEqual([...states].sort());
	});

	it('is deterministic: one target per state and event', () => {
		const keys = specLifecycle.transitions.map((t) => `${t.from}:${t.event}`);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
