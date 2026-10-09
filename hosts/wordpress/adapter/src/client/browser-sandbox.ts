import apiFetch from '@wordpress/api-fetch';
import sandboxIndex from '../../../playground/sandbox/index.php';
import sandboxCanary from '../../../playground/sandbox/canary.php';
import sandboxModel from '../../../playground/sandbox/model.php';
import { protocolSandbox, type ProtocolSandbox } from '../sandbox-protocol.ts';
import type * as PlaygroundClient from './playground-client.ts';

/**
 * A verification sandbox in the admin's browser: a private, throwaway
 * WordPress in WordPress Playground (hidden iframe) with this site's Graft
 * plugin and the sandbox endpoint installed. Nothing from the site's
 * database goes along; checks seed their own fixtures.
 *
 * Playground's client ships with the plugin (build/playground-client.js,
 * the version the CLI uses) and loads only when a sandbox starts; the
 * iframe loads remote.html from the Playground URL the site configures
 * (graft_playground_url), which serves the WordPress and PHP builds.
 */

export interface PlaygroundOptions {
	/** build/playground-client.js on this site. */
	client: string;
	/** The Playground that serves remote.html. */
	url: string;
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) {
		bytes[i] = binary.charCodeAt(i);
	}
	return bytes;
}

let starting: Promise<ProtocolSandbox> | undefined;

/** Starts (once per page) and returns the browser sandbox. */
export function browserSandbox(wp: string, playground: PlaygroundOptions): Promise<ProtocolSandbox> {
	starting ??= start(wp, playground).catch((error: unknown) => {
		starting = undefined;
		throw error;
	});
	return starting;
}

async function start(wp: string, playground: PlaygroundOptions): Promise<ProtocolSandbox> {
	const token = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, '0')).join('');
	const { zip } = await apiFetch<{ zip: string }>({ path: '/graft/v1/sandbox-package' });

	const iframe = document.createElement('iframe');
	iframe.title = 'Graft verification sandbox';
	iframe.style.cssText = 'position:absolute;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
	iframe.setAttribute('aria-hidden', 'true');
	document.body.append(iframe);

	const { startPlaygroundWeb } = (await import(/* @vite-ignore */ playground.client)) as typeof PlaygroundClient;
	const client = await startPlaygroundWeb({
		iframe,
		remoteUrl: `${playground.url.replace(/\/+$/, '')}/remote.html`,
		blueprint: {
			preferredVersions: { wp, php: '8.3' },
			steps: [
				{ step: 'defineWpConfigConsts', consts: { GRAFT_SANDBOX_TOKEN: token } },
				{ step: 'installPlugin', pluginData: { resource: 'literal', name: 'graft.zip', contents: base64ToBytes(zip) } },
				{ step: 'mkdir', path: '/wordpress/graft-sandbox' },
				{ step: 'writeFile', path: '/wordpress/graft-sandbox/index.php', data: sandboxIndex },
				{ step: 'writeFile', path: '/wordpress/graft-sandbox/canary.php', data: sandboxCanary },
				{ step: 'writeFile', path: '/wordpress/graft-sandbox/model.php', data: sandboxModel },
				{ step: 'writeFile', path: '/wordpress/wp-content/mu-plugins/graft-canary.php', data: "<?php require '/wordpress/graft-sandbox/canary.php'; require '/wordpress/graft-sandbox/model.php';" },
			],
		},
	});
	await client.isReady();

	return protocolSandbox(async (body) => {
		const response = await client.request({
			url: '/graft-sandbox/',
			method: 'POST',
			headers: { 'Content-Type': 'application/json', 'X-Graft-Sandbox': token },
			body: JSON.stringify(body),
		});
		if (response.httpStatusCode !== 200) {
			throw new Error(`Sandbox ${String(body.op)} failed (${response.httpStatusCode}): ${response.text.slice(0, 300)}`);
		}
		return JSON.parse(response.text) as unknown;
	});
}
