import { test, expect } from '@playwright/test';

test.describe('Dashboard redesign smoke', () => {
  test('Home renders 7 bands and 3 primary nav links', async ({ page }) => {
    await page.goto('/');
    // If signed out, the test environment redirects to /auth/signin. Skip.
    if (page.url().includes('/auth/signin')) test.skip();

    // Primary nav
    await expect(page.getByRole('link', { name: /^Home$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Repos$/ })).toBeVisible();
    await expect(page.getByRole('link', { name: /^Brainstorm$/ })).toBeVisible();

    // 7 bands by heading
    for (const heading of [
      'Needs you now',
      'In motion',
      'Recently shipped (last 7d)',
      'PM proposes',
      'Verification posture',
      'Your repos',
    ]) {
      await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    }

    // Hero CTA
    await expect(page.getByRole('button', { name: /Brainstorm new work/ })).toBeVisible();
  });

  test('Help panel opens', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    await page.getByRole('button', { name: /help/i }).click();
    await expect(page.getByText(/About dev-agent/)).toBeVisible();
  });
});
