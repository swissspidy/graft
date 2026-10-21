import type { Anchor, Landmark } from './surface.ts';

/**
 * Finds a slot's anchor in a page. Used by the content script to mount a
 * customization, and by the drift probe (bundled and evaluated in the
 * page), so both read the DOM the same way. Self-contained on purpose: no
 * imports at run time.
 *
 * The selectors are tried in order; the first that matches exactly one
 * element, which is also the landmark, wins. When none does, the landmark
 * alone is looked for (its role and accessible name): exactly one match
 * is the anchor again, *re-anchored*, with a selector proposed for it.
 */

export interface Resolved {
	/** ok: the first selector; moved: a later selector or the landmark alone; broken: nothing. */
	status: 'ok' | 'moved' | 'broken';
	element?: Element;
	/** The selector that found it, or the one proposed for it after re-anchoring by landmark. */
	selector?: string;
	via?: 'selector' | 'landmark';
	/** What was found, for the fingerprint: structure, never text content. */
	observed?: { tag: string; role: string | null; name: string | null };
	/** Why it is broken or moved. */
	reason?: string;
}

const IMPLICIT_ROLES: Record<string, string> = {
	aside: 'complementary',
	nav: 'navigation',
	main: 'main',
	header: 'banner',
	footer: 'contentinfo',
	form: 'form',
	section: 'region',
	dialog: 'dialog',
	table: 'table',
	ul: 'list',
	ol: 'list',
};

/** An element's ARIA role: explicit, else implied by its tag. */
export function roleOf(element: Element): string | null {
	const explicit = element.getAttribute('role')?.trim().split(/\s+/)[0];
	return explicit || IMPLICIT_ROLES[element.localName] || null;
}

/** An element's accessible name, from aria-label or aria-labelledby (the cases landmarks use). */
export function nameOf(element: Element): string | null {
	const label = element.getAttribute('aria-label')?.trim();
	if (label) {
		return label;
	}
	const ids = element.getAttribute('aria-labelledby')?.trim().split(/\s+/) ?? [];
	const text = ids
		.map((id) => element.ownerDocument.getElementById(id)?.textContent?.trim() ?? '')
		.filter(Boolean)
		.join(' ');
	return text || null;
}

export function isLandmark(element: Element, landmark: Landmark | undefined): boolean {
	return !landmark || (roleOf(element) === landmark.role && (landmark.name === undefined || nameOf(element) === landmark.name));
}

function all(root: ParentNode, selector: string): Element[] {
	try {
		return [...root.querySelectorAll(selector)];
	} catch {
		return [];
	}
}

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;

/** A selector for an element found by its landmark: a test id, an id, or its tag and label; only if it is unique. */
export function proposeSelector(element: Element, root: ParentNode): string | undefined {
	const candidates: string[] = [];
	for (const attribute of ['data-testid', 'data-test', 'data-qa']) {
		const value = element.getAttribute(attribute);
		if (value) {
			candidates.push(`[${attribute}=${quote(value)}]`);
		}
	}
	if (element.id) {
		candidates.push(`#${CSS.escape(element.id)}`);
	}
	const label = element.getAttribute('aria-label');
	if (label) {
		candidates.push(`${element.localName}[aria-label=${quote(label)}]`);
	}
	return candidates.find((selector) => {
		const found = all(root, selector);
		return found.length === 1 && found[0] === element;
	});
}

const describe = (element: Element) => ({ tag: element.localName, role: roleOf(element), name: nameOf(element) });

export function resolveAnchor(anchor: Anchor, root: ParentNode): Resolved {
	const reasons: string[] = [];
	for (const [i, selector] of anchor.selectors.entries()) {
		const found = all(root, selector);
		if (found.length === 1 && isLandmark(found[0]!, anchor.landmark)) {
			return { status: i === 0 ? 'ok' : 'moved', element: found[0]!, selector, via: 'selector', observed: describe(found[0]!), ...(i > 0 ? { reason: `${reasons.join('; ')}` } : {}) };
		}
		reasons.push(found.length === 1 ? `${selector} is no longer the landmark` : `${selector} matches ${found.length} elements`);
	}
	if (anchor.landmark) {
		const { role, name } = anchor.landmark;
		const found = all(root, '*').filter((element) => roleOf(element) === role && (name === undefined || nameOf(element) === name));
		if (found.length === 1) {
			const element = found[0]!;
			const selector = proposeSelector(element, root);
			return { status: 'moved', element, via: 'landmark', observed: describe(element), ...(selector ? { selector } : {}), reason: reasons.join('; ') };
		}
		reasons.push(`${found.length} elements are ${role}${name ? ` "${name}"` : ''}`);
	}
	return { status: 'broken', reason: reasons.join('; ') };
}
