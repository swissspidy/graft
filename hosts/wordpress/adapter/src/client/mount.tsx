import { createElement, useCallback, useState, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import apiFetch from '@wordpress/api-fetch';
import { Notice as WPNotice } from '@wordpress/components';
import { GraftRoot, type Gateway, type Notice, type UiRootProps } from '@graft/renderer-react';
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
	/**
	 * In the block editor: the panels to add to the sidebar, the slot (the
	 * post being edited), and the capabilities that only read.
	 */
	editor?: { panels: Array<{ spec: string; title: string }>; slot: Record<string, unknown>; reads?: string[] };
}

/** The block editor's globals, present on its screen only (the runtime does not bundle them). */
interface EditorGlobals {
	plugins?: { registerPlugin(name: string, settings: { render: () => ReactNode }): void };
	editor?: { PluginDocumentSettingPanel?: ComponentType<{ name: string; title: string; children?: ReactNode }> };
	data?: { select(store: string): { isEditedPostDirty?(): boolean } };
}

declare global {
	interface Window {
		graftRuntime?: RuntimeConfig;
		/** Renderers for builds in other UI formats (build/a2ui.js adds A2UI). */
		graftUi?: { A2UI?: ComponentType<UiRootProps> };
		wp?: EditorGlobals;
	}
}

export function createGateway(spec: string, guard?: (capability: string) => string | undefined): Gateway {
	return {
		call: (capability, input) => {
			const refused = guard?.(capability);
			return refused ? Promise.reject(new Error(refused)) : apiFetch({ path: '/graft/v1/call', method: 'POST', data: { spec, capability, input } });
		},
	};
}

/**
 * In the editor, the post may have unsaved changes: a call that changes the
 * post would be overwritten by the next save, and the reload after it would
 * lose them. So calls wait until the editor has nothing to save, except
 * those the surface lists as reads (data sources keep loading).
 */
const editorGuard = (capability: string): string | undefined =>
	!window.graftRuntime?.editor?.reads?.includes(capability) && window.wp?.data?.select('core/editor').isEditedPostDirty?.()
		? 'Save or discard your changes to the post first.'
		: undefined;

function Mounted({ spec, config, slot, inEditor = false }: { spec: string; config: RuntimeConfig['specs'][string]; slot: Record<string, unknown>; inEditor?: boolean }) {
	const [notices, setNotices] = useState<Array<Notice & { key: number }>>([]);
	const onNotice = useCallback((notice: Notice) => setNotices((current) => [...current, { ...notice, key: Date.now() + Math.random() }]), []);
	const [gateway] = useState(() => createGateway(spec, inEditor ? editorGuard : undefined));
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
				// A build in another format is drawn by its renderer, loaded only on screens that serve one.
				{...(window.graftUi?.A2UI ? { ui: window.graftUi.A2UI as never } : {})}
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

/**
 * Adds the post.editor.panel customizations to the block editor sidebar, as
 * document settings panels, each rendering its build for the edited post.
 */
export function registerEditorPanels(): void {
	const config = window.graftRuntime;
	const Panel = window.wp?.editor?.PluginDocumentSettingPanel;
	if (!config?.editor || !Panel || !window.wp?.plugins) {
		return;
	}
	const { panels, slot } = config.editor;
	window.wp.plugins.registerPlugin('graft-editor-panels', {
		render: () =>
			panels
				.filter(({ spec }) => config.specs[spec])
				.map(({ spec, title }) =>
					createElement(
						Panel,
						{ key: spec, name: `graft-${spec}`, title },
						createElement('div', { 'data-graft-spec': spec, className: 'graft-editor-panel' }, createElement(Mounted, { spec, config: config.specs[spec]!, slot, inEditor: true })),
					),
				),
	});
}

registerEditorPanels();

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', () => mountAll());
} else {
	mountAll();
}
