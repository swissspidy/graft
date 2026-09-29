import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { exampleFixtures } from './fixtures.ts';
import { lastJsonLine, runPhp } from './playground.ts';

interface SmokeResult {
	wp: string;
	php: string;
	checks: Array<{ name: string; ok: boolean; detail: unknown }>;
}

/**
 * Runs playground/smoke.php against each WordPress and PHP version pair and
 * reports the checks. Exit code 1 if any check fails.
 */
async function main(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			wp: { type: 'string', multiple: true },
			php: { type: 'string', multiple: true },
		},
	});
	const fixtures = await mkdtemp(join(tmpdir(), 'graft-fixtures-'));
	await writeFile(join(fixtures, 'examples.json'), JSON.stringify(await exampleFixtures()));
	let failed = 0;
	for (const wp of values.wp ?? ['7.1']) {
		for (const php of values.php ?? ['7.4', '8.4']) {
			const output = await runPhp({ wp, php, script: '/graft-playground/smoke.php', mounts: { [fixtures]: '/graft-fixtures' } });
			const result = lastJsonLine(output) as SmokeResult;
			console.log(`WordPress ${result.wp}, PHP ${result.php}`);
			for (const check of result.checks) {
				console.log(`  ${check.ok ? '✔' : '✖'} ${check.name}`);
				if (!check.ok) {
					failed++;
					console.log(`      ${JSON.stringify(check.detail)}`);
				}
			}
		}
	}
	await rm(fixtures, { recursive: true, force: true });
	console.log(failed ? `\n${failed} check(s) failed` : '\nAll checks passed');
	return failed ? 1 : 0;
}

main(process.argv.slice(2)).then(
	(code) => {
		process.exitCode = code;
	},
	(error: unknown) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	},
);
