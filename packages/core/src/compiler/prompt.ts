import type { Build, Check } from '../build/types.ts';
import type { Spec } from '../spec/types.ts';
import type { Surface } from '../surface/types.ts';
import { usableCapabilities } from './schemas.ts';
import type { HostGuide } from './types.ts';

const EXPRESSIONS = `Prop values are JSON. Besides literals, these expression objects are allowed anywhere in props and inputs (nothing else: no code, no HTML):
- {"$data": "source.path"}: a value from a named data source, e.g. "queue.items".
- {"$field": "path"}: a field of the current row (only inside per-row props such as table actions).
- {"$slot": "path"}: a prop the slot provides, e.g. "post.id".
- {"$can": "scope"} or {"$can": "scope", "on": <value>}: whether the viewer may use a permission scope, optionally on an object; inside a row "on" defaults to the row.
- {"$eq": [a, b]}, {"$and": [...]}, {"$or": [...]}, {"$not": value}: logic over values and permission checks.
- {"$call": "capability", "input": <value>, "then": [...], "notice": "text"}: an action run on click. "then" may contain "refresh:<source>", "remove-row:<source>" (drop the clicked row from a source) and "reload:page".`;

const CHECK_VOCABULARY = `A check proves one acceptance criterion. It seeds its own fixtures, renders the customization for one fixture user (view_as), optionally performs steps, then evaluates expectations over what that user sees and can do.
- steps: [{"action": "<action id>", "row": {<fields identifying the row, e.g. "title": "Draft A">}}]
- expectations (each an object):
  {"rows": ["label", ...]}: the labels (primary field) of the listed rows, in any order; [] for none.
  {"columns": ["Label", ...]}: the column labels, in order.
  {"text": "..."}: this text is shown somewhere.
  {"action": "<action id>", "row": {...}, "available": true|false}: whether the action is available (for that row).
  plus the host assertions below.
Write checks that would fail for a wrong implementation: include fixtures that must NOT show up, users who must NOT be able to act, and the empty case when a criterion mentions one.
Some criteria cannot be checked this way: taste ("looks clean"), performance ("is fast"), or anything not observable in what a user sees and can do. Do not write a weak check for those; list them under "unverifiable" with a one-sentence reason the author can act on.`;

function json(value: unknown): string {
	return JSON.stringify(value);
}

/** The surface as far as this spec may use it: its slot, all components, usable capabilities and scopes. */
export function describeSurface(spec: Spec, surface: Surface): string {
	const slot = surface.slots[spec.manifest.mount.slot];
	const lines: string[] = [`Host: ${surface.host} ${surface.hostVersion}`];
	lines.push(
		`\nSlot "${spec.manifest.mount.slot}" (${slot?.kind ?? 'unknown'}): ${slot?.description ?? slot?.title ?? ''}`,
		`  provides: ${json(slot?.provides ?? {})}`,
		slot?.accepts ? `  root component must be one of: ${slot.accepts.join(', ')}` : '  any component may be the root',
	);
	lines.push('\nComponents (props are JSON Schema of resolved values; actions and conditions stay expressions):');
	for (const [name, component] of Object.entries(surface.components).sort(([a], [b]) => a.localeCompare(b))) {
		lines.push(`- ${name} (children: ${component.children ?? 'none'}): ${component.description ?? ''}`, `  props: ${json(component.props)}`);
	}
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

export function treeSystem(spec: Spec, surface: Surface, host: HostGuide): string {
	return [
		'You build customizations of a web application as declarative UI trees. The tree may only use the components, slot props and capabilities listed below; it is rendered by a trusted renderer and every capability call is permission-checked. Keep it minimal: build what the spec asks, nothing it puts out of scope.',
		EXPRESSIONS,
		host.notes ?? '',
		describeSurface(spec, surface),
	]
		.filter(Boolean)
		.join('\n\n');
}

export function treePrompt(spec: Spec, checks: Check[], previous: Build | undefined, feedback: string[]): string {
	const lines = [
		'Build this spec. Your build must pass these frozen checks (action ids in the checks must match the ids you give actions):',
		'',
		describeSpec(spec),
		'',
		`Checks: ${JSON.stringify(checks)}`,
	];
	if (previous) {
		lines.push(
			'',
			'This replaces an earlier build of the same spec that no longer fits the host. Keep its layout and wording where the parts still exist:',
			JSON.stringify({ tree: previous.tree, data: previous.data }),
		);
	}
	if (feedback.length > 0) {
		lines.push('', 'Your previous attempt was rejected:', ...feedback.map((f) => `- ${f}`), 'Fix these problems and return the complete build.');
	}
	return lines.join('\n');
}
