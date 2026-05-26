import { test, expect } from '@playwright/test';

test.describe('happy-path', () => {
  test('redirects to sign-in when unauthenticated', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveURL(/\/auth\/signin/);
    await expect(page.getByRole('button', { name: /continue with github/i })).toBeVisible();
  });

  test('/intent route renders the Claude Code explainer', async ({ page }) => {
    // Real auth bypass + MSW for GitHub API mocking is non-trivial and out of scope for v1's E2E.
    // First test (unauth redirect) gives us our smoke; second is a stub for future expansion.
    test.skip(process.env.TEST_AUTH_BYPASS !== '1', 'requires TEST_AUTH_BYPASS=1');
    await page.goto('/intent');
    await expect(page.getByRole('heading', { name: /brainstorm/i })).toBeVisible();
  });
});
