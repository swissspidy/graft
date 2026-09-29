/**
 * A sandboxed host the verifier drives: synthetic fixtures, capability
 * calls as fixture users, host state for assertions. It never touches
 * tenant data. Implemented by each host adapter.
 */
export interface Sandbox {
	/** Removes everything a previous check created. */
	reset(): Promise<void>;
	/** Seeds fixtures (host-specific shape); returns the roles of each user alias. */
	seed(fixtures: Record<string, unknown>): Promise<{ users: Record<string, string[]> }>;
	/** Which of the scopes the user can use with the host's own permissions. */
	scopes(user: string, scopes: string[]): Promise<Record<string, boolean>>;
	/** Runs a capability as a user. Rejects with a SandboxCallError when the host refuses. */
	call(user: string, capability: string, input: unknown): Promise<unknown>;
	/**
	 * Slot props for every place the slot renders for the user: one entry
	 * for owned slots, one per row for row-level extension slots.
	 */
	slotInstances(user: string, slot: string): Promise<Array<Record<string, unknown>>>;
	/**
	 * Evaluates a host assertion from a check (an expectation key the core
	 * does not know, such as `post`). Returns whether it holds and what was
	 * found.
	 */
	assert(kind: string, expected: unknown): Promise<{ ok: boolean; actual: unknown }>;
}

export class SandboxCallError extends Error {
	constructor(
		readonly code: string,
		message: string,
	) {
		super(message);
		this.name = 'SandboxCallError';
	}
}
