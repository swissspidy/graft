import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '@graft/core';

export interface AnthropicModelOptions {
	model?: string;
	effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
	/** Injected for tests; a default client reads credentials from the environment. */
	client?: Pick<Anthropic, 'beta'>;
}

export const DEFAULT_MODEL = 'claude-opus-5-5';

/**
 * The compiler's model on the Claude API. Structured outputs keep every
 * response to the compiler's schema; the system prompt (surface and
 * vocabulary) is cached across attempts; refusals fall back server-side to
 * another model, and a final refusal or truncation is an error rather than
 * half an answer.
 */
export function anthropicModel({ model = DEFAULT_MODEL, effort = 'high', client }: AnthropicModelOptions = {}): ModelClient {
	const api = client ?? new Anthropic();
	return {
		async generate({ system, prompt, schema }) {
			const stream = api.beta.messages.stream({
				model,
				max_tokens: 64000,
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default',
				output_config: { effort, format: { type: 'json_schema', schema } },
				system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: prompt }],
			});
			const message = await stream.finalMessage();
			if (message.stop_reason === 'refusal') {
				throw new Error(`The model declined to compile this spec (${message.stop_details?.category ?? 'no category'}).`);
			}
			if (message.stop_reason === 'max_tokens') {
				throw new Error('The model ran out of output tokens before finishing the build.');
			}
			const text = message.content
				.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('');
			return { output: JSON.parse(text) as unknown, model: message.model };
		},
	};
}
