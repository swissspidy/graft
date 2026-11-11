import { useState } from 'react';
import apiFetch from '@wordpress/api-fetch';
import { Button, Card, CardBody, CardHeader, Spinner } from '@wordpress/components';

/** One entry of the plugin's change log (GET graft/v1/changes), newest first. */
interface Change {
	time: string;
	user: number;
	user_name: string;
	what: string;
	spec: string;
	version: number;
	from?: string;
	to?: string;
	granted?: string[];
	granted_triggers?: Record<string, string[]>;
	verified?: boolean;
	runner?: string;
}

const verbs: Record<string, string> = {
	created: 'wrote',
	build_attached: 'attached a build to',
	approve: 'approved',
	decline: 'declined',
	archive: 'archived',
	supersede: 'replaced',
	host_changed: 'put on hold after the site changed',
	upgraded: 'upgraded',
	upgrade_needs_grant: 'upgraded, pending approval,',
	upgrade_failed: 'could not upgrade',
	retry: 'retried the upgrade of',
	verified_within_grant: 'put live',
	verified_needs_grant: 'sent for approval',
	submit: 'submitted',
};

/** What an entry says, in one sentence. */
export function describeChange(change: Change, scopes: Record<string, string>): string {
	const who = change.user_name || (change.user ? `User ${change.user}` : 'The site');
	const title = (scope: string) => scopes[scope] ?? scope;
	let detail = '';
	if (change.what === 'approve') {
		const granted = (change.granted ?? []).map(title);
		const triggers = Object.entries(change.granted_triggers ?? {}).map(([id, list]) => `"${id}" on its own: ${list.map(title).join('; ')}`);
		detail = granted.length || triggers.length ? `, allowing: ${[...granted, ...triggers].join('; ')}` : '';
	} else if (change.what === 'build_attached') {
		detail = change.verified ? ` (verified${change.runner ? ` by ${change.runner}` : ''})` : ' (not verified)';
	}
	return `${who} ${verbs[change.what] ?? `${change.what}:`} ${change.spec}, version ${change.version}${detail}.`;
}

/** Who did what to which customization, on request: the trail behind every approval. */
export function History({ scopes }: { scopes: Record<string, string> }) {
	const [changes, setChanges] = useState<Change[] | null | 'loading'>(null);
	const [error, setError] = useState<string | null>(null);
	const load = async () => {
		setChanges('loading');
		setError(null);
		try {
			setChanges(await apiFetch<Change[]>({ path: '/graft/v1/changes' }));
		} catch (e) {
			setChanges(null);
			setError((e as { message?: string }).message ?? 'Could not load the history.');
		}
	};
	return (
		<Card data-graft-history="">
			<CardHeader>
				<strong>History</strong>
				<Button variant="secondary" onClick={() => (Array.isArray(changes) ? setChanges(null) : void load())} disabled={changes === 'loading'}>
					{Array.isArray(changes) ? 'Hide' : 'Show what changed'}
				</Button>
			</CardHeader>
			{changes === null && !error ? null : (
				<CardBody>
					{error ? <p>{error}</p> : null}
					{changes === 'loading' ? <Spinner /> : null}
					{Array.isArray(changes) && changes.length === 0 ? <p>Nothing has changed yet.</p> : null}
					{Array.isArray(changes) ? (
						<ul>
							{changes.map((change, i) => (
								<li key={i} data-graft-change={change.what}>
									<time dateTime={change.time}>{new Date(change.time).toLocaleString()}</time>: {describeChange(change, scopes)}
								</li>
							))}
						</ul>
					) : null}
				</CardBody>
			)}
		</Card>
	);
}
