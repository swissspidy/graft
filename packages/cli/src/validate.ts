import { readdir, readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import { validateSpec, type Diagnostic, type Spec } from '@graft/core';

export interface FileResult {
	file: string;
	ok: boolean;
	spec?: Spec;
	diagnostics: Diagnostic[];
}

/** Expands files and directories (recursively) into spec file paths. */
export async function collectSpecFiles(paths: string[]): Promise<string[]> {
	const files: string[] = [];
	for (const path of paths) {
		const info = await stat(path);
		if (info.isDirectory()) {
			const entries = await readdir(path, { recursive: true, withFileTypes: true });
			for (const entry of entries) {
				if (entry.isFile() && entry.name.endsWith('.md')) {
					files.push(join(entry.parentPath, entry.name));
				}
			}
		} else {
			files.push(path);
		}
	}
	return [...new Set(files)].sort();
}

export async function validateFiles(paths: string[]): Promise<FileResult[]> {
	const files = await collectSpecFiles(paths);
	return Promise.all(
		files.map(async (file) => {
			const result = validateSpec(await readFile(file, 'utf8'));
			return { file, ...result };
		}),
	);
}

export function formatResults(results: FileResult[], cwd: string): string {
	const out: string[] = [];
	for (const result of results) {
		const rel = relative(cwd, result.file);
		const name = rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : result.file;
		const summary = result.spec
			? `  ${result.spec.manifest.id} · ${result.spec.criteria.length} criteria`
			: '';
		out.push(`${result.ok ? '✔' : '✖'} ${name}${summary}`);
		for (const d of result.diagnostics) {
			const where = d.line !== undefined ? `${name}:${d.line}` : name;
			out.push(`  ${d.severity.padEnd(7)} ${where}  ${d.message}  [${d.code}]`);
		}
	}
	const failed = results.filter((r) => !r.ok).length;
	const warnings = results.reduce((n, r) => n + r.diagnostics.filter((d) => d.severity === 'warning').length, 0);
	out.push('', `${results.length} spec(s), ${failed} invalid, ${warnings} warning(s)`);
	return out.join('\n');
}
