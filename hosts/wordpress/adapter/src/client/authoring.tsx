import { Fragment, useEffect, useMemo, useState } from 'react';
import apiFetch from '@wordpress/api-fetch';
import { Button, CheckboxControl, Notice } from '@wordpress/components';
import { compileSpec, hashSpec, validateSpec, type Build, type CompileEvent, type ModelClient, type Spec, type Surface, type Verification } from '@swissspidy/graft-core';
import { hostGuide } from '../guide.ts';

/**
 * Writing a customization in wp-admin: a spec editor that validates against
 * this site's surface as you type, and compiles in the browser. Model
 * requests go through the site (POST /graft/v1/generate → the WordPress AI
 * client), so no provider key reaches the browser.
 */

export const TEMPLATE = `---
graft: 1
id: my-customization
host: wordpress
mount:
  slot: admin.page
  menu: { parent: posts, title: My page }
audience: [editor, administrator]
permissions:
  - posts:read
---

# What it does

Who sees it, what they see, and what they can do.

## Acceptance criteria

- One observable behavior per line {#first-behavior}
`;

export const restModel: ModelClient = {
	async generate(request) {
		return apiFetch({ path: '/graft/v1/generate', method: 'POST', data: request });
	},
};

function describe(event: CompileEvent): string {
	switch (event.type) {
		case 'request':
			return event.purpose === 'checks' ? `Writing checks from the criteria (attempt ${event.attempt})…` : `Building (attempt ${event.attempt})…`;
		case 'rejected':
			return `Attempt ${event.attempt} was rejected: ${event.problems.join(' ')}`;
		case 'verified':
			return event.passed ? 'The checks pass.' : 'Some checks fail; trying again.';
	}
}

export interface AuthoringProps {
	surface: Surface;
	onSaved(message: string): void;
	onCancel(): void;
	/**
	 * Starts a sandbox and returns a function that runs a build's checks in
	 * it. Without it, or when it fails to start, builds are saved unverified.
	 */
	startVerifier?: () => Promise<(build: Build, spec: Spec) => Promise<Verification>>;
	/**
	 * The author is not an administrator: the customization is theirs
	 * alone, and is only saved once its checks passed (ADR 0014).
	 */
	personalOnly?: boolean;
	/** The permissions a customization of one's own may have without an administrator's approval. */
	selfService?: string[];
	/** The author's roles on the site: a customization of their own is shown to them as one of its audience. */
	roles?: string[];
}

