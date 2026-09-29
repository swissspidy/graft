import type { Surface } from './types.ts';

/**
 * Fields that describe where a surface came from rather than what it
 * offers. Two host versions exposing the same contract hash the same.
 */
const PROVENANCE_FIELDS = ['hash', 'hostVersion', 'previous', 'migrations'] as const;

/** JSON with object keys sorted, so equal values serialize identically. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeys);
	}
	if (value !== null && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value)
				.sort()
				.map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
		);
	}
	return value;
}

export async function sha256(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Content hash of a surface's contract: `sha256:<hex>`. */
export async function hashSurface(surface: Surface): Promise<string> {
	const contract: Record<string, unknown> = { ...surface };
	for (const field of PROVENANCE_FIELDS) {
		delete contract[field];
	}
	return `sha256:${await sha256(canonicalJson(contract))}`;
}
