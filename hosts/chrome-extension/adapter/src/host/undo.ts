import type { Capability } from '@swissspidy/graft-core';

/**
 * Undo in the browser host. A write capability can say how to put back
 * what it did: another write of the same surface (its reverse), with each
 * input field taken from the original call's input or from its answer.
 * The extension records the reverse call when the write goes through, and
 * the person can run it from the options page.
 *
 * It is declared by the adapter author next to the binding, so it is part
 * of the surface and its hash, and it is data: nothing a build says. A
 * reverse never needs a scope the original did not, so undoing never does
 * more than was approved when the call was made.
 */

/** Where one input field of the reverse call comes from. */
export type UndoValue = { input: string } | { output: string };

/** How to put back what a write did. */
export interface Undo {
	/** The reverse: a write capability of the same surface. */
	capability: string;
	/** Each input field of the reverse: a field of the original input, or a JSON Pointer into the original's answer. */
	input: Record<string, UndoValue>;
}

/** A reverse call, ready to run. */
export interface UndoCall {
	capability: string;
	input: Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The undo a capability's binding declares, if any. */
export function undoOf(capability: Capability | undefined): Undo | undefined {
	const undo = (capability?.binding as { undo?: unknown } | undefined)?.undo;
	return isObject(undo) && typeof undo.capability === 'string' && isObject(undo.input) ? (undo as unknown as Undo) : undefined;
}

function pointer(value: unknown, path: string): unknown {
	if (path === '' || path === '/') {
		return value;
	}
	return path
		.replace(/^\//, '')
		.split('/')
		.map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))
		.reduce<unknown>((inner, key) => (isObject(inner) ? inner[key] : Array.isArray(inner) ? inner[Number(key)] : undefined), value);
}

/**
 * The reverse of a write that went through, from its input and its
 * (projected) answer; undefined when the capability has no undo or a field
 * the reverse needs is missing.
 */
export function undoCall(capability: Capability | undefined, input: unknown, output: unknown): UndoCall | undefined {
	const undo = undoOf(capability);
	if (!undo) {
		return undefined;
	}
	const fields: Record<string, unknown> = {};
	for (const [name, from] of Object.entries(undo.input)) {
		const value = 'input' in from ? (isObject(input) ? input[from.input] : undefined) : pointer(output, from.output);
		if (value === undefined) {
			return undefined;
		}
		fields[name] = value;
	}
	return { capability: undo.capability, input: fields };
}

/** What is wrong with the undos of a set of capabilities: unknown or read reverses, wider scopes, unknown fields. */
export function undoProblems(capabilities: Record<string, Capability>): string[] {
	const problems: string[] = [];
	for (const [name, capability] of Object.entries(capabilities)) {
		const undo = undoOf(capability);
		if (!undo) {
			continue;
		}
		const reverse = capabilities[undo.capability];
		if (capability.kind !== 'write') {
			problems.push(`"${name}" is not a write, so it has nothing to undo.`);
		}
		if (!reverse || reverse.kind !== 'write') {
			problems.push(`The undo of "${name}" names "${undo.capability}", which is not a write capability.`);
			continue;
		}
		const wider = reverse.scopes.filter((scope) => !capability.scopes.includes(scope));
		if (wider.length > 0) {
			problems.push(`The undo of "${name}" needs ${wider.join(', ')}, which "${name}" does not.`);
		}
		const properties = isObject(reverse.input) && isObject(reverse.input.properties) ? reverse.input.properties : {};
		for (const field of Object.keys(undo.input)) {
			if (!Object.hasOwn(properties, field)) {
				problems.push(`The undo of "${name}" sets "${field}", which "${undo.capability}" does not take.`);
			}
		}
	}
	return problems;
}
