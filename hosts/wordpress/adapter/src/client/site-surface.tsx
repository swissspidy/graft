import { useEffect, useState } from 'react';
import apiFetch from '@wordpress/api-fetch';
import { Button, Notice, Spinner } from '@wordpress/components';
import { hasErrors, upgradeBuild, validateSpec, validateSurface, type Build, type Surface, type UpgradeResult, type Verification } from '@graft/core';
import { assembleSurface } from '../assemble.ts';
import type { HostDump } from '../surface-types.ts';

/**
 * A site whose surface no shipped snapshot describes (its own post types,
 * fields and taxonomies, or a WordPress version the plugin does not know
 * yet) records its own: the host dump is assembled here, with the same code
 * that generates the shipped snapshots, and the plugin checks that it
 * describes this site before keeping it (store_site_surface()).
 */
export async function recordSiteSurface(): Promise<string> {
	const dump = await apiFetch<HostDump>({ path: '/graft/v1/host-surface' });
	const surface = await assembleSurface(dump);
	const { diagnostics } = await validateSurface(surface);
	if (hasErrors(diagnostics)) {
		throw new Error(`This site's surface is not valid: ${diagnostics.map((d) => d.message).join(' ')}`);
	}
	const { hash } = await apiFetch<{ hash: string }>({ path: '/graft/v1/surfaces', method: 'POST', data: { surface } });
	return hash;
}

/** Records the site's surface as soon as the screen opens, then reloads it with the new surface. */
export function RecordSurface() {
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);
	useEffect(() => {
		let stopped = false;
		recordSiteSurface().then(
			() => {
				if (!stopped) {
					window.location.reload();
				}
			},
			(e: unknown) => {
				if (!stopped) {
					setError(e instanceof Error ? e.message : ((e as { message?: string }).message ?? 'Could not record the surface.'));
				}
			},
		);
		return () => {
			stopped = true;
		};
	}, [attempt]);
	return error ? (
		<Notice status="error" isDismissible={false}>
			<p>No customization is shown: this site exposes content or a version of WordPress Graft has no surface for, and recording it failed. {error}</p>
			<Button
				variant="secondary"
				onClick={() => {
					setError(null);
					setAttempt((n) => n + 1);
				}}
			>
				Try again
			</Button>
		</Notice>
	) : (
		<Notice status="info" isDismissible={false}>
			<span data-graft-recording-surface="">
				<Spinner /> This site exposes content Graft has not seen yet. Recording its surface…
			</span>
		</Notice>
	);
}

/** A version that waits for a build for this site's surface, and the verified build it has for another one. */
export interface UpgradeCandidate {
	specId: string;
	title: string;
	version: number;
	source: string;
	grant: string[];
	build: Build;
}

interface Outcome {
	title: string;
	result?: UpgradeResult;
	error?: string;
}

const outcomeLabels: Record<string, string> = {
	survived: 'works unchanged, and is back',
	migrated: 'was updated automatically, and is back',
	reanchored: 'moved to a new place, and is back',
	regenerated: 'was rebuilt, and is back',
	needs_approval: 'works again once you approve new permissions',
	failed: 'could not be upgraded; it needs a new build',
};

/**
 * Takes customizations to the site's current surface with the upgrade
 * ladder, verified in Playground in this browser: after the site's content
 * model changed, or its surface was recorded for the first time. Builds
 * that pass are attached, which puts each version back (or asks for the
 * new permissions).
 */
export function Upgrades({
	candidates,
	surface,
	startVerifier,
	onDone,
}: {
	candidates: UpgradeCandidate[];
	surface: Surface & { hash: string };
	startVerifier: () => Promise<(build: Build, grant: string[], spec: NonNullable<ReturnType<typeof validateSpec>['spec']>) => Promise<Verification>>;
	onDone(): void;
}) {
	const [running, setRunning] = useState(false);
	const [outcomes, setOutcomes] = useState<Outcome[]>([]);
	if (candidates.length === 0 && outcomes.length === 0) {
		return null;
	}

	const run = async () => {
		setRunning(true);
		setOutcomes([]);
		try {
			const verify = await startVerifier();
			for (const candidate of candidates) {
				const outcome = await upgradeOne(candidate, surface, verify);
				setOutcomes((current) => [...current, outcome]);
			}
		} catch (e) {
			setOutcomes((current) => [...current, { title: 'Upgrade', error: e instanceof Error ? e.message : String(e) }]);
		} finally {
			setRunning(false);
			onDone();
		}
	};

	return (
		<Notice status="warning" isDismissible={false}>
			<div data-graft-upgrades="">
				{candidates.length > 0 ? (
					<p>
						{candidates.length === 1 ? 'One customization is' : `${candidates.length} customizations are`} not shown because this site changed (
						{candidates.map((c) => c.title).join(', ')}). Graft can check {candidates.length === 1 ? 'it' : 'them'} against the site as it is now, in a
						throwaway copy of WordPress in your browser.
					</p>
				) : null}
				{outcomes.length > 0 ? (
					<ul>
						{outcomes.map((o, i) => (
							<li key={i} data-graft-upgrade-outcome={o.result?.outcome ?? 'error'}>
								<strong>{o.title}</strong> {o.error ?? outcomeLabels[o.result!.outcome]}
								{o.result && o.result.outcome !== 'survived' ? ` (${o.result.path.map((step) => step.note).join('; ')})` : ''}
							</li>
						))}
					</ul>
				) : null}
				{candidates.length > 0 ? (
					<Button variant="primary" isBusy={running} disabled={running} onClick={() => void run()}>
						{running ? 'Checking…' : 'Check and upgrade'}
					</Button>
				) : null}
			</div>
		</Notice>
	);
}

async function upgradeOne(
	candidate: UpgradeCandidate,
	to: Surface & { hash: string },
	verify: (build: Build, grant: string[], spec: NonNullable<ReturnType<typeof validateSpec>['spec']>) => Promise<Verification>,
): Promise<Outcome> {
	try {
		const from = await apiFetch<Surface>({ path: `/graft/v1/surfaces/${candidate.build.surface.hash}` });
		const { spec } = validateSpec(candidate.source);
		if (!spec) {
			return { title: candidate.title, error: 'has a spec this version of Graft cannot read.' };
		}
		const result = await upgradeBuild({
			build: candidate.build,
			spec,
			specHash: candidate.build.spec.hash,
			grant: candidate.grant,
			from,
			to,
			verify: (build, grant) => verify(build, grant, spec),
		});
		if (result.build && result.verification) {
			await apiFetch({
				path: `/graft/v1/specs/${candidate.specId}/versions/${candidate.version}/builds`,
				method: 'POST',
				data: { build: result.build, verification: { ...result.verification, runner: 'browser-upgrade' } },
			});
		}
		return { title: candidate.title, result };
	} catch (e) {
		return { title: candidate.title, error: e instanceof Error ? e.message : ((e as { message?: string }).message ?? String(e)) };
	}
}
