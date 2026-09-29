// Probe: can headless Chromium start WordPress Playground in an iframe and run
// PHP in it? Prerequisite for verifying builds inside the admin's browser.
import { chromium } from '@playwright/test';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console error:', m.text().slice(0, 300)));
await page.setContent('<!doctype html><html><body><iframe id="pg"></iframe></body></html>');
const started = Date.now();
const result = await page
	.evaluate(async () => {
		const { startPlaygroundWeb } = await import('https://playground.wordpress.net/client/index.js');
		const client = await startPlaygroundWeb({
			iframe: document.getElementById('pg'),
			remoteUrl: 'https://playground.wordpress.net/remote.html',
			blueprint: { preferredVersions: { wp: '7.1', php: '8.3' }, steps: [] },
		});
		await client.isReady();
		const run = await client.run({ code: '<?php require "/wordpress/wp-load.php"; echo $GLOBALS["wp_version"], " ", PHP_VERSION;' });
		await client.writeFile('/wordpress/probe.txt', 'hello');
		const read = await client.readFileAsText('/wordpress/probe.txt');
		const response = await client.request({ url: '/wp-json/', method: 'GET' });
		return `${run.text} | writeFile ${read} | request ${response.httpStatusCode}`;
	})
	.catch((e) => `ERROR ${e.message}`);
console.log(`PROBE RESULT: ${result} (${Math.round((Date.now() - started) / 1000)}s)`);
await browser.close();
process.exitCode = result.startsWith('ERROR') ? 1 : 0;
