import type { SurfaceFunctions } from '@graft/core';

/**
 * WordPress runs build functions in wp-admin, in QuickJS inside a Web
 * Worker (@graft/sandbox), under these limits, and draws interactive
 * widgets with the components below.
 */
export const functions: SurfaceFunctions = {
	runtime: 'quickjs',
	limits: { timeMs: 50, memoryBytes: 8 * 1024 * 1024, outputBytes: 16 * 1024, sourceBytes: 32 * 1024 },
	// What a widget's render function may draw with: display components,
	// inputs and buttons, whose events only reach the widget's update function.
	widgets: {
		components: ['button', 'card', 'checkbox', 'empty-state', 'heading', 'notice', 'select', 'stack', 'table', 'text', 'text-input', 'textarea'],
		// Inputs show what the viewer entered; declared actions read them with $input.
		inputs: ['checkbox', 'select', 'text-input', 'textarea'],
		maxNodes: 200,
	},
};
