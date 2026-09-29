import { definePlugin, PluginRouteError, type RouteContext } from 'emdash';
import { adminPages, adminWidgets, capabilities, editorPanels, allowedHosts, PLUGIN_ID, PLUGIN_VERSION, sandboxCapabilities, settingsSchema } from './manifest.ts';
import { GraftRouteError, graftRoutes, type RouteOptions } from './routes.ts';
import type { LoadFunctions } from './serve.ts';

export { currentSurface } from './routes.ts';

/**
 * The Graft plugin for EmDash in the native format: it runs in the host
 * process, configured from astro.config (see ../index.ts). The same routes
 * run sandboxed in the standard format (plugin/standard.ts).
 *
 * Customizations are served as Block Kit on the Customizations page, a
 * dashboard widget and an entry editor panel; administrators write,
 * install and approve them.
 */

export interface GraftOptions extends RouteOptions {
	/** Extra hosts the plugin may call (for example a model gateway). */
	allowedHosts?: string[];
}

function toPluginError(error: unknown): never {
	if (error instanceof GraftRouteError) {
		throw new PluginRouteError(error.code, error.message, error.status, error.details);
	}
	throw error;
}

/** Build functions in QuickJS compiled to WebAssembly, loaded on first use. */
const loadFunctions: LoadFunctions = async (code, limits) => (await import('@graft/sandbox')).loadFunctions(code, limits);

export function createPlugin(options: GraftOptions = {}) {
	const routes = Object.fromEntries(
		Object.entries(graftRoutes({ authoring: true, loadFunctions, ...options })).map(([name, route]) => [
			name,
			{
				permission: route.permission,
				handler: (ctx: RouteContext) => route.handler(ctx, ctx).catch(toPluginError),
			},
		]),
	);
	return definePlugin({
		id: PLUGIN_ID,
		version: PLUGIN_VERSION,
		capabilities: [...(options.sandbox ? sandboxCapabilities : capabilities)],
		allowedHosts: [...allowedHosts, ...(options.allowedHosts ?? [])],
		admin: { pages: adminPages, widgets: adminWidgets, editorPanels, settingsSchema },
		routes,
	});
}

export default createPlugin;
