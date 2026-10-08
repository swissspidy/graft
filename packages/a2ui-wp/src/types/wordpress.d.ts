/**
 * Shims for the WordPress packages that do not ship type declarations.
 */

declare module '@wordpress/scripts/config/playwright.config' {
	const config: import( '@playwright/test' ).PlaywrightTestConfig;
	export default config;
}
