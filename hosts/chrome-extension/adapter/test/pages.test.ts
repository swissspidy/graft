import { describe, expect, it } from 'vitest';
import { matchPage, originMatches, pageMatchPattern, slotProps } from '../src/host/pages.ts';

describe('pages', () => {
	it('matches path patterns and decodes their parameters', () => {
		expect(matchPage('/projects/:project', '/projects/launch')).toEqual({ project: 'launch' });
		expect(matchPage('/projects/:project', '/projects/a%20b/')).toEqual({ project: 'a b' });
		expect(matchPage('/projects/:project', '/projects/launch/settings')).toBeUndefined();
		expect(matchPage('/projects/:project', '/teams/launch')).toBeUndefined();
		expect(matchPage('/projects/:project', '/projects/%E0%A4%A')).toBeUndefined();
	});

	it('turns page parameters into slot props', () => {
		const anchor = { pages: ['/projects/:project'], selectors: ['aside'], insert: 'append' as const };
		expect(slotProps(anchor, 'http://127.0.0.1:4490/projects/launch?tab=1')).toEqual({ project: { id: 'launch' } });
		expect(slotProps(anchor, 'http://127.0.0.1:4490/')).toBeUndefined();
	});

	it('matches origins like Chrome match patterns', () => {
		expect(originMatches('http://127.0.0.1/*', 'http://127.0.0.1:4490/projects/x')).toBe(true);
		expect(originMatches('http://127.0.0.1/*', 'https://127.0.0.1/projects/x')).toBe(false);
		expect(originMatches('https://*.example.com/*', 'https://app.example.com/')).toBe(true);
		expect(originMatches('https://*.example.com/*', 'https://example.com/')).toBe(true);
		expect(originMatches('https://*.example.com/*', 'https://evilexample.com/')).toBe(false);
		expect(originMatches('https://app.example.com:8443/*', 'https://app.example.com/')).toBe(false);
		expect(originMatches('<all_urls>', 'https://app.example.com/')).toBe(false);
	});

	it('derives content script match patterns', () => {
		expect(pageMatchPattern('https://app.example.com/*', '/projects/:project')).toBe('https://app.example.com/projects/*');
	});
});
