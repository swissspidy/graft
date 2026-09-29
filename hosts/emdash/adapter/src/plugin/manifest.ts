/**
 * What the Graft plugin declares to EmDash, shared by the native plugin
 * (plugin/index.ts) and the standard-format, sandboxable one (the
 * descriptor in ../index.ts and plugin/standard.ts).
 */

export const PLUGIN_ID = 'graft';
export const PLUGIN_VERSION = '0.1.0';

/** Where model requests go by default; the "modelEndpoint" setting overrides it. */
export const DEFAULT_MODEL_ENDPOINT = 'https://api.anthropic.com';

export const capabilities = ['content:read', 'content:publish', 'users:read', 'network:request'] as const;
/** The verification sandbox also creates and deletes content. */
export const sandboxCapabilities = [...capabilities, 'content:write'] as const;

export const allowedHosts = ['api.anthropic.com'];

export const adminPages = [{ path: '/customizations', label: 'Customizations', icon: 'puzzle-piece' }];
export const adminWidgets = [{ id: 'customizations', title: 'Customizations', size: 'full' as const }];
export const editorPanels = [{ id: 'customizations', title: 'Customizations', route: 'panel', order: 50 }];

/** Plugin settings: the model that compiles specs written in the admin. */
export const settingsSchema = {
	anthropicApiKey: {
		type: 'secret' as const,
		label: 'Anthropic API key',
		description: 'Used to compile customizations written in the admin. Stored encrypted.',
	},
	model: {
		type: 'select' as const,
		label: 'Model',
		options: [
			{ label: 'Claude Opus 5.5', value: 'claude-opus-5-5' },
			{ label: 'Claude Sonnet 5.5', value: 'claude-sonnet-5-5' },
		],
		default: 'claude-opus-5-5',
	},
	effort: {
		type: 'select' as const,
		label: 'Effort',
		description: 'Lower is faster. Each compile step must finish within the host request time limit.',
		options: [
			{ label: 'Low', value: 'low' },
			{ label: 'Medium', value: 'medium' },
			{ label: 'High', value: 'high' },
		],
		default: 'medium',
	},
	modelEndpoint: {
		type: 'url' as const,
		label: 'Model endpoint',
		description: `Base URL of the Claude API (default ${DEFAULT_MODEL_ENDPOINT}). Its host must be an allowed host of the plugin.`,
	},
};

/** Route permissions; EmDash checks them before a route runs. */
export const routePermissions = {
	admin: 'content:read',
	panel: 'content:read',
	surface: 'plugins:manage',
	specs: 'plugins:manage',
	install: 'plugins:manage',
	attach: 'plugins:manage',
	approve: 'plugins:manage',
	sandbox: 'plugins:manage',
} as const;

export type RouteName = keyof typeof routePermissions;
