import { existsSync } from 'node:fs';
import type { APIRoute } from 'astro';

/** 200 once the test server has finished seeding (it writes GRAFT_READY_FILE). */
export const prerender = false;

export const GET: APIRoute = () => {
	const file = process.env.GRAFT_READY_FILE;
	return new Response(null, { status: import.meta.env.DEV && file && existsSync(file) ? 200 : 503 });
};
