/** The spec manifest: YAML frontmatter, shaped by schemas/spec.schema.json. */
export interface SpecManifest {
	graft: 1;
	id: string;
	host: string;
	requires?: Record<string, string>;
	mount: { slot: string; [option: string]: unknown };
	audience?: string[];
	permissions: string[];
	locale?: string;
}

export interface Criterion {
	/** Stable id: explicit `{#id}` or derived from the text. */
	id: string;
	/** Criterion text without the id marker. */
	text: string;
	/** False when the id was derived; rewording will reset its history. */
	explicitId: boolean;
	line: number;
}

export interface Section {
	heading: string;
	content: string;
	line: number;
}

export interface Spec {
	manifest: SpecManifest;
	title: string;
	description: string;
	criteria: Criterion[];
	outOfScope: string[];
	notes?: string;
	/** Unrecognized sections, preserved and passed to the compiler as context. */
	sections: Section[];
}
