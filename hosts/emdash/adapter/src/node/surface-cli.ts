import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { hashSurface, validateSurface, type Surface } from '@graft/core';
import { hostSurface } from '../host/surface.ts';
import { emdashVersion } from '../index.ts';

/**
 * Writes the EmDash surface snapshot for the installed EmDash version:
 *
 *   tsx hosts/emdash/adapter/src/node/surface-cli.ts [--check]
 *
 * The surface is declared by the adapter (src/host/surface.ts); the hash
 * leaves the version out, so a new EmDash version only changes the hash
 * when what builds can use changes.
 */

export const SURFACES = fileURLToPath(new URL('../../surfaces/', import.meta.url));
const SITE = fileURLToPath(new URL('../../../site/', import.meta.url));

export async function generateSurface(version = emdashVersion(SITE)): Promise<Surface> {
	const surface = hostSurface(version);
	const validation = await validateSurface(surface);
	if (!validation.ok) {
		throw new Error(`Invalid EmDash surface: ${validation.diagnostics.map((d) => d.message).join('; ')}`);
	}
	return { ...surface, hash: await hashSurface(surface) };
}

export const surfaceFile = (version: string) => `${SURFACES}${version.split('.').slice(0, 2).join('.')}.json`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const surface = await generateSurface();
	const file = surfaceFile(surface.hostVersion);
	const json = JSON.stringify(surface, null, '\t') + '\n';
	if (process.argv.includes('--check')) {
		const existing = await readFile(file, 'utf8').catch(() => '');
		if (existing !== json) {
			console.error(`${file} is out of date. Run: pnpm surface:emdash`);
			process.exit(1);
		}
		console.log(`${file} is up to date (${surface.hash}).`);
	} else {
		await writeFile(file, json);
		console.log(`Wrote ${file} (${surface.hash}).`);
	}
}
