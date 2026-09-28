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
			tree: {
				type: 'table',
				props: {
					rows: { $data: 'queue.items' },
					columns: ['title', 'author', 'date'],
					empty: 'Nothing to review',
					actions: [
						{
							id: 'approve',
							label: 'Approve',
							visible: { $can: 'posts.status:write', on: { $field: 'id' } },
							onClick: {
								$call: 'posts.update_status',
								input: { id: { $field: 'id' }, status: 'publish' },
								then: ['remove-row:queue'],
							},
						},
					],
				},
			},
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
				components: { table: ['rows', 'columns', 'empty', 'actions'] },
				capabilities: ['posts.list', 'posts.update_status'],
				scopes: ['posts:read', 'posts.status:write'],
			},
			provenance: { compiler: 'handwritten', strategy: 'handwritten' },
		};
		expect(validate(build), JSON.stringify(validate.errors)).toBe(true);
		// Unknown $-keys are rejected: there is no expression form beyond the declared ones.
		expect(validate({ ...build, tree: { type: 'table', props: { x: { $eval: 'alert(1)', $data: 'a' } } } })).toBe(false);
	});
});
