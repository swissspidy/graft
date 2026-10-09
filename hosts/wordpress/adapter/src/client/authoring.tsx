import { useEffect, useMemo, useState } from 'react';
import apiFetch from '@wordpress/api-fetch';
import { Button, Notice } from '@wordpress/components';
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
}

export function Authoring({ surface, onSaved, onCancel, startVerifier }: AuthoringProps) {
	const [source, setSource] = useState(TEMPLATE);
	const [log, setLog] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [debounced, setDebounced] = useState(source);

	useEffect(() => {
		const timer = setTimeout(() => setDebounced(source), 300);
		return () => clearTimeout(timer);
	}, [source]);
	const validation = useMemo(() => validateSpec(debounced, { surface }), [debounced, surface]);
	const current = debounced === source;

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
			if (startVerifier) {
				setLog(['Starting a private WordPress in this browser to run the checks…']);
				try {
					verify = await startVerifier();
				} catch (e) {
					sandboxFailed = (e as { message?: string }).message ?? 'it did not start';
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
				data: { source, manifest: parsed.spec.manifest, title: parsed.spec.title },
			});
			await apiFetch({
				path: `/graft/v1/specs/${parsed.spec.manifest.id}/versions/${version.version}/builds`,
				method: 'POST',
				data: { build: result.build, verification: result.verification ?? null },
			});
			const verified = result.verification?.passed === true;
			onSaved(
				verified
					? `"${parsed.spec.title}" was built and verified. Review and approve it below.`
					: `"${parsed.spec.title}" was built. It needs verification before it can be approved${sandboxFailed ? ` (the in-browser check could not run: ${sandboxFailed})` : ''}.`,
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
			<div style={{ display: 'flex', gap: 8 }}>
				<Button variant="primary" isBusy={busy} disabled={busy || !validation.ok || !current} onClick={() => void build()}>
					Build it
				</Button>
				<Button variant="tertiary" disabled={busy} onClick={onCancel}>
					Cancel
				</Button>
			</div>
		</div>
	);
}
