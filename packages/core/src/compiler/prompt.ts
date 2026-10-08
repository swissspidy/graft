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
- {"$gt": [a, b]}, {"$gte": [a, b]}, {"$lt": [a, b]}, {"$lte": [a, b]}: compares two numbers (or two strings).
- {"$if": [condition, then, else]}: then when the condition is true, else otherwise; nest them for more cases.
- {"$daysSince": <date>}: whole days from an ISO 8601 date (e.g. {"$field": "modified"}) to now.
- {"$call": "capability", "input": <value>, "then": [...], "notice": "text"}: an action run on click. "then" may contain "refresh:<source>", "remove-row:<source>" (drop the clicked row from a source) and "reload:page".`;

const CHECK_VOCABULARY = `A check proves one acceptance criterion. It seeds its own fixtures, renders the customization for one fixture user (view_as), optionally performs steps, then evaluates expectations over what that user sees and can do.
- steps: [{"action": "<action id>", "row": {<fields identifying the row, e.g. "title": "Draft A">}}], or, to type into a widget's input, {"fill": "<input id>", "value": "<text>" (true/false for a checkbox), "row": {...}}
- expectations (each an object):
  {"rows": ["label", ...]}: the labels (primary field) of the listed rows, in any order; [] for none.
  {"columns": ["Label", ...]}: every column label, in order (the whole list, not just the ones a criterion names; use "cell" to check one column).
  rows and columns read the first table shown, so a tree (or widget) the checks list rows in shows that table first and draws choices such as filters as buttons, not as another table.
  {"text": "..."}: this text is shown somewhere.
  {"action": "<action id>", "row": {...}, "available": true|false}: whether the action is available (for that row). Only a table row's actions have a row; a button outside a table has none, so give each such button its own action id (e.g. "author-alice") and leave "row" out.
  {"cell": {"row": {...}, "column": "Label", "text": "...", "tone": "..."}}: what a table cell shows for that row (text: contained; tone: the mark, when the column has one).
  {"input": "<input id>", "value": <value>, "row": {...}}: what a widget's input shows.
  plus the host assertions below.
Fixtures are created when the check starts. To test anything that depends on age ("older than 30 days"), set advance_days: the check then looks that many days later.
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

export function treeSystem(spec: Spec, surface: Surface, host: HostGuide): string {
	return [
		'You build customizations of a web application as declarative UI trees. The tree may only use the components, slot props and capabilities listed below; it is rendered by a trusted renderer and every capability call is permission-checked. Keep it minimal: build what the spec asks, nothing it puts out of scope.',
		EXPRESSIONS,
		surface.functions ? functionsGuide(surface.functions.limits) : '',
		surface.functions?.widgets ? widgetsGuide(surface.functions.widgets) : '',
		host.notes ?? '',
		describeSurface(spec, surface),
	]
		.filter(Boolean)
		.join('\n\n');
}

/** Only on surfaces that run build functions. */
function functionsGuide(limits: NonNullable<Surface['functions']>['limits']): string {
	return `Functions (use only when the expressions above cannot compute a value):
- Put plain JavaScript in "code": {"source": "function name(a, b) { ... }", "functions": ["name"]}. Otherwise "code" is null.
- Call one with {"$fn": "name", "args": [<values>]}, e.g. {"$fn": "verdict", "args": [{"$field": "title"}]}. Arguments are evaluated first and passed as JSON.
- Functions are pure: they get their arguments and nothing else. No window, document, fetch, storage, timers or promises; nothing can be read or written. Return strings, numbers, booleans, arrays or plain objects; keys starting with "$" are dropped, so a function cannot make an action.
- $fn may only compute values to show: never inside a $call input or a data source input.
- Each call must finish within ${limits.timeMs} ms; the source may be at most ${limits.sourceBytes} bytes.`;
}

/** Only on surfaces that run interactive widgets. */
function widgetsGuide(widgets: NonNullable<NonNullable<Surface['functions']>['widgets']>): string {
	return `Interactive widgets (use only when the spec needs state that changes as the viewer clicks, e.g. filtering or switching views):
- A "widget" node names two functions from "code": {"type": "widget", "props": {"render": "draw", "update": "choose", "input": {"$data": "queue.items"}, "state": {"author": null}}}.
- render(input, state) returns a tree of nodes {type, props, children} using only: ${widgets.components.join(', ')}; at most ${widgets.maxNodes} nodes. "children" follows the component's children rule above: leave it out where it is "none", a single string (not a list) where it is "text", a list of nodes where it is "any". Props are plain data (no expressions); give every button an "id" the checks can use.
- A button's onClick is {"$event": "name", "payload": <data>}: clicking it calls update(state, "name", payload, input), which returns the next state, and render draws again.
- To change something, declare the action on the widget node: "actions": {"approve": {"call": {"$call": ..., "input": {"id": {"$field": "id"}}, "then": ["refresh:<source>"]}, "visible": {"$can": ...}}}, with "input" a list of records that have an "id". A drawn button then uses it with onClick {"$use": "approve", "row": <row id>}; in a table's actions, {"$use": "approve"} applies to each row. Code can only offer a declared action on a row of the input; it can never call a capability itself.
- Checks click widget buttons with steps: {"action": "<button id>"}.${
		widgets.inputs?.length
			? `
- Inputs (${widgets.inputs.join(', ')}) take an "id" and a "label"; "value" is what they start with. After that they show what the viewer enters, and the code cannot change it. With "onChange": {"$event": "name"}, each change calls update(state, "name", <entered value>, input), so the code can react as the viewer types (keep the value in state if render needs it).
- A declared action sends what an input shows with {"$input": "<input id>"} in its "call" input, e.g. "input": {"id": {"$field": "id"}, "title": {"$input": "title"}}. $input works nowhere else.
- Checks type into inputs with steps: {"fill": "<input id>", "value": ...}.`
			: ''
	}`;
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
			JSON.stringify({ tree: previous.tree, data: previous.data, ...(previous.code ? { code: previous.code } : {}) }),
		);
	}
	if (feedback.length > 0) {
		lines.push('', 'Your previous attempt was rejected:', ...feedback.map((f) => `- ${f}`), 'Fix these problems and return the complete build.');
	}
	return lines.join('\n');
}
