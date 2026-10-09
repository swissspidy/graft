import { describe, expect, it, vi } from 'vitest';
import { anthropicModel } from '../src/anthropic.ts';

function fakeClient(message: Record<string, unknown>) {
	const stream = vi.fn(() => ({ finalMessage: async () => message }));
	return { client: { beta: { messages: { stream } } } as never, stream };
}

const request = { purpose: 'ui' as const, system: 'SYSTEM', prompt: 'PROMPT', schema: { type: 'object' } };

describe('anthropicModel', () => {
	it('asks for structured output with a cached system prompt and fallbacks', async () => {
		const { client, stream } = fakeClient({
			model: 'claude-opus-5-5',
			stop_reason: 'end_turn',
			content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: '{"nodes":' }, { type: 'text', text: '[],"data":[]}' }],
		});
		const response = await anthropicModel({ client }).generate(request);
		expect(response).toEqual({ output: { nodes: [], data: [] }, model: 'claude-opus-5-5' });
		expect(stream).toHaveBeenCalledWith({
			model: 'claude-opus-5-5',
			max_tokens: 64000,
			betas: ['server-side-fallback-2026-07-01'],
			fallbacks: 'default',
			output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } },
			system: [{ type: 'text', text: 'SYSTEM', cache_control: { type: 'ephemeral' } }],
			messages: [{ role: 'user', content: 'PROMPT' }],
		});
	});

	it('turns refusals and truncation into errors', async () => {
		await expect(
			anthropicModel(fakeClient({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] })).generate(request),
		).rejects.toThrow('declined to compile this spec (cyber)');
		await expect(anthropicModel(fakeClient({ stop_reason: 'max_tokens', content: [] })).generate(request)).rejects.toThrow('ran out of output tokens');
	});
});
