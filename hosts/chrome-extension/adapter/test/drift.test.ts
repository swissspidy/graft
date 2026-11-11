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

	it('only narrows what was declared: a key that went is dropped, and no new key is taken in', () => {
		// "due" went. "dueDate" may be its new name and "assigneeEmail" was always withheld: an answer cannot tell which is which.
		for (const task of [
			{ id: 't1', title: 'A', dueDate: '2026-01-01' },
			{ id: 't1', title: 'A', assigneeEmail: 'ada@example.com' },
			{ id: 't1', title: 'A', dueDate: '2026-01-01', assigneeEmail: 'ada@example.com' },
		]) {
			const output = driftedOutput(declared, { tasks: [task], total: 1 }) as { properties: Record<string, any> };
			const item = output.properties.tasks.items;
			expect(Object.keys(item.properties)).toEqual(['id', 'title']);
			expect(item.required).toEqual(['id', 'title']);
			expect(Object.keys(output.properties)).toEqual(['tasks']);
			// What still fits keeps its declared schema, not the one sample's type.
			expect(item.properties.title).toEqual({ type: 'string' });
		}
	});

	it('takes nothing from an answer of another kind altogether', () => {
		expect(driftedOutput(declared, [{ id: 't1', assigneeEmail: 'ada@example.com' }])).toEqual({ type: 'array', items: { type: 'object', properties: {} } });
	});

	it('does not depend on the values the probe account happens to have', () => {
		const one = driftedOutput(declared, { tasks: [{ id: 't1', title: 'A', dueDate: '2026-01-01' }] });
		const other = driftedOutput(declared, { tasks: [{ id: 't9', title: 'Z', dueDate: '2027-05-05' }, { id: 't8', title: 'Y', dueDate: '2027-05-06' }] });
		expect(other).toEqual(one);
	});
});
