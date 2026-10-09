import type { Diagnostic } from '../diagnostics.ts';
import type { Spec } from '../spec/types.ts';
import type { Migration, Surface } from '../surface/types.ts';
import type { EvalContext } from './evaluate.ts';
import type { Snapshot } from '../verifier/snapshot.ts';
import type { Build, Check, Refs } from './types.ts';

/**
 * The format of a build's UI: A2UI, in a catalog per host. The UI is in
 * fields the format owns (`ui` and `events`). The envelope (spec, mount,
 * data sources, checks, refs, provenance) and everything around it are
 * Graft's: the gateway, grants, verification against frozen checks, the
 * upgrade ladder.
 *
 * Core does not depend on any format. A host or tool that supports one
 * registers it (`registerUiFormat`), and core hands it the build wherever
 * it reads the UI.
 */
export interface UiFormat {
	/** Name for messages, e.g. "A2UI". */
	name: string;
	/** The host it draws for (a surface's `host`); one format of a name per host. */
	host: string;
	/** Whether the build's UI is in this format. */
	handles(build: unknown): boolean;
	/**
	 * Problems with the UI against the surface: everything it references and
	 * the inputs of the calls it makes. Paths point into the build.
	 */
	validate(build: Build, surface: Surface, spec?: Spec): Diagnostic[];
	/**
	 * What the UI uses: capabilities it calls, scopes it checks, and its
	 * component usage (the `catalog` refs field). Data sources are added by
	 * core.
	 */
	refs(build: Build, surface: Surface): Pick<Refs, 'capabilities' | 'scopes' | 'catalog'>;
	/** Reads the UI into a semantic snapshot for one viewer, with what they entered so far. */
	snapshot(build: Build, ctx: EvalContext, entered: Record<string, Record<string, unknown>>): Snapshot;
	/**
	 * Applies one host migration (a rename) to the UI; core handles the
	 * mount and data sources. Undefined when it cannot.
	 */
	migrate(build: Build, migration: Migration): Build | undefined;
	/** The slot props the UI reads, for re-anchoring. */
	slotPropsUsed(build: Build): string[];
	/** The compiler's UI phase for this format; without it, builds in the format are not compiled. */
	compiler?: UiCompiler;
}

/** The compiler's UI phase for a format: prompt, output schema and assembly. */
export interface UiCompiler {
	system(spec: Spec, surface: Surface, notes?: string): string;
	prompt(spec: Spec, checks: Check[], previous: Build | undefined, feedback: string[]): string;
	/** JSON Schema of the model's output (closed, non-recursive). */
	schema(spec: Spec, surface: Surface): Record<string, unknown>;
	/** The UI fields and data sources from the model's output, or the problems to send back. */
	assemble(output: unknown, surface: Surface): { value?: Partial<Build>; problems: string[] };
	/** Fields of a previous build that make up its UI, as the dedupe key and regeneration reference. */
	content(build: Build): unknown;
	/**
	 * The checks phase's system prompt for a build in this format: checks
	 * name actions, inputs and columns, so the writer should know what the
	 * UI is made of. Given core's version; without it, that is used.
	 */
	checksSystem?(base: string, spec: Spec, surface: Surface): string;
	/**
	 * A build in the format as the model's output for its UI phase (the
	 * inverse of `assemble`), for scripted models in tests. `dataInput`
	 * replaces data source inputs by name.
	 */
	answer?(build: Build, dataInput?: Record<string, unknown>): unknown;
}

const formats: UiFormat[] = [];

/** Makes a UI format known to core (once per name and host; a later one replaces it). */
export function registerUiFormat(format: UiFormat): void {
	const i = formats.findIndex((f) => f.name === format.name && f.host === format.host);
	if (i >= 0) {
		formats[i] = format;
	} else {
		formats.push(format);
	}
}

/** A registered format by name (case-insensitive, e.g. "a2ui") for a host. */
export function uiFormatNamed(name: string, host: string): UiFormat | undefined {
	return formats.find((format) => format.name.toLowerCase() === name.toLowerCase() && format.host === host);
}

/** The registered format a build's UI is in, if any. */
export function uiFormatOf(build: unknown): UiFormat | undefined {
	return formats.find((format) => format.handles(build));
}

/** The format of a build's UI, or an error naming what is missing. */
export function requireUiFormat(build: Build): UiFormat {
	const format = uiFormatOf(build);
	if (!format) {
		throw new Error(`No registered UI format handles this build's UI (${build.ui?.protocol ?? 'none'}, catalog ${build.ui?.catalogId ?? 'none'}).`);
	}
	return format;
}
