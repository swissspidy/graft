import type { Surface } from '@swissspidy/graft-core';
import { browserModel, CHROME, MINIMUM_CHROME } from '../browser/surface.ts';
import { pageMatchPattern } from '../host/pages.ts';
import { appModel, HOST } from '../host/surface.ts';

/**
 * The extension's manifest, derived from the surfaces it ships: host
 * permissions for exactly the apps' origins, the content script only on
 * the pages that have slots, and nothing else. With the browser's own
 * surface, also the Chrome permissions its scopes map to, the side panel
 * it owns, and `alarms` when it runs triggers. No externally_connectable,
 * no web-accessible resources, no remote code. Extension pages build their
 * DOM without parsing markup, so Trusted Types is enforced with no policy
 * allowed: any string written to an HTML or script sink throws.
 */
export function extensionManifest(surfaces: Surface[], version: string): Record<string, unknown> {
	const origins = new Set<string>();
	const pages = new Set<string>();
	const permissions = new Set<string>(['storage']);
	const browser = surfaces.find((surface) => surface.host === CHROME);
	for (const surface of surfaces.filter((s) => s.host === HOST)) {
		const model = appModel(surface);
		for (const origin of model.app.origins) {
			origins.add(origin);
			for (const anchor of Object.values(model.anchors)) {
				anchor.pages.forEach((page) => pages.add(pageMatchPattern(origin, page)));
			}
		}
	}
	if (browser) {
		Object.values(browserModel(browser).permissions).flat().forEach((permission) => permissions.add(permission));
		permissions.add('sidePanel');
	}
	if (surfaces.some((surface) => surface.triggers)) {
		permissions.add('alarms');
	}
	return {
		manifest_version: 3,
		name: 'Graft',
		version,
		description: 'Customizations for web apps you use and for your browser, verified against their acceptance criteria.',
		minimum_chrome_version: browser ? MINIMUM_CHROME : '120',
		permissions: [...permissions].sort(),
		host_permissions: [...origins].sort(),
		background: { service_worker: 'background.js', type: 'module' },
		...(pages.size > 0 ? { content_scripts: [{ matches: [...pages].sort(), js: ['content.js'], run_at: 'document_idle', all_frames: false }] } : {}),
		options_ui: { page: 'options.html', open_in_tab: true },
		...(browser ? { side_panel: { default_path: 'sidepanel.html' }, action: { default_title: 'Graft' } } : {}),
		content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; require-trusted-types-for 'script'; trusted-types 'none'" },
	};
}
