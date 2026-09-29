import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import apiFetch from '@wordpress/api-fetch';
import { Notice as WPNotice } from '@wordpress/components';
import { GraftRoot, type Gateway, type Notice } from '@graft/renderer-react';
import type { Build } from '@graft/core/runtime';
import { components } from './components.tsx';

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
}

declare global {
	interface Window {
		graftRuntime?: RuntimeConfig;
	}
}

/**
 * Per-object refinement of a scope check: WordPress post objects from the
 * Graft abilities carry `can` flags for the current user.
 */
const objectChecks: Record<string, string> = {
	'posts.status:write': 'publish',
	'posts:write': 'edit',
};

export function createCan(scopes: Record<string, boolean>) {
	return (scope: string, on: unknown): boolean => {
		if (scopes[scope] !== true) {
			return false;
		}
		const key = objectChecks[scope];
		if (key && typeof on === 'object' && on !== null) {
			const can = (on as { can?: Record<string, unknown> }).can;
			if (can && key in can) {
				return can[key] === true;
			}
		}
		return true;
	};
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