export function Authoring({ surface, onSaved, onCancel, startVerifier, personalOnly = false, selfService = [], roles = [] }: AuthoringProps) {
	const [source, setSource] = useState(TEMPLATE);
	const [log, setLog] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [debounced, setDebounced] = useState(source);
	// For the person writing it only: a way to live with a customization before the whole audience gets it.
	const [chosePersonal, setPersonal] = useState(false);
	const personal = personalOnly || chosePersonal;

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(source), 300);
		return () => clearTimeout(timer);
	}, [source]);
	const validation = useMemo(() => validateSpec(debounced, { surface }), [debounced, surface]);
	const current = debounced === source;
	// A customization for oneself is shown to its author as one of the roles its spec names: its checks ran as those.
	const audience = validation.spec?.manifest.audience ?? [];
	const notForMe = personal && audience.length > 0 && !audience.some((role) => roles.includes(role));

	const build = async () => {
		const parsed = validateSpec(source, { surface });
		if (!parsed.spec) {
			return;
		}
		setBusy(true);
		setError(null);
		setLog([]);
		try {
			const specHash = await hashSpec(source);
			const spec = parsed.spec;
			let verify: ((build: Build, spec: Spec) => Promise<Verification>) | undefined;
			let sandboxFailed: string | null = null;
			if (personalOnly && !startVerifier) {
				setError('This site does not check customizations in the browser, so you cannot build your own here. Ask an administrator.');
				return;
			}
			if (startVerifier) {
				setLog(['Starting a private WordPress in this browser to run the checks…']);
				try {
					verify = await startVerifier();
				} catch (e) {
					sandboxFailed = (e as { message?: string }).message ?? 'it did not start';
					if (personalOnly) {
						// Before any model call: nothing unverified of one's own can be saved.
						setError(`The private WordPress that runs the checks could not start in this browser (${sandboxFailed}), and your customization can only be saved once its checks pass.`);
						return;
					}
					setLog((lines) => [...lines, `The private WordPress could not start (${sandboxFailed}); the build will be saved unverified.`]);
				}
			}
			const result = await compileSpec({
				spec: parsed.spec,
				specHash,
				surface,
				model: restModel,
				host: hostGuide,
				...(verify ? { verify: (candidate: Build) => verify(candidate, spec) } : {}),
				onEvent: (event) => setLog((lines) => [...lines, describe(event)]),
			});
			if (result.unverifiable?.length) {
				setError(
					`Some criteria cannot be checked, so nothing could guarantee them: ${result.unverifiable
						.map((u) => `"${u.criterion}": ${u.reason}`)
						.join(' ')} Make them observable (what someone sees or can do), or move them out of the acceptance criteria.`,
				);
				return;
			}
			if (!result.ok || !result.build) {
				setError('The build did not succeed. Make the criteria more specific or simplify the spec, then try again.');
				return;
			}
			const version = await apiFetch<{ version: number }>({
				path: '/graft/v1/specs',
				method: 'POST',
				data: { source, manifest: parsed.spec.manifest, title: parsed.spec.title, ...(personal ? { scope: { type: 'user' } } : {}) },
			});
			const stored = await apiFetch<{ state: string }>({
				path: `/graft/v1/specs/${parsed.spec.manifest.id}/versions/${version.version}/builds`,
				method: 'POST',
				data: { build: result.build, verification: result.verification ?? null },
			});
			const verified = result.verification?.passed === true;
			const title = `"${parsed.spec.title}"`;
			onSaved(
				stored.state === 'active'
					? `${title} was built and verified, and is live for you: it only reads, so it needed no approval.`
					: verified
						? personalOnly
							? `${title} was built and verified. It changes things, so an administrator has to approve it before you see it.`
							: `${title} was built and verified. Review and approve it below.`
						: `${title} was built. It needs verification before it can be approved${sandboxFailed ? ` (the in-browser check could not run: ${sandboxFailed})` : ''}.`,
			);
		} catch (e) {
			setError((e as { message?: string }).message ?? 'Building failed.');
		} finally {
			setBusy(false);
		}
	};

	const errors = validation.diagnostics.filter((d) => d.severity === 'error');
	const warnings = validation.diagnostics.filter((d) => d.severity === 'warning');
	return (
		<div className="graft-authoring" style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
			<label htmlFor="graft-spec-source">
				<strong>Spec</strong> <span className="description">Markdown with YAML frontmatter; see the examples for the format.</span>
			</label>
			<textarea
				id="graft-spec-source"
				value={source}
				onChange={(event) => setSource(event.target.value)}
				rows={22}
				spellCheck={false}
				style={{ fontFamily: 'Menlo, Consolas, monospace', width: '100%' }}
				disabled={busy}
			/>
			<ul className="graft-diagnostics" aria-live="polite">
				{current && validation.ok && errors.length === 0 ? <li>Valid for this site.</li> : null}
				{[...errors, ...warnings].map((d, i) => (
					<li key={i} className={d.severity === 'error' ? 'graft-error' : 'graft-warning'}>
						{d.line ? `Line ${d.line}: ` : ''}
						{d.message}
					</li>
				))}
			</ul>
			{error ? (
				<Notice status="error" isDismissible={false}>
					{error}
				</Notice>
			) : null}
			{log.length > 0 ? (
				<ol className="graft-build-log">
					{log.map((line, i) => (
						<li key={i}>{line}</li>
					))}
				</ol>
			) : null}
			{notForMe ? (
				<Notice status="warning" isDismissible={false}>
					<span data-graft-not-for-me="">
						This customization is for you alone, but its audience ({audience.join(', ')}) does not include your role ({roles.join(', ') || 'none'}), so you would not see it. Add your
						role to <code>audience</code>, and say in the criteria what you should see.
					</span>
				</Notice>
			) : null}
			{personalOnly ? (
				<p data-graft-personal-only="">
					This customization is yours alone: only you will see it. If all it asks for is{' '}
					{selfService.length > 0
						? selfService.map((scope, i) => (
								<Fragment key={scope}>
									{i ? ', ' : ''}
									<code>{scope}</code>
								</Fragment>
							))
						: 'nothing'}
					, it goes live as soon as its checks pass. Anything more waits for an administrator.
				</p>
			) : null}
			<div data-graft-personal-option="" hidden={personalOnly}>
				<CheckboxControl
					__nextHasNoMarginBottom
					label="Only for me"
					help="Shown to you alone, as one of the roles its audience names. It still needs approval. A customization for everyone is a new one, with its own id."
					checked={chosePersonal}
					onChange={(checked) => (busy ? undefined : setPersonal(checked))}
				/>
			</div>
			<div style={{ display: 'flex', gap: 8 }}>
				<Button variant="primary" isBusy={busy} disabled={busy || !validation.ok || !current || notForMe} onClick={() => void build()}>
					Build it
				</Button>
				<Button variant="tertiary" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
