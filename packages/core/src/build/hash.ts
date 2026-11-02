import { canonicalJson, sha256 } from '../surface/hash.ts';
import type { Build } from './types.ts';

/** Content hash of a build: `sha256:<hex>` of its canonical JSON. */
export async function buildHash(build: Build): Promise<string> {
	return `sha256:${await sha256(canonicalJson(build))}`;
}
