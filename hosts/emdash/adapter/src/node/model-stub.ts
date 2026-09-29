import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Claude Messages API that answers each request with the
 * next scripted output (as a JSON text block) and records the requests. The
 * test site routes the plugin's Claude API calls here (site/src/test-model.ts).
 */

export interface ModelStub {
	url: string;
	requests: Array<{ headers: Record<string, unknown>; body: Record<string, unknown> }>;
	close(): void;
}

export async function startModelStub(outputs: unknown[]): Promise<ModelStub> {
	const requests: ModelStub['requests'] = [];
	const server = createServer((request, response) => {
		let raw = '';
		request.on('data', (chunk) => (raw += chunk));
		request.on('end', () => {
			const body = JSON.parse(raw || '{}') as Record<string, unknown>;
			requests.push({ headers: request.headers, body });
			const output = outputs[requests.length - 1];
			response.setHeader('Content-Type', 'application/json');
			if (new URL(request.url ?? '/', 'http://stub').pathname !== '/v1/messages' || output === undefined) {
				response.statusCode = 400;
				response.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `Unexpected request ${requests.length}` } }));
				return;
			}
			response.end(
				JSON.stringify({
					id: `msg_${requests.length}`,
					type: 'message',
					role: 'assistant',
					model: body.model,
					content: [{ type: 'text', text: JSON.stringify(output) }],
					stop_reason: 'end_turn',
					stop_sequence: null,
					usage: { input_tokens: 10, output_tokens: 10 },
				}),
			);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, requests, close: () => server.close() };
}

/** Saves the plugin settings as the dev admin (the auto-generated settings form's endpoint). */
export async function saveSettings(server: { url: string; cookie: string }, values: Record<string, unknown>): Promise<Response> {
	return fetch(`${server.url}/_emdash/api/admin/plugins/graft/settings`, {
		method: 'PUT',
		headers: { Cookie: server.cookie, 'Content-Type': 'application/json', 'X-EmDash-Request': '1', Origin: server.url },
		body: JSON.stringify({ values }),
	});
}
