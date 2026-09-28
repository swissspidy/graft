import { parseArgs } from 'node:util';
import { formatResults, validateFiles } from './validate.ts';

const USAGE = `Usage: graft <command> [options]

Commands:
  validate <path...>   Validate spec files or directories of specs
    --json             Print results as JSON

Coming next (see docs/adr/0001-architecture.md, section 9):
  compile, verify, canary`;

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === 'validate') {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: { json: { type: 'boolean', default: false } },
		});
		if (positionals.length === 0) {
			console.error('graft validate: pass at least one spec file or directory.');
			return 2;
		}
		const results = await validateFiles(positionals);
		if (values.json) {
			console.log(JSON.stringify(results, null, 2));
		} else {
			console.log(formatResults(results, process.cwd()));
		}
		return results.every((r) => r.ok) ? 0 : 1;
	}
	if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
		console.log(USAGE);
		return command === undefined ? 2 : 0;
	}
	console.error(`graft: unknown command "${command}"\n\n${USAGE}`);
	return 2;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('bin/graft.js')) {
	main(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		(error: unknown) => {
			console.error(error instanceof Error ? error.message : error);
			process.exitCode = 2;
		},
	);
}
