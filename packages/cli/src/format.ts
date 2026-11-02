import { isAbsolute, relative } from 'node:path';
import type { Diagnostic, SpecLocation } from '@swissspidy/graft-core';

/** A path relative to the working directory when it is inside it. */
export function displayPath(file: string, cwd = process.cwd()): string {
	const rel = relative(cwd, file);
	return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : file;
}

/**
 * Where in the spec a build's diagnostic points: `spec.md:12 (/mount/slot)`,
 * the file and line an editor can jump to, and the frontmatter key.
 */
export function formatSpecLocation(location: SpecLocation | undefined, specFile: string | undefined): string {
	if (!location || (location.line === undefined && location.path === undefined)) {
		return '';
	}
	const file = specFile ? displayPath(specFile) : 'spec';
	const where = location.line !== undefined ? `${file}:${location.line}` : file;
	return location.path !== undefined && location.line !== undefined ? `${where} (${location.path})` : location.path !== undefined ? `${where} ${location.path}` : where;
}

/** One diagnostic of a build, on one line, with the spec line it is about when it has one. */
export function formatBuildDiagnostic(d: Diagnostic, specFile?: string): string {
	const spec = formatSpecLocation(d.spec, specFile);
	return `${d.severity.padEnd(7)} ${d.path ?? ''}  ${d.message}  [${d.code}]${spec ? `  → ${spec}` : ''}`;
}
