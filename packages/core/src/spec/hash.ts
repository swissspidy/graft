import { sha256 } from '../surface/hash.ts';

/**
 * Normalizes a spec file for hashing: no BOM, LF line endings, no trailing
 * whitespace, exactly one final newline. Formatting noise does not create
 * a new spec version.
 */
export function normalizeSpecSource(source: string): string {
	return (
		source
			.replace(/^﻿/, '')
			.replace(/\r\n?/g, '\n')
			.split('\n')
			.map((line) => line.trimEnd())
			.join('\n')
			.trimEnd() + '\n'
	);
}

/** Content hash of a spec file: `sha256:<hex>`. */
export async function hashSpec(source: string): Promise<string> {
	return `sha256:${await sha256(normalizeSpecSource(source))}`;
}
