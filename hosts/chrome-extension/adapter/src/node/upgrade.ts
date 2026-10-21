import { hashSpec, upgradeBuild, validateSpec, type Build, type Check, type Surface, type UpgradeResult } from '@swissspidy/graft-core';
import type { DriftReport } from './drift.ts';
import { verifyInBrowserHost, type FixtureSandbox } from './sandbox.ts';

/**
 * Drift as the trigger of the upgrade ladder: each build goes from the
 * surface it was built for to the surface the drift probe observed,
 * candidates verified with their frozen checks in a sandbox of the
 * changed app (a copy that changed the same way). Regeneration needs a
 * model; without one, a build that only regeneration could save fails,
 * and is suspended rather than served broken.
 */
export async function upgradeAfterDrift(options: {
	report: DriftReport;
	from: Surface;
	build: Build;
	/** The spec's Markdown source. */
	source: string;
	/** Scopes granted to the spec version; default: what the spec requests (it was approved as written). */
	grant?: string[];
	sandbox: FixtureSandbox;
	regenerate?: (args: { previous: Build; checks: Check[]; surface: Surface }) => Promise<Build | undefined>;
}): Promise<UpgradeResult> {
	const to = options.report.surface;
	const spec = validateSpec(options.source, { surface: to }).spec ?? validateSpec(options.source, { surface: options.from }).spec;
	if (!spec) {
		throw new Error('The spec does not validate against the declared or the observed surface.');
	}
	return upgradeBuild({
		build: options.build,
		spec,
		specHash: await hashSpec(options.source),
		grant: options.grant ?? spec.manifest.permissions,
		from: options.from,
		to,
		verify: async (candidate, grant) => (await verifyInBrowserHost([{ build: candidate, spec, surface: to }], { sandbox: options.sandbox, grant }))[0]!,
		...(options.regenerate ? { regenerate: options.regenerate } : {}),
	});
}
