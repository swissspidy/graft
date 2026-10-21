import { describe, expect, it } from 'vitest';
import type { Capability } from '@swissspidy/graft-core';
import { buildRequest, CallError, perform, project } from '../src/host/http.ts';
import { tasklet } from '../src/apps/tasklet.ts';

const list = tasklet.capabilities['tasks.list']!;
const complete = tasklet.capabilities['tasks.complete']!;
const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('HTTP bindings', () => {
	it('builds requests on the page origin from the binding and the input', () => {
		const { url, init } = buildRequest(list.binding, { project: 'launch', status: 'open' }, 'http://127.0.0.1:4490');
		expect(url).toBe('http://127.0.0.1:4490/api/projects/launch/tasks?status=open');
		expect(init).toMatchObject({ method: 'GET', credentials: 'include', redirect: 'error' });
		const post = buildRequest(complete.binding, { id: 't1' }, 'http://127.0.0.1:4490');
		expect(post.init.headers).toMatchObject({ 'X-Requested-With': 'tasklet' });
	});

	it('encodes path parameters, so an input cannot walk to another endpoint or origin', () => {
		expect(buildRequest(list.binding, { project: '../members' }, 'https://app.example.com').url).toBe('https://app.example.com/api/projects/..%2Fmembers/tasks');
		expect(() => buildRequest({ method: 'GET', path: '//evil.example/x' }, {}, 'https://app.example.com')).toThrow(CallError);
		expect(() => buildRequest(list.binding, {}, 'https://app.example.com')).toThrow(/no "project"/);
	});

	it('cuts answers down to the declared output', () => {
		const output = project(list.output, { tasks: [{ id: 't1', title: 'A', status: 'open', due: null, assignee: { id: 'ada', name: 'Ada', email: 'ada@x' }, secret: 1 }], next: 'x' });
		expect(output).toEqual({ tasks: [{ id: 't1', title: 'A', status: 'open', due: null, assignee: { id: 'ada', name: 'Ada' } }] });
	});

	it('maps refusals and answers that no longer match', async () => {
		const call = (status: number, body: unknown, capability: Capability = list) => perform(capability, { project: 'p' }, 'https://app.example.com', respond(status, body));
		await expect(call(401, {})).rejects.toMatchObject({ code: 'host_unauthorized' });
		await expect(call(403, {})).rejects.toMatchObject({ code: 'host_forbidden' });
		await expect(call(500, {})).rejects.toMatchObject({ code: 'host_error' });
		await expect(call(200, { tasks: [{ id: 't1', title: 'A', status: 'open', dueDate: null, assignee: null }] })).rejects.toMatchObject({
			code: 'graft_drift',
			details: ['/tasks/0 is missing "due"'],
		});
		await expect(call(200, { tasks: [] })).resolves.toEqual({ tasks: [] });
	});
});
