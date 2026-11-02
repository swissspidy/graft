import { describe, expect, it } from 'vitest';
import { extractRefs, type Build } from '@swissspidy/graft-core';
import { pageBuild, surface } from '../../core/test/fixtures/acme.ts';
import { validateA2UI, type A2UIBuild, type A2UIHost } from '../src/index.ts';

const host: A2UIHost = { catalogId: 'graft:acme' };

/** An Acme page whose one text shows whether the first item's title matches `pattern`. */
async function patternBuild(pattern: string): Promise<Build> {
	const build = (await pageBuild({})) as unknown as A2UIBuild;
	build.data = { items: { call: 'items.list', input: {} } };
	build.ui = {
		protocol: 'a2ui/v0.9',
		catalogId: 'graft:acme',
		components: [
			{
				id: 'root',
				component: 'Text',
				text: { call: 'if', args: { condition: { call: 'regex', args: { value: { path: '/items/items/0/title' }, pattern } }, then: 'Matches', else: 'No match' } },
			},
		],
	};
	build.events = {};
	build.checks = [];
	const result = build as unknown as Build;
	result.refs = extractRefs(result, surface);
	return result;
}

const unsafe = (diagnostics: Array<{ code: string }>) => diagnostics.filter((d) => d.code === 'a2ui-unsafe-pattern');

describe('regex patterns', () => {
	it('refuses a pattern the renderer would refuse to run', async () => {
		const diagnostics = unsafe(validateA2UI(await patternBuild('\\S+\\s+\\S+\\s+\\S+'), surface, host));
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ severity: 'error', path: '/ui/components/0/text/args/condition/args/pattern' });
	});

	it('accepts the anchored equivalent', async () => {
		expect(unsafe(validateA2UI(await patternBuild('^\\s*\\S+\\s+\\S+\\s+\\S'), surface, host))).toEqual([]);
	});
});
