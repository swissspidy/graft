import type { MiddlewareHandler } from 'astro';

/**
 * Test-only: with GRAFT_TEST_MODEL_URL set (dev mode only), requests the
 * plugin makes to the Claude API go to a local stub instead, so authoring
 * can be tested without a key or network. EmDash checks every plugin
 * request against SSRF rules (resolving hosts over DNS-over-HTTPS), so the
 * DNS answer for api.anthropic.com is stubbed too.
 */

const target = process.env.GRAFT_TEST_MODEL_URL;
const ANTHROPIC = 'https://api.anthropic.com';

if (import.meta.env.DEV && target && !(globalThis as { __graftTestModel?: boolean }).__graftTestModel) {
	(globalThis as { __graftTestModel?: boolean }).__graftTestModel = true;
	const real = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		const parsed = new URL(url);
		if (parsed.hostname === 'cloudflare-dns.com' && parsed.searchParams.get('name')?.replace(/\.$/, '') === 'api.anthropic.com') {
			const type = parsed.searchParams.get('type');
			const Answer = type === 'A' || type === '1' ? [{ name: 'api.anthropic.com', type: 1, TTL: 60, data: '160.79.104.10' }] : [];
			return Response.json({ Status: 0, Answer }, { headers: { 'Content-Type': 'application/dns-json' } });
		}
		if (url.startsWith(ANTHROPIC)) {
			return real(target + url.slice(ANTHROPIC.length), init);
		}
		return real(input, init);
	};
}

export const onRequest: MiddlewareHandler = (_context, next) => next();
