import type { Component, JsonSchema } from '@graft/core';

/**
 * The UI vocabulary builds may use on EmDash. Each component translates to
 * EmDash Block Kit (src/host/blocks.ts), which the EmDash admin draws with
 * its own components: no Graft code runs in the browser.
 *
 * Prop schemas describe values after bindings resolve, except actions
 * (`$call`) and conditions (`$can`), which stay expressions.
 */

const action: JsonSchema = {
	description: 'A capability call: { $call, input, then, notice }.',
	type: 'object',
	required: ['$call'],
};

const condition: JsonSchema = {
	description: 'true, false, a permission check { $can, on }, or logic over them: $eq, $and, $or, $not.',
	anyOf: [
		{ type: 'boolean' },
		{ type: 'object', required: ['$can'] },
		{ type: 'object', required: ['$eq'] },
		{ type: 'object', required: ['$and'] },
		{ type: 'object', required: ['$or'] },
		{ type: 'object', required: ['$not'] },
	],
};

const label: JsonSchema = { type: 'string', minLength: 1, maxLength: 80 };
const id: JsonSchema = { type: 'string', pattern: '^[a-z][a-z0-9-]*$' };
const text: JsonSchema = { type: 'string', maxLength: 2000 };
const noProps: JsonSchema = { type: 'object', properties: {}, additionalProperties: false };

const buttonProps = {
	id,
	label,
	style: { enum: ['primary', 'secondary', 'danger'], default: 'secondary' },
	onClick: action,
	visible: condition,
	disabled: condition,
	confirm: { description: 'Ask for confirmation with this question first.', type: 'string', maxLength: 200 },
};

export const components: Record<string, Component> = {
	stack: {
		description: 'The root of a tree: its children render one below the other.',
		props: noProps,
		children: 'any',
	},
	header: {
		description: 'A heading.',
		props: { type: 'object', properties: { text }, required: ['text'], additionalProperties: false },
		children: 'none',
	},
	section: {
		description: 'A paragraph of text (Markdown links and emphasis allowed).',
		props: { type: 'object', properties: { text }, required: ['text'], additionalProperties: false },
		children: 'none',
	},
	context: {
		description: 'Small, muted help text.',
		props: { type: 'object', properties: { text }, required: ['text'], additionalProperties: false },
		children: 'none',
	},
	divider: {
		description: 'A horizontal rule.',
		props: noProps,
		children: 'none',
	},
	banner: {
		description: 'An inline message.',
		props: {
			type: 'object',
			properties: {
				title: { type: 'string', maxLength: 120 },
				text,
				variant: { enum: ['default', 'alert', 'error'], default: 'default' },
				visible: condition,
			},
			additionalProperties: false,
		},
		children: 'none',
	},
	fields: {
		description: 'A two-column grid of labels and values.',
		props: {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					maxItems: 20,
					items: {
						type: 'object',
						properties: { label, value: { type: ['string', 'number', 'null'] } },
						required: ['label'],
						additionalProperties: false,
					},
				},
			},
			required: ['items'],
			additionalProperties: false,
		},
		children: 'none',
	},
	stats: {
		description: 'Metric cards: a label and a number each.',
		props: {
			type: 'object',
			properties: {
				items: {
					type: 'array',
					maxItems: 6,
					items: {
						type: 'object',
						properties: { label, value: { type: ['string', 'number', 'null'] }, description: { type: 'string', maxLength: 120 } },
						required: ['label'],
						additionalProperties: false,
					},
				},
			},
			required: ['items'],
			additionalProperties: false,
		},
		children: 'none',
	},
	empty: {
		description: 'An empty state: shown in place of content when there is nothing to show.',
		props: {
			type: 'object',
			properties: { title: label, text: { type: 'string', maxLength: 300 }, visible: condition },
			required: ['title'],
			additionalProperties: false,
		},
		children: 'none',
	},
	table: {
		description: 'A table of records with optional per-row buttons.',
		props: {
			type: 'object',
			properties: {
				rows: { description: 'Records, usually bound to a data source.', type: 'array' },
				columns: {
					type: 'array',
					minItems: 1,
					maxItems: 8,
					items: {
						type: 'object',
						properties: {
							key: { description: 'Path into the row, e.g. "author.name".', type: 'string', minLength: 1 },
							label,
							format: { enum: ['text', 'badge', 'relative_time', 'number', 'code'], default: 'text' },
							primary: { description: "The row's label: what checks call the row by.", type: 'boolean' },
						},
						required: ['key', 'label'],
						additionalProperties: false,
					},
				},
				actions: {
					description: 'Buttons shown on every row; bindings and $can resolve per row.',
					type: 'array',
					maxItems: 3,
					items: { type: 'object', properties: buttonProps, required: ['id', 'label', 'onClick'], additionalProperties: false },
				},
				empty: { description: 'Shown instead of the table when there are no rows.', type: 'string', maxLength: 200 },
			},
			required: ['rows', 'columns'],
			additionalProperties: false,
		},
		children: 'none',
	},
	actions: {
		description: 'A row of buttons.',
		props: noProps,
		children: 'any',
	},
	button: {
		description: 'A button that calls a capability. Place it inside "actions".',
		props: { type: 'object', properties: buttonProps, required: ['id', 'label', 'onClick'], additionalProperties: false },
		children: 'none',
	},
};
