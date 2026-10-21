import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { hashSurface, validateBuild, validateSpec, validateSurface, type Build, type Surface } from '@swissspidy/graft-core';
import { tasklet } from '../src/apps/tasklet.ts';
import { extensionManifest } from '../src/extension/manifest.ts';
import { appSurface } from '../src/host/surface.ts';
import '../src/host/a2ui.ts';

const surface = JSON.parse(await readFile(new URL('../surfaces/tasklet.json', import.meta.url), 'utf8')) as Surface;
const read = (path: string) => readFile(new URL(`../../../../examples/chrome-extension/${path}`, import.meta.url), 'utf8');

describe('the Tasklet surface', () => {
	it('is the declared app with its observed fingerprint, and hashes to its hash', async () => {
		expect((await validateSurface(surface)).ok).toBe(true);
		expect(surface.hash).toBe(await hashSurface(surface));
		const declared = appSurface(tasklet, { hostVersion: surface.hostVersion, fingerprint: surface.fingerprint! });
		expect(await hashSurface(declared)).toBe(surface.hash);
	});

	it('keeps anchors in the hashed model: moving one is a new surface', async () => {
		const moved = structuredClone(surface);
		(moved.model as { anchors: Record<string, { selectors: string[] }> }).anchors['project.sidebar']!.selectors = ['aside.details'];
		expect(await hashSurface(moved)).not.toBe(surface.hash);
	});

	it('takes the example spec and build', async () => {
		const source = await read('specs/my-tasks.md');
		const { spec } = validateSpec(source, { surface });
		expect(spec?.manifest.id).toBe('my-tasks');
		const build = JSON.parse(await read('builds/my-tasks.json')) as Build;
		const validation = await validateBuild(build, surface);
		expect(validation.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
		const bundle = JSON.parse(await read('bundles/my-tasks.json')) as { builds: Array<{ build: Build }> };
		expect(bundle.builds[0]!.build).toEqual(build);
	});
});

describe('the extension manifest', () => {
	it('asks for the app’s origin and storage, and nothing that would expose the extension to pages', () => {
		const manifest = extensionManifest([surface], '0.0.1');
		expect(manifest.permissions).toEqual(['storage']);
		expect(manifest.host_permissions).toEqual(['http://127.0.0.1/*']);
		expect(manifest.content_scripts).toEqual([{ matches: ['http://127.0.0.1/projects/*'], js: ['content.js'], run_at: 'document_idle', all_frames: false }]);
		expect(manifest).not.toHaveProperty('externally_connectable');
		expect(manifest).not.toHaveProperty('web_accessible_resources');
	});
});
