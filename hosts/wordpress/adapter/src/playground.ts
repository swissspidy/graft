import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Playground CLI version the adapter is tested with. It is run through npx
 * on demand rather than installed, because it is large and only the surface
 * generator and sandbox need it.
 */
export const PLAYGROUND_CLI = '@wp-playground/cli@3.1.56';

/** PHP version used when none is given; matches Playground CLI's default. */
export const DEFAULT_PHP = '8.3';

export const paths = {
	plugin: fileURLToPath(new URL('../../plugin', import.meta.url)),
	playground: fileURLToPath(new URL('../../playground', import.meta.url)),
	surfaces: fileURLToPath(new URL('../../plugin/surfaces', import.meta.url)),
};

export interface RunPhpOptions {
	/** WordPress version, e.g. 7.1, latest, beta or nightly. */
	wp: string;
	/** PHP version, DEFAULT_PHP when omitted. */
	php?: string;
	/** Script path inside the Playground file system, under /graft-playground. */
	script: string;
	/** Extra mounts: host path → Playground path. */
	mounts?: Record<string, string>;
}

/**
 * Boots WordPress in Playground with the Graft plugin mounted and active,
 * runs one PHP script and returns its standard output.
 */
export async function runPhp({ wp, php = DEFAULT_PHP, script, mounts = {} }: RunPhpOptions): Promise<string> {
	// With a blueprint, Playground takes versions from the blueprint and
	// ignores --php, so each run gets a copy with preferredVersions set.
	const blueprint = JSON.parse(await readFile(join(paths.playground, 'blueprint.json'), 'utf8')) as object;
	const dir = await mkdtemp(join(tmpdir(), 'graft-playground-'));
	const blueprintFile = join(dir, 'blueprint.json');
	await writeFile(blueprintFile, JSON.stringify({ ...blueprint, preferredVersions: { php, wp } }));
	const args = [
		'--yes',
		PLAYGROUND_CLI,
		'php',
		`--wp=${wp}`,
		`--php=${php}`,
		'--verbosity=quiet',
		`--mount=${paths.plugin}:/wordpress/wp-content/plugins/graft`,
		`--mount=${paths.playground}:/graft-playground`,
		...Object.entries(mounts).map(([from, to]) => `--mount=${from}:${to}`),
		`--blueprint=${blueprintFile}`,
		'--',
		script,
	];
	try {
		return await spawnOutput('npx', args, `${script} on WordPress ${wp}, PHP ${php}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function spawnOutput(command: string, args: string[], what: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let stdout = '';
		let stderr = '';
		child.stdout.on('data', (chunk: Buffer) => (stdout += chunk));
		child.stderr.on('data', (chunk: Buffer) => (stderr += chunk));
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve(stdout);
			} else {
				reject(new Error(`Playground exited with ${code} running ${what}:\n${stderr || stdout}`));
			}
		});
	});
}

/** Parses the last line of output that is a JSON object. */
export function lastJsonLine(output: string): unknown {
	const line = output
		.trim()
		.split('\n')
		.reverse()
		.find((l) => l.trimStart().startsWith('{'));
	if (!line) {
		throw new Error(`No JSON in output:\n${output}`);
	}
	return JSON.parse(line);
}
