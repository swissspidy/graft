import type { Spec } from '../spec/types.ts';
import type { Surface } from '../surface/types.ts';
import { usableCapabilities } from './schemas.ts';
import type { HostGuide } from './types.ts';

const CHECK_VOCABULARY = `A check proves one acceptance criterion. It seeds its own fixtures, renders the customization for one fixture user (view_as), optionally performs steps, then evaluates expectations over what that user sees and can do.
- steps: [{"action": "<action id>", "row": {<fields identifying the row, e.g. "title": "Draft A">}}], or, to type into an input, {"fill": "<input id>", "value": "<text>" (true/false for a checkbox), "row": {...}}
- expectations (each an object):
  {"rows": ["label", ...]}: the labels (primary field) of the listed rows, in any order; [] for none.
  {"columns": ["Label", ...]}: every column label, in order (the whole list, not just the ones a criterion names; use "cell" to check one column).
  rows and columns read the first table shown, so a UI the checks list rows in shows that table first and draws choices such as filters as buttons, not as another table.
  {"text": "..."}: this text is shown somewhere: in text, a table cell, an input's label, or the label of a button or action the viewer can use (not of one that is hidden or disabled). It cannot say where: to check a value in a table use "cell" (which row and column), and to check a button use "action".
  {"action": "<action id>", "row": {...}, "available": true|false}: whether the action is available (for that row). Only a table row's actions have a row; a button outside a table has none, so give each such button its own action id (e.g. "author-alice") and leave "row" out.
  {"cell": {"row": {...}, "column": "Label", "text": "...", "tone": "..."}}: what a table cell shows for that row (text: contained; tone: the mark, when the column has one).
  {"input": "<input id>", "value": <value>, "row": {...}}: what an input shows.
  plus the host assertions below.
Fixtures are created when the check starts. To test anything that depends on age ("older than 30 days"), set advance_days: the check then looks that many days later.
Write checks that would fail for a wrong implementation: include fixtures that must NOT show up, users who must NOT be able to act, and the empty case when a criterion mentions one.
Some criteria cannot be checked this way: taste ("looks clean"), performance ("is fast"), or anything not observable in what a user sees and can do. Do not write a weak check for those; list them under "unverifiable" with a one-sentence reason the author can act on.`;

function json(value: unknown): string {
	return JSON.stringify(value);
}

/** The surface as far as this spec may use it: its slot, usable capabilities and scopes, the content model. */
export function describeSurface(spec: Spec, surface: Surface): string {
	const slot = surface.slots[spec.manifest.mount.slot];
	const lines: string[] = [`Host: ${surface.host} ${surface.hostVersion}`];
	lines.push(
		`\nSlot "${spec.manifest.mount.slot}" (${slot?.kind ?? 'unknown'}): ${slot?.description ?? slot?.title ?? ''}`,
		`  provides: ${json(slot?.provides ?? {})}`,
	);
	lines.push('\nCapabilities you may use (anything else is refused):');
	for (const name of usableCapabilities(spec, surface)) {
		const capability = surface.capabilities[name]!;
		lines.push(
			`- ${name} (${capability.kind}, scopes ${capability.scopes.join(', ')}): ${capability.description ?? ''}`,
			`  input: ${json(capability.input)}`,
			`  output: ${json(capability.output)}`,
		);
	}
	lines.push('\nPermission scopes:');
	for (const [name, scope] of Object.entries(surface.scopes)) {
		lines.push(`- ${name}: ${scope.title}`);
	}
	if (surface.model) {
		lines.push("\nThe host's content model (what exists on the site, and what fixtures can create):", json(surface.model));
	}
	return lines.join('\n');
}

export function describeSpec(spec: Spec): string {
	const lines = [
		`# ${spec.title}`,
		'',
		spec.description,
		'',
		`Mounted at: ${json(spec.manifest.mount)}`,
		`Audience: ${spec.manifest.audience?.join(', ') || 'everyone'}`,
		`Permissions requested: ${spec.manifest.permissions.join(', ')}`,
		'',
		'Acceptance criteria:',
		...spec.criteria.map((c) => `- [${c.id}] ${c.text}`),
	];
	if (spec.outOfScope.length > 0) {
		lines.push('', 'Out of scope (do not build these):', ...spec.outOfScope.map((item) => `- ${item}`));
	}
	if (spec.notes) {
		lines.push('', 'Notes:', spec.notes);
	}
	for (const section of spec.sections) {
		lines.push('', `${section.heading}:`, section.content);
	}
	return lines.join('\n');
}

export function checksSystem(spec: Spec, surface: Surface, host: HostGuide): string {
	return [
		'You write executable acceptance checks for a customization of a web application. The checks are frozen once written: implementations are graded against them later, so they must capture each criterion faithfully, no stricter and no looser.',
		CHECK_VOCABULARY,
		`Fixtures on this host:\n${host.fixtures}`,
		`Host assertions:\n${host.assertions}`,
		'The customization will be built from these parts:',
		describeSurface(spec, surface),
	].join('\n\n');
}

export function checksPrompt(spec: Spec, feedback: string[]): string {
	const lines = [
		'Write at least one check for every acceptance criterion of this spec. Action ids you may refer to should be short kebab-case verbs taken from the criteria (e.g. "approve").',
		'',
		describeSpec(spec),
	];
	if (feedback.length > 0) {
		lines.push('', 'Your previous answer was rejected:', ...feedback.map((f) => `- ${f}`), 'Fix these problems.');
	}
	return lines.join('\n');
}
