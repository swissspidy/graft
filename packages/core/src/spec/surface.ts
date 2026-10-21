import '../ajv.ts';
import { compileSchema, type Validator } from '../schema.ts';
import type { Diagnostic } from '../diagnostics.ts';
import { describeSchemaError, schemaErrorPath } from '../schema-errors.ts';
import type { Surface } from '../surface/types.ts';
import type { SpecManifest } from './types.ts';
import { intervalSeconds } from '../build/triggers.ts';


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

	const triggers = Object.entries(manifest.triggers ?? {});
	if (triggers.length > 0 && !surface.triggers) {
		report('error', 'trigger-unsupported', '/triggers', `${surface.host} ${surface.hostVersion} does not run triggers.`);
	} else if (surface.triggers) {
		const host = surface.triggers;
		for (const [id, trigger] of triggers) {
			const path = `/triggers/${id}`;
			if (trigger.schedule) {
				const seconds = intervalSeconds(trigger.schedule);
				if (!(seconds >= host.minInterval)) {
					report('error', 'trigger-too-often', `${path}/schedule/every`, `Triggers run at most every ${host.minInterval / 60} minutes; "${trigger.schedule.every}" is more often.`);
				}
				if (trigger.schedule.at && !trigger.schedule.every.endsWith('d')) {
					report('error', 'trigger-at', `${path}/schedule/at`, 'A time of day ("at") only goes with a schedule in days, e.g. every: 1d.');
				}
			}
			if (trigger.event && !host.events[trigger.event]) {
				report('error', 'trigger-unknown-event', `${path}/event`, `Unknown event "${trigger.event}". Available: ${Object.keys(host.events).join(', ') || 'none'}.`);
			}
			trigger.permissions.forEach((scope, i) => {
				if (!surface.scopes[scope]) {
					report('error', 'permission-unknown-scope', `${path}/permissions/${i}`, `Unknown permission "${scope}". Available: ${Object.keys(surface.scopes).join(', ')}.`);
				} else if (!host.capabilities.some((name) => surface.capabilities[name]?.scopes.includes(scope))) {
					report('error', 'trigger-scope-unusable', `${path}/permissions/${i}`, `No capability triggers may use needs "${scope}", so granting it does nothing.`);
				}
			});
			if (trigger.limit !== undefined && trigger.limit > host.maxPerRun) {
				report('error', 'trigger-limit', `${path}/limit`, `A run makes at most ${host.maxPerRun} calls on ${surface.host}.`);
			}
		}
	}

	return diagnostics;
}

function optionsValidator(schema: object | boolean): Validator {
	return compileSchema(schema);
}
