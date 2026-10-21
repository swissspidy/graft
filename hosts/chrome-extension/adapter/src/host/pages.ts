import type { Anchor } from './surface.ts';

/**
 * Pages and origins: which slots a URL has, the props a slot gets from the
 * URL, and the extension match patterns for both.
 */

/** The `:param` values of a path pattern (`/projects/:project`) on a path, or undefined when it does not match. */
export function matchPage(pattern: string, pathname: string): Record<string, string> | undefined {
	const want = pattern.split('/').filter(Boolean);
	const have = pathname.split('/').filter(Boolean);
	if (want.length !== have.length) {
		return undefined;
	}
	const params: Record<string, string> = {};
	for (const [i, part] of want.entries()) {
		const segment = have[i]!;
		if (part.startsWith(':')) {
			let value: string;
			try {
				value = decodeURIComponent(segment);
			} catch {
				return undefined;
			}
			params[part.slice(1)] = value;
		} else if (part !== segment) {
			return undefined;
		}
	}
	return params;
}

/** The props a slot gets on a page (`{ project: { id } }`), or undefined when the anchor is not on that page. */
export function slotProps(anchor: Anchor, url: string): Record<string, unknown> | undefined {
	const { pathname } = new URL(url);
	for (const page of anchor.pages) {
		const params = matchPage(page, pathname);
		if (params) {
			return Object.fromEntries(Object.entries(params).map(([name, id]) => [name, { id }]));
		}
	}
	return undefined;
}

/**
 * Whether a URL is covered by an extension match pattern of an origin,
 * `<scheme>://<host>/*` (a host may start with `*.`). As in Chrome, a
 * pattern without a port matches every port.
 */
export function originMatches(pattern: string, url: string): boolean {
	const match = /^(https?|\*):\/\/(\*|(?:\*\.)?[^/:*]+)(?::(\d+))?\/\*$/.exec(pattern);
	if (!match) {
		return false;
	}
	const [, scheme, host, port] = match;
	let target: URL;
	try {
		target = new URL(url);
	} catch {
		return false;
	}
	const protocol = target.protocol.slice(0, -1);
	if (scheme === '*' ? protocol !== 'http' && protocol !== 'https' : protocol !== scheme) {
		return false;
	}
	if (port !== undefined && target.port !== port) {
		return false;
	}
	if (host === '*') {
		return true;
	}
	return host!.startsWith('*.') ? target.hostname === host!.slice(2) || target.hostname.endsWith(host!.slice(1)) : target.hostname === host;
}

/** The content script match pattern for a page pattern on an origin pattern: `:param` segments become `*`. */
export function pageMatchPattern(origin: string, page: string): string {
	const base = origin.replace(/\/\*$/, '');
	return `${base}${page.replace(/:[a-z][a-z0-9_]*/g, '*')}`;
}
