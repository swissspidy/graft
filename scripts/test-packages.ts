import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISHED } from './build-packages.ts';

/**
 * Packs the published packages as npm would get them, installs the
 * tarballs into an empty project outside the workspace and imports every
 * export, so a package that would not work once published fails here.
 *
 *   tsx scripts/test-packages.ts
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const work = await mkdtemp(join(tmpdir(), 'graft-packages-'));
try {
	const packs = join(work, 'packs');
	const imports: string[] = [];
	for (const dir of PUBLISHED) {
		execFileSync('pnpm', ['pack', '--pack-destination', packs], { cwd: join(root, dir), stdio: ['ignore', 'ignore', 'inherit'] });
		const manifest = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8')) as { name: string; exports: Record<string, string> };
		imports.push(...Object.keys(manifest.exports).map((path) => manifest.name + path.slice(1)));
	}
	const project = join(work, 'project');
	await mkdir(project);
	await writeFile(join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
	const tarballs = (await readdir(packs)).map((file) => join(packs, file));
	execFileSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', ...tarballs], { cwd: project, stdio: 'inherit' });

	const script = `${imports.map((name, i) => `import * as m${i} from '${name}';`).join('\n')}
const modules = { ${imports.map((name, i) => `'${name}': m${i}`).join(', ')} };
for (const [name, module] of Object.entries(modules)) {
	if (Object.keys(module).length === 0) throw new Error(name + ' exports nothing');
	console.log('✔ ' + name + ' (' + Object.keys(module).length + ' exports)');
}
// Shared chunks: the entry points see one registry of UI formats.
const { registerUiFormat, uiFormatNamed } = modules['@swissspidy/graft-core'];
const { createA2UIFormat } = modules['@swissspidy/graft-a2ui'];
registerUiFormat(createA2UIFormat({ host: 'acme', catalogId: 'graft:acme' }));
if (!uiFormatNamed('A2UI', 'acme')) throw new Error('the A2UI format did not register');
console.log('✔ the A2UI format registers with core');
`;
	await writeFile(join(project, 'check.mjs'), script);
	execFileSync('node', ['check.mjs'], { cwd: project, stdio: 'inherit' });
} finally {
	await rm(work, { recursive: true, force: true });
}
