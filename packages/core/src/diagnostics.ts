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
}

export function hasErrors(diagnostics: readonly Diagnostic[]): boolean {
	return diagnostics.some((d) => d.severity === 'error');
}
