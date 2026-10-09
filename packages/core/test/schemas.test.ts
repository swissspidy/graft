import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import buildSchema from '../../../schemas/build.schema.json' with { type: 'json' };
import specSchema from '../../../schemas/spec.schema.json' with { type: 'json' };
import surfaceSchema from '../../../schemas/surface.schema.json' with { type: 'json' };

describe('schemas', () => {
	it.each([
		['spec', specSchema],
		['surface', surfaceSchema],
		['build', buildSchema],
	])('%s schema compiles in strict mode', (_, schema) => {
		expect(() => new Ajv2020({ strict: true, allowUnionTypes: true }).compile(schema)).not.toThrow();
	});

	it('accepts a hand-written review-queue build', () => {
		const validate = new Ajv2020({ strict: true, allowUnionTypes: true }).compile(buildSchema);
		const build = {
			graft: 1,
			spec: { id: 'review-queue', hash: 'sha256:spec' },
			surface: { host: 'wordpress', hostVersion: '7.1', hash: 'sha256:surface' },
			mount: { slot: 'admin.page' },
			data: { queue: { call: 'posts.list', input: { status: 'pending' } } },
			ui: {
				protocol: 'a2ui/v0.9',
				catalogId: 'graft:wordpress',
				components: [
					{
						id: 'root',
						component: 'Table',
						rows: { path: '/queue/items' },
						fields: [{ id: 'title', label: 'Title', primary: true }],
						rowActions: [{ id: 'approve', label: 'Approve', action: { event: { name: 'approve', context: { id: { path: 'id' } } } } }],
						empty: 'Nothing to review',
					},
				],
			},
			events: { approve: { call: 'posts.update_status', input: { id: { $context: 'id' }, status: 'publish' }, then: ['remove-row:queue'] } },
			checks: [
				{
					criterion: 'contributors-no-approve',
					fixtures: { users: [{ as: 'c', role: 'contributor' }], posts: [{ status: 'pending', title: 'Draft A' }] },
					view_as: 'c',
					expect: [{ action: 'approve', available: false }],
				},
			],
			refs: {
				slot: 'admin.page',
				capabilities: ['posts.list', 'posts.update_status'],
				scopes: ['posts:read', 'posts.status:write'],
				catalog: { Table: ['empty', 'fields', 'rowActions', 'rows'] },
			},
			provenance: { compiler: 'handwritten', strategy: 'handwritten' },
		};
		expect(validate(build), JSON.stringify(validate.errors)).toBe(true);
		// Unknown $-keys are rejected: there is no expression form beyond the declared ones.
		expect(validate({ ...build, data: { queue: { call: 'posts.list', input: { x: { $eval: 'alert(1)', $data: 'a' } } } } })).toBe(false);
		// A build has a UI.
		const { ui: _ui, ...noUi } = build;
		expect(validate(noUi)).toBe(false);
	});
});
