import { expect, test } from '@playwright/test';

test('anonymous users are redirected to the tenant login', async ({ page }) => {
  await page.goto('/customers');

  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'KirinDesk 登录' })).toBeVisible();
  await expect(page.getByLabel('租户标识 (tenant slug)')).toBeVisible();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page.getByLabel('密码')).toBeVisible();
});

test('tenant and platform login surfaces remain separated', async ({ page }) => {
  await page.goto('/platform/tenants');

  await expect(page).toHaveURL(/\/platform\/login$/);
  await expect(page.getByRole('heading', { name: '平台控制台登录' })).toBeVisible();
  await expect(page.getByLabel('邮箱')).toBeVisible();
  await expect(page.getByLabel('密码')).toBeVisible();
});
