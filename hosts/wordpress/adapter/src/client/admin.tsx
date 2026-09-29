import { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import apiFetch from '@wordpress/api-fetch';
import { Button, Card, CardBody, CardHeader, Notice, Spinner } from '@wordpress/components';
import { describeCheck, verifyBuild, type Build, type Surface } from '@graft/core';
import { createCan } from '../can.ts';
import { playgroundVersion } from '../playground-version.ts';
import { semantics } from '../semantics.ts';
import { loadFunctions } from '@graft/sandbox';
import { browserSandbox } from './browser-sandbox.ts';
import { parseSpec } from '@graft/core/parse';
import { describers } from '../describe.ts';
import { Authoring } from './authoring.tsx';

/**
 * Tools → Customizations: every spec on the site with its state, the
 * permissions it asks for in plain language, and its checks as sentences,
 * so an administrator can judge what they approve without reading JSON.
 */

interface AdminConfig {
	scopes: Record<string, string>;
	browserVerification: boolean;
	surface: (Surface & { hash: string }) | null;
	quickjsWasm: string;
}

interface VersionRecord {
	spec_id: string;
	version: number;
	title: string;
	state: string;
	unverified: boolean;
	source: string;
	manifest: { permissions: string[]; audience?: string[]; mount: { slot: string } };
	grant: { scopes: string[] } | null;
	builds: Record<string, { build: Build; verification: { passed: boolean } | null; attached: string }>;
}

interface SpecRecord {
	spec_id: string;
	title: string;
	active_version: number | null;
	versions: VersionRecord[];
}

declare global {
	interface Window {
		graftAdmin?: AdminConfig;
	}
}

const stateLabels: Record<string, string> = {
	draft: 'Draft',
	building: 'Waiting for a verified build',
	needs_approval: 'Needs approval',
	active: 'Active',
	rejected: 'Rejected',
	upgrading: 'Waiting for an upgrade',
	suspended: 'Suspended',
	superseded: 'Superseded',
	archived: 'Archived',
};

const actions: Record<string, Array<{ event: string; label: string; primary?: boolean }>> = {
	needs_approval: [
		{ event: 'approve', label: 'Approve', primary: true },
		{ event: 'decline', label: 'Decline' },
	],
	active: [{ event: 'archive', label: 'Archive' }],
	upgrading: [{ event: 'upgrade_failed', label: 'Mark upgrade as failed' }],
	suspended: [
		{ event: 'retry', label: 'Retry upgrade' },
		{ event: 'archive', label: 'Archive' },
	],
};

function Version({ version, config, onEvent, busy }: { version: VersionRecord; config: AdminConfig; onEvent(event: string): void; busy: boolean }) {
	const current = config.surface ? version.builds[config.surface.hash] : undefined;
	const granted = version.grant?.scopes ?? [];
	const needed = [...new Set([...version.manifest.permissions, ...(current?.build.refs.scopes ?? [])])];
	const criteria = new Map(parseSpec(version.source).criteria.map((c) => [c.id, c.text]));
	const prepared = Object.entries(version.builds).filter(([hash]) => hash !== config.surface?.hash);

	return (
		<div className="graft-version" data-graft-version={version.version}>
			<p>
				<strong data-graft-state={version.state}>{stateLabels[version.state] ?? version.state}</strong>
				{` · version ${version.version}`}
				{version.unverified ? ' · not verified' : ''}
				{current
					? ` · build ${current.build.provenance.strategy ?? 'compiled'}${current.verification?.passed ? ', verified' : ', not verified yet'}`
					: ' · no build for this WordPress'}
			</p>

			<h4>Permissions</h4>
			<ul className="graft-permissions">
				{needed.map((scope) => (
					<li key={scope}>
						{config.scopes[scope] ?? scope}
						{granted.includes(scope) ? ' (granted)' : ' (not granted yet)'}
					</li>
				))}
			</ul>

			{current ? (
				<>
					<h4>What is checked</h4>
					<table className="widefat striped graft-checks">
						<thead>
							<tr>
								<th scope="col">Criterion</th>
								<th scope="col">Check</th>
							</tr>
						</thead>
						<tbody>
							{current.build.checks.map((check, i) => (
								<tr key={i}>
									<td>{criteria.get(check.criterion) ?? check.criterion}</td>
									<td>{describeCheck(check, describers)}</td>
								</tr>
							))}
						</tbody>
					</table>
				</>
			) : null}

			{prepared.length > 0 ? (
				<p className="description">
					Prepared for other WordPress versions:{' '}
					{prepared.map(([hash, entry]) => `${entry.build.surface.hostVersion ?? hash.slice(0, 15)}${entry.verification?.passed ? ' (verified)' : ''}`).join(', ')}
				</p>
			) : null}

			<div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
				{(actions[version.state] ?? []).map((action) => (
					<Button key={action.event} variant={action.primary ? 'primary' : 'secondary'} isBusy={busy} disabled={busy} onClick={() => onEvent(action.event)}>
						{action.label}
					</Button>
				))}
			</div>
		</div>
	);
}

function App({ config }: { config: AdminConfig }) {
	const [specs, setSpecs] = useState<SpecRecord[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [authoring, setAuthoring] = useState(false);
	const [saved, setSaved] = useState<string | null>(null);

	const load = useCallback(async () => {
		try {
			setSpecs(await apiFetch<SpecRecord[]>({ path: '/graft/v1/specs' }));
		} catch (e) {
			setError((e as { message?: string }).message ?? 'Could not load customizations.');
		}
	}, []);
	useEffect(() => void load(), [load]);

	const onEvent = async (spec: SpecRecord, version: VersionRecord, event: string) => {
		setBusy(spec.spec_id);
		setError(null);
		try {
			await apiFetch({ path: `/graft/v1/specs/${spec.spec_id}/versions/${version.version}/${event}`, method: 'POST' });
			await load();
		} catch (e) {
			setError((e as { message?: string }).message ?? 'That did not work.');
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="graft-admin" style={{ display: 'flex', flexDirection: 'column', gap: 16, maxWidth: 960 }}>
			{config.surface ? null : (
				<Notice status="warning" isDismissible={false}>
					This version of WordPress exposes a surface Graft has no snapshot for, so no customization is shown. Run the canary for it.
				</Notice>
			)}
			{error ? (
				<Notice status="error" onRemove={() => setError(null)}>
					{error}
				</Notice>
			) : null}
			{saved ? (
				<Notice status="success" onRemove={() => setSaved(null)}>
					{saved}
				</Notice>
			) : null}
			{config.surface && !authoring ? (
				<div>
					<Button variant="primary" onClick={() => setAuthoring(true)}>
						New customization
					</Button>
				</div>
			) : null}
			{config.surface && authoring ? (
				<Card>
					<CardHeader>
						<strong>New customization</strong>
					</CardHeader>
					<CardBody>
						<Authoring
							surface={config.surface}
							{...(config.browserVerification
								? {
										startVerifier: async () => {
											const sandbox = await browserSandbox(playgroundVersion(config.surface!.hostVersion));
											return (build: Build, spec: Parameters<typeof verifyBuild>[0]['spec']) =>
												verifyBuild({
													build,
													spec,
													surface: config.surface!,
													sandbox,
													semantics,
													createCan,
													loadFunctions: (code, limits) => loadFunctions(code, limits, { wasmLocation: config.quickjsWasm }),
												});
										},
									}
								: {})}
							onCancel={() => setAuthoring(false)}
							onSaved={(message) => {
								setAuthoring(false);
								setSaved(message);
								void load();
							}}
						/>
					</CardBody>
				</Card>
			) : null}
			{specs === null ? <Spinner /> : null}
			{specs?.length === 0 ? <p>No customizations yet.</p> : null}
			{specs?.map((spec) => {
				// What is live, and separately the newest version waiting to
				// replace it, so a new draft never hides the live one.
				const active = spec.versions.find((v) => v.version === spec.active_version);
				const pending = spec.versions.find(
					(v) => v.version > (active?.version ?? 0) && !['superseded', 'archived', 'rejected'].includes(v.state),
				);
				const shown = [active, pending].filter((v): v is VersionRecord => Boolean(v));
				if (shown.length === 0 && spec.versions[0]) {
					shown.push(spec.versions[0]);
				}
				return (
					<div key={spec.spec_id} data-graft-spec={spec.spec_id}>
						<Card>
							<CardHeader>
								<strong>{spec.title}</strong> <code>{spec.spec_id}</code>
							</CardHeader>
							<CardBody>
								{shown.map((version, i) => (
									<div key={version.version} data-graft-role={i === 0 && version === active ? 'active' : 'pending'}>
										{i > 0 ? <h3>Newer version</h3> : null}
										<Version version={version} config={config} busy={busy === spec.spec_id} onEvent={(event) => void onEvent(spec, version, event)} />
									</div>
								))}
							</CardBody>
						</Card>
					</div>
				);
			})}
		</div>
	);
}

const root = document.getElementById('graft-admin');
if (root && window.graftAdmin) {
	createRoot(root).render(<App config={window.graftAdmin} />);
}
