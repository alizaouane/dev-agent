import { test, expect } from '@playwright/test';

test.describe('UX — brand + help + nav', () => {
  test('nav shows WORK and INSIGHTS section labels', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    await expect(page.getByText(/^WORK$/)).toBeVisible();
    await expect(page.getByText(/^INSIGHTS$/)).toBeVisible();
  });

  test('Home link has aria-current=page when on /', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    const home = page.getByRole('link', { name: /^Home$/ });
    await expect(home).toHaveAttribute('aria-current', 'page');
  });

  test('no breadcrumb on top-level routes', async ({ page }) => {
    await page.goto('/repos');
    if (page.url().includes('/auth/signin')) test.skip();
    await expect(page.getByRole('navigation', { name: /breadcrumb/i })).toHaveCount(0);
  });

  test('Home shows "Needs you now" with a (?) bubble', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    // The (?) bubble is a button labeled "What is Needs you now?"
    await expect(
      page.getByRole('button', { name: /what is needs you now/i }),
    ).toBeVisible();
  });

  test('clicking the (?) bubble opens the popover with the long body', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    await page.getByRole('button', { name: /what is needs you now/i }).click();
    await expect(page.getByText(/waiting on you to act/i)).toBeVisible();
  });

  test('HelpPanel drawer shows Glossary section', async ({ page }) => {
    await page.goto('/');
    if (page.url().includes('/auth/signin')) test.skip();
    await page.getByRole('button', { name: /^help$/i }).click();
    await expect(page.getByRole('heading', { name: /glossary/i })).toBeVisible();
    await expect(page.getByText('EvidenceBundle')).toBeVisible();
  });
});
