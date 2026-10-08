import type { Diagnostic } from '../diagnostics.ts';
import type { Spec } from '../spec/types.ts';
import type { Migration, Surface } from '../surface/types.ts';
import type { EvalContext } from './evaluate.ts';
import type { Snapshot } from '../verifier/snapshot.ts';
import type { Build, Check, Refs } from './types.ts';

/**
 * A UI format other than Graft's tree, e.g. A2UI. A build in such a format
 * has no `tree`; its UI is in fields the format owns (A2UI: `ui` and
 * `events`). The envelope (spec, mount, data sources, checks, refs,
 * provenance) and everything around it stay Graft's: the gateway, grants,
 * verification against frozen checks, the upgrade ladder.
 *
 * Core does not depend on any format. A host or tool that supports one
 * registers it (`registerUiFormat`), and core hands it the build wherever
 * it would otherwise read the tree.
 */
export interface UiFormat {
	/** Name for messages, e.g. "A2UI". */
	name: string;
	/** Whether the build's UI is in this format. */
	handles(build: unknown): boolean;
	/**
	 * Problems with the UI against the surface: everything it references and
	 * the inputs of the calls it makes. Paths point into the build.
	 */
	validate(build: Build, surface: Surface, spec?: Spec): Diagnostic[];
	/**
	 * What the UI uses: capabilities it calls, scopes it checks, and its own
	 * component usage (the `catalog` refs field). Data sources are added by
	 * core. Host components (`refs.components`) stay empty unless the format
	 * draws the host's components.
	 */
	refs(build: Build, surface: Surface): Pick<Refs, 'capabilities' | 'scopes'> & { catalog?: Refs['catalog'] };
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
}

const formats: UiFormat[] = [];

/** Makes a UI format known to core (once per format name; a later one replaces it). */
export function registerUiFormat(format: UiFormat): void {
	const i = formats.findIndex((f) => f.name === format.name);
	if (i >= 0) {
		formats[i] = format;
	} else {
		formats.push(format);
	}
}

/** The format a build without a tree is in, if one is registered. */
export function uiFormatOf(build: unknown): UiFormat | undefined {
	if (isTreeBuild(build)) {
		return undefined;
	}
	return formats.find((format) => format.handles(build));
}

export function isTreeBuild(build: unknown): build is Build & { tree: NonNullable<Build['tree']> } {
	return typeof build === 'object' && build !== null && typeof (build as { tree?: unknown }).tree === 'object' && (build as { tree?: unknown }).tree !== null;
}

/** The format of a tree-less build, or an error naming what is missing. */
export function requireUiFormat(build: Build): UiFormat {
	const format = uiFormatOf(build);
	if (!format) {
		throw new Error('This build has no tree, and no registered UI format handles it.');
	}
	return format;
}
