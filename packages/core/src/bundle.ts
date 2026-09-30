import type { Build } from './build/types.ts';
import { hashSpec } from './spec/hash.ts';
import type { SpecManifest } from './spec/types.ts';
import type { Verification } from './verifier/run.ts';

/**
 * One customization as a file: its spec (the source, and the manifest the
 * core parsed from it, because hosts cannot all parse YAML) and verified
 * builds for one or more surfaces. Written by `graft bundle`.
 *
 * On WordPress, bundles in the policy's managed directory are
 * customizations the site's maintainer ships with its code. They are also
 * the unit for sharing a customization with another site.
 */
export interface CustomizationBundle {
	graft: 1;
	kind: 'customization';
	title: string;
	spec: { source: string; manifest: SpecManifest; hash: string };
	builds: Array<{ build: Build; verification: Verification }>;
}

export async function createBundle(
	source: string,
	spec: { title: string; manifest: SpecManifest },
	builds: Array<{ build: Build; verification: Verification }>,
): Promise<CustomizationBundle> {
	return {
		graft: 1,
		kind: 'customization',
		title: spec.title,
		spec: { source, manifest: spec.manifest, hash: await hashSpec(source) },
		builds,
	};
}
