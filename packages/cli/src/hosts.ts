import type { Build, CanaryOptions, CanaryReport, CorpusEntry, HostGuide, Sandbox, Spec, Surface, Verification } from '@graft/core';

/**
 * The host adapters the CLI can drive: a compiler guide, a verification
 * sandbox and the verifier wired to the host's semantics. Loaded lazily so
 * one host's tooling is only loaded when a surface needs it.
 */
export interface HostTools {
	guide: HostGuide;
	startSandbox(): Promise<Sandbox & { close(): Promise<void> }>;
	verify(targets: Array<{ build: Build; spec: Spec; surface: Surface }>, sandbox?: Sandbox & { close(): Promise<void> }): Promise<Verification[]>;
	/** Synthetic host changes the canary can apply. */
	scenarios: string[];
	loadCorpus(dir: string): Promise<CorpusEntry[]>;
	canary(options: HostCanaryOptions): Promise<CanaryReport>;
}

export interface HostCanaryOptions {
	corpus: CorpusEntry[];
	from: Surface;
	to?: Surface;
	/** A scenario name from `scenarios`. */
	scenario?: string;
	regenerate?: CanaryOptions['regenerate'];
	onEntry?: CanaryOptions['onEntry'];
}

function findScenario<T extends { name: string }>(scenarios: T[], name: string | undefined): T | undefined {
	if (name === undefined) {
		return undefined;
	}
	const scenario = scenarios.find((s) => s.name === name);
	if (!scenario) {
		throw new Error(`Unknown scenario "${name}". Available: ${scenarios.map((s) => s.name).join(', ')}.`);
	}
	return scenario;
}

/** Options the host canaries share, without the undefined ones. */
function canaryOptions(options: HostCanaryOptions) {
	return {
		corpus: options.corpus,
		from: options.from,
		...(options.to ? { to: options.to } : {}),
		...(options.regenerate ? { regenerate: options.regenerate } : {}),
		...(options.onEntry ? { onEntry: options.onEntry } : {}),
	};
}

export interface HostToolOptions {
	/** WordPress version for the Playground sandbox. */
	wp?: string;
	verbose?: boolean;
}

export async function hostTools(surface: Surface, options: HostToolOptions = {}): Promise<HostTools> {
	if (surface.host === 'wordpress') {
		const wordpress = await import('@graft/wordpress-adapter');
		const wp = options.wp ?? wordpress.playgroundVersion(surface.hostVersion);
		return {
			guide: wordpress.hostGuide,
			startSandbox: () => wordpress.startSandbox({ wp, verbose: options.verbose ?? false }),
			verify: (targets, sandbox) => wordpress.verifyInWordPress(targets, { wp, verbose: options.verbose ?? false, ...(sandbox ? { sandbox: sandbox as never } : {}) }),
			scenarios: wordpress.scenarios.map((s) => s.name),
			loadCorpus: wordpress.loadCorpus,
			canary: async (canary) => {
				const scenario = findScenario(wordpress.scenarios, canary.scenario);
				return (await wordpress.runWordPressCanary({ ...canaryOptions(canary), ...(scenario ? { scenario } : {}) })).report;
			},
		};
	}
	if (surface.host === 'emdash') {
		const emdash = await import('@graft/emdash/node');
		const log = options.verbose ? (line: string) => process.stderr.write(line) : undefined;
		return {
			guide: emdash.hostGuide,
			startSandbox: () => emdash.startSandbox(log ? { log } : {}),
			verify: (targets, sandbox) => emdash.verifyInEmDash(targets, { ...(sandbox ? { sandbox: sandbox as never } : {}), ...(log ? { log } : {}) }),
			scenarios: emdash.scenarios.map((s) => s.name),
			loadCorpus: emdash.loadCorpus,
			canary: async (canary) => {
				const scenario = findScenario(emdash.scenarios, canary.scenario);
				return (await emdash.runEmDashCanary({ ...canaryOptions(canary), ...(scenario ? { scenario } : {}) })).report;
			},
		};
	}
	throw new Error(`No host adapter for "${surface.host}".`);
}
