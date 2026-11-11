import { describe, expect, it } from 'vitest';
import { driftedOutput } from '../src/node/drift.ts';

const declared = {
	type: 'object',
	required: ['tasks'],
	properties: {
		tasks: {
			type: 'array',
			items: {
				type: 'object',
				required: ['id', 'title', 'due'],
				properties: { id: { type: 'string' }, title: { type: 'string' }, due: { type: ['string', 'null'] } },
			},
		},
	},
};

describe('the output a capability has after drift', () => {
	it('is the declared one while answers fit, whatever else they carry', () => {
		const body = { tasks: [{ id: 't1', title: 'A', due: null, assigneeEmail: 'ada@example.com' }], total: 1 };
		expect(driftedOutput(declared, body)).toBe(declared);
	});

	it('takes in what a declared key may have been renamed to, and nothing the surface withheld elsewhere', () => {
		const body = { tasks: [{ id: 't1', title: 'A', dueDate: '2026-01-01' }], total: 1 };
		const output = driftedOutput(declared, body) as { properties: Record<string, any> };
		const item = output.properties.tasks.items;
		// One key went and one came: a candidate for its new name. At the top level nothing went, so "total" stays out.
		expect(Object.keys(item.properties)).toEqual(['dueDate', 'id', 'title']);
		expect(item.required).toEqual(['id', 'title']);
		expect(Object.keys(output.properties)).toEqual(['tasks']);
		// What still fits keeps its declared schema, not the one sample's type.
		expect(item.properties.title).toEqual({ type: 'string' });
	});

	it('takes in no new key where more appeared than went: a rename cannot be told from what was withheld', () => {
		const body = { tasks: [{ id: 't1', title: 'A', dueDate: '2026-01-01', assigneeEmail: 'ada@example.com' }] };
		const item = (driftedOutput(declared, body) as { properties: Record<string, any> }).properties.tasks.items;
		expect(Object.keys(item.properties)).toEqual(['id', 'title']);
		expect(item.required).toEqual(['id', 'title']);
	});

	it('does not depend on the values the probe account happens to have', () => {
		const one = driftedOutput(declared, { tasks: [{ id: 't1', title: 'A', dueDate: '2026-01-01' }] });
		const other = driftedOutput(declared, { tasks: [{ id: 't9', title: 'Z', dueDate: '2027-05-05' }, { id: 't8', title: 'Y', dueDate: '2027-05-06' }] });
		expect(other).toEqual(one);
	});
});
