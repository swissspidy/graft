import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exampleFixtures } from './fixtures.ts';
import { DEFAULT_PHP, paths } from './playground.ts';

/**
 * Builds the public WordPress Playground demo into a directory that can be
 * served as is (GitHub Pages in CI):
 *
 *   graft.zip       the plugin, with its client bundle and functions worker
 *   demo.json       the example customizations, verified in Playground first
 *   seed-demo.php   the script that seeds a small newsroom and installs them
 *   blueprint.json  installs and activates the plugin, seeds, logs in
 *
 * Run `pnpm build` first. `--base-url` is where the directory will be
 * served from; the blueprint fetches the other files from there.
 */

const USAGE = `Usage: demo:build [--out <dir>] [--base-url <url>]

  --out <dir>        Where to write the demo (default: dist/demo)
  --base-url <url>   Where the directory is served from
                     (default: https://swissspidy.github.io/graft/)`;

const { values } = parseArgs({
	options: {
		out: { type: 'string', default: fileURLToPath(new URL('../../../../dist/demo', import.meta.url)) },
		'base-url': { type: 'string', default: 'https://swissspidy.github.io/graft/' },
		help: { type: 'boolean', short: 'h' },
	},
});
if (values.help) {
	console.log(USAGE);
	process.exit(0);
}

const out = values.out!;
const base = values['base-url']!.endsWith('/') ? values['base-url']! : `${values['base-url']}/`;
const wp = '7.1';

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

// The plugin, as WordPress installs it: one graft/ directory.
const staging = join(out, '.staging');
await mkdir(staging, { recursive: true });
await promisify(execFile)('cp', ['-r', paths.plugin, join(staging, 'graft')]);
await promisify(execFile)('zip', ['-qr', join(out, 'graft.zip'), 'graft'], { cwd: staging });
await rm(staging, { recursive: true, force: true });

// The examples, verified: the plugin only serves verified builds.
const surface = JSON.parse(await readFile(join(paths.surfaces, `${wp}.json`), 'utf8'));
await writeFile(join(out, 'demo.json'), JSON.stringify(await exampleFixtures({ verifyAgainst: surface })));
await copyFile(join(paths.playground, 'seed-demo.php'), join(out, 'seed-demo.php'));

const blueprint = {
	$schema: 'https://playground.wordpress.net/blueprint-schema.json',
	meta: {
		title: 'Graft',
		description: 'Durable, spec-driven customizations for wp-admin, with example customizations installed.',
		author: 'swissspidy',
	},
	landingPage: '/wp-admin/',
	preferredVersions: { php: DEFAULT_PHP, wp },
	steps: [
		{ step: 'installPlugin', pluginData: { resource: 'url', url: `${base}graft.zip` }, options: { activate: true } },
		{ step: 'mkdir', path: '/wordpress/graft-demo' },
		{ step: 'writeFile', path: '/wordpress/graft-demo/demo.json', data: { resource: 'url', url: `${base}demo.json` } },
		{ step: 'writeFile', path: '/wordpress/graft-demo/seed-demo.php', data: { resource: 'url', url: `${base}seed-demo.php` } },
		{ step: 'runPHP', code: "<?php require '/wordpress/graft-demo/seed-demo.php';" },
		{ step: 'login', username: 'admin' },
	],
};
await writeFile(join(out, 'blueprint.json'), `${JSON.stringify(blueprint, null, '\t')}\n`);
await writeFile(join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><title>Graft demo</title><meta http-equiv="refresh" content="0; url=https://playground.wordpress.net/?blueprint-url=${encodeURIComponent(`${base}blueprint.json`)}">\n`);

console.log(`Demo written to ${out} for ${base}`);
console.log(`Open: https://playground.wordpress.net/?blueprint-url=${encodeURIComponent(`${base}blueprint.json`)}`);
