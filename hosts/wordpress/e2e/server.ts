import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exampleFixtures } from '../adapter/src/fixtures.ts';
import { DEFAULT_PHP, PLAYGROUND_CLI, paths } from '../adapter/src/playground.ts';

/**
 * Serves a seeded WordPress for the end-to-end tests on port 9400:
 * the plugin active, test users and posts, and the example specs verified,
 * attached and approved.
 * Run `pnpm build` first so the plugin has its client bundle.
 */

const port = process.env.GRAFT_E2E_PORT ?? '9400';
const wp = process.env.GRAFT_E2E_WP ?? '7.1';
const dir = await mkdtemp(join(tmpdir(), 'graft-e2e-'));
// Verify the example builds first: the site only serves verified builds.
const surface = JSON.parse(await readFile(join(paths.surfaces, `${wp}.json`), 'utf8'));
await writeFile(join(dir, 'examples.json'), JSON.stringify(await exampleFixtures({ verifyAgainst: surface })));
await writeFile(
	join(dir, 'blueprint.json'),
	JSON.stringify({
		preferredVersions: { php: DEFAULT_PHP, wp },
		steps: [
			{ step: 'activatePlugin', pluginPath: 'graft/graft.php' },
			{ step: 'runPHP', code: "<?php require '/graft-playground/seed-e2e.php';" },
		],
	}),
);

const child = spawn(
	'npx',
	[
		'--yes',
		PLAYGROUND_CLI,
		'server',
		`--port=${port}`,
		`--wp=${wp}`,
		`--php=${DEFAULT_PHP}`,
		`--mount=${paths.plugin}:/wordpress/wp-content/plugins/graft`,
		`--mount=${paths.playground}:/graft-playground`,
		`--mount=${dir}:/graft-fixtures`,
		`--blueprint=${join(dir, 'blueprint.json')}`,
	],
	{ stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
