import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { hasErrors, validateSurface } from '@graft/core';
import { assembleSurface, generateSurface, type GeneratedSurface, type HostDump } from './surface.ts';
import { paths } from './playground.ts';

const USAGE = `Usage: surface:generate [--wp <version>]... [--out-dir <dir>] [--check] [--from-dump <file> --name <name>]

Boots each WordPress version in Playground with the Graft plugin active and
writes its surface to <out-dir>/<version>.json (default: hosts/wordpress/plugin/surfaces).

  --wp <version>      WordPress version: 7.1, latest, beta, nightly. Repeatable. Default: 7.1
  --check             Do not write; fail if a generated contract differs from the
                      checked-in file (compares hashes, so a new hostVersion alone passes)
  --from-dump <file>  Assemble from a saved host dump instead of booting Playground
  --name <name>       Output file name (without .json) for --from-dump`;

async function main(argv: string[]): Promise<number> {
	const { values } = parseArgs({
		args: argv,
		options: {
			wp: { type: 'string', multiple: true },
			'out-dir': { type: 'string', default: paths.surfaces },
			'from-dump': { type: 'string' },
			name: { type: 'string' },
			check: { type: 'boolean', default: false },
			help: { type: 'boolean', short: 'h' },
		},
	});
	if (values.help) {
		console.log(USAGE);
		return 0;
	}
	const outDir = values['out-dir'];
	await mkdir(outDir, { recursive: true });

	const jobs: Array<{ name: string; run: () => Promise<GeneratedSurface> }> = [];
	if (values['from-dump']) {
		const file = values['from-dump'];
		jobs.push({
			name: values.name ?? 'surface',
			run: async () => {
				const surface = await assembleSurface(JSON.parse(await readFile(file, 'utf8')) as HostDump);
				return { surface, diagnostics: (await validateSurface(surface)).diagnostics };
			},
		});
	} else {
		for (const wp of values.wp ?? ['7.1']) {
			jobs.push({ name: wp, run: () => generateSurface(wp) });
		}
	}

	let failed = false;
	for (const job of jobs) {
		process.stderr.write(`Generating surface ${job.name}…\n`);
		const { surface, diagnostics } = await job.run();
		for (const d of diagnostics) {
			console.error(`  ${d.severity} ${d.path ?? ''} ${d.message} [${d.code}]`);
		}
		if (hasErrors(diagnostics)) {
			failed = true;
			continue;
		}
		const file = join(outDir, `${job.name}.json`);
		if (values.check) {
			const stored = await readStoredHash(file);
			if (stored !== surface.hash) {
				failed = true;
				console.error(`${file} is out of date: stored ${stored ?? 'nothing'}, generated ${surface.hash}. Run pnpm surface:generate and commit the result.`);
			} else {
				console.log(`${file}  up to date (WordPress ${surface.hostVersion})`);
			}
			continue;
		}
		await writeFile(file, JSON.stringify(surface, null, '\t') + '\n');
		console.log(`${file}  WordPress ${surface.hostVersion}  ${surface.hash}`);
	}
	return failed ? 1 : 0;
}

async function readStoredHash(file: string): Promise<string | undefined> {
	try {
		return (JSON.parse(await readFile(file, 'utf8')) as { hash?: string }).hash;
	} catch {
		return undefined;
	}
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
