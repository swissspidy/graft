import { LineCounter, parseDocument, isNode, type Document } from 'yaml';
import type { Diagnostic } from '../diagnostics.ts';
import { CRITERION_ID, deriveCriterionId, splitIdMarker } from './criteria.ts';
import type { Criterion, Section } from './types.ts';

export interface ParsedSpec {
	/** Frontmatter as plain data; not yet schema-validated. */
	frontmatter: unknown;
	title: string;
	description: string;
	criteria: Criterion[];
	outOfScope: string[];
	notes?: string;
	sections: Section[];
	/** Resolves a JSON pointer into the frontmatter to a source line. */
	lineOf(pointer: string): number | undefined;
	diagnostics: Diagnostic[];
}

interface Line {
	text: string;
	number: number;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST_ITEM = /^(?:[-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * Parses a spec file (Markdown with YAML frontmatter) into its parts. Never
 * throws: problems are reported as diagnostics.
 */
export function parseSpec(source: string): ParsedSpec {
	const diagnostics: Diagnostic[] = [];
	const lines = source.replace(/^﻿/, '').split(/\r?\n/);

	const front = extractFrontmatter(lines, diagnostics);
	const body: Line[] = lines
		.slice(front.bodyStart)
		.map((text, i) => ({ text, number: front.bodyStart + i + 1 }));

	const { title, blocks } = splitSections(body, diagnostics);

	const description = blocks.preamble.map((l) => l.text).join('\n').trim();
	if (title && !description) {
		diagnostics.push({
			severity: 'warning',
			code: 'description-missing',
			message: 'Add a short description of the intent below the title.',
		});
	}

	let criteria: Criterion[] = [];
	let outOfScope: string[] = [];
	let notes: string | undefined;
	const sections: Section[] = [];

	for (const block of blocks.sections) {
		const key = block.heading.toLowerCase();
		if (key === 'acceptance criteria') {
			if (criteria.length > 0) {
				diagnostics.push({
					severity: 'error',
					code: 'criteria-duplicate-section',
					message: 'Only one "## Acceptance criteria" section is allowed.',
					line: block.line,
				});
				continue;
			}
			criteria = parseCriteria(block, diagnostics);
		} else if (key === 'out of scope') {
			outOfScope = listItems(block.lines).map((item) => item.text);
		} else if (key === 'notes') {
			notes = joinContent(block.lines);
		} else {
			sections.push({ heading: block.heading, content: joinContent(block.lines), line: block.line });
		}
	}

	if (!blocks.sections.some((s) => s.heading.toLowerCase() === 'acceptance criteria')) {
		diagnostics.push({
			severity: 'error',
			code: 'criteria-missing',
			message: 'A spec needs a "## Acceptance criteria" section with at least one item.',
		});
	}

	const result: ParsedSpec = {
		frontmatter: front.data,
		title,
		description,
		criteria,
		outOfScope,
		sections,
		lineOf: front.lineOf,
		diagnostics,
	};
	if (notes !== undefined) {
		result.notes = notes;
	}
	return result;
}

function extractFrontmatter(
	lines: string[],
	diagnostics: Diagnostic[],
): { data: unknown; bodyStart: number; lineOf: (pointer: string) => number | undefined } {
	const none = { data: undefined, bodyStart: 0, lineOf: () => undefined };
	if (lines[0]?.trim() !== '---') {
		diagnostics.push({
			severity: 'error',
			code: 'frontmatter-missing',
			message: 'A spec must start with YAML frontmatter between "---" lines.',
			line: 1,
		});
		return none;
	}
	const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
	if (end === -1) {
		diagnostics.push({
			severity: 'error',
			code: 'frontmatter-unterminated',
			message: 'The frontmatter is never closed with a "---" line.',
			line: 1,
		});
		return none;
	}

	// Line 1 of the YAML text is line 2 of the file.
	const offset = 1;
	const lineCounter = new LineCounter();
	const doc = parseDocument(lines.slice(1, end).join('\n'), { lineCounter, prettyErrors: false });
	for (const error of doc.errors) {
		diagnostics.push({
			severity: 'error',
			code: 'frontmatter-yaml',
			message: error.message.split('\n')[0] ?? error.message,
			line: (error.linePos?.[0].line ?? 1) + offset,
		});
	}
	const data = doc.errors.length > 0 ? undefined : doc.toJS();
	if (doc.errors.length === 0 && (data === null || typeof data !== 'object' || Array.isArray(data))) {
		diagnostics.push({
			severity: 'error',
			code: 'frontmatter-not-object',
			message: 'The frontmatter must be a YAML mapping.',
			line: 2,
		});
	}
	return {
		data,
		bodyStart: end + 1,
		lineOf: (pointer) => lineOfPointer(doc, lineCounter, pointer, offset),
	};
}

function lineOfPointer(doc: Document, counter: LineCounter, pointer: string, offset: number): number | undefined {
	const path = pointer
		.split('/')
		.slice(1)
		.map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
		.map((part) => (/^\d+$/.test(part) ? Number(part) : part));
	// Walk up until a node with a source range is found.
	for (let depth = path.length; depth >= 0; depth--) {
		const node = depth === 0 ? doc.contents : doc.getIn(path.slice(0, depth), true);
		if (isNode(node) && node.range) {
			return counter.linePos(node.range[0]).line + offset;
		}
	}
	return undefined;
}

interface Block {
	heading: string;
	line: number;
	lines: Line[];
}

function splitSections(
	body: Line[],
	diagnostics: Diagnostic[],
): { title: string; blocks: { preamble: Line[]; sections: Block[] } } {
	let title = '';
	const preamble: Line[] = [];
	const sections: Block[] = [];
	let current: Block | undefined;
	let inFence = false;

	for (const line of body) {
		if (FENCE.test(line.text)) {
			inFence = !inFence;
		}
		const heading = inFence ? null : HEADING.exec(line.text);
		if (heading && heading[1] === '#') {
			if (title) {
				diagnostics.push({
					severity: 'warning',
					code: 'title-duplicate',
					message: 'Only the first "# " heading is used as the title.',
					line: line.number,
				});
			} else {
				title = heading[2] ?? '';
				continue;
			}
		}
		if (heading && heading[1] === '##') {
			current = { heading: heading[2] ?? '', line: line.number, lines: [] };
			sections.push(current);
			continue;
		}
		(current ? current.lines : preamble).push(line);
	}

	if (!title) {
		diagnostics.push({
			severity: 'error',
			code: 'title-missing',
			message: 'A spec needs a "# " title.',
		});
	}
	return { title, blocks: { preamble, sections } };
}

interface Item {
	text: string;
	line: number;
}

/** Top-level list items; indented lines continue the previous item. */
function listItems(lines: Line[]): Item[] {
	const items: Item[] = [];
	let current: Item | undefined;
	for (const line of lines) {
		const item = /^\S/.test(line.text) ? LIST_ITEM.exec(line.text) : null;
		if (item) {
			current = { text: item[1] ?? '', line: line.number };
			items.push(current);
		} else if (current && /^\s+\S/.test(line.text)) {
			current.text += ' ' + line.text.trim().replace(/^(?:[-*+]|\d+[.)])\s+/, '');
		} else if (line.text.trim() === '') {
			current = undefined;
		}
	}
	return items;
}

function parseCriteria(block: Block, diagnostics: Diagnostic[]): Criterion[] {
	const items = listItems(block.lines);
	if (items.length === 0) {
		diagnostics.push({
			severity: 'error',
			code: 'criteria-empty',
			message: 'List at least one acceptance criterion as a "- " item.',
			line: block.line,
		});
	}

	const criteria: Criterion[] = [];
	const seen = new Map<string, number>();
	for (const item of items) {
		const { text, id } = splitIdMarker(item.text);
		let criterion: Criterion;
		if (id !== undefined) {
			if (!CRITERION_ID.test(id)) {
				diagnostics.push({
					severity: 'error',
					code: 'criterion-id-invalid',
					message: `Criterion id "${id}" must be lowercase letters, digits and dashes.`,
					line: item.line,
				});
			}
			criterion = { id, text, explicitId: true, line: item.line };
		} else {
			let derived = deriveCriterionId(text);
			for (let n = 2; seen.has(derived); n++) {
				derived = `${deriveCriterionId(text)}-${n}`;
			}
			diagnostics.push({
				severity: 'warning',
				code: 'criterion-id-derived',
				message: `No {#id} on this criterion; using "${derived}". Rewording it will reset its verification history.`,
				line: item.line,
			});
			criterion = { id: derived, text, explicitId: false, line: item.line };
		}
		if (!text) {
			diagnostics.push({
				severity: 'error',
				code: 'criterion-empty',
				message: 'This acceptance criterion has no text.',
				line: item.line,
			});
		}
		const previous = seen.get(criterion.id);
		if (previous !== undefined) {
			diagnostics.push({
				severity: 'error',
				code: 'criterion-id-duplicate',
				message: `Criterion id "${criterion.id}" is already used on line ${previous}.`,
				line: item.line,
			});
		}
		seen.set(criterion.id, item.line);
		criteria.push(criterion);
	}
	return criteria;
}

function joinContent(lines: Line[]): string {
	return lines.map((l) => l.text).join('\n').trim();
}
