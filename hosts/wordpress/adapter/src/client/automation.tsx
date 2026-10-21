import { useCallback, useEffect, useState } from 'react';
import apiFetch from '@wordpress/api-fetch';
import { Button, Card, CardBody, CardHeader, Notice } from '@wordpress/components';
import type { Surface } from '@swissspidy/graft-core';
import { describeWhen, type TriggerRun } from '@swissspidy/graft-core/runtime';

/**
 * Tools → Customizations, "Running on their own" (ADR 0010): what each
 * active customization's triggers do, as whom, and what they did. An
 * administrator can pause one trigger or all of them, try one as a dry
 * run, or run it now.
 */

export interface TriggerEntry {
	spec: string;
	title: string;
	trigger: string;
	schedule: { every: string; at?: string } | null;
	event: string | null;
	granted: string[];
	limit: number;
	once: boolean;
	paused: boolean;
	pauseReason: string | null;
	lastRun: string | null;
	lastStatus: string | null;
	nextRun: string | null;
	managed: boolean;
}

export interface LoggedRun extends Omit<Partial<TriggerRun>, 'status'> {
	time: string;
	spec: string;
	trigger: string;
	kind: string;
	status: string;
}

interface TriggersResponse {
	/** Why no trigger runs on the site, or null. */
	disabled: string | null;
	/** Whether an administrator paused them all. */
	paused: boolean;
	identity: string;
	triggers: TriggerEntry[];
	runs: LoggedRun[];
}

const statusLabels: Record<string, string> = {
	ok: 'Done',
	partial: 'Partly failed',
	failed: 'Failed',
	'dry-run': 'Dry run',
	refused: 'Refused',
	'rate-limited': 'Dropped (too many events)',
};

/** What a run did, in a sentence. */
export function describeRun(run: LoggedRun): string {
	if (run.error && !run.calls?.length) {
		return run.error;
	}
	const calls = run.calls ?? [];
	const ok = calls.filter((c) => c.ok).length;
	const failed = calls.length - ok;
	const parts = [run.status === 'dry-run' ? `would act on ${calls.length} of ${run.targets ?? 0}` : `acted on ${ok} of ${run.targets ?? 0}`];
	if (failed > 0) {
		parts.push(`${failed} failed (${[...new Set(calls.flatMap((c) => (c.error ? [c.error] : [])))].join('; ')})`);
	}
	if (run.skipped) {
		parts.push(`${run.skipped} left for the next run`);
	}
	const titles = calls.flatMap((c) => (c.target?.title ? [c.target.title] : []));
	return `${parts.join(', ')}${titles.length ? `: ${titles.join(', ')}` : ''}.`;
}

const when = (time: string | null) => (time ? new Date(time).toLocaleString() : '—');

