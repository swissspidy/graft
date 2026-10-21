import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { canonicalJson, hashSurface, validateSpec, type Build, type Surface } from '@swissspidy/graft-core';
import { startTasklet } from '../../../fixtures/tasklet/server.ts';
import { tasklet, taskletProbes } from '../apps/tasklet.ts';
import { appSurface } from '../host/surface.ts';
import { checkDrift, formatDriftReport, observe, observedVersion, type Probes } from './drift.ts';
import { connectSandbox, startTaskletSandbox, type FixtureSandbox } from './sandbox.ts';
import { upgradeAfterDrift } from './upgrade.ts';
import '../host/a2ui.ts';

/**
 * The browser host's tooling:
 *
 *   surface [--check]       Writes surfaces/tasklet.json: the declared Tasklet surface,
 *                           fingerprinted against the fixture app (version 1).
 *   drift [options] [build.json...]
 *                           Probes the app and reports which slots and capabilities drifted
 *                           from the surface, and where each build's upgrade ladder starts.
 *     --surface <file>      Default: surfaces/tasklet.json
 *     --url <url>           The app (or a copy) to probe; default: a fixture Tasklet
 *     --app-version <n>     The fixture's version when no --url (1, 2 or 3)
 *     --probes <file>       JSON probes (session, pages, inputs); default: Tasklet's
 *     --out <file>          Also write the observed surface
 *     --spec <path>         With builds: also take each build up the upgrade ladder to the
 *                           observed surface (a spec file, or a directory of specs by id)
 *     --sandbox <url>       A copy of the changed app that speaks the fixture protocol, to
 *                           verify candidates in; default: a fixture Tasklet of --app-version
 *     --json                Print the report as JSON
 *   Exits 1 when the app drifted.
 */

const root = fileURLToPath(new URL('../../', import.meta.url));
const SURFACE = `${root}surfaces/tasklet.json`;

async function declared(): Promise<Surface> {
	const server = await startTasklet({ version: 1 });
	try {
		const surface = appSurface(tasklet);
		const { fingerprint } = await observe(surface, { url: server.url, probes: taskletProbes });
		const observed = appSurface(tasklet, { hostVersion: observedVersion(fingerprint), fingerprint });
		return { ...observed, hash: await hashSurface(observed) };
	} finally {
		await server.close();
	}
}

const [command, ...rest] = process.argv.slice(2);

if (command === 'surface') {
	const { values } = parseArgs({ args: rest, options: { check: { type: 'boolean' } } });
	const surface = await declared();
	const text = `${JSON.stringify(surface, null, '\t')}\n`;
	if (values.check) {
		const current = await readFile(SURFACE, 'utf8').catch(() => '');
		if (canonicalJson(JSON.parse(current || 'null')) !== canonicalJson(surface)) {
			console.error(`${SURFACE} is out of date: run pnpm surface:extension.`);
			process.exit(1);
		}
		console.log(`${SURFACE} is up to date (${surface.hash}).`);
	} else {
		await writeFile(SURFACE, text);
		console.log(`Wrote ${SURFACE} (${surface.hash}, ${surface.hostVersion}).`);
	}
} else if (command === 'drift') {
	const { values, positionals } = parseArgs({
		args: rest,
		allowPositionals: true,
		options: {
			surface: { type: 'string' },
			url: { type: 'string' },
			'app-version': { type: 'string' },
			probes: { type: 'string' },
			out: { type: 'string' },
			spec: { type: 'string' },
			sandbox: { type: 'string' },
			json: { type: 'boolean' },
		},
	});
	const surface = JSON.parse(await readFile(values.surface ?? SURFACE, 'utf8')) as Surface;
	const builds = await Promise.all(positionals.map(async (file) => JSON.parse(await readFile(file, 'utf8')) as Build));
	const probes = values.probes ? (JSON.parse(await readFile(values.probes, 'utf8')) as Probes) : taskletProbes;
	const appVersion = Number(values['app-version'] ?? 1);
	if (appVersion !== 1 && appVersion !== 2 && appVersion !== 3) {
		console.error('--app-version must be 1, 2 or 3.');
		process.exit(2);
	}
	const server = values.url ? undefined : await startTasklet({ version: appVersion });
	try {
		const report = await checkDrift(surface, builds, { url: values.url ?? server!.url, probes });
		if (values.out) {
			await writeFile(values.out, `${JSON.stringify(report.surface, null, '\t')}\n`);
		}
		// With --json, one document: the report, and the ladder's outcomes when it ran.
		const upgrades: Array<{ spec: string; outcome: string; path?: unknown }> = [];
		if (!values.json) {
			console.log(formatDriftReport(report));
		}
		process.exitCode = report.drifted ? 1 : 0;
		if (values.spec && builds.length > 0) {
			if (values.url && !values.sandbox) {
				throw new Error('--spec with --url needs --sandbox: a copy of the changed app to verify in, never the app itself.');
			}
			const specs = values.spec.endsWith('.md') ? [values.spec] : (await readdir(values.spec)).filter((f) => f.endsWith('.md')).map((f) => join(values.spec!, f));
			const sources = new Map<string, string>();
			for (const file of specs) {
				const source = await readFile(file, 'utf8');
				sources.set(validateSpec(source).spec?.manifest.id ?? file, source);
			}
			const sandbox: FixtureSandbox = values.sandbox ? connectSandbox(values.sandbox) : await startTaskletSandbox({ version: appVersion });
			try {
				if (!values.json) {
					console.log('Upgrade ladder (no model: regeneration is not tried):');
				}
				for (const build of builds) {
					const source = sources.get(build.spec.id);
					if (!source) {
						upgrades.push({ spec: build.spec.id, outcome: 'no_spec' });
						continue;
					}
					const result = await upgradeAfterDrift({ report, from: surface, build, source, sandbox });
					upgrades.push({ spec: build.spec.id, outcome: result.outcome, path: result.path });
				}
			} finally {
				await sandbox.close();
			}
			if (!values.json) {
				for (const upgrade of upgrades) {
					const path = upgrade.path as Array<{ state: string }> | undefined;
					console.log(`  ${upgrade.spec}: ${upgrade.outcome === 'no_spec' ? 'no spec' : `${upgrade.outcome} (${path!.map((step) => step.state).join(' → ')})`}`);
				}
			}
		}
		if (values.json) {
			console.log(JSON.stringify({ ...report, ...(upgrades.length ? { upgrades } : {}) }, null, 2));
		}
	} finally {
		await server?.close();
	}
} else {
	console.error('Usage: cli.ts surface [--check] | drift [--surface <file>] [--url <url> | --app-version <n>] [--probes <file>] [--out <file>] [--json] [build.json...]');
	process.exit(2);
}
