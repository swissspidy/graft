import { hashSurface, type Surface, type Verification } from '@graft/core';
import { definePlugin, PluginRouteError, type PluginContext, type RouteContext } from 'emdash';
import { hostSurface } from '../host/surface.ts';
import { HostError, type Viewer } from './host.ts';
import { handleSandbox } from './sandbox.ts';
import { serveAdmin, servePanel, type Interaction } from './serve.ts';
import { createStore, StoreError } from './store.ts';

/**
 * The Graft plugin for EmDash (native format: it runs in the host process).
 * Customizations are served as Block Kit on a plugin page, a dashboard
 * widget and an entry editor panel; administrators install and approve
 * them through the routes below.
 */

export interface GraftOptions {
	/** The EmDash version, read from its package.json at config time. */
	emdashVersion?: string;
	/** Enables the verification sandbox route. Never on a live site. */
	sandbox?: boolean;
}

let surfacePromise: Promise<Surface> | undefined;

export function currentSurface(emdashVersion = 'unknown'): Promise<Surface> {
	surfacePromise ??= (async () => {
		const surface = hostSurface(emdashVersion);
		return { ...surface, hash: await hashSurface(surface) };
	})();
	return surfacePromise;
}

function viewerOf(ctx: RouteContext): Viewer {
	if (!ctx.user) {
		throw PluginRouteError.unauthorized();
	}
	return { id: ctx.user.id, role: ctx.user.role };
}

const storeFor = (ctx: PluginContext, version?: string) => createStore(ctx.kv, () => currentSurface(version));

/** Store and host errors as route errors, with diagnostics for the CLI. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof StoreError) {
			throw PluginRouteError.badRequest(error.message, { diagnostics: error.diagnostics });
		}
		if (error instanceof HostError) {
			throw new PluginRouteError(error.code, error.message, 403);
		}
		throw error;
	}
}

export function createPlugin(options: GraftOptions = {}) {
	const version = options.emdashVersion;
	return definePlugin({
		id: 'graft',
		version: '0.1.0',
		capabilities: options.sandbox ? ['content:read', 'content:write', 'content:publish', 'users:read'] : ['content:read', 'content:publish', 'users:read'],
		admin: {
			pages: [{ path: '/', label: 'Customizations', icon: 'puzzle-piece' }],
			widgets: [{ id: 'customizations', title: 'Customizations', size: 'full' }],
			editorPanels: [{ id: 'customizations', title: 'Customizations', route: 'panel', order: 50 }],
		},
		routes: {
			admin: {
				permission: 'content:read',
				handler: async (ctx) => {
					const surface = await currentSurface(version);
					const where = ctx.ui?.surface === 'dashboard-widget' ? 'dashboard-widget' : 'admin-page';
					return serveAdmin({ ctx, viewer: viewerOf(ctx), store: storeFor(ctx, version), surface }, (ctx.input ?? {}) as Interaction, where);
				},
			},
			panel: {
				permission: 'content:read',
				handler: async (ctx) => {
					const entry = ctx.ui?.entry;
					if (!entry) {
						throw PluginRouteError.badRequest('The panel needs an entry.');
					}
					const surface = await currentSurface(version);
					return servePanel({ ctx, viewer: viewerOf(ctx), store: storeFor(ctx, version), surface }, (ctx.input ?? {}) as Interaction, entry);
				},
			},
			surface: {
				permission: 'plugins:manage',
				handler: async () => currentSurface(version),
			},
			specs: {
				permission: 'plugins:manage',
				handler: async (ctx) => ({ specs: await storeFor(ctx, version).list() }),
			},
			install: {
				permission: 'plugins:manage',
				handler: async (ctx) => {
					const input = (ctx.input ?? {}) as { source?: unknown; build?: unknown; verification?: Verification };
					if (typeof input.source !== 'string') {
						throw PluginRouteError.badRequest('"source" must be the spec source.');
					}
					const source = input.source;
					const { record, version: stored } = await guarded(() => storeFor(ctx, version).put({ source, build: input.build, verification: input.verification }));
					return { id: record.id, version: stored.n, state: stored.state, scopes: stored.scopes };
				},
			},
			attach: {
				permission: 'plugins:manage',
				handler: async (ctx) => {
					const input = (ctx.input ?? {}) as { id?: unknown; version?: unknown; verification?: Verification };
					if (typeof input.id !== 'string' || typeof input.version !== 'number' || !input.verification) {
						throw PluginRouteError.badRequest('Pass "id", "version" and "verification".');
					}
					const verification = input.verification;
					const { record, version: stored } = await guarded(() => storeFor(ctx, version).attach(input.id as string, input.version as number, verification));
					return { id: record.id, version: stored.n, state: stored.state };
				},
			},
			approve: {
				permission: 'plugins:manage',
				handler: async (ctx) => {
					const id = (ctx.input as { id?: unknown } | undefined)?.id;
					const record = await guarded(() => storeFor(ctx, version).approve(String(id)));
					return { id: record.id, grant: record.grant };
				},
			},
			...(options.sandbox
				? {
						sandbox: {
							permission: 'plugins:manage' as const,
							handler: async (ctx: RouteContext) => handleSandbox(ctx, await currentSurface(version)),
						},
					}
				: {}),
		},
	});
}

export default createPlugin;
