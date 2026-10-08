import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleFixtures, examplesDir } from '../adapter/src/fixtures.ts';
import { DEFAULT_PHP, PLAYGROUND_CLI, paths } from '../adapter/src/playground.ts';

/**
 * Serves the A2UI end-to-end site on port 9403: the e2e site (users,
 * posts, seed), with the example specs built as A2UI surfaces
 * (examples/a2ui/builds) instead of trees, verified, attached and approved
 * through Graft's own paths.
 * Run `pnpm build` first so the plugin has its client bundles.
 */

const port = process.env.GRAFT_E2E_A2UI_PORT ?? '9403';
const wp = process.env.GRAFT_E2E_WP ?? '7.1';
// A fixed directory, so tests can read what the seed writes (the admin's
// application password).
const dir = fileURLToPath(new URL('../../../test-results/e2e-a2ui-fixtures', import.meta.url));
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
// Verify the example builds first: the site only serves verified builds.
const surface = JSON.parse(await readFile(join(paths.surfaces, `${wp}.json`), 'utf8'));
await writeFile(join(dir, 'examples.json'), JSON.stringify(await exampleFixtures({ buildsDir: join(examplesDir, 'a2ui', 'builds'), verifyAgainst: surface })));
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
					// No update checks or other requests to wordpress.org from the server: the first
					// admin page after login makes them inline, which can take over a minute on CI.
					WP_HTTP_BLOCK_EXTERNAL: true,
					// Verifying in the admin's browser needs playground.wordpress.net;
					// CI turns it on with GRAFT_E2E_BROWSER_VERIFY=1.
					GRAFT_BROWSER_VERIFICATION: process.env.GRAFT_E2E_BROWSER_VERIFY === '1',
				},
			},
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
