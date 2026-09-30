import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleFixtures, examplesDir, modelAnswers } from '../adapter/src/fixtures.ts';
import { DEFAULT_PHP, PLAYGROUND_CLI, paths } from '../adapter/src/playground.ts';

/**
 * Serves a seeded WordPress for the end-to-end tests on port 9400:
 * the plugin active, test users and posts, and the example specs verified,
 * attached and approved.
 * Run `pnpm build` first so the plugin has its client bundle.
 */

const port = process.env.GRAFT_E2E_PORT ?? '9400';
const wp = process.env.GRAFT_E2E_WP ?? '7.1';
// A fixed directory, so tests can read what the seed writes (the admin's
// application password).
const dir = fileURLToPath(new URL('../../../test-results/e2e-fixtures', import.meta.url));
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
// Verify the example builds first: the site only serves verified builds.
const surface = JSON.parse(await readFile(join(paths.surfaces, `${wp}.json`), 'utf8'));
await writeFile(join(dir, 'examples.json'), JSON.stringify(await exampleFixtures({ verifyAgainst: surface })));
// The scripted model answers with the waiting-posts build, for authoring tests.
await writeFile(join(dir, 'model.json'), JSON.stringify(modelAnswers(JSON.parse(await readFile(join(examplesDir, 'builds/waiting-posts.json'), 'utf8')))));
await writeFile(
	join(dir, 'blueprint.json'),
	JSON.stringify({
		preferredVersions: { php: DEFAULT_PHP, wp },
		steps: [
			// Application passwords need HTTPS or a local environment.
			{
				step: 'defineWpConfigConsts',
				consts: {
					WP_ENVIRONMENT_TYPE: 'local',
					// Verifying in the admin's browser needs playground.wordpress.net;
					// CI turns it on with GRAFT_E2E_BROWSER_VERIFY=1.
					GRAFT_BROWSER_VERIFICATION: process.env.GRAFT_E2E_BROWSER_VERIFY === '1',
				},
			},
			{ step: 'activatePlugin', pluginPath: 'graft/graft.php' },
			{ step: 'runPHP', code: "<?php require '/graft-playground/seed-e2e.php';" },
			{
				step: 'writeFile',
				path: '/wordpress/wp-content/mu-plugins/graft-e2e-model.php',
				data: "<?php require '/graft-playground/e2e-model.php';",
			},
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
		// The CLI drops to cpus-1 workers on small runners (3 on CI) and warns that fewer than
		// 6 can deadlock on file locks; the dashboard's parallel requests hung a login there.
		'--workers=6',
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
