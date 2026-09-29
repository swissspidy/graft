import { extractRefs } from '../build/refs.ts';
import type { Build, Check } from '../build/types.ts';
import { validateBuild } from '../build/validate.ts';
import { buildHash } from '../compiler/compile.ts';
import type { Spec } from '../spec/types.ts';
import { canonicalJson, hashSurface } from '../surface/hash.ts';
import type { Surface } from '../surface/types.ts';
import type { Verification } from '../verifier/run.ts';
import { applyMigrations } from './migrate.ts';
import { reanchor } from './reanchor.ts';
import { staticCheck, type LadderStart, type RefChange } from './static-check.ts';

export type UpgradeOutcome = 'survived' | 'migrated' | 'reanchored' | 'regenerated' | 'needs_approval' | 'failed';

/**
 * The upgrade ladder (ADR 0001, section 7) as data: rungs in order of
 * increasing cost and decreasing fidelity to the accepted build, each with
 * the state its candidate is verified in and the outcome when it passes.
 */
export const UPGRADE_LADDER: ReadonlyArray<{ rung: LadderStart; verify: string; outcome: UpgradeOutcome }> = [
	{ rung: 'reverify', verify: 'reverify', outcome: 'survived' },
	{ rung: 'migrate', verify: 'verify_migrated', outcome: 'migrated' },
	{ rung: 'reanchor', verify: 'verify_reanchored', outcome: 'reanchored' },
	{ rung: 'regenerate', verify: 'verify_regenerated', outcome: 'regenerated' },
];

export interface UpgradeStep {
	state: string;
	note: string;
}

export interface UpgradeOptions {
	build: Build;
	spec: Spec;
	specHash: string;
	/** Scopes currently granted to the spec version. */
	grant: string[];
	from: Surface;
	to: Surface;
	/** Runs a candidate's frozen checks on the new host, simulating `grant`. */
	verify(build: Build, grant: string[]): Promise<Verification>;
	/** Compiles the spec anew for `to`, reusing the frozen checks. Without it the rung does not apply. */
	regenerate?(args: { previous: Build; checks: Check[]; surface: Surface }): Promise<Build | undefined>;
	/** Picks a slot when re-anchoring has several candidates. */
	chooseSlot?(candidates: string[], build: Build): Promise<string | undefined>;
}

export interface UpgradeResult {
	outcome: UpgradeOutcome;
	/** The build to serve on the new surface (or to approve). */
	build?: Build;
	verification?: Verification;
	changes: RefChange[];
	/** Scopes the new build needs beyond the grant (needs_approval). */
	extraScopes?: string[];
	/** Every state the ladder went through, with what happened. */
	path: UpgradeStep[];
}

/**
 * Takes an active build from one surface to another: static check, then
 * rungs from the first applicable one, each candidate validated and
 * verified with the frozen checks. A failing rung escalates to the next.
 * A candidate that needs scopes outside the grant exits as needs_approval
 * (verified with the widened grant, so it is known to work once approved).
 */
export async function upgradeBuild(options: UpgradeOptions): Promise<UpgradeResult> {
	const { build, spec, from, to, grant } = options;
	const target: Surface = { ...to, hash: to.hash ?? (await hashSurface(to)) };
	const check = staticCheck(build, from, target);
	const path: UpgradeStep[] = [
		{
			state: 'static_check',
			note: check.changes.length === 0 ? 'no referenced symbol changed' : check.changes.map(describeChange).join('; '),
		},
	];
	const slotAffected = check.changes.some((c) => c.kind === 'slot');
	const replaces = await buildHash(build);

	let base = build;
	const tried = new Set<string>();
	let lastVerification: Verification | undefined;

	for (let i = UPGRADE_LADDER.findIndex((r) => r.rung === check.start); i < UPGRADE_LADDER.length; i++) {
		const { rung, verify, outcome } = UPGRADE_LADDER[i]!;
		if (rung === 'reanchor' && !slotAffected) {
			continue;
		}

		let candidate: Build | undefined;
		if (rung === 'reverify') {
			candidate = structuredClone(build);
		} else if (rung === 'migrate') {
			candidate = applyMigrations(build, target.migrations ?? []);
		} else if (rung === 'reanchor') {
			candidate = await reanchor(base, from, target, options.chooseSlot ? (c) => options.chooseSlot!(c, base) : undefined);
		} else {
			candidate = options.regenerate ? await options.regenerate({ previous: build, checks: build.checks, surface: target }) : undefined;
		}
		if (!candidate) {
			path.push({ state: rung, note: rung === 'regenerate' ? 'no compiler available' : 'does not apply' });
			continue;
		}

		candidate = rebase(candidate, target, rung, replaces);
		const key = canonicalJson({ tree: candidate.tree, data: candidate.data, mount: candidate.mount });
		if (tried.has(key)) {
			path.push({ state: rung, note: 'same candidate as before' });
			continue;
		}
		tried.add(key);
		if (rung !== 'regenerate') {
			base = candidate;
		}

		const validation = await validateBuild(candidate, target, { spec: { spec, hash: options.specHash }, upgrade: true });
		const errors = validation.diagnostics.filter((d) => d.severity === 'error');
		if (errors.length > 0) {
			path.push({ state: rung, note: `invalid for the new surface: ${errors.map((d) => d.message).join(' ')}` });
			continue;
		}

		const extraScopes = candidate.refs.scopes.filter((scope) => !grant.includes(scope));
		const verification = await options.verify(candidate, [...grant, ...extraScopes]);
		lastVerification = verification;
		const failed = verification.results.filter((r) => !r.passed).map((r) => r.criterion);
		path.push({ state: verify, note: verification.passed ? 'checks pass' : `checks fail: ${failed.join(', ') || 'unchecked criteria'}` });
		if (!verification.passed) {
			continue;
		}
		if (extraScopes.length > 0) {
			return { outcome: 'needs_approval', build: candidate, verification, changes: check.changes, extraScopes, path };
		}
		return { outcome, build: candidate, verification, changes: check.changes, path };
	}

	const result: UpgradeResult = { outcome: 'failed', changes: check.changes, path };
	if (lastVerification) {
		result.verification = lastVerification;
	}
	return result;
}

function rebase(candidate: Build, to: Surface, rung: LadderStart, replaces: string): Build {
	const rebased: Build = {
		...candidate,
		surface: { host: to.host, hostVersion: to.hostVersion, hash: to.hash ?? '' },
	};
	rebased.refs = extractRefs(rebased, to);
	if (rung === 'migrate' || rung === 'reanchor') {
		rebased.provenance = { ...candidate.provenance, strategy: rung === 'migrate' ? 'migrated' : 'reanchored', replaces };
	}
	return rebased;
}

export function describeChange(change: RefChange): string {
	const label = change.kind === 'prop' ? `prop ${change.symbol}` : `${change.kind} ${change.symbol}`;
	const how = change.migration
		? change.migration.op === 'remove'
			? 'removed'
			: `renamed to ${change.migration.to}`
		: change.refsOnly
			? 'permissions changed'
			: change.change;
	return `${label} ${how}`;
}
