// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Harness sanity — the mock hub replays a scripted SNAPSHOT and the demo client renders it
 * (WS → store → views). Every behavioral spec depends on this baseline working.
 */
test('harness: the scripted spec renders (graph + table from SNAPSHOT)', async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
  await expect(page.locator('.abra-cell [data-view="graph"]')).toBeVisible();
  await expect(page.locator('.abra-cell [data-view="table"]')).toBeVisible();
  await expect(page.locator('.abra-cell .abra-canvas')).toHaveCount(2);
});
