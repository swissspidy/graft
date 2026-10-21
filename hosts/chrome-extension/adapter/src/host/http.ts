import { compileSchema, type Capability, type SchemaError } from '@swissspidy/graft-core';
import { httpBinding, type HttpBinding } from './surface.ts';

/**
 * Capability calls as requests to the app's own API, shared by the
 * extension's gateway (with the viewer's session) and the sandbox (with a
 * fixture user's). A request only ever goes to the page's own origin, to
 * the binding's path, with input fields where the binding puts them. The
 * response is cut down to the capability's declared output before
 * anything (the UI, the data model, a check) sees it, and must then match
 * it: a response that does not is drift, not data.
 */

export class CallError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly details?: string[],
	) {
		super(message);
		this.name = 'CallError';
	}
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value));

/** The request a binding makes for an input on an origin. */
export function buildRequest(binding: HttpBinding, input: unknown, origin: string): { url: string; init: RequestInit } {
	const fields = isObject(input) ? input : {};
	const path = binding.path.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_, name: string) => {
		const value = fields[name];
		if (value === undefined || value === null || value === '') {
			throw new CallError('graft_invalid_input', `The input has no "${name}" for the request path.`);
		}
		const segment = text(value);
		// encodeURIComponent leaves dots alone, and URL resolves "." and "..": they would leave the binding's path.
		if (segment === '.' || segment === '..') {
			throw new CallError('graft_invalid_input', `"${name}" is not a valid path segment.`);
		}
		return encodeURIComponent(segment);
	});
	const url = new URL(path, origin);
	if (url.origin !== new URL(origin).origin) {
		throw new CallError('graft_invalid_binding', 'The binding leaves the app.');
	}
	for (const name of binding.query ?? []) {
		const value = fields[name];
		if (value !== undefined && value !== null) {
			url.searchParams.set(name, text(value));
		}
	}
	const headers: Record<string, string> = { accept: 'application/json', ...binding.headers };
	const init: RequestInit = { method: binding.method, headers, credentials: 'include', redirect: 'error', cache: 'no-store' };
	if (binding.body) {
		headers['content-type'] = 'application/json';
		init.body = JSON.stringify(Object.fromEntries(binding.body.filter((name) => fields[name] !== undefined).map((name) => [name, fields[name]])));
	}
	return { url: url.href, init };
}

/**
 * A value cut down to what a schema declares: object properties it does
 * not list are dropped, recursively through `properties`, `items` and
 * `anyOf`/`oneOf` branches. Whatever the app adds to its responses never
 * reaches a build.
 */
export function project(schema: unknown, value: unknown): unknown {
	if (!isObject(schema)) {
		return value;
	}
	for (const key of ['anyOf', 'oneOf'] as const) {
		const branches = schema[key];
		if (Array.isArray(branches)) {
			const fitting = branches.find((branch) => compileSchema(branch as object)(project(branch, value)));
			return fitting === undefined ? value : project(fitting, value);
		}
	}
	if (Array.isArray(value)) {
		return schema.items === undefined ? value : value.map((item) => project(schema.items, item));
	}
	if (isObject(value) && isObject(schema.properties)) {
		const properties = schema.properties;
		return Object.fromEntries(Object.entries(value).filter(([key]) => Object.hasOwn(properties, key)).map(([key, inner]) => [key, project(properties[key], inner)]));
	}
	return value;
}

/** Runs a capability against the app on `origin` with `fetch` (which carries the session), and returns its projected output. */
export async function perform(capability: Capability, input: unknown, origin: string, fetch: Fetch): Promise<unknown> {
	const { url, init } = buildRequest(httpBinding(capability), input, origin);
	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		throw new CallError('host_unreachable', `The app did not answer: ${(error as Error).message}`);
	}
	if (response.status === 401) {
		throw new CallError('host_unauthorized', 'You are not signed in to the app.');
	}
	if (response.status === 403) {
		throw new CallError('host_forbidden', 'The app refused this for your account.');
	}
	if (!response.ok) {
		throw new CallError('host_error', `The app answered ${response.status}.`);
	}
	let body: unknown;
	try {
		body = await response.json();
	} catch {
		throw new CallError('graft_drift', 'The app did not answer with JSON.');
	}
	const { output, problems } = checkOutput(capability, body);
	if (problems.length > 0) {
		throw new CallError('graft_drift', `The app's answer no longer matches what this customization expects (${problems.slice(0, 3).join('; ')}).`, problems);
	}
	return output;
}

/** A schema error in words, the same on every schema engine. */
function describeProblem(error: SchemaError): string {
	const at = error.instancePath || '/';
	const missing = error.params.missingProperty;
	return error.keyword === 'required' && typeof missing === 'string' ? `${at} is missing "${missing}"` : `${at} ${error.message ?? error.keyword}`;
}

/** A response body cut down to a capability's output, and how it fails to match it (empty when it does). */
export function checkOutput(capability: Capability, body: unknown): { output: unknown; problems: string[] } {
	const output = project(capability.output, body);
	const validate = compileSchema(capability.output as object);
	return { output, problems: validate(output) ? [] : (validate.errors ?? []).map(describeProblem) };
}

/** The viewer's role from the app's "who am I" endpoint. */
export async function viewerRole(viewer: { binding: HttpBinding; role: string }, origin: string, fetch: Fetch): Promise<string | undefined> {
	const { url, init } = buildRequest(viewer.binding, {}, origin);
	const response = await fetch(url, init);
	if (!response.ok) {
		return undefined;
	}
	const body = (await response.json()) as unknown;
	const role = viewer.role
		.replace(/^\//, '')
		.split('/')
		.reduce<unknown>((value, key) => (isObject(value) ? value[key] : undefined), body);
	return typeof role === 'string' ? role : undefined;
}
