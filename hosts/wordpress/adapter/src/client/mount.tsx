import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import apiFetch from '@wordpress/api-fetch';
import { Notice as WPNotice } from '@wordpress/components';
import { GraftRoot, type Gateway, type Notice } from '@graft/renderer-react';
import type { AsyncFunctionRunner, Build, SurfaceFunctions } from '@graft/core/runtime';
import { startFunctions } from '@graft/sandbox/client';
import { createCan } from '../can.ts';
import { components } from './components.tsx';

export { createCan };

/** Printed by the plugin (includes/runtime.php) for the specs on this screen. */
export interface RuntimeConfig {
	specs: Record<
		string,
		{
			build: Build;
			/** Granted scopes the current user may use (grant ∩ host capabilities). */
			scopes: Record<string, boolean>;
		}
	>;
	/** Present when a build on this screen has code: where the functions worker is, and its limits. */
	functions?: { worker: string; wasm: string; limits: SurfaceFunctions['limits']; widgets?: SurfaceFunctions['widgets'] };
}

declare global {
	interface Window {
		graftRuntime?: RuntimeConfig;
	}
}

export function createGateway(spec: string): Gateway {
	return {
		call: (capability, input) =>
			apiFetch({ path: '/graft/v1/call', method: 'POST', data: { spec, capability, input } }),
	};
}

function Mounted({ spec, config, slot }: { spec: string; config: RuntimeConfig['specs'][string]; slot: Record<string, unknown> }) {
	const [notices, setNotices] = useState<Array<Notice & { key: number }>>([]);
	const onNotice = useCallback((notice: Notice) => setNotices((current) => [...current, { ...notice, key: Date.now() + Math.random() }]), []);
	const [gateway] = useState(() => createGateway(spec));
	const [can] = useState(() => createCan(config.scopes));
	const inline = config.build.mount.slot === 'posts.list.row-actions';
	// Started on the first $fn only: screens without code never load the worker or QuickJS.
	const [functions] = useState(() => {
		const code = config.build.code;
		const host = window.graftRuntime?.functions;
		if (!code || !host) {
			return undefined;
		}
		return (): AsyncFunctionRunner =>
			startFunctions({
				workerUrl: host.worker,
				wasmLocation: host.wasm,
				code,
				limits: host.limits,
				onProblem: (message) => console.warn(`Graft: ${spec}: ${message}`),
			});
	});
	return (
		<>
			{notices.map((notice) =>
				inline ? (
					<span key={notice.key} role="status" className={notice.status === 'error' ? 'graft-error' : undefined}>
						{' '}
						{notice.message}
					</span>
				) : (
					<WPNotice key={notice.key} status={notice.status} onRemove={() => setNotices((current) => current.filter((n) => n.key !== notice.key))}>
						{notice.message}
					</WPNotice>
				),
			)}
			<GraftRoot
				build={config.build}
				components={components}
				gateway={gateway}
				slot={slot}
				can={can}
				onNotice={onNotice}
				onReload={() => window.location.reload()}
				functions={functions}
				{...(window.graftRuntime?.functions?.widgets ? { widgets: window.graftRuntime.functions.widgets } : {})}
			/>
		</>
	);
}

/** Renders every `[data-graft-mount]` element the plugin printed. */
export function mountAll(root: ParentNode = document): void {
	const config = window.graftRuntime;
	if (!config) {
		return;
	}
	root.querySelectorAll<HTMLElement>('[data-graft-mount]:not([data-graft-mounted])').forEach((element) => {
		const spec = element.dataset.graftSpec ?? '';
		const specConfig = config.specs[spec];
		if (!specConfig) {
			return;
		}
		let slot: Record<string, unknown> = {};
		try {
			slot = JSON.parse(element.dataset.graftSlot ?? '{}') as Record<string, unknown>;
		} catch {
			return;
		}
		element.dataset.graftMounted = '';
		createRoot(element).render(<Mounted spec={spec} config={specConfig} slot={slot} />);
	});
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => mountAll());
} else {
	mountAll();
}
