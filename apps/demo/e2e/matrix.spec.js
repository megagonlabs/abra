// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Consequence matrix — the same round-trip contract across the view×action space. Each is a
 * controller/gesture firing a consequence → pending → the stub owner resolves → content changes.
 * Adding a new case is data (a published action + a control/gesture + an assertion), not new
 * infrastructure: the stub owner already resolves the whole add / edit / delete family.
 */
test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
});

test('table +Row round-trips (add_row → owner appends a row)', async ({ page }) => {
  await expect(page.getByText('New person')).toHaveCount(0);
  await page.getByRole('button', { name: '+ Row' }).click();
  await expect(page.getByText('New person')).toBeVisible();
});

test('table +Column round-trips (add_column → owner appends a column)', async ({ page }) => {
  await expect(page.getByText('New col')).toHaveCount(0);
  await page.getByRole('button', { name: '+ Column' }).click();
  await expect(page.getByText('New col')).toBeVisible();
});

test('graph delete round-trips (select node → Delete → owner removes it)', async ({ page }) => {
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(2);
  await page.locator('.react-flow__node[data-id="n1"]').click(); // select (delete is status=selected)
  await page.keyboard.press('Delete');
  await expect(nodes).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="n1"]')).toHaveCount(0);
});
