import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashSpec, validateSpec, type Build, type Surface, type Verification } from '@graft/core';

/** A WordPress site with the Graft plugin, reached with an application password. */
export interface Site {
	url: string;
	user: string;
	password: string;
}

interface VersionRecord {
	spec_id: string;
	version: number;
	state: string;
	source: string;
	grant: { scopes: string[] } | null;
	builds: Record<string, { build: Build; verification: { passed: boolean } | null }>;
}

interface SpecRecord {
	spec_id: string;
	active_version: number | null;
	versions: VersionRecord[];
}

/** Calls the site's REST API (through ?rest_route=, which works without pretty permalinks). */
export async function siteFetch<T>(site: Site, route: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	const url = `${site.url.replace(/\/$/, '')}/?rest_route=${encodeURIComponent(route)}`;
	const response = await fetch(url, {
		method: init.method ?? 'GET',
		headers: {
			Authorization: `Basic ${Buffer.from(`${site.user}:${site.password}`).toString('base64')}`,
			...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
		},
		...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
	});
	const data = (await response.json().catch(() => null)) as T & { code?: string; message?: string };
	if (!response.ok) {
		throw new Error(`${site.url} ${route}: ${response.status} ${data?.code ?? ''} ${data?.message ?? ''}`.trim());
	}
	return data;
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

/** The version that matters for a spec: the newest one that is not superseded. */
function currentVersion(spec: SpecRecord): VersionRecord | undefined {
	return spec.versions.find((v) => v.state !== 'superseded') ?? spec.versions[0];
}

export interface SiteVerifyResult {
	spec: string;
	version: number;
	surface: string;
	passed?: boolean;
	state?: string;
	skipped?: string;
	failures?: string[];
}

/**
 * Verifies the builds on a site that have no passing verification yet (for
 * example drafts built in wp-admin), in a local sandbox, and posts the
 * verification records back so the site can move them on.
 */
export async function siteVerify(site: Site, surfacesDir: string, log: (line: string) => void = () => {}): Promise<SiteVerifyResult[]> {
	const specs = await siteFetch<SpecRecord[]>(site, '/graft/v1/specs');
	const snapshots = await loadSnapshots(surfacesDir);
	const results: SiteVerifyResult[] = [];
	const targets: Array<{ record: VersionRecord; hash: string; build: Build; surface: Surface; spec: NonNullable<ReturnType<typeof validateSpec>['spec']> }> = [];

	for (const specRecord of specs) {
		const record = currentVersion(specRecord);
		if (!record || ['archived', 'rejected'].includes(record.state)) {
			continue;
		}
		for (const [hash, entry] of Object.entries(record.builds)) {
			if (entry.verification?.passed) {
				continue;
			}
			const base = { spec: record.spec_id, version: record.version, surface: hash };
			const surface = snapshots.get(hash);
			const { spec } = validateSpec(record.source, surface ? { surface } : {});
			if (!surface) {
				results.push({ ...base, skipped: 'no local snapshot for this surface' });
			} else if (!spec || (await hashSpec(record.source)) !== entry.build.spec.hash) {
				results.push({ ...base, skipped: 'the stored spec does not match its build' });
			} else {
				targets.push({ record, hash, build: entry.build, surface, spec });
			}
		}
	}

	if (targets.length > 0) {
		const { playgroundVersion, verifyInWordPress } = await import('@graft/wordpress-adapter');
		// One sandbox per WordPress version the targets were built for.
		const byVersion = new Map<string, typeof targets>();
		for (const target of targets) {
			const wp = playgroundVersion(target.surface.hostVersion);
			byVersion.set(wp, [...(byVersion.get(wp) ?? []), target]);
		}
		for (const [wp, group] of byVersion) {
			log(`Verifying ${group.length} build(s) in WordPress ${wp}…`);
			const verifications: Verification[] = await verifyInWordPress(
				group.map((t) => ({ build: t.build, spec: t.spec, surface: t.surface })),
				{ wp },
			);
			for (const [i, target] of group.entries()) {
				const verification = verifications[i]!;
				const updated = await siteFetch<{ state: string }>(site, `/graft/v1/specs/${target.record.spec_id}/versions/${target.record.version}/builds`, {
					method: 'POST',
					body: { build: target.build, verification },
				});
				results.push({
					spec: target.record.spec_id,
					version: target.record.version,
					surface: target.hash,
					passed: verification.passed,
					state: updated.state,
					failures: verification.results.filter((r) => !r.passed).flatMap((r) => r.failures.map((f) => `${r.criterion}: ${f}`)),
				});
			}
		}
	}
	return results;
}

/**
 * Exports a site's active customizations as a canary corpus tenant: the
 * spec, the build for the site's current surface, and the grant.
 */
export async function sitePull(site: Site, dir: string): Promise<string[]> {
	const { hash } = await siteFetch<{ hash: string | null }>(site, '/graft/v1/surface');
	const specs = await siteFetch<SpecRecord[]>(site, '/graft/v1/specs');
	await mkdir(dir, { recursive: true });
	const written: string[] = [];
	for (const spec of specs) {
		const record = spec.versions.find((v) => v.version === spec.active_version && v.state === 'active');
		const build = hash ? record?.builds[hash]?.build : undefined;
		if (!record || !build) {
			continue;
		}
		await writeFile(join(dir, `${spec.spec_id}.md`), record.source);
		await writeFile(join(dir, `${spec.spec_id}.json`), JSON.stringify(build, null, '\t') + '\n');
		await writeFile(join(dir, `${spec.spec_id}.grant.json`), JSON.stringify({ scopes: record.grant?.scopes ?? [] }, null, '\t') + '\n');
		written.push(spec.spec_id);
	}
	return written;
}
