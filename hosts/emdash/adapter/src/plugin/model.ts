import Anthropic from '@anthropic-ai/sdk';
import type { ModelClient } from '@graft/core';
import type { PluginContext } from 'emdash';
import { DEFAULT_MODEL_ENDPOINT } from './manifest.ts';

/**
 * The compiler's model for specs written in the EmDash admin: the Claude
 * API through the plugin's own HTTP access (ctx.http, limited to the
 * plugin's allowed hosts), with the key and model from the plugin
 * settings. Requests are not streamed: EmDash buffers plugin HTTP
 * responses.
 */

export interface ModelSettings {
	apiKey: string;
	model: string;
	effort: 'low' | 'medium' | 'high';
	endpoint: string;
}

export class ModelSetupError extends Error {}

export async function modelSettings(ctx: PluginContext): Promise<ModelSettings> {
	const apiKey = await ctx.settings.get<string>('anthropicApiKey');
	if (!apiKey) {
		throw new ModelSetupError('Set an Anthropic API key in the Graft plugin settings to build customizations here.');
	}
	const effort = await ctx.settings.get<string>('effort');
	return {
		apiKey,
		model: (await ctx.settings.get<string>('model')) || 'claude-opus-5-5',
		effort: effort === 'low' || effort === 'high' ? effort : 'medium',
		endpoint: (await ctx.settings.get<string>('modelEndpoint')) || DEFAULT_MODEL_ENDPOINT,
	};
}

export function pluginModel(ctx: PluginContext, settings: ModelSettings): ModelClient {
	const http = ctx.http;
	if (!http) {
		throw new ModelSetupError('The Graft plugin has no network access (network:request).');
	}
	const client = new Anthropic({
		apiKey: settings.apiKey,
		baseURL: settings.endpoint,
		// Retries would multiply a step's time against the host's request limit.
		maxRetries: 0,
		fetch: (url, init) => http.fetch(String(url), init),
	});
	return {
		async generate({ system, prompt, schema }) {
			const message = await client.beta.messages.create({
				model: settings.model,
				max_tokens: 16000,
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default',
				output_config: { effort: settings.effort, format: { type: 'json_schema', schema } },
				system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
				messages: [{ role: 'user', content: prompt }],
			});
			if (message.stop_reason === 'refusal') {
				throw new Error(`The model declined to compile this spec (${message.stop_details?.category ?? 'no category'}).`);
			}
			if (message.stop_reason === 'max_tokens') {
				throw new Error('The model ran out of output tokens before finishing.');
			}
			const text = message.content
				.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
				.map((block) => block.text)
				.join('');
			return { output: JSON.parse(text) as unknown, model: message.model };
		},
	};
}
