/**
 * The Playground --wp value for a surface's WordPress version: major.minor
 * for releases, "nightly" for alphas and "beta" for betas and release
 * candidates. Canary suffixes ("7.1.2+scenario") are ignored.
 */
export function playgroundVersion(hostVersion: string): string {
	const version = hostVersion.split('+')[0]!;
	if (/-alpha/i.test(version)) {
		return 'nightly';
	}
	if (/-(beta|rc)/i.test(version)) {
		return 'beta';
	}
	return version.split('.').slice(0, 2).join('.');
}
