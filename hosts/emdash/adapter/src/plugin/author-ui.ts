import type { ModelClient, Surface } from '@graft/core';
import type { Block } from '../host/blocks.ts';
import { AuthoringError, startJob, stepJob, type Job, type Jobs } from './author.ts';
import type { Store } from './store.ts';

/**
 * The authoring part of the Manage tab: a spec editor, and the compile jobs
 * with their state. Administrators only (the caller checks).
 */

export interface Authoring {
	jobs: Jobs;
	/** Why the admin cannot build yet (no API key...), or undefined. */
	setupProblem(): Promise<string | undefined>;
	model(): Promise<ModelClient>;
}

export const TEMPLATE = `---
graft: 1
id: my-customization
host: emdash
mount:
  slot: admin.page
  title: My customization
audience: [editor, admin]
permissions:
  - content:read
---

# What it is for

One or two sentences on who uses it and why.

## Acceptance criteria

- Something a person can check, e.g. "Only draft posts are listed" {#first}
`;

type Toast = { message: string; type: 'success' | 'error' | 'info' };

export interface AuthoringResult {
	toast?: Toast;
	/** Source to keep in the editor (after a validation error). */
	draft?: string;
	/** Problems to show next to the editor. */
	problems?: string[];
}

/** Handles an authoring interaction; returns undefined when it is not one. */
export async function authoringAction(
	authoring: Authoring,
	deps: { store: Store; surface: Surface },
	interaction: { type: string; action_id?: string; value?: unknown; values?: Record<string, unknown> },
): Promise<AuthoringResult | undefined> {
	const step = async (job: Job) => stepJob(job, { jobs: authoring.jobs, store: deps.store, surface: deps.surface, model: () => cached! });
	let cached: ModelClient | undefined;
	const withModel = async (run: () => Promise<Job>): Promise<AuthoringResult> => {
		const problem = await authoring.setupProblem();
		if (problem) {
			return { toast: { message: problem, type: 'error' } };
		}
		cached = await authoring.model();
		const job = await run();
		return { toast: jobToast(job) };
	};

	if (interaction.type === 'form_submit' && interaction.action_id === 'graft:author') {
		const source = typeof interaction.values?.source === 'string' ? interaction.values.source : '';
		try {
			const problem = await authoring.setupProblem();
			if (problem) {
				return { toast: { message: problem, type: 'error' }, draft: source };
			}
			const job = await startJob(authoring.jobs, source, deps.surface);
			return await withModel(() => step(job));
		} catch (error) {
			if (error instanceof AuthoringError) {
				return {
					toast: { message: error.message, type: 'error' },
					draft: source,
					problems: error.diagnostics.map((d) => `${d.line ? `Line ${d.line}: ` : ''}${d.message}`),
				};
			}
			throw error;
		}
	}
	if (interaction.type === 'block_action' && interaction.action_id === 'graft:job-continue') {
		const job = await authoring.jobs.read(String(interaction.value));
		if (!job) {
			return { toast: { message: 'That build no longer exists.', type: 'error' } };
		}
		return withModel(() => step(job));
	}
	if (interaction.type === 'block_action' && interaction.action_id === 'graft:job-dismiss') {
		await authoring.jobs.remove(String(interaction.value));
		return { toast: { message: 'Dismissed.', type: 'info' } };
	}
	return undefined;
}

function jobToast(job: Job): Toast {
	switch (job.state) {
		case 'built':
			return { message: `"${job.title}" is built. Verify it, then approve it.`, type: 'success' };
		case 'running':
			return job.messages.length > 0 && !job.messages[0]!.startsWith('Retrying')
				? { message: job.messages[0]!, type: 'error' }
				: { message: `Step ${job.answers.length} done. Continue to take the next step.`, type: 'info' };
		case 'rephrase':
			return { message: 'Some criteria cannot be checked. Rephrase them.', type: 'error' };
		default:
			return { message: `Building "${job.title}" failed.`, type: 'error' };
	}
}

const stateLabels: Record<Job['state'], string> = {
	running: 'Building',
	built: 'Built (not verified)',
	failed: 'Failed',
	rephrase: 'Needs rephrasing',
};

/** The editor and the jobs, for the Manage tab. */
export async function authoringBlocks(authoring: Authoring, result: AuthoringResult | undefined): Promise<Block[]> {
	const blocks: Block[] = [{ type: 'header', text: 'New customization' }];
	const problem = await authoring.setupProblem();
	if (problem) {
		blocks.push({ type: 'banner', variant: 'alert', description: problem });
		blocks.push({ type: 'actions', elements: [{ type: 'link', label: 'Plugin settings', target: { kind: 'plugin-settings' }, appearance: 'secondary' }] });
	}
	blocks.push({
		type: 'context',
		text: 'Describe the customization and how to check it. Graft writes checks for each criterion, then builds it against them, one model call per step.',
	});
	if (result?.problems?.length) {
		blocks.push({ type: 'banner', variant: 'error', title: 'The spec has problems', description: result.problems.join(' ') });
	}
	blocks.push({
		type: 'form',
		block_id: 'graft-author',
		fields: [{ type: 'text_input', action_id: 'source', label: 'Spec', multiline: true, initial_value: result?.draft ?? TEMPLATE }],
		submit: { label: 'Build it', action_id: 'graft:author' },
	});
	for (const job of await authoring.jobs.list()) {
		blocks.push({ type: 'divider' });
		blocks.push({
			type: 'fields',
			fields: [
				{ label: 'Building', value: `${job.title} (${job.id})` },
				{ label: 'State', value: `${stateLabels[job.state]}${job.state === 'running' ? `, ${job.answers.length} model call(s) so far` : ''}` },
			],
		});
		if (job.messages.length > 0) {
			blocks.push({ type: 'context', text: job.messages.join(' ') });
		}
		const elements: Block[] = [];
		if (job.state === 'running') {
			elements.push({ type: 'button', action_id: 'graft:job-continue', value: job.id, label: 'Continue building', style: 'primary' });
		}
		elements.push({ type: 'button', action_id: 'graft:job-dismiss', value: job.id, label: job.state === 'running' ? 'Cancel' : 'Dismiss' });
		blocks.push({ type: 'actions', elements });
	}
	return blocks;
}
