import type { SurfaceFunctions } from '@graft/core';

/**
 * WordPress runs build functions in wp-admin, in QuickJS inside a Web
 * Worker (@graft/sandbox), under these limits, and draws interactive
 * widgets with the components below.
 */
export const functions: SurfaceFunctions = {
	runtime: 'quickjs',
	limits: { timeMs: 50, memoryBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024, sourceBytes: 32 * 1024 },
	// What a widget's render function may draw with: display components and
	// buttons, whose clicks only reach the widget's update function.
	widgets: { components: ['button', 'card', 'empty-state', 'heading', 'notice', 'stack', 'table', 'text'], maxNodes: 200 },
};
