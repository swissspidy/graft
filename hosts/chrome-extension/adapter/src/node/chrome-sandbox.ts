import { compileSchema, FixtureError, SandboxCallError, verifyBuild, type Sandbox, type Surface, type Verification } from '@swissspidy/graft-core';
import { tabsPerform, type Tab, type Tabs } from '../browser/tabs.ts';
import { createCan } from '../host/can.ts';
import { CallError } from '../host/http.ts';
import { runInstalledTrigger, type TriggerState } from '../host/runner.ts';
import type { Installed } from '../host/gateway.ts';
import type { VerifyTarget } from './sandbox.ts';
import '../host/a2ui.ts';

/**
 * The verification sandbox of the browser surface: an in-memory browser
 * with the tabs a check's fixtures describe, never the person's own.
 * Capability calls run the same tab functions as the extension
 * (../browser/tabs.ts), and triggers run with the extension's runner and
 * gateway checks (../host/runner.ts), so a check proves the code the
 * extension runs, apart from Chrome itself (the end-to-end tests cover
 * that).
 */

const DAY = 24 * 60 * 60 * 1000;

/** The person: the only viewer there is. */
export const PERSON = 'you';

interface TabFixture {
	title?: unknown;
	url?: unknown;
	pinned?: unknown;
	active?: unknown;
	unused_days?: unknown;
}

/** An in-memory browser. */
export class FakeTabs implements Tabs {
	private tabs: Tab[] = [];
	private next = 1;

	reset(): void {
		this.tabs = [];
		this.next = 1;
	}

	seed(fixtures: TabFixture[], now: number): void {
		const titles = new Set<string>();
		for (const fixture of fixtures) {
			if (typeof fixture.title !== 'string' || fixture.title === '') {
				throw new FixtureError('Every tab needs a "title".');
			}
			if (titles.has(fixture.title)) {
				throw new FixtureError(`Two tabs are called "${fixture.title}"; titles must be unique.`);
			}
			titles.add(fixture.title);
			const days = fixture.unused_days ?? 0;
			if (typeof days !== 'number' || !Number.isFinite(days) || days < 0) {
				throw new FixtureError(`"unused_days" of "${fixture.title}" must be a number of days, 0 or more.`);
			}
			const url = fixture.url ?? `https://example.com/${encodeURIComponent(fixture.title.toLowerCase().replace(/\s+/g, '-'))}`;
			if (typeof url !== 'string') {
				throw new FixtureError(`"url" of "${fixture.title}" must be a string.`);
			}
			this.tabs.push({ id: this.next++, title: fixture.title, url, pinned: fixture.pinned === true, active: fixture.active === true, lastAccessed: now - days * DAY });
		}
	}

	all(): Tab[] {
		return [...this.tabs];
	}

	async query(): Promise<Tab[]> {
		return this.all();
	}

	async get(id: number): Promise<Tab | undefined> {
		return this.tabs.find((tab) => tab.id === id);
	}

	async remove(id: number): Promise<void> {
		this.tabs = this.tabs.filter((tab) => tab.id !== id);
	}

	async create(url: string): Promise<Tab> {
		const tab: Tab = { id: this.next++, title: url, url, pinned: false, active: false, lastAccessed: Date.now() };
		this.tabs.push(tab);
		return tab;
	}

	async focus(id: number): Promise<Tab> {
		// The tab brought to the front is the one used now; the others keep when they were last used.
		const now = Date.now();
		this.tabs = this.tabs.map((t) => (t.id === id ? { ...t, active: true, lastAccessed: now } : { ...t, active: false }));
		return { ...this.tabs.find((t) => t.id === id)! };
	}
}

export interface ChromeSandbox extends Sandbox {
	tabs: FakeTabs;
	close(): Promise<void>;
}

/** A sandbox on a fresh in-memory browser. */
export async function startChromeSandbox(): Promise<ChromeSandbox> {
	const tabs = new FakeTabs();
	let surface: Surface | undefined;
	// What each trigger acted on (`once`), until the next reset.
	let states: Record<string, TriggerState> = {};
	const current = () => {
		if (!surface) {
			throw new Error('The sandbox was not prepared with a surface.');
		}
		return surface;
	};
	return {
		tabs,
		async prepare(next) {
			surface = next;
		},
		async reset() {
			tabs.reset();
			states = {};
		},
		async seed(fixtures) {
			const { tabs: list = [], ...rest } = fixtures as { tabs?: unknown };
			const unknown = Object.keys(rest).filter((key) => key !== 'users');
			if (unknown.length > 0) {
				throw new FixtureError(`The browser has no fixtures called ${unknown.map((k) => `"${k}"`).join(', ')}: only "tabs".`);
			}
			if (!Array.isArray(list)) {
				throw new FixtureError('"tabs" must be a list.');
			}
			tabs.seed(list as TabFixture[], Date.now());
			return { users: { [PERSON]: [] } };
		},
		async scopes(_user, scopes) {
			// No roles: what the person approved is all there is.
			return Object.fromEntries(scopes.map((scope) => [scope, current().scopes[scope] !== undefined]));
		},
		async call(user, capability, input) {
			if (user !== PERSON) {
				throw new SandboxCallError('sandbox_no_user', `The browser has one person, "${PERSON}", not "${user}".`);
			}
			const declared = current().capabilities[capability];
			if (!declared) {
				throw new SandboxCallError('graft_unknown_capability', `The browser has no "${capability}".`);
			}
			if (!compileSchema(declared.input as object)(input ?? {})) {
				throw new SandboxCallError('graft_invalid_input', `Invalid input for "${capability}".`);
			}
			try {
				return await tabsPerform(tabs)(capability, declared, input ?? {});
			} catch (error) {
				throw error instanceof CallError ? new SandboxCallError(error.code, error.message) : error;
			}
		},
		async slotInstances(_user, slot) {
			return current().slots[slot] ? [{}] : [];
		},
		async assert(kind, expected) {
			if (kind !== 'tabs' || !Array.isArray(expected)) {
				return { ok: false, actual: `The browser has no assertion "${kind}" of that shape: use {"tabs": ["<title>", ...]}.` };
			}
			const open = tabs
				.all()
				.map((tab) => tab.title)
				.sort();
			const want = expected.map(String).sort();
			return { ok: JSON.stringify(open) === JSON.stringify(want), actual: open };
		},
		async fire(options) {
			const key = options.trigger;
			const installed = {
				id: options.build.spec.id,
				build: options.build,
				specHash: options.build.spec.hash,
				triggerGrants: { [options.trigger]: options.grant },
				manifest: { triggers: { [options.trigger]: { limit: options.limit } } },
			} as unknown as Installed;
			const { run, state } = await runInstalledTrigger({
				installed,
				surface: current(),
				trigger: options.trigger,
				perform: tabsPerform(tabs, () => options.now),
				state: states[key] ?? { specHash: options.build.spec.hash, failures: 0, handled: [] },
				now: options.now,
			});
			states[key] = state;
			return run;
		},
		close: async () => {},
	};
}

/** Verifies builds for the browser surface in one in-memory browser. */
export async function verifyInChrome(targets: VerifyTarget[], options: { sandbox?: ChromeSandbox; grant?: string[] } = {}): Promise<Verification[]> {
	const sandbox = options.sandbox ?? (await startChromeSandbox());
	const results: Verification[] = [];
	for (const target of targets) {
		results.push(await verifyBuild({ ...target, sandbox, createCan, ...(options.grant ? { grant: options.grant } : {}) }));
	}
	return results;
}
