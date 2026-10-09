import { parseArgs } from 'node:util';
import { anthropicModel, DEFAULT_MODEL } from './anthropic.ts';
import { checkBuildFile } from './build.ts';
import { bundleFiles } from './bundle.ts';
import { canaryCommand } from './canary.ts';
import { compileFile } from './compile.ts';
import { emdashSiteInstall, emdashSitePull, emdashSiteVerify } from './site-emdash.ts';
import { sitePull, siteVerify, type Site } from './site.ts';
import { formatCanaryReport } from '@graft/core';
import { formatVerification, verifyFiles } from './verify.ts';
import { formatResults, loadSurface, validateFiles } from './validate.ts';

const USAGE = `Usage: graft <command> [options]

Commands:
  validate <path...>   Validate spec files or directories of specs
    --surface <file>   Also check mount, audience and permissions against a
                       host surface, e.g. hosts/wordpress/plugin/surfaces/7.1.json
    --json             Print results as JSON
  build <file>         Validate a build against a surface
    --surface <file>   Surface the build targets (required)
    --spec <file>      Also check it against the spec it implements
    --fix-refs         Recompute refs and hashes and rewrite the file
  verify <file...>     Run builds' checks in a sandbox of their host
    --surface <file>   Surface the builds target (required)
    --spec <path>      Spec file, or directory of specs matched by id (required)
    --out <dir>        Write one verification record per spec
    --json             Print results as JSON
    --verbose          Show the sandbox's output
  bundle <build...>    Verify builds and write them with their spec as one customization
                       bundle (for a WordPress site's managed directory, or to share)
    --spec <file>      The spec the builds implement (required)
    --surface <file>   A surface a build targets (required; repeatable)
    --out <file>       Where to write the bundle (required)
  compile <spec>       Compile a spec into a verified build with Claude
    --surface <file>   Surface to build for (required)
    --out <file>       Where to write the build (default: <spec id>.build.json)
    --model <id>       Model (default: ${DEFAULT_MODEL})
    --attempts <n>     Attempts per phase (default: 3)
    --previous <file>  Earlier build of the same spec version: reuse its checks, regenerate the UI
    --ui <format>      a2ui or tree (default: the previous build's format, else
                       the host's: a2ui on WordPress and EmDash)
    --no-verify        Only validate candidates, do not run their checks
                       Needs ANTHROPIC_API_KEY (or an \`ant auth login\` profile).
  canary               Upgrade every tenant's customizations ahead of a host change
    --corpus <dir>     One directory per tenant with <spec>.md and its <spec>.json build
    --from <file>      Surface the builds were made for (required)
    --to <file>        Surface of the next host version, or:
    --scenario <name>  A synthetic host change (hosts/wordpress/adapter/src/canary.ts,
                       hosts/emdash/adapter/src/node/canary.ts)
    --regenerate       Let Claude regenerate builds nothing else can save (needs a key)
    --out <dir>        Write upgraded builds and report.json
    --json             Print the report as JSON
  site verify          Verify a site's unverified builds (e.g. built in wp-admin) and send the results
  site pull            Export a site's active customizations as a canary corpus tenant
  site install <spec> <build>
                       EmDash: verify a build locally and install it on the site
    --site <url>       Site with the Graft plugin (or GRAFT_SITE)
    --user <login>     WordPress: administrator (or GRAFT_USER)
    --password <app>   WordPress: application password (or GRAFT_APP_PASSWORD)
    --token <token>    EmDash: API token with the admin scope (or GRAFT_TOKEN)
    --surfaces <dir>   Surface snapshots (default: the host's surfaces directory)
    --out <dir>        pull: tenant directory to write
    --no-verify        install: send the build unverified (it stays a draft)

See docs/adr/0001-architecture.md for how the pieces fit together.`;

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	if (command === 'validate') {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				json: { type: 'boolean', default: false },
				surface: { type: 'string' },
			},
		});
		if (positionals.length === 0) {
			console.error('graft validate: pass at least one spec file or directory.');
			return 2;
		}
		const surface = values.surface ? await loadSurface(values.surface) : undefined;
		const results = await validateFiles(positionals, surface);
		if (values.json) {
			console.log(JSON.stringify(results, null, 2));
		} else {
			if (surface) {
				console.log(`Checking against ${surface.host} ${surface.hostVersion} (${surface.hash ?? 'unhashed'})\n`);
			}
			console.log(formatResults(results, process.cwd()));
		}
		return results.every((r) => r.ok) ? 0 : 1;
	}
	if (command === 'build') {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				surface: { type: 'string' },
				spec: { type: 'string' },
				'fix-refs': { type: 'boolean', default: false },
			},
		});
		const [file] = positionals;
		if (!file || !values.surface) {
			console.error('graft build: pass a build file and --surface.');
			return 2;
		}
		const result = await checkBuildFile(file, {
			surface: values.surface,
			...(values.spec ? { spec: values.spec } : {}),
			fixRefs: values['fix-refs'],
		});
		console.log(`${result.ok ? '✔' : '✖'} ${file}${result.fixed ? '  (refs recomputed)' : ''}`);
		for (const d of result.diagnostics) {
			console.log(`  ${d.severity.padEnd(7)} ${d.path ?? ''}  ${d.message}  [${d.code}]`);
		}
		return result.ok ? 0 : 1;
	}
	if (command === 'verify') {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				surface: { type: 'string' },
				spec: { type: 'string' },
				out: { type: 'string' },
				json: { type: 'boolean', default: false },
				verbose: { type: 'boolean', default: false },
			},
		});
		if (positionals.length === 0 || !values.surface || !values.spec) {
			console.error('graft verify: pass build files, --surface and --spec.');
			return 2;
		}
		const results = await verifyFiles(positionals, {
			surface: values.surface,
			spec: values.spec,
			verbose: values.verbose,
			...(values.out ? { out: values.out } : {}),
		});
		console.log(values.json ? JSON.stringify(results, null, 2) : formatVerification(results));
		return results.every((r) => r.verification?.passed) ? 0 : 1;
	}
	if (command === 'bundle') {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			options: {
				spec: { type: 'string' },
				surface: { type: 'string', multiple: true },
				out: { type: 'string' },
				verbose: { type: 'boolean', default: false },
			},
		});
		if (positionals.length === 0 || !values.spec || !values.surface?.length || !values.out) {
			console.error('graft bundle: pass build files, --spec, --surface and --out.');
			return 2;
		}
		const result = await bundleFiles({ spec: values.spec, builds: positionals, surfaces: values.surface, out: values.out, verbose: values.verbose });
		result.problems.forEach((problem) => console.error(`  ${problem}`));
		if (result.bundle) {
			console.log(`✔ ${values.out}  ${result.bundle.spec.manifest.id} with ${result.bundle.builds.length} verified build(s)`);
		}
		return result.bundle && result.problems.length === 0 ? 0 : 1;
	}
	if (command === 'compile') {
		const { values, positionals } = parseArgs({
			args: rest,
			allowPositionals: true,
			allowNegative: true,
			options: {
				surface: { type: 'string' },
				out: { type: 'string' },
				model: { type: 'string', default: DEFAULT_MODEL },
				attempts: { type: 'string', default: '3' },
				previous: { type: 'string' },
				verify: { type: 'boolean', default: true },
				ui: { type: 'string' },
			},
		});
		const [file] = positionals;
		if (!file || !values.surface) {
			console.error('graft compile: pass a spec file and --surface.');
			return 2;
		}
		let model;
		try {
			model = anthropicModel({ model: values.model });
		} catch (error) {
			console.error(`graft compile: ${error instanceof Error ? error.message : String(error)}`);
			return 2;
		}
		const id = file.replace(/^.*\//, '').replace(/\.md$/, '');
		const result = await compileFile(file, {
			surface: values.surface,
			out: values.out ?? `${id}.build.json`,
			model,
			verify: values.verify,
			attempts: Number(values.attempts),
			...(values.previous ? { previous: values.previous } : {}),
			...(values.ui ? { ui: values.ui } : {}),
		});
		return result.ok ? 0 : 1;
	}
	if (command === 'canary') {
		const { values } = parseArgs({
			args: rest,
			options: {
				corpus: { type: 'string' },
				from: { type: 'string' },
				to: { type: 'string' },
				scenario: { type: 'string' },
				regenerate: { type: 'boolean', default: false },
				model: { type: 'string', default: DEFAULT_MODEL },
				out: { type: 'string' },
				json: { type: 'boolean', default: false },
			},
		});
		if (!values.corpus || !values.from || (!values.to && !values.scenario)) {
			console.error('graft canary: pass --corpus, --from and --to or --scenario.');
			return 2;
		}
		const report = await canaryCommand({
			corpus: values.corpus,
			from: values.from,
			...(values.to ? { to: values.to } : {}),
			...(values.scenario ? { scenario: values.scenario } : {}),
			...(values.regenerate ? { model: anthropicModel({ model: values.model }) } : {}),
			...(values.out ? { out: values.out } : {}),
			log: (line) => console.error(line),
		});
		console.log(values.json ? JSON.stringify({ ...report, entries: report.entries.map(({ build: _b, ...e }) => e) }, null, 2) : formatCanaryReport(report));
		return report.counts.failed > 0 ? 1 : 0;
	}
	if (command === 'site') {
		const [action, ...args] = rest;
		const { values, positionals } = parseArgs({
			args,
			allowPositionals: true,
			options: {
				site: { type: 'string', default: process.env.GRAFT_SITE },
				user: { type: 'string', default: process.env.GRAFT_USER },
				password: { type: 'string', default: process.env.GRAFT_APP_PASSWORD },
				token: { type: 'string', default: process.env.GRAFT_TOKEN },
				surfaces: { type: 'string' },
				out: { type: 'string' },
				json: { type: 'boolean', default: false },
				'no-verify': { type: 'boolean', default: false },
			},
		});
		// A token means EmDash; a user and application password mean WordPress.
		const emdash = values.site && values.token ? { url: values.site, token: values.token } : undefined;
		const wordpress: Site | undefined = values.site && values.user && values.password ? { url: values.site, user: values.user, password: values.password } : undefined;
		if (!emdash && !wordpress) {
			console.error('graft site: pass --site and either --token (EmDash) or --user and --password (WordPress).');
			return 2;
		}
		if (action === 'verify') {
			const results = emdash
				? await emdashSiteVerify(emdash, values.surfaces ?? 'hosts/emdash/adapter/surfaces', (line) => console.error(line))
				: await siteVerify(wordpress!, values.surfaces ?? 'hosts/wordpress/plugin/surfaces', (line) => console.error(line));
			if (values.json) {
				console.log(JSON.stringify(results, null, 2));
			} else if (results.length === 0) {
				console.log('Nothing to verify: every build on the site has a passing verification.');
			} else {
				for (const r of results) {
					const status = r.skipped ? `skipped: ${r.skipped}` : `${r.passed ? '✔ verified' : '✖ failed'} → ${r.state?.replace('_', ' ')}`;
					console.log(`${r.spec} v${r.version}  ${status}`);
					r.failures?.forEach((f) => console.log(`    ${f}`));
				}
			}
			return results.every((r) => r.passed !== false) ? 0 : 1;
		}
		if (action === 'pull') {
			if (!values.out) {
				console.error('graft site pull: pass --out <dir>.');
				return 2;
			}
			const written = emdash ? await emdashSitePull(emdash, values.out) : await sitePull(wordpress!, values.out);
			console.log(`Wrote ${written.length} customization(s) to ${values.out}: ${written.join(', ') || '(none)'}`);
			return 0;
		}
		if (action === 'install') {
			const [specFile, buildFile] = positionals;
			if (!emdash || !specFile || !buildFile) {
				console.error('graft site install: pass --site, --token (EmDash), a spec and a build. On WordPress, install from Tools → Customizations.');
				return 2;
			}
			const result = await emdashSiteInstall(emdash, specFile, buildFile, { verify: !values['no-verify'], log: (line) => console.error(line) });
			if (values.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				const checks = result.verification ? ` (${result.verification.results.filter((r) => r.passed).length}/${result.verification.results.length} checks passed)` : ' (not verified)';
				console.log(`${result.id} v${result.version}: ${result.state.replace('_', ' ')}${checks}`);
				result.verification?.results.filter((r) => !r.passed).forEach((r) => r.failures.forEach((f) => console.log(`    ${r.criterion}: ${f}`)));
			}
			return result.verification?.passed === false ? 1 : 0;
		}
		console.error('graft site: use "verify", "pull" or "install".');
		return 2;
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
