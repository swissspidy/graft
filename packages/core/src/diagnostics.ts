export type Severity = 'error' | 'warning';

export interface Diagnostic {
	severity: Severity;
	/** Stable, machine-readable code, e.g. `criterion-id-derived`. */
	code: string;
	message: string;
	/** 1-based line in the source file, when known. */
	line?: number;
	/** JSON pointer into the frontmatter, for schema errors. */
	path?: string;
	/**
	 * For a diagnostic of a build checked against its spec: the place in the
	 * spec the build disagrees with (a frontmatter key, as a JSON pointer,
	 * and its line, or a criterion's line), so the fix can be made on
	 * either side.
	 */
	spec?: SpecLocation;
}

export interface SpecLocation {
	/** JSON pointer into the frontmatter, e.g. `/mount/slot`. */
	path?: string;
	/** 1-based line in the spec file. */
	line?: number;
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some((d) => d.severity === 'error');
}
