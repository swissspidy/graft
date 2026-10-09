import { compileSpec, hashSpec, validateSpec, type Diagnostic, type ModelClient, type ModelResponse, type Surface } from '@swissspidy/graft-core';
import { hostGuide } from '../host/guide.ts';
import type { KV, Store } from './store.ts';

/**
 * Compiling a spec written in the EmDash admin. A compile makes several
 * model calls and each may take a while, longer in total than a host
 * allows one request (a sandboxed plugin gets 30 seconds). So a compile is
 * a job in KV that advances one model call per step: each step replays the
 * answers recorded so far through the unchanged compiler, makes the next
 * call, records it and stops at the one after. Replaying is deterministic:
 * prompts depend only on the spec, the surface and earlier answers.
 *
 * A finished build is stored as a draft of the spec. It is not verified
 * here: the site cannot run checks on itself without touching its own
 * content, so `graft site verify` verifies it in a throwaway EmDash and
 * the version then waits for approval.
 */

export interface Job {
	id: string;
	title: string;
	source: string;
	specHash: string;
	/** Recorded model answers, in call order. */
	answers: ModelResponse[];
	state: 'running' | 'built' | 'failed' | 'rephrase';
	/** What the author should know: problems, unverifiable criteria, errors. */
	messages: string[];
	/** The stored draft version, once built. */
	version?: number;
	updatedAt: string;
}

const key = (id: string) => `job:${id}`;
const MAX_CALLS = 8;

class Pause extends Error {}

export class AuthoringError extends Error {
	constructor(
		message: string,
		readonly diagnostics: Diagnostic[] = [],
	) {
		super(message);
	}
}

export function createJobs(kv: KV) {
	return {
		read: (id: string) => kv.get<Job>(key(id)),
		async list(): Promise<Job[]> {
			return (await kv.list('job:')).map((e) => e.value as Job).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		},
		save: (job: Job) => kv.set(key(job.id), job),
		async remove(id: string) {
			await kv.delete(key(id));
		},
	};
}

export type Jobs = ReturnType<typeof createJobs>;

/** Validates a spec written in the admin and starts a job for it. */
export async function startJob(jobs: Jobs, source: string, surface: Surface): Promise<Job> {
	const validation = validateSpec(source, { surface });
	if (!validation.ok || !validation.spec) {
		throw new AuthoringError('The spec has problems.', validation.diagnostics.filter((d) => d.severity === 'error'));
	}
	const spec = validation.spec;
	const existing = await jobs.read(spec.manifest.id);
	if (existing?.state === 'running') {
		throw new AuthoringError(`"${spec.manifest.id}" is already being built.`);
	}
	const job: Job = {
		id: spec.manifest.id,
		title: spec.title,
		source,
		specHash: await hashSpec(source),
		answers: [],
		state: 'running',
		messages: [],
		updatedAt: new Date().toISOString(),
	};
	await jobs.save(job);
	return job;
}

/** Advances a running job by one model call. */
export async function stepJob(job: Job, deps: { jobs: Jobs; store: Store; surface: Surface; model: () => ModelClient }): Promise<Job> {
	if (job.state !== 'running') {
		return job;
	}
	const spec = validateSpec(job.source, { surface: deps.surface }).spec;
	if (!spec) {
		return finish(deps.jobs, job, 'failed', ['The spec is no longer valid for this site.']);
	}
	if (job.answers.length >= MAX_CALLS) {
		return finish(deps.jobs, job, 'failed', [`Gave up after ${MAX_CALLS} model calls.`]);
	}
	const replay = [...job.answers];
	let called = false;
	const model: ModelClient = {
		async generate(request) {
			const recorded = replay.shift();
			if (recorded) {
				return recorded;
			}
			if (called) {
				throw new Pause();
			}
			called = true;
			const answer = await deps.model().generate(request);
			job.answers.push(answer);
			return answer;
		},
	};
	const problems: string[] = [];
	try {
		const result = await compileSpec({
			spec,
			specHash: job.specHash,
			surface: deps.surface,
			model,
			host: hostGuide,
			onEvent: (event) => {
				if (event.type === 'rejected') {
					problems.splice(0, problems.length, ...event.problems);
				}
			},
		});
		if (result.unverifiable?.length) {
			return finish(
				deps.jobs,
				job,
				'rephrase',
				result.unverifiable.map((u) => `"${u.criterion}" cannot be checked objectively: ${u.reason}`),
			);
		}
		if (!result.ok || !result.build) {
			return finish(deps.jobs, job, 'failed', problems.length > 0 ? problems : ['The compiler gave up.']);
		}
		const { version } = await deps.store.put({ source: job.source, build: result.build });
		job.version = version.n;
		return finish(deps.jobs, job, 'built', ['Built. Verify it with graft site verify, then approve it here.']);
	} catch (error) {
		if (error instanceof Pause) {
			job.messages = problems.length > 0 ? [`Retrying after: ${problems.join(' ')}`] : [];
			job.updatedAt = new Date().toISOString();
			await deps.jobs.save(job);
			return job;
		}
		// A failed call is not recorded: continuing retries it.
		job.messages = [error instanceof Error ? error.message : String(error)];
		job.updatedAt = new Date().toISOString();
		await deps.jobs.save(job);
		return job;
	}
}

async function finish(jobs: Jobs, job: Job, state: Job['state'], messages: string[]): Promise<Job> {
	job.state = state;
	job.messages = messages;
	job.updatedAt = new Date().toISOString();
	await jobs.save(job);
	return job;
}
