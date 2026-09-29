import type { APIRoute } from 'astro';
import { getDb } from 'emdash/runtime';

/**
 * Test-only login: creates a user with a role (if needed) and signs the
 * browser in as them, like EmDash's own dev bypass does for the admin.
 * Only in dev mode with GRAFT_TEST_LOGIN=1; EmDash's real sign-in needs
 * passkeys, which tests cannot create through the API.
 *
 *   /graft-test/login?user=editor&role=40[&redirect=/_emdash/admin]
 */
export const prerender = false;

const handler: APIRoute = async ({ url, session }) => {
	if (!import.meta.env.DEV || process.env.GRAFT_TEST_LOGIN !== '1') {
		return new Response('Not found', { status: 404 });
	}
	const db = await getDb();
	const alias = url.searchParams.get('user') ?? '';
	const role = Number(url.searchParams.get('role'));
	if (!db || !/^[a-z][a-z0-9-]*$/.test(alias) || ![10, 20, 30, 40, 50].includes(role)) {
		return new Response('Bad request', { status: 400 });
	}
	const email = `${alias}@graft.test`;
	let user = await db.selectFrom('users').select(['id', 'role']).where('email', '=', email).executeTakeFirst();
	if (!user) {
		const now = new Date().toISOString();
		user = { id: crypto.randomUUID(), role };
		const name = alias.charAt(0).toUpperCase() + alias.slice(1);
		await db.insertInto('users').values({ id: user.id, email, name, role, email_verified: 1, created_at: now, updated_at: now }).execute();
	}
	session?.set('user', { id: user.id });
	const redirect = url.searchParams.get('redirect');
	if (redirect?.startsWith('/') && !redirect.startsWith('//')) {
		return new Response(`<!doctype html><meta http-equiv="refresh" content="0;url=${redirect.replace(/[<>"&]/g, '')}">`, { headers: { 'Content-Type': 'text/html' } });
	}
	return Response.json({ id: user.id, role: user.role, email });
};

export const GET = handler;
export const POST = handler;
