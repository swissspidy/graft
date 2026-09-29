import type { Build, Check } from '../build/types.ts';
import { hashSpec } from '../spec/hash.ts';
import type { Spec } from '../spec/types.ts';
import { validateSpec } from '../spec/validate.ts';
import { canonicalJson, hashSurface } from '../surface/hash.ts';
import type { Surface } from '../surface/types.ts';
import type { Verification } from '../verifier/run.ts';
import { describeChange, upgradeBuild, type UpgradeOutcome, type UpgradeResult, type UpgradeStep } from './ladder.ts';

/** One tenant's active spec version and build, as stored. */
export interface CorpusEntry {
	tenant: string;
	/** The spec file. */
	source: string;
	build: Build;
	grant: string[];
}

export interface CanaryOptions {
	corpus: CorpusEntry[];
	from: Surface;
	to: Surface;
	verify(build: Build, spec: Spec, grant: string[]): Promise<Verification>;
	regenerate?(args: { spec: Spec; specHash: string; previous: Build; checks: Check[]; surface: Surface }): Promise<Build | undefined>;
	chooseSlot?(candidates: string[], build: Build): Promise<string | undefined>;
	onEntry?(entry: CanaryEntry): void;
}

export interface CanaryEntry {
	tenant: string;
	spec: string;
	specHash: string;
	outcome: UpgradeOutcome;
	changes: string[];
	path: UpgradeStep[];
	extraScopes?: string[];
	/** The build to serve on the new surface, when there is one. */
	build?: Build;
	/** Criteria that still fail, for failed outcomes. */
	failing?: string[];
	/** The result was computed for another tenant with the identical spec, build and grant. */
	shared: boolean;
}

export interface CanaryReport {
	from: { hostVersion: string; hash: string };
	to: { hostVersion: string; hash: string };
	entries: CanaryEntry[];
	counts: Record<UpgradeOutcome, number>;
	/** Distinct ladders run (entries share results when identical). */
	runs: number;
}

export const OUTCOMES: UpgradeOutcome[] = ['survived', 'migrated', 'reanchored', 'regenerated', 'needs_approval', 'failed'];

/**
 * Runs the upgrade ladder for every tenant's customization against a new
 * surface, ahead of the host upgrade. Identical customizations (same spec
 * content, build and grant) are upgraded once and the result is shared, so
 * cost scales with distinct customizations, not tenants.
 */
export async function runCanary(options: CanaryOptions): Promise<CanaryReport> {
	const { from, to } = options;
	const target: Surface = { ...to, hash: to.hash ?? (await hashSurface(to)) };
	const results = new Map<string, Promise<{ result: UpgradeResult; spec: string; specHash: string }>>();
	const entries: CanaryEntry[] = [];

	for (const item of options.corpus) {
		const specHash = await hashSpec(item.source);
		const key = canonicalJson({ specHash, build: item.build, grant: [...item.grant].sort() });
		const shared = results.has(key);
		if (!shared) {
			results.set(key, upgradeOne(item, specHash, from, target, options));
		}
		const { result, spec } = await results.get(key)!;
		const entry: CanaryEntry = {
			tenant: item.tenant,
			spec,
			specHash,
			outcome: result.outcome,
			changes: result.changes.map(describeChange),
			path: result.path,
			shared,
		};
		if (result.build) {
			entry.build = result.build;
		}
		if (result.extraScopes) {
			entry.extraScopes = result.extraScopes;
		}
		if (result.outcome === 'failed' && result.verification) {
			entry.failing = [
				...result.verification.results.filter((r) => !r.passed).map((r) => r.criterion),
				...result.verification.unchecked,
			];
		}
		entries.push(entry);
		options.onEntry?.(entry);
	}

	const counts = Object.fromEntries(OUTCOMES.map((o) => [o, entries.filter((e) => e.outcome === o).length])) as Record<UpgradeOutcome, number>;
	return {
		from: { hostVersion: from.hostVersion, hash: from.hash ?? (await hashSurface(from)) },
		to: { hostVersion: target.hostVersion, hash: target.hash! },
		entries,
		counts,
		runs: results.size,
	};
}

async function upgradeOne(item: CorpusEntry, specHash: string, from: Surface, to: Surface, options: CanaryOptions) {
	const { spec } = validateSpec(item.source);
	if (!spec) {
		const result: UpgradeResult = { outcome: 'failed', changes: [], path: [{ state: 'static_check', note: 'the stored spec is invalid' }] };
		return { result, spec: item.build.spec.id, specHash };
	}
	const result = await upgradeBuild({
		build: item.build,
		spec,
		specHash,
		grant: item.grant,
		from,
		to,
		verify: (build, grant) => options.verify(build, spec, grant),
		...(options.regenerate
			? { regenerate: (args: { previous: Build; checks: Check[]; surface: Surface }) => options.regenerate!({ ...args, spec, specHash }) }
			: {}),
		...(options.chooseSlot ? { chooseSlot: options.chooseSlot } : {}),
	});
	return { result, spec: spec.manifest.id, specHash };
}

const labels: Record<UpgradeOutcome, string> = {
	survived: 'survived',
	migrated: 'migrated',
	reanchored: 're-anchored',
	regenerated: 'regenerated',
	needs_approval: 'needs approval',
	failed: 'failed',
};

/** A plain-text report: one line per tenant and spec, then totals. */
export function formatCanaryReport(report: CanaryReport): string {
	const lines = [`Canary: ${report.from.hostVersion} → ${report.to.hostVersion}`, ''];
	const width = Math.max(...report.entries.map((e) => `${e.tenant} / ${e.spec}`.length), 10);
	for (const entry of report.entries) {
		let detail = entry.changes.join('; ') || 'nothing it uses changed';
		if (entry.outcome === 'reanchored' && entry.build) {
			detail = `moved to ${entry.build.mount.slot}`;
		} else if (entry.outcome === 'needs_approval') {
			detail = `needs ${entry.extraScopes?.join(', ')}`;
		} else if (entry.outcome === 'failed') {
			detail = `${detail}${entry.failing?.length ? `; failing: ${entry.failing.join(', ')}` : ''}`;
		}
		lines.push(`${`${entry.tenant} / ${entry.spec}`.padEnd(width)}  ${labels[entry.outcome].padEnd(14)}  ${detail}${entry.shared ? '  (shared)' : ''}`);
	}
	lines.push(
		'',
		OUTCOMES.map((o) => `${labels[o]}: ${report.counts[o]}`).join(', '),
		`${report.entries.length} customizations, ${report.runs} distinct upgrade runs`,
	);
	return lines.join('\n');
}
