import { expect, type Page } from '@playwright/test';

interface EditorStores {
	wp?: {
		data?: {
			dispatch(store: 'core/block-editor'): { clearSelectedBlock(): void };
			dispatch(store: 'core/interface'): { enableComplementaryArea(scope: string, area: string): void };
		};
	};
}

/**
 * Opens the Publish checklist panel in the block editor and returns it.
 *
 * The panel sits in the sidebar's Post tab, which the editor swaps for the
 * Block tab whenever a block gets selected (closing the welcome guide can
 * do that while the editor loads), unmounting the panel. So show the post's
 * settings, expand the panel, and retry until it stays open.
 */
export async function openPublishChecklist(page: Page) {
	const toggle = page.getByRole('button', { name: 'Publish checklist' });
	const panel = page.locator('.graft-editor-panel');
	await expect(async () => {
		await page.evaluate(() => {
			const data = (window as EditorStores).wp?.data;
			data?.dispatch('core/block-editor').clearSelectedBlock();
			data?.dispatch('core/interface').enableComplementaryArea('core', 'edit-post/document');
		});
		if ((await toggle.getAttribute('aria-expanded', { timeout: 5_000 })) === 'false') {
			await toggle.click({ timeout: 5_000 });
		}
		await expect(panel).toBeVisible({ timeout: 5_000 });
	}).toPass({ timeout: 90_000 });
	return panel;
}
