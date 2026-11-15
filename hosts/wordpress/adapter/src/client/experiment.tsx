import { useState } from 'react';
import apiFetch from '@wordpress/api-fetch';
import { Button, SelectControl } from '@wordpress/components';

/**
 * An experiment on a live customization (ADR 0016): what is running, the
 * rule applied to its counts now, and whether the viewer is in the
 * baseline; or, for a customization that can be tested, a way to start one.
 */

export interface ExperimentOptions {
	/** The host events an experiment can count, by id, with their titles. */
	metrics: Record<string, string>;
	maxShare: number;
}

interface Counts {
	visits: number;
	conversions: number;
}

export interface ExperimentView {
	id: string;
	version: number;
	share: number;
	metric: string;
	minPerBucket: number;
	maxDays: number;
	started: string;
	decision: { action: 'keep' | 'revert' | 'continue'; reason: string; probability: number; days: number; counts: { baseline: Counts; variant: Counts } };
	viewer_bucket: 'baseline' | 'variant';
}

const SHARES = [0.1, 0.2, 0.3, 0.5];
const percent = (share: number) => `${Math.round(share * 100)}%`;

export function Experiment({
	specId,
	version,
	experiment,
	options,
	testable,
	onChanged,
	onError,
}: {
	specId: string;
	version: number;
	experiment: ExperimentView | null;
	options: ExperimentOptions;
	/** Why it cannot be tested, or null when it can. */
	testable: string | null;
	onChanged(): void;
	onError(message: string): void;
}) {
	const metrics = Object.entries(options.metrics);
	const [share, setShare] = useState(String(Math.min(0.5, options.maxShare)));
	const [metric, setMetric] = useState(metrics[0]?.[0] ?? '');
	const [busy, setBusy] = useState(false);

	const call = async (request: Parameters<typeof apiFetch>[0]) => {
		setBusy(true);
		try {
			await apiFetch(request);
			onChanged();
		} catch (e) {
			onError((e as { message?: string }).message ?? 'That did not work.');
		} finally {
			setBusy(false);
		}
	};

	if (experiment && experiment.version === version) {
		const { counts } = experiment.decision;
		const rate = (c: Counts) => (c.visits ? ` (${Math.round((c.conversions / c.visits) * 100)}%)` : '');
		return (
			<div data-graft-experiment={experiment.id}>
				<h4>Being tested</h4>
				<p>
					Shown to {percent(experiment.share)} of its audience since {new Date(experiment.started).toLocaleDateString()}. Counted for each person and day: whether
					they caused “{options.metrics[experiment.metric] ?? experiment.metric}”.
				</p>
				<ul>
					<li data-graft-experiment-bucket="baseline">
						Without it: {counts.baseline.conversions} of {counts.baseline.visits} person-days{rate(counts.baseline)}
					</li>
					<li data-graft-experiment-bucket="variant">
						With it: {counts.variant.conversions} of {counts.variant.visits} person-days{rate(counts.variant)}
					</li>
				</ul>
				<p data-graft-experiment-decision={experiment.decision.action}>
					{experiment.decision.reason} It is kept at 0.95 with {experiment.minPerBucket} person-days in each group, and reverted at 0.05 or after{' '}
					{experiment.maxDays} days.
				</p>
				{experiment.viewer_bucket === 'baseline' ? (
					<p data-graft-not-served="experiment_baseline">
						<strong>Not showing to you.</strong> You are in the group that sees the site without it while it is tested.
					</p>
				) : null}
				<div style={{ display: 'flex', gap: 8 }}>
					<Button variant="secondary" isBusy={busy} disabled={busy} onClick={() => void call({ path: `/graft/v1/specs/${specId}/experiment?outcome=keep&experiment=${experiment.id}`, method: 'DELETE' })}>
						Keep it for everyone
					</Button>
					<Button variant="secondary" isDestructive isBusy={busy} disabled={busy} onClick={() => void call({ path: `/graft/v1/specs/${specId}/experiment?outcome=revert&experiment=${experiment.id}`, method: 'DELETE' })}>
						Revert it
					</Button>
				</div>
			</div>
		);
	}

	if (testable !== null || metrics.length === 0) {
		return null;
	}
	return (
		<div data-graft-experiment-start="">
			<h4>Test it</h4>
			<p className="description">
				Show it to a share of its audience and count a site event for both groups. The site keeps it or reverts it when the numbers decide, or reverts it after 14
				days.
			</p>
			<div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
				<SelectControl
					__nextHasNoMarginBottom
					label="Show it to"
					value={share}
					options={SHARES.filter((s) => s <= options.maxShare).map((s) => ({ value: String(s), label: `${percent(s)} of its audience` }))}
					onChange={setShare}
				/>
				<SelectControl __nextHasNoMarginBottom label="Count" value={metric} options={metrics.map(([value, label]) => ({ value, label }))} onChange={setMetric} />
				<Button variant="secondary" isBusy={busy} disabled={busy} onClick={() => void call({ path: `/graft/v1/specs/${specId}/experiment`, method: 'POST', data: { share: Number(share), metric } })}>
					Start test
				</Button>
			</div>
		</div>
	);
}
