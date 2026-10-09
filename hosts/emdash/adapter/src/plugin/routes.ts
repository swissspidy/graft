import { hashSurface, type Surface, type Verification } from '@graft/core';
import type { PluginContext } from 'emdash';
import { hostSurface } from '../host/surface.ts';
import { createJobs } from './author.ts';
import type { Authoring } from './author-ui.ts';
import { HostError, type Viewer } from './host.ts';
import { routePermissions, type RouteName } from './manifest.ts';
import { ModelSetupError, modelSettings, pluginModel } from './model.ts';
import { handleSandbox } from './sandbox.ts';
import { serveAdmin, servePanel, type Interaction } from './serve.ts';
import { createStore, StoreError } from './store.ts';

/**
 * The plugin's routes, independent of how EmDash runs the plugin: the
 * native plugin (plugin/index.ts) calls a handler with one context, a
 * sandboxed one (plugin/standard.ts) with the request and the plugin
 * context apart. Handlers take them apart.
 */

export interface RouteRequest {
	input?: unknown;
	/** The caller, authenticated and authorized by EmDash for the route's permission. */
	user?: { id: string; role: number };
	ui?: { surface?: string; entry?: { collection: string; id: string } };
}

export class GraftRouteError extends Error {
	constructor(
		readonly code: string,
		message: string,
		readonly status = 400,
		readonly details?: unknown,
	) {
		super(message);
		this.name = 'GraftRouteError';
	}
}

export interface GraftRoute {
	permission: (typeof routePermissions)[RouteName];
	handler(request: RouteRequest, ctx: PluginContext): Promise<unknown>;
}

export interface RouteOptions {
	/** The EmDash version, for the surface's provenance. */
	emdashVersion?: string;
	/** Adds the verification sandbox route. Never on a live site. */
	sandbox?: boolean;
	/** Offers writing customizations in the admin (needs an API key in the settings). */
	authoring?: boolean;
}

const surfaces = new Map<string, Promise<Surface>>();

export function currentSurface(emdashVersion = 'unknown'): Promise<Surface> {
	let surface = surfaces.get(emdashVersion);
	if (!surface) {
		surface = (async () => {
			const declared = hostSurface(emdashVersion);
			return { ...declared, hash: await hashSurface(declared) };
		})();
		surfaces.set(emdashVersion, surface);
	}
	return surface;
}

function viewerOf(request: RouteRequest): Viewer {
	if (!request.user) {
		throw new GraftRouteError('UNAUTHORIZED', 'Sign in first.', 401);
	}
	return { id: request.user.id, role: request.user.role };
}

/** Store and host errors as route errors, with diagnostics for the CLI. */
async function guarded<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run();
	} catch (error) {
		if (error instanceof StoreError) {
			throw new GraftRouteError('BAD_REQUEST', error.message, 400, { diagnostics: error.diagnostics });
		}
		if (error instanceof HostError) {
			throw new GraftRouteError(error.code, error.message, 403);
		}
		throw error;
	}
}

function authoringFor(ctx: PluginContext): Authoring {
	return {
		jobs: createJobs(ctx.kv),
		async setupProblem() {
			try {
				await modelSettings(ctx);
				return ctx.http ? undefined : 'The Graft plugin has no network access (network:request).';
			} catch (error) {
				if (error instanceof ModelSetupError) {
					return error.message;
				}
				throw error;
			}
		},
		async model() {
			return pluginModel(ctx, await modelSettings(ctx));
		},
	};
}

export function graftRoutes(options: RouteOptions = {}): Partial<Record<RouteName, GraftRoute>> {
	const version = options.emdashVersion;
	const storeFor = (ctx: PluginContext) => createStore(ctx.kv, () => currentSurface(version));
	const route = (name: RouteName, handler: GraftRoute['handler']): GraftRoute => ({ permission: routePermissions[name], handler });

	const routes: Partial<Record<RouteName, GraftRoute>> = {
		admin: route('admin', async (request, ctx) => {
			const where = request.ui?.surface === 'dashboard-widget' ? 'dashboard-widget' : 'admin-page';
			return serveAdmin(
				{
					ctx,
					viewer: viewerOf(request),
					store: storeFor(ctx),
					surface: await currentSurface(version),
					...(options.authoring ? { authoring: authoringFor(ctx) } : {}),
				},
				(request.input ?? {}) as Interaction,
				where,
			);
		}),
		panel: route('panel', async (request, ctx) => {
			const entry = request.ui?.entry;
			if (!entry) {
				throw new GraftRouteError('BAD_REQUEST', 'The panel needs an entry.');
			}
			return servePanel(
				{ ctx, viewer: viewerOf(request), store: storeFor(ctx), surface: await currentSurface(version) },
				(request.input ?? {}) as Interaction,
				entry,
			);
		}),
		surface: route('surface', async () => currentSurface(version)),
		specs: route('specs', async (_request, ctx) => ({ specs: await storeFor(ctx).list() })),
		install: route('install', async (request, ctx) => {
			const input = (request.input ?? {}) as { source?: unknown; build?: unknown; verification?: Verification };
			if (typeof input.source !== 'string') {
				throw new GraftRouteError('BAD_REQUEST', '"source" must be the spec source.');
			}
			const source = input.source;
			const { record, version: stored } = await guarded(() => storeFor(ctx).put({ source, build: input.build, verification: input.verification }));
			return { id: record.id, version: stored.n, state: stored.state, scopes: stored.scopes };
		}),
		attach: route('attach', async (request, ctx) => {
			const input = (request.input ?? {}) as { id?: unknown; version?: unknown; verification?: Verification };
			if (typeof input.id !== 'string' || typeof input.version !== 'number' || !input.verification) {
				throw new GraftRouteError('BAD_REQUEST', 'Pass "id", "version" and "verification".');
			}
			const { id, version: n, verification } = input as { id: string; version: number; verification: Verification };
			const { record, version: stored } = await guarded(() => storeFor(ctx).attach(id, n, verification));
			return { id: record.id, version: stored.n, state: stored.state };
		}),
		approve: route('approve', async (request, ctx) => {
			const id = (request.input as { id?: unknown } | undefined)?.id;
			const record = await guarded(() => storeFor(ctx).approve(String(id)));
			return { id: record.id, grant: record.grant };
		}),
	};
	if (options.sandbox) {
		routes.sandbox = route('sandbox', async (request, ctx) => handleSandbox(request.input, ctx, await currentSurface(version)));
	}
	return routes;
}
