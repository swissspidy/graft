import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashSpec, validateBuild, validateSpec, type Build, type Diagnostic, type Surface, type Verification } from '@swissspidy/graft-core';
import { loadHostFormats } from './hosts.ts';
import type { SiteVerifyResult } from './site.ts';

/** An EmDash site with the Graft plugin, reached with an API token that has the "admin" scope. */
export interface EmDashSite {
	url: string;
	token: string;
}

interface Version {
	n: number;
	source: string;
	specHash: string;
	state: string;
	build?: Build;
	verification?: Verification;
	scopes: string[];
}

interface SpecRecord {
	id: string;
	title: string;
	versions: Version[];
	grant: string[];
}

/** Calls a Graft plugin route on the site. */
export async function emdashRoute<T>(site: EmDashSite, route: string, body: unknown = {}): Promise<T> {
	const url = `${site.url.replace(/\/$/, '')}/_emdash/api/plugins/graft/${route}`;
	const response = await fetch(url, {
		method: 'POST',
		headers: { Authorization: `Bearer ${site.token}`, 'Content-Type': 'application/json', 'X-EmDash-Request': '1' },
		body: JSON.stringify(body),
	});
	const json = (await response.json().catch(() => null)) as { data?: T; error?: { code?: string; message?: string; details?: { diagnostics?: Diagnostic[] } } } | null;
	if (!response.ok) {
		const diagnostics = json?.error?.details?.diagnostics?.map((d) => `\n  ${d.path ?? ''} ${d.message}`).join('') ?? '';
		throw new Error(`${site.url} ${route}: ${response.status} ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}${diagnostics}`.trim());
	}
	return json?.data as T;
}

async function loadSnapshots(dir: string): Promise<Map<string, Surface>> {
	const snapshots = new Map<string, Surface>();
	for (const file of (await readdir(dir)).filter((f) => f.endsWith('.json'))) {
		const surface = JSON.parse(await readFile(join(dir, file), 'utf8')) as Surface;
		if (surface.hash) {
			snapshots.set(surface.hash, surface);
		}
	}
	return snapshots;
}

/**
 * Verifies the drafts on an EmDash site that have a build but no
 * verification, in a local EmDash sandbox, and attaches the results so the
 * site can move them on.
 */
export async function emdashSiteVerify(site: EmDashSite, surfacesDir: string, log: (line: string) => void = () => {}): Promise<SiteVerifyResult[]> {
	const { specs } = await emdashRoute<{ specs: SpecRecord[] }>(site, 'specs');
	const snapshots = await loadSnapshots(surfacesDir);
	const results: SiteVerifyResult[] = [];
	const targets: Array<{ record: SpecRecord; version: Version; build: Build; surface: Surface; spec: NonNullable<ReturnType<typeof validateSpec>['spec']> }> = [];

	for (const record of specs) {
		const version = record.versions.at(-1);
		if (!version?.build || version.state !== 'draft') {
			continue;
		}
		const base = { spec: record.id, version: version.n, surface: version.build.surface.hash };
		const surface = snapshots.get(version.build.surface.hash);
		const { spec } = validateSpec(version.source, surface ? { surface } : {});
		if (!surface) {
			results.push({ ...base, skipped: 'no local snapshot for this surface' });
		} else if (!spec || (await hashSpec(version.source)) !== version.build.spec.hash) {
			results.push({ ...base, skipped: 'the stored spec does not match its build' });
		} else {
			targets.push({ record, version, build: version.build, surface, spec });
		}
	}

	if (targets.length > 0) {
		const { verifyInEmDash } = await import('@graft/emdash/node');
		log(`Verifying ${targets.length} build(s) in an EmDash sandbox…`);
		const verifications = await verifyInEmDash(targets.map((t) => ({ build: t.build, spec: t.spec, surface: t.surface })));
		for (const [i, target] of targets.entries()) {
			const verification = verifications[i]!;
			const updated = await emdashRoute<{ state: string }>(site, 'attach', { id: target.record.id, version: target.version.n, verification });
			results.push({
				spec: target.record.id,
				version: target.version.n,
				surface: target.build.surface.hash,
				passed: verification.passed,
				state: updated.state,
				failures: verification.results.filter((r) => !r.passed).flatMap((r) => r.failures.map((f) => `${r.criterion}: ${f}`)),
			});
		}
	}
	return results;
}

/** Exports an EmDash site's active customizations as a canary corpus tenant. */
export async function emdashSitePull(site: EmDashSite, dir: string): Promise<string[]> {
	const { hash } = await emdashRoute<{ hash: string }>(site, 'surface');
	const { specs } = await emdashRoute<{ specs: SpecRecord[] }>(site, 'specs');
	await mkdir(dir, { recursive: true });
	const written: string[] = [];
	for (const record of specs) {
		const version = record.versions.find((v) => v.state === 'active');
		if (!version?.build || version.build.surface.hash !== hash) {
			continue;
		}
		await writeFile(join(dir, `${record.id}.md`), version.source);
		await writeFile(join(dir, `${record.id}.json`), JSON.stringify(version.build, null, '\t') + '\n');
		await writeFile(join(dir, `${record.id}.grant.json`), JSON.stringify({ scopes: record.grant }, null, '\t') + '\n');
		written.push(record.id);
	}
	return written;
}

export interface InstallResult {
	id: string;
	version: number;
	state: string;
	scopes: string[];
	verification?: Verification;
}

/**
 * Installs a customization on an EmDash site: checks the build against the
 * site's surface, verifies it in a local EmDash sandbox (unless `verify` is
 * false) and sends the spec, the build and the verification. The site
 * serves it once it is verified and its permissions are approved.
 */
export async function emdashSiteInstall(
	site: EmDashSite,
	specFile: string,
	buildFile: string,
	options: { verify?: boolean; log?: (line: string) => void } = {},
): Promise<InstallResult> {
	const source = await readFile(specFile, 'utf8');
	const build = JSON.parse(await readFile(buildFile, 'utf8')) as Build;
	const surface = await emdashRoute<Surface>(site, 'surface');
	const parsed = validateSpec(source, { surface });
	if (!parsed.spec) {
		throw new Error(`${specFile} is not valid for this site:${parsed.diagnostics.map((d) => `\n  ${d.line ?? ''} ${d.message}`).join('')}`);
	}
	await loadHostFormats(surface.host);
	const validation = await validateBuild(build, surface, { spec: { spec: parsed.spec, hash: await hashSpec(source) } });
	if (!validation.ok) {
		throw new Error(`${buildFile} is not valid for this spec and site:${validation.diagnostics.filter((d) => d.severity === 'error').map((d) => `\n  ${d.path ?? ''} ${d.message}`).join('')}`);
	}
	let verification: Verification | undefined;
	if (options.verify !== false) {
		const { verifyInEmDash } = await import('@graft/emdash/node');
		options.log?.('Verifying in an EmDash sandbox…');
		[verification] = await verifyInEmDash([{ build, spec: parsed.spec, surface }]);
	}
	const installed = await emdashRoute<Omit<InstallResult, 'verification'>>(site, 'install', { source, build, ...(verification ? { verification } : {}) });
	return { ...installed, ...(verification ? { verification } : {}) };
}