export function Automation({ surface, scopes }: { surface: Surface; scopes: Record<string, string> }) {
	const [data, setData] = useState<TriggersResponse | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [message, setMessage] = useState<{ status: 'success' | 'error' | 'info'; text: string } | null>(null);

	const load = useCallback(async () => {
		try {
			setData(await apiFetch<TriggersResponse>({ path: '/graft/v1/triggers' }));
		} catch (e) {
			setMessage({ status: 'error', text: (e as { message?: string }).message ?? 'Could not load triggers.' });
		}
	}, []);
	useEffect(() => void load(), [load]);

	const act = async (key: string, path: string, data?: Record<string, unknown>) => {
		setBusy(key);
		setMessage(null);
		try {
			const result = await apiFetch<TriggersResponse | LoggedRun>({ path: `/graft/v1/triggers/${path}`, method: 'POST', ...(data ? { data } : {}) });
			if ('kind' in result) {
				setMessage({ status: result.status === 'ok' || result.status === 'dry-run' ? 'info' : 'error', text: `${statusLabels[result.status] ?? result.status}: ${describeRun(result)}` });
			}
			await load();
		} catch (e) {
			setMessage({ status: 'error', text: (e as { message?: string }).message ?? 'That did not work.' });
		} finally {
			setBusy(null);
		}
	};

	if (!data || (data.triggers.length === 0 && data.runs.length === 0)) {
		return null;
	}
	return (
		<Card>
			<CardHeader>
				<strong>Running on their own</strong>
			</CardHeader>
			<CardBody>
				<div data-graft-automation="">
					<p>
						These customizations also act without anyone viewing them, as <strong>{data.identity}</strong>: a user with no role of its own that can
						only do what you approved for each one, and only while it runs.
					</p>
					{data.disabled ? (
						<Notice status="warning" isDismissible={false}>
							<span data-graft-triggers-disabled="">{data.disabled}</span>
						</Notice>
					) : null}
					{message ? (
						<Notice status={message.status} onRemove={() => setMessage(null)}>
							<span data-graft-trigger-message="">{message.text}</span>
						</Notice>
					) : null}
					<div style={{ margin: '8px 0' }}>
						<Button variant="secondary" isDestructive={!data.paused} isBusy={busy === 'all'} disabled={busy !== null} onClick={() => void act('all', data.paused ? 'resume-all' : 'pause-all')}>
							{data.paused ? 'Resume all' : 'Pause all'}
						</Button>
					</div>
					<table className="widefat striped graft-triggers">
						<thead>
							<tr>
								<th scope="col">Customization</th>
								<th scope="col">Runs</th>
								<th scope="col">May</th>
								<th scope="col">State</th>
								<th scope="col">Last run</th>
								<th scope="col">Next run</th>
								<th scope="col">
									<span className="screen-reader-text">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{data.triggers.map((t) => {
								const key = `${t.spec}/${t.trigger}`;
								return (
									<tr key={key} data-graft-trigger={key} data-graft-paused={t.paused ? 'true' : 'false'}>
										<td>
											{t.title} <code>{t.trigger}</code>
										</td>
										<td>
											{describeWhen(t.event ? { event: t.event } : t.schedule ? { schedule: t.schedule } : {}, surface)}
											{`, at most ${t.limit} per run`}
											{t.once ? ', once per post' : ''}
										</td>
										<td>{t.granted.map((scope) => scopes[scope] ?? scope).join('; ')}</td>
										<td>{t.paused ? `Paused${t.pauseReason ? `: ${t.pauseReason}` : ''}` : 'Active'}</td>
										<td>{t.lastRun ? `${when(t.lastRun)} (${statusLabels[t.lastStatus ?? ''] ?? t.lastStatus})` : 'Not yet'}</td>
										<td>{t.event ? 'On the event' : t.paused ? '—' : when(t.nextRun)}</td>
										<td style={{ whiteSpace: 'nowrap' }}>
											<Button variant="link" disabled={busy !== null} onClick={() => void act(key, `${key}/${t.paused ? 'resume' : 'pause'}`)}>
												{t.paused ? 'Resume' : 'Pause'}
											</Button>
											{t.schedule ? (
												<>
													{' · '}
													<Button variant="link" disabled={busy !== null} onClick={() => void act(key, `${key}/run`, { dry_run: true })}>
														Dry run
													</Button>
													{' · '}
													<Button variant="link" disabled={busy !== null || t.paused || data.disabled !== null} onClick={() => void act(key, `${key}/run`)}>
														Run now
													</Button>
												</>
											) : null}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>

					{data.runs.length > 0 ? (
						<>
							<h4>Recent runs</h4>
							<table className="widefat striped graft-trigger-runs">
								<thead>
									<tr>
										<th scope="col">When</th>
										<th scope="col">Trigger</th>
										<th scope="col">How</th>
										<th scope="col">Result</th>
										<th scope="col">What it did</th>
									</tr>
								</thead>
								<tbody>
									{data.runs.slice(0, 20).map((run, i) => (
										<tr key={i} data-graft-run={`${run.spec}/${run.trigger}`} data-graft-run-status={run.status}>
											<td>{when(run.time)}</td>
											<td>
												{run.spec} <code>{run.trigger}</code>
											</td>
											<td>{run.kind}</td>
											<td>{statusLabels[run.status] ?? run.status}</td>
											<td>{describeRun(run)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</>
					) : null}
				</div>
			</CardBody>
		</Card>
	);
}
