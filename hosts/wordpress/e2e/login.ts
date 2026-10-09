import { expect, type Page } from '@playwright/test';

/**
 * Logs in on wp-login.php as `user` (password "password"). WordPress's
 * login scripts can reset the password field just after it is filled
 * (user-profile.js, once zxcvbn loads); the browser then refuses to submit
 * the empty required field and nothing navigates. So it fills and submits
 * again until the admin is reached.
 */
export async function login(page: Page, user: string): Promise<void> {
	await page.goto('/wp-login.php');
	await expect(async () => {
		if (/\/wp-admin\//.test(page.url())) {
			return;
		}
		await page.fill('#user_login', user, { timeout: 5_000 });
		await page.fill('#user_pass', 'password', { timeout: 5_000 });
		await page.click('#wp-submit', { timeout: 5_000 });
		// The admin page's DOM is enough: its images and feeds may be slow to finish loading.
		await page.waitForURL(/wp-admin/, { waitUntil: 'domcontentloaded', timeout: 20_000 });
	}).toPass({ timeout: 90_000 });
}
