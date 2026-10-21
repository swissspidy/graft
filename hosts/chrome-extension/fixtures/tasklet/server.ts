import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';

/**
 * Tasklet: a tiny task tracker that stands in for a third-party web app
 * the extension customizes. It has what such apps have and Graft needs:
 * pages with landmarks (a project sidebar, a toolbar), a JSON API behind
 * a session cookie, a CSRF header on writes, roles, and a strict CSP.
 *
 * It ships in three versions, to play an app that changes without notice:
 * - 1: the app as the surface describes it;
 * - 2: the sidebar's test id is renamed (its landmark stays): re-anchoring finds it;
 * - 3: as 2, the toolbar is gone and tasks' `due` is renamed `dueDate`.
 *
 * `/__fixture/*` is not part of the app: it is the fixture protocol that
 * makes this copy a verification sandbox (reset, seed, slot instances,
 * assertions) and lets tests read the request log. A sandbox for a real
 * app is a copy of it that speaks the same protocol.
 */

export type TaskletVersion = 1 | 2 | 3;
export type Role = 'owner' | 'member' | 'guest';

interface User {
	id: string;
	name: string;
	role: Role;
	email: string;
}
interface Project {
	id: string;
	name: string;
}
interface Task {
	id: string;
	project: string;
	title: string;
	status: 'open' | 'done';
	due: string | null;
	assignee: string | null;
}

interface State {
	users: Map<string, User>;
	projects: Map<string, Project>;
	tasks: Task[];
}

export interface TaskletServer {
	url: string;
	port: number;
	version(): TaskletVersion;
	setVersion(version: TaskletVersion): void;
	/** Requests to the app (not to /__fixture), oldest first: "GET /api/me". */
	log(): string[];
	close(): Promise<void>;
}

export interface TaskletOptions {
	port?: number;
	version?: TaskletVersion;
	/** Start with the demo data (default) or nothing. */
	seed?: 'demo' | 'empty';
}

const ROLES: Role[] = ['owner', 'member', 'guest'];
const DAY = 86_400_000;
const day = (offset: number) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);

function demo(): State {
	const users = new Map<string, User>(
		[
			{ id: 'lin', name: 'Lin', role: 'owner' as const, email: 'lin@tasklet.test' },
			{ id: 'ada', name: 'Ada', role: 'member' as const, email: 'ada@tasklet.test' },
			{ id: 'grace', name: 'Grace', role: 'guest' as const, email: 'grace@tasklet.test' },
		].map((u) => [u.id, u]),
	);
	const projects = new Map<string, Project>([['launch', { id: 'launch', name: 'Website launch' }]]);
	const tasks: Task[] = [
		{ id: 't1', project: 'launch', title: 'Write launch post', status: 'open', due: day(-2), assignee: 'ada' },
		{ id: 't2', project: 'launch', title: 'Check redirects', status: 'open', due: day(3), assignee: 'ada' },
		{ id: 't3', project: 'launch', title: 'Book the photographer', status: 'done', due: day(-5), assignee: 'ada' },
		{ id: 't4', project: 'launch', title: 'Update pricing page', status: 'open', due: day(1), assignee: 'lin' },
		{ id: 't5', project: 'launch', title: 'Proofread FAQ', status: 'open', due: null, assignee: 'grace' },
	];
	return { users, projects, tasks };
}

const empty = (): State => ({ users: new Map(), projects: new Map(), tasks: [] });

const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'";

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(version: TaskletVersion, project: Project, user: User): string {
	// The sidebar is drawn by the app's script after it loads, as in a single-page app.
	const toolbar =
		version === 3
			? ''
			: `<div role="toolbar" aria-label="Project actions" data-testid="project-toolbar" class="toolbar"><button type="button" disabled>Share</button></div>`;
	return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(project.name)} · Tasklet</title><link rel="stylesheet" href="/static/app.css"></head>
<body data-version="${version}">
<header class="top"><a href="/">Tasklet</a> <span class="who">${escapeHtml(user.name)} (${user.role})</span></header>
<div class="layout" id="layout" data-project="${escapeHtml(project.id)}">
  <main>
    <h1>${escapeHtml(project.name)}</h1>
    ${toolbar}
    <ul id="tasks" aria-label="Tasks"></ul>
  </main>
