import { extractRefs, hashSpec, nextSpecState, validateBuild, validateSpec, type Build, type Diagnostic, type SpecEvent, type SpecState, type Surface, type Verification } from '@graft/core';

/**
 * Customizations, stored in the plugin's KV. One record per spec id, with
 * its versions; each version moves through the shared lifecycle table
 * (schemas/spec-lifecycle.json). Only administrators write here (the
 * routes require plugins:manage), so every spec is site-wide.
 */

export interface Version {
	n: number;
	source: string;
	specHash: string;
	state: SpecState;
	build?: Build;
	verification?: Verification;
	/** Scopes the build needs, derived from its content, never taken from it. */
	scopes: string[];
	createdAt: string;
}

export interface SpecRecord {
	id: string;
	title: string;
	versions: Version[];
	/** Scopes an administrator approved for this customization. */
	grant: string[];
}

export interface KV {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	list(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
}

export class StoreError extends Error {
	constructor(
		message: string,
		readonly diagnostics: Diagnostic[] = [],
	) {
		super(message);
		this.name = 'StoreError';
	}
}

const MAX_SOURCE = 20_000;
const MAX_VERSIONS = 25;
const key = (id: string) => `spec:${id}`;

/** Scopes a build needs, from the capabilities it actually uses. */
export function buildScopes(build: Pick<Build, 'mount' | 'tree' | 'data'>, surface: Surface): string[] {
	const refs = extractRefs(build, surface);
	return [...new Set(refs.capabilities.flatMap((name) => surface.capabilities[name]?.scopes ?? []))].sort();
}

function transition(version: Version, event: SpecEvent): void {
	const next = nextSpecState(version.state, event);
	if (!next) {
		throw new StoreError(`Version ${version.n} is ${version.state}; "${event}" is not allowed.`);
	}
	version.state = next;
}

export const activeVersion = (record: SpecRecord) => record.versions.find((v) => v.state === 'active');
export const pendingVersion = (record: SpecRecord) => [...record.versions].reverse().find((v) => v.state === 'needs_approval');

export function createStore(kv: KV, surface: () => Promise<Surface>) {
	const read = async (id: string) => kv.get<SpecRecord>(key(id));

	/** Makes `version` the active one; the previous active version is superseded. */
	const activate = (record: SpecRecord, version: Version, event: SpecEvent) => {
		const previous = activeVersion(record);
		transition(version, event);
		if (previous && previous !== version) {
			transition(previous, 'supersede');
		}
	};

	return {
		read,

		async list(): Promise<SpecRecord[]> {
			return (await kv.list('spec:')).map((entry) => entry.value as SpecRecord).sort((a, b) => a.id.localeCompare(b.id));
		},

		/**
		 * Stores a new version of a spec, with a build and its verification
		 * when there is one. A build that passed its checks on the current
		 * surface goes live when the grant covers it, else it waits for
		 * approval; anything else is kept as a draft.
		 */
		async put(input: { source: string; build?: unknown; verification?: Verification }): Promise<{ record: SpecRecord; version: Version }> {
			if (input.source.length > MAX_SOURCE) {
				throw new StoreError(`Specs are limited to ${MAX_SOURCE} characters.`);
			}
			const current = await surface();
			const validation = validateSpec(input.source, { surface: current });
			if (!validation.ok || !validation.spec) {
				throw new StoreError('The spec is not valid for this site.', validation.diagnostics);
			}
			const spec = validation.spec;
			const specHash = await hashSpec(input.source);
			const record: SpecRecord = (await read(spec.manifest.id)) ?? { id: spec.manifest.id, title: spec.title, versions: [], grant: [] };
			if (record.versions.length >= MAX_VERSIONS) {
				throw new StoreError(`A customization keeps at most ${MAX_VERSIONS} versions.`);
			}
			record.title = spec.title;
			const version: Version = { n: (record.versions.at(-1)?.n ?? 0) + 1, source: input.source, specHash, state: 'draft', scopes: [], createdAt: new Date().toISOString() };
			record.versions.push(version);

			if (input.build !== undefined) {
				const result = await validateBuild(input.build, current, { spec: { spec, hash: specHash } });
				if (!result.ok || !result.build) {
					throw new StoreError('The build is not valid for this spec and site.', result.diagnostics);
				}
				version.build = result.build;
				version.scopes = buildScopes(result.build, current);
				const verified =
					input.verification?.passed === true &&
					input.verification.spec.hash === specHash &&
					input.verification.surface.hash === current.hash &&
					result.build.surface.hash === current.hash;
				if (verified) {
					version.verification = input.verification;
					transition(version, 'submit');
					const covered = version.scopes.every((scope) => record.grant.includes(scope));
					if (covered) {
						activate(record, version, 'verified_within_grant');
					} else {
						transition(version, 'verified_needs_grant');
					}
				}
			}
			await kv.set(key(record.id), record);
			return { record, version };
		},

		/** Approves the pending version: its scopes join the grant and it goes live. */
		async approve(id: string): Promise<SpecRecord> {
			const record = await read(id);
			const version = record && pendingVersion(record);
			if (!record || !version) {
				throw new StoreError(`"${id}" has nothing waiting for approval.`);
			}
			record.grant = [...new Set([...record.grant, ...version.scopes])].sort();
			activate(record, version, 'approve');
			await kv.set(key(id), record);
			return record;
		},

		async archive(id: string): Promise<SpecRecord> {
			const record = await read(id);
			const version = record && activeVersion(record);
			if (!record || !version) {
				throw new StoreError(`"${id}" is not active.`);
			}
			transition(version, 'archive');
			await kv.set(key(id), record);
			return record;
		},
	};
}

export type Store = ReturnType<typeof createStore>;
