import type { UiFormat } from '../build/format.ts';
import type { Build, Check } from '../build/types.ts';
import type { Diagnostic } from '../diagnostics.ts';
import type { Spec } from '../spec/types.ts';
import type { Surface } from '../surface/types.ts';
import type { Verification } from '../verifier/run.ts';

/** One structured-output request to a model. */
export interface ModelRequest {
	/** Which compiler phase is asking. */
	purpose: 'checks' | 'tree';
	/** Stable per surface and spec: suitable for prompt caching. */
	system: string;
	prompt: string;
	/** JSON Schema the output must follow (non-recursive, closed objects). */
	schema: Record<string, unknown>;
}

export interface ModelResponse {
	/** Parsed JSON output. */
	output: unknown;
	/** The model that produced it, for provenance. */
	model: string;
}

/** The model the compiler talks to. Injected: the core does no I/O. */
export interface ModelClient {
	generate(request: ModelRequest): Promise<ModelResponse>;
}

/** Host-specific prompt material, from the host adapter. */
export interface HostGuide {
	/** How check fixtures look on this host. */
	fixtures: string;
	/** Host assertions checks may use besides rows/columns/text/action. */
	assertions: string;
	/** Anything else the compiler should know about building for this host. */
	notes?: string;
	/** The same for building in another UI format, by format name (e.g. "A2UI"). */
	formats?: Record<string, string>;
	/**
	 * The UI format new builds are compiled in, by name (e.g. "A2UI"),
	 * when neither the caller nor a previous build decides. Default: a tree.
	 */
	ui?: string;
}

export interface CompileOptions {
	spec: Spec;
	/** Content hash of the spec file (hashSpec). */
	specHash: string;
	surface: Surface;
	model: ModelClient;
	host: HostGuide;
	/**
	 * Runs a candidate build's checks. Without it, candidates are only
	 * validated statically.
	 */
	verify?: (build: Build) => Promise<Verification>;
	/** Frozen checks from an earlier build of the same spec version; skips the checks phase. */
	checks?: Check[];
	/** The build being replaced, as a reference for layout and wording (regeneration). */
	previous?: Build;
	/**
	 * Build the UI in this format, or as a tree ("tree"). Default: the
	 * previous build's format, else the host's (`HostGuide.ui`), else a
	 * tree; a previous tree regenerates in the host's format.
	 */
	format?: UiFormat | 'tree';
	/** Attempts per phase. Default 3. */
	maxAttempts?: number;
	compilerVersion?: string;
	onEvent?(event: CompileEvent): void;
}

export type CompileEvent =
	| { type: 'request'; purpose: ModelRequest['purpose']; attempt: number }
	| { type: 'rejected'; purpose: ModelRequest['purpose']; attempt: number; problems: string[] }
	| { type: 'verified'; attempt: number; passed: boolean };

export interface CompileAttempt {
	phase: ModelRequest['purpose'];
	/** Problems that sent this attempt back; empty for the accepted one. */
	problems: string[];
	diagnostics: Diagnostic[];
	verification?: Verification;
}

export interface CompileResult {
	ok: boolean;
	/**
	 * Criteria the model judged impossible to check objectively, with the
	 * reason. Compilation stops: the author has to make them checkable (or
	 * move them out of the acceptance criteria).
	 */
	unverifiable?: Array<{ criterion: string; reason: string }>;
	/** The accepted build, or the last candidate when none was accepted. */
	build?: Build;
	checks?: Check[];
	verification?: Verification;
	attempts: CompileAttempt[];
}
