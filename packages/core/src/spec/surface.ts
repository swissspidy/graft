import '../ajv.ts';
import { compileSchema, type Validator } from '../schema.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { describeSchemaError, schemaErrorPath } from '../schema-errors.ts';
import type { Surface } from '../surface/types.ts';
import type { SpecManifest } from './types.ts';


/**
 * Phase two of spec validation: checks the manifest's mount, audience and
 * permissions against the surface of one host version.
 */
export function checkManifestAgainstSurface(
	manifest: SpecManifest,
	surface: Surface,
	lineOf: (pointer: string) => number | undefined = () => undefined,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const report = (severity: Diagnostic['severity'], code: string, path: string, message: string) => {
		const diagnostic: Diagnostic = { severity, code, message, path };
		const line = lineOf(path);
		if (line !== undefined) {
			diagnostic.line = line;
		}
		diagnostics.push(diagnostic);
	};

	if (manifest.host !== surface.host) {
		report('error', 'surface-host-mismatch', '/host', `This spec targets "${manifest.host}", but the surface is for "${surface.host}".`);
		return diagnostics;
	}

	const { slot: slotId, ...options } = manifest.mount;
	const slot = surface.slots[slotId];
	if (!slot) {
		report(
			'error',
			'mount-unknown-slot',
			'/mount/slot',
			`Slot "${slotId}" does not exist in ${surface.host} ${surface.hostVersion}. Available: ${Object.keys(surface.slots).join(', ')}.`,
		);
	} else {
		if (slot.deprecated) {
			report(
				'warning',
				'mount-deprecated-slot',
				'/mount/slot',
				`Slot "${slotId}" is deprecated${slot.successor ? `; use "${slot.successor}"` : ''}.`,
			);
		}
		if (slot.options !== undefined) {
			const validate = optionsValidator(slot.options);
			if (!validate(options)) {
				for (const error of validate.errors ?? []) {
					report('error', 'mount-invalid-options', `/mount${schemaErrorPath(error)}`, describeSchemaError(error, '/mount', '"mount"'));
				}
			}
		}
	}

	if (surface.audiences) {
		manifest.audience?.forEach((audience, i) => {
			if (!surface.audiences?.includes(audience)) {
				report(
					'error',
					'audience-unknown',
					`/audience/${i}`,
					`Unknown audience "${audience}". Available: ${surface.audiences?.join(', ')}.`,
				);
			}
		});
	}

	manifest.permissions.forEach((scope, i) => {
		if (!surface.scopes[scope]) {
			report(
				'error',
				'permission-unknown-scope',
				`/permissions/${i}`,
				`Unknown permission "${scope}". Available: ${Object.keys(surface.scopes).join(', ')}.`,
			);
		}
	});

	return diagnostics;
}

function optionsValidator(schema: object | boolean): Validator {
	return compileSchema(schema);
}
