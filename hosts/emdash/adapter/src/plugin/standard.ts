import { setSchemaEngine } from '@graft/core';
import { cfworkerEngine } from '@graft/core/cfworker';
import type { PluginContext } from 'emdash';
import { GraftRouteError, graftRoutes, type RouteRequest } from './routes.ts';

/**
 * The Graft plugin in EmDash's standard format, for the plugin sandbox
 * (workerd on Node, Worker Loader on Cloudflare) and the registry. Bundled
 * into dist/sandbox-entry.mjs by scripts/build-sandboxed.ts; its manifest
 * (capabilities, routes, admin pages, settings) is in ../index.ts
 * (graftSandboxed) and emdash-plugin.jsonc.
 *
 * The sandbox forbids generating code at runtime, so JSON Schema
 * validation runs on the cfworker engine instead of Ajv, and build
 * functions on QuickJS compiled to asm.js instead of WebAssembly.
 */

setSchemaEngine(cfworkerEngine());

declare const __GRAFT_EMDASH_VERSION__: string;

const routes = graftRoutes({
	authoring: true,
	// The sandbox compiles no WebAssembly at run time: QuickJS as asm.js.
	loadFunctions: async (code, limits) => (await import('@graft/sandbox/asmjs')).loadFunctions(code, limits),
	emdashVersion: typeof __GRAFT_EMDASH_VERSION__ === 'string' ? __GRAFT_EMDASH_VERSION__ : undefined,
});

export default {
	routes: Object.fromEntries(
		Object.entries(routes).map(([name, route]) => [
			name,
			{
				permission: route.permission,
				handler: async (request: RouteRequest, ctx: PluginContext) => {
					try {
						return await route.handler(request, ctx);
					} catch (error) {
						// The sandbox reports thrown errors with their message only.
						if (error instanceof GraftRouteError) {
							const diagnostics = (error.details as { diagnostics?: Array<{ path?: string; message: string }> } | undefined)?.diagnostics ?? [];
							throw new Error([error.message, ...diagnostics.map((d) => `${d.path ?? ''} ${d.message}`)].join('\n'));
						}
						throw error;
					}
				},
			},
		]),
	),
};