</div>
<script src="/static/app.js"></script>
</body>
</html>`;
}

/** The app's own script: draws the task list and, a moment later, the sidebar. */
function appScript(version: TaskletVersion): string {
	const sidebar: Record<string, string> = version === 1 ? { 'data-testid': 'project-sidebar', class: 'sidebar' } : { 'data-testid': 'details-pane', class: 'pane pane--details' };
	const due = version === 3 ? 'dueDate' : 'due';
	return `(() => {
  const layout = document.getElementById('layout');
  const project = layout.dataset.project;
  fetch('/api/projects/' + encodeURIComponent(project) + '/tasks').then((r) => r.json()).then(({ tasks }) => {
    const list = document.getElementById('tasks');
    for (const task of tasks) {
      const li = document.createElement('li');
      li.textContent = task.title + (task.${due} ? ' (due ' + task.${due} + ')' : '') + (task.status === 'done' ? ' ✓' : '');
      list.append(li);
    }
  });
  setTimeout(() => {
    const aside = document.createElement('aside');
    aside.setAttribute('aria-label', 'Project details');
    for (const [name, value] of Object.entries(${JSON.stringify(sidebar)})) aside.setAttribute(name, value);
    const h2 = document.createElement('h2');
    h2.textContent = 'Details';
    aside.append(h2);
    layout.append(aside);
  }, 150);
})();`;
}

const STYLE = `body{font:15px system-ui,sans-serif;margin:0;color:#1d2327}
.top{padding:8px 16px;background:#1d2327;color:#fff}.top a{color:#fff}
.layout{display:flex;gap:24px;padding:16px}main{flex:1}aside{width:320px;border-left:1px solid #ddd;padding-left:16px}`;

export async function startTasklet(options: TaskletOptions = {}): Promise<TaskletServer> {
	let version: TaskletVersion = options.version ?? 1;
	let state = options.seed === 'empty' ? empty() : demo();
	const sessions = new Map<string, string>();
	const requests: string[] = [];

	const json = (res: ServerResponse, status: number, body: unknown) => {
		res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
		res.end(JSON.stringify(body));
	};
	const viewer = (req: IncomingMessage): User | undefined => {
		const token = /(?:^|;\s*)tasklet_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
		const id = token ? sessions.get(token) : undefined;
		return id ? state.users.get(id) : undefined;
	};
	const body = async (req: IncomingMessage): Promise<unknown> => {
		const chunks: Buffer[] = [];
		for await (const chunk of req) {
			chunks.push(chunk as Buffer);
		}
		const text = Buffer.concat(chunks).toString('utf8');
		return text ? JSON.parse(text) : {};
	};
	const taskJson = (task: Task) => {
		const assignee = task.assignee ? state.users.get(task.assignee) : undefined;
		return {
			id: task.id,
			title: task.title,
			status: task.status,
			[version === 3 ? 'dueDate' : 'due']: task.due,
			assignee: assignee ? { id: assignee.id, name: assignee.name } : null,
		};
	};

	/** The fixture protocol: what makes this copy of the app a sandbox. */
	const fixture = async (req: IncomingMessage, res: ServerResponse, path: string, url: URL) => {
		if (path === '/__fixture/ready') {
			return json(res, 200, { ok: true, version });
		}
		if (path === '/__fixture/log') {
			return json(res, 200, { requests });
		}
		if (req.method !== 'POST' && path !== '/__fixture/instances') {
			return json(res, 405, { error: 'POST only' });
		}
		if (path === '/__fixture/reset') {
			state = empty();
			sessions.clear();
			requests.length = 0;
			return json(res, 200, { ok: true });
		}
		if (path === '/__fixture/demo') {
			state = demo();
			return json(res, 200, { ok: true });
		}
		if (path === '/__fixture/version') {
			const next = (await body(req)) as { version?: number };
			if (next.version !== 1 && next.version !== 2 && next.version !== 3) {
				return json(res, 400, { error: 'version must be 1, 2 or 3' });
			}
			version = next.version;
			return json(res, 200, { version });
		}
		if (path === '/__fixture/seed') {
			const fixtures = (await body(req)) as {
				users?: Array<{ as?: string; role?: string; name?: string }>;
				projects?: Array<{ id?: string; name?: string }>;
				tasks?: Array<{ title?: string; project?: string; status?: string; due_in_days?: number | null; assignee?: string | null }>;
			};
			const next = empty();
			for (const user of fixtures.users ?? []) {
				if (!user.as || !ROLES.includes(user.role as Role)) {
					return json(res, 400, { error: `A user needs "as" and a role (${ROLES.join(', ')}); got ${JSON.stringify(user)}.` });
				}
				next.users.set(user.as, { id: user.as, name: user.name ?? user.as, role: user.role as Role, email: `${user.as}@tasklet.test` });
			}
			for (const project of fixtures.projects?.length ? fixtures.projects : [{ id: 'demo', name: 'Demo' }]) {
				if (!project.id || !/^[a-z0-9-]+$/.test(project.id)) {
					return json(res, 400, { error: `A project needs an id of lowercase letters, digits and dashes; got ${JSON.stringify(project)}.` });
				}
				next.projects.set(project.id, { id: project.id, name: project.name ?? project.id });
			}
			const first = [...next.projects.keys()][0]!;
			for (const [i, task] of (fixtures.tasks ?? []).entries()) {
				if (!task.title) {
					return json(res, 400, { error: `Every task needs a title; task ${i + 1} has none.` });
				}
				if (task.status !== undefined && task.status !== 'open' && task.status !== 'done') {
					return json(res, 400, { error: `A task's status is "open" or "done"; got "${task.status}".` });
				}
				if (task.project !== undefined && !next.projects.has(task.project)) {
					return json(res, 400, { error: `The task "${task.title}" is in the unknown project "${task.project}".` });
				}
				if (task.assignee && !next.users.has(task.assignee)) {
					return json(res, 400, { error: `The task "${task.title}" is assigned to "${task.assignee}", who is not a fixture user.` });
				}
				next.tasks.push({
					id: `t${i + 1}`,
					project: task.project ?? first,
					title: task.title,
					status: (task.status as Task['status'] | undefined) ?? 'open',
					due: task.due_in_days === undefined || task.due_in_days === null ? null : day(task.due_in_days),
					assignee: task.assignee ?? null,
				});
			}
			state = next;
			sessions.clear();
			return json(res, 200, { users: Object.fromEntries([...state.users.values()].map((u) => [u.id, [u.role]])) });
		}
		if (path === '/__fixture/instances') {
			// Every place a slot renders: one per project page.
			const slot = url.searchParams.get('slot') ?? '';
			if (slot !== 'project.sidebar' && slot !== 'project.toolbar') {
				return json(res, 200, { instances: [] });
			}
			return json(res, 200, { instances: [...state.projects.values()].map((p) => ({ project: { id: p.id } })) });
		}
		if (path === '/__fixture/assert') {
			const { kind, expected } = (await body(req)) as { kind?: string; expected?: { title?: string; status?: string } };
			if (kind !== 'task') {
				return json(res, 200, { ok: false, actual: `unknown assertion "${kind}"` });
			}
			const task = state.tasks.find((t) => t.title === expected?.title);
			return json(res, 200, { ok: task !== undefined && (expected?.status === undefined || task.status === expected.status), actual: task ? { title: task.title, status: task.status } : null });
		}
		return json(res, 404, { error: 'unknown fixture route' });
	};

	const server = createServer(async (req, res) => {
		try {
			const url = new URL(req.url ?? '/', 'http://tasklet.invalid');
			const path = url.pathname;
			if (path.startsWith('/__fixture/')) {
				return await fixture(req, res, path, url);
			}
			requests.push(`${req.method} ${path}`);
			res.setHeader('content-security-policy', CSP);
			res.setHeader('x-content-type-options', 'nosniff');

			if (path === '/login') {
				// The fixture's sign-in: a real app would ask for a password.
				const user = state.users.get(url.searchParams.get('as') ?? '');
				if (!user) {
					return json(res, 404, { error: 'no such user' });
				}
				const token = randomUUID();
				sessions.set(token, user.id);
				res.writeHead(303, { 'set-cookie': `tasklet_session=${token}; HttpOnly; SameSite=Lax; Path=/`, location: url.searchParams.get('next') ?? '/' });
				return res.end();
			}
			if (path === '/static/app.js') {
				res.writeHead(200, { 'content-type': 'text/javascript' });
				return res.end(appScript(version));
			}
			if (path === '/static/app.css') {
				res.writeHead(200, { 'content-type': 'text/css' });
				return res.end(STYLE);
			}

			const user = viewer(req);
			if (path.startsWith('/api/')) {
				if (!user) {
					return json(res, 401, { error: 'not signed in' });
				}
				if (path === '/api/me' && req.method === 'GET') {
					return json(res, 200, { id: user.id, name: user.name, role: user.role });
				}
				if (path === '/api/members' && req.method === 'GET') {
					return json(res, 200, { members: [...state.users.values()].map((u) => ({ id: u.id, name: u.name, role: u.role, email: u.email })) });
				}
				const tasks = /^\/api\/projects\/([^/]+)\/tasks$/.exec(path);
				if (tasks && req.method === 'GET') {
					const project = state.projects.get(decodeURIComponent(tasks[1]!));
					if (!project) {
						return json(res, 404, { error: 'no such project' });
					}
					const status = url.searchParams.get('status');
					const assignee = url.searchParams.get('assignee');
					const list = state.tasks.filter(
						(t) => t.project === project.id && (!status || t.status === status) && (!assignee || t.assignee === (assignee === 'me' ? user.id : assignee)),
					);
					return json(res, 200, { tasks: list.map(taskJson) });
				}
				const complete = /^\/api\/tasks\/([^/]+)\/complete$/.exec(path);
				if (complete && req.method === 'POST') {
					if (req.headers['x-requested-with'] !== 'tasklet') {
						return json(res, 403, { error: 'missing CSRF header' });
					}
					if (user.role === 'guest') {
						return json(res, 403, { error: 'guests cannot change tasks' });
					}
					const task = state.tasks.find((t) => t.id === decodeURIComponent(complete[1]!));
					if (!task) {
						return json(res, 404, { error: 'no such task' });
					}
					task.status = 'done';
					return json(res, 200, taskJson(task));
				}
				return json(res, 404, { error: 'not found' });
			}

			if (!user) {
				res.writeHead(200, { 'content-type': 'text/html' });
				return res.end('<!doctype html><title>Tasklet</title><p>Sign in first.</p>');
			}
			if (path === '/') {
				const first = [...state.projects.keys()][0];
				res.writeHead(first ? 303 : 200, first ? { location: `/projects/${first}` } : { 'content-type': 'text/html' });
				return res.end(first ? undefined : '<!doctype html><title>Tasklet</title><p>No projects.</p>');
			}
			const project = /^\/projects\/([^/]+)$/.exec(path);
			const found = project ? state.projects.get(decodeURIComponent(project[1]!)) : undefined;
			if (found) {
				res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
				return res.end(page(version, found, user));
			}
			res.writeHead(404, { 'content-type': 'text/html' });
			res.end('<!doctype html><title>Not found</title><p>Not found.</p>');
		} catch (error) {
			json(res, 500, { error: (error as Error).message });
		}
	});
	await new Promise<void>((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		url: `http://127.0.0.1:${port}`,
		port,
		version: () => version,
		setVersion: (next) => {
			version = next;
		},
		log: () => [...requests],
		close: () =>
			new Promise<void>((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}

// `tsx server.ts [--port 4490] [--version 1]`: the app on its own, with the demo data.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const arg = (name: string) => {
		const i = process.argv.indexOf(`--${name}`);
		return i >= 0 ? process.argv[i + 1] : undefined;
	};
	const server = await startTasklet({ port: Number(arg('port') ?? 4490), version: Number(arg('version') ?? 1) as TaskletVersion });
	console.log(`Tasklet ${server.version()} on ${server.url} (sign in at ${server.url}/login?as=ada, lin or grace)`);
}
