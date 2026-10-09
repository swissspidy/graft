import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

/**
 * Builds the packages published to npm into their dist/: ES modules
 * bundled per entry point with shared chunks (one module registry, one
 * format registry), the JSON schemas inlined and dependencies left as
 * imports; and type declarations from tsc.
 *
 * In the workspace, packages export their TypeScript sources; publishing
 * swaps in `publishConfig.exports`, which point here.
 *
 *   tsx scripts/build-packages.ts [package dir...]
 */

const root = fileURLToPath(new URL('..', import.meta.url));
export const PUBLISHED = ['packages/core', 'packages/a2ui'];

interface Manifest {
	name: string;
	exports: Record<string, string>;
	publishConfig?: { exports?: Record<string, { types: string; default: string }> };
}

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	return (await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat();
}

export async function buildPackage(dir: string): Promise<void> {
	const pkg = join(root, dir);
	const manifest = JSON.parse(await readFile(join(pkg, 'package.json'), 'utf8')) as Manifest;
	const dist = join(pkg, 'dist');
	await rm(dist, { recursive: true, force: true });

	await build({
		entryPoints: Object.values(manifest.exports).map((entry) => join(pkg, entry)),
		outbase: join(pkg, 'src'),
		outdir: dist,
		bundle: true,
		splitting: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		packages: 'external',
		chunkNames: 'chunks/[name]-[hash]',
		legalComments: 'none',
		logLevel: 'warning',
	});

	// Declarations: tsc keeps the sources' .ts specifiers, which point at .d.ts files once published.
	const tsconfig = join(pkg, 'tsconfig.build.json');
	await writeFile(
		tsconfig,
		JSON.stringify({
			extends: '../../tsconfig.base.json',
			compilerOptions: { noEmit: false, declaration: true, emitDeclarationOnly: true, rootDir: 'src', outDir: 'dist' },
			include: ['src'],
		}),
	);
	try {
		execFileSync(join(root, 'node_modules/.bin/tsc'), ['-p', tsconfig], { stdio: 'inherit' });
	} finally {
		await rm(tsconfig);
	}
	for (const file of (await walk(dist)).filter((f) => f.endsWith('.d.ts'))) {
		const source = await readFile(file, 'utf8');
		await writeFile(file, source.replace(/((?:from|import)\s+['"]\.{1,2}\/[^'"]+)\.ts(['"])/g, '$1.js$2'));
	}

	// Every published export must exist.
	for (const [path, target] of Object.entries(manifest.publishConfig?.exports ?? {})) {
		for (const file of [target.types, target.default]) {
			if (!existsSync(join(pkg, file))) {
				throw new Error(`${manifest.name}: export "${path}" points at ${file}, which the build did not write.`);
			}
		}
	}
	console.log(`Built ${manifest.name} into ${dir}/dist`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const dirs = process.argv.slice(2);
	for (const dir of dirs.length ? dirs : PUBLISHED) {
		await buildPackage(dir);
	}
}
