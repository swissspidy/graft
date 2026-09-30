import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exampleFixtures, examplesDir } from '../adapter/src/fixtures.ts';
import { DEFAULT_PHP, PLAYGROUND_CLI, paths } from '../adapter/src/playground.ts';

/**
 * Serves the Riverside Arts Centre, a client site an agency built
 * (playground/sites/riverside.php), for the agency end-to-end tests on port
 * 9402: events with custom fields and types, the agency's policy, its
 * managed customizations (examples/agency/managed) and the centre's own
 * Family friendly action waiting for approval.
 * Run `pnpm build` first so the plugin has its client bundle.
 */

const port = process.env.GRAFT_E2E_AGENCY_PORT ?? '9402';
const agencyDir = join(examplesDir, 'agency');
const dir = fileURLToPath(new URL('../../../test-results/e2e-agency', import.meta.url));
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
const surface = JSON.parse(await readFile(join(agencyDir, 'surface.json'), 'utf8'));
await writeFile(join(dir, 'examples.json'), JSON.stringify(await exampleFixtures({ dir: agencyDir, verifyAgainst: surface })));
await writeFile(
	join(dir, 'blueprint.json'),
	JSON.stringify({
		preferredVersions: { php: DEFAULT_PHP, wp: '7.1' },
		steps: [
			{
				step: 'defineWpConfigConsts',
				consts: { WP_ENVIRONMENT_TYPE: 'local', GRAFT_BROWSER_VERIFICATION: process.env.GRAFT_E2E_BROWSER_VERIFY === '1' },
			},
			{
				step: 'writeFile',
				path: '/wordpress/wp-content/mu-plugins/riverside.php',
				data: "<?php require '/graft-playground/sites/riverside.php';",
			},
			{ step: 'activatePlugin', pluginPath: 'graft/graft.php' },
			{ step: 'runPHP', code: "<?php require '/graft-playground/seed-agency.php';" },
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
		'--wp=7.1',
		`--php=${DEFAULT_PHP}`,
		'--workers=6',
		`--mount=${paths.plugin}:/wordpress/wp-content/plugins/graft`,
		`--mount=${paths.playground}:/graft-playground`,
		`--mount=${agencyDir}:/graft-agency`,
		`--mount=${join(agencyDir, 'managed')}:/wordpress/wp-content/graft-managed`,
		`--mount=${dir}:/graft-fixtures`,
		`--blueprint=${join(dir, 'blueprint.json')}`,
	],
	{ stdio: 'inherit' },
);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.on(signal, () => child.kill(signal));
}
child.on('exit', (code) => process.exit(code ?? 0));
