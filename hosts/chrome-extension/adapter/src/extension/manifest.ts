import type { Surface } from '@swissspidy/graft-core';
import { pageMatchPattern } from '../host/pages.ts';
import { appModel } from '../host/surface.ts';

/**
 * The extension's manifest, derived from the app surfaces it ships: host
 * permissions for exactly the apps' origins, the content script only on
 * the pages that have slots, and nothing else. No externally_connectable,
 * no web-accessible resources, no remote code; the only API permission is
 * storage.
 */
export function extensionManifest(surfaces: Surface[], version: string): Record<string, unknown> {
	const origins = new Set<string>();
	const pages = new Set<string>();
	for (const surface of surfaces) {
		const model = appModel(surface);
		for (const origin of model.app.origins) {
			origins.add(origin);
			for (const anchor of Object.values(model.anchors)) {
				anchor.pages.forEach((page) => pages.add(pageMatchPattern(origin, page)));
			}
		}
	}
	return {
		manifest_version: 3,
		name: 'Graft',
		version,
		description: 'Customizations for web apps you use, verified against their acceptance criteria.',
		minimum_chrome_version: '120',
		permissions: ['storage'],
		host_permissions: [...origins].sort(),
		background: { service_worker: 'background.js', type: 'module' },
		content_scripts: [{ matches: [...pages].sort(), js: ['content.js'], run_at: 'document_idle', all_frames: false }],
		options_ui: { page: 'options.html', open_in_tab: true },
		content_security_policy: { extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'" },
	};
}
