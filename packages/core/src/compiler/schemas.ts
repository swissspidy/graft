import type { Spec } from '../spec/types.ts';
import type { Surface } from '../surface/types.ts';

/**
 * Output schemas for the model. Structured outputs do not allow recursive
 * schemas or open objects, so free-form JSON (fixtures, expectations) comes
 * back as JSON strings. The compiler reassembles and fully validates the
 * result. A UI format brings the schema of its own phase.
 */

const names = (values: string[]) => (values.length > 0 ? { type: 'string', enum: values } : { type: 'string' });

export function checksOutputSchema(spec: Spec): Record<string, unknown> {
	return {
		type: 'object',
		additionalProperties: false,
		required: ['checks', 'unverifiable'],
		properties: {
			unverifiable: {
				type: 'array',
				description: 'Criteria that cannot be checked objectively from what users see and can do, with the reason. Leave empty when every criterion is checkable.',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['criterion', 'reason'],
					properties: {
						criterion: names(spec.criteria.map((c) => c.id)),
						reason: { type: 'string' },
					},
				},
			},
			checks: {
				type: 'array',
				items: {
					type: 'object',
					additionalProperties: false,
					required: ['criterion', 'fixtures_json', 'view_as', 'advance_days', 'steps_json', 'expect_json'],
					properties: {
						criterion: names(spec.criteria.map((c) => c.id)),
						fixtures_json: { type: 'string', description: 'JSON object: the fixtures to seed.' },
						view_as: { type: 'string', description: 'Fixture user alias the check renders for.' },
						advance_days: { type: 'integer', description: 'View the customization this many days after the fixtures were seeded (0 for right away).' },
						steps_json: { type: 'string', description: 'JSON array of steps, [] for none.' },
						expect_json: { type: 'string', description: 'JSON array of expectations, at least one.' },
					},
				},
			},
		},
	};
}

/** Capabilities a build for this spec may use: those whose scopes the spec requests. */
export function usableCapabilities(spec: Spec, surface: Surface): string[] {
	return Object.entries(surface.capabilities)
		.filter(([, capability]) => capability.scopes.every((scope) => spec.manifest.permissions.includes(scope)))
		.map(([name]) => name)
		.sort();
}
