import { describeCheck, validateSpec, type Surface } from '@swissspidy/graft-core';
import type { Block } from '../host/blocks.ts';
import { describers } from '../host/describe.ts';
import { activeVersion, pendingVersion, type SpecRecord } from './store.ts';

const states: Record<string, string> = {
	draft: 'Draft (not verified)',
	building: 'Building',
	needs_approval: 'Waiting for approval',
	active: 'Live',
	rejected: 'Rejected',
	upgrading: 'Upgrading',
	suspended: 'Suspended',
	superseded: 'Superseded',
	archived: 'Archived',
};

/**
 * One customization as an administrator reviews it: its state, the
 * permissions it needs, and each check next to the criterion it proves.
 */
export function describeVersion(record: SpecRecord, surface: Surface): Block[] {
	const version = pendingVersion(record) ?? activeVersion(record) ?? record.versions.at(-1);
	if (!version) {
		return [];
	}
	const spec = validateSpec(version.source).spec;
	const blocks: Block[] = [
		{ type: 'header', text: record.title },
		{
			type: 'fields',
			fields: [
				{ label: 'Id', value: record.id },
				{ label: `Version ${version.n}`, value: states[version.state] ?? version.state },
				{ label: 'Permissions', value: version.scopes.map((s) => surface.scopes[s]?.title ?? s).join('; ') || 'None' },
			],
		},
	];
	if (version.build && version.build.surface.hash !== surface.hash) {
		blocks.push({ type: 'banner', variant: 'alert', description: 'Built for another EmDash surface: not served until it is upgraded.' });
	}
	if (spec && version.build) {
		const rows = spec.criteria.map((criterion) => ({
			criterion: criterion.text,
			check: version.build!.checks.filter((c) => c.criterion === criterion.id).map((c) => describeCheck(c, describers)).join(' ') || 'No check.',
		}));
		blocks.push({
			type: 'table',
			columns: [
				{ key: 'criterion', label: 'Criterion' },
				{ key: 'check', label: 'How it is checked' },
			],
			rows,
			page_action_id: `graft:checks:${record.id}`,
		});
	}
	return blocks;
}
