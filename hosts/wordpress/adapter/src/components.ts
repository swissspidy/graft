import type { Component, JsonSchema } from '@graft/core';

/**
 * The UI vocabulary builds may use on WordPress: curated wrappers over
 * @wordpress/components and @wordpress/dataviews, not the raw packages. The
 * wrappers are where upstream churn is absorbed, so these prop schemas are
 * meant to stay stable across WordPress versions.
 *
 * Prop schemas describe values after bindings resolve, with two
 * exceptions that stay expressions: actions (`$call`) and conditions
 * (`$can`), which the renderer evaluates at interaction time.
 */

const action: JsonSchema = {
	description: 'A capability call: { $call, input, then }.',
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

export const components: Record<string, Component> = {
	stack: {
		description: 'Lays out children in a row or column.',
		props: {
			type: 'object',
			properties: {
				direction: { enum: ['row', 'column'], default: 'column' },
				gap: { type: 'integer', minimum: 0, maximum: 8, default: 2 },
				align: { enum: ['start', 'center', 'end', 'stretch'] },
				justify: { enum: ['start', 'center', 'end', 'space-between'] },
			},
			additionalProperties: false,
		},
		children: 'any',
	},
	heading: {
		description: 'A section heading.',
		props: {
			type: 'object',
			properties: { level: { type: 'integer', minimum: 1, maximum: 4, default: 2 } },
			additionalProperties: false,
		},
		children: 'text',
	},
	text: {
		description: 'A paragraph of plain text.',
		props: {
			type: 'object',
			properties: { variant: { enum: ['body', 'muted', 'strong'], default: 'body' } },
			additionalProperties: false,
		},
		children: 'text',
	},
	button: {
		description: 'A button that calls a capability.',
		props: {
			type: 'object',
			properties: {
				id,
				label,
				variant: { enum: ['primary', 'secondary', 'tertiary', 'link'], default: 'secondary' },
				onClick: action,
				disabled: condition,
				visible: condition,
				confirm: { description: 'Ask for confirmation with this question first.', type: 'string' },
			},
			required: ['id', 'label', 'onClick'],
			additionalProperties: false,
		},
		children: 'none',
	},
	notice: {
		description: 'An inline status message.',
		props: {
			type: 'object',
			properties: {
				status: { enum: ['info', 'success', 'warning', 'error'], default: 'info' },
				dismissible: { type: 'boolean', default: false },
			},
			additionalProperties: false,
		},
		children: 'text',
	},
	card: {
		description: 'A bordered container with an optional title.',
		props: {
			type: 'object',
			properties: { title: { type: 'string' } },
			additionalProperties: false,
		},
		children: 'any',
	},
	'empty-state': {
		description: 'Shown when there is nothing to display.',
		props: {
			type: 'object',
			properties: {
				title: label,
				description: { type: 'string' },
			},
			required: ['title'],
			additionalProperties: false,
		},
		children: 'none',
	},
	table: {
		description: 'A list of records with fields and per-row actions. DataViews-shaped props: fields and actions.',
		props: {
			type: 'object',
			properties: {
				rows: { type: 'array', items: { type: 'object' } },
				fields: {
					type: 'array',
					minItems: 1,
					items: {
						type: 'object',
						properties: {
							id: { description: 'Path into the row, e.g. author.name.', type: 'string', minLength: 1 },
							label,
							type: { enum: ['text', 'integer', 'date', 'datetime', 'status', 'user', 'link'], default: 'text' },
							primary: { description: 'The row title field.', type: 'boolean' },
						},
						required: ['id', 'label'],
						additionalProperties: false,
					},
				},
				actions: {
					type: 'array',
					items: {
						type: 'object',
						properties: {
							id,
							label,
							onClick: action,
							visible: condition,
							primary: { type: 'boolean' },
							destructive: { type: 'boolean' },
							confirm: { type: 'string' },
						},
						required: ['id', 'label', 'onClick'],
						additionalProperties: false,
					},
				},
				empty: { description: 'Shown when there are no rows.', type: 'string' },
				perPage: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
				search: { type: 'boolean', default: false },
			},
			required: ['rows', 'fields'],
			additionalProperties: false,
		},
		children: 'none',
	},
	'row-action': {
		description: 'A link in a list table row\'s action bar.',
		props: {
			type: 'object',
			properties: {
				id,
				label,
				onClick: action,
				visible: condition,
				confirm: { type: 'string' },
			},
			required: ['id', 'label', 'onClick'],
			additionalProperties: false,
		},
		children: 'none',
	},
};
