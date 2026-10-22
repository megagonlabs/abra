// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Broken-spec handling — two layers of defense against a mis-authored spec:
 *   1. VALIDATION (reducer) rejects a bad spec at CREATE, catalogue-driven (per-wire validator).
 *   2. VIEW robustness — if a bad value slips through anyway, the view coerces and never crashes.
 * Both are testable deterministically regardless of whether a real agent would emit such a spec.
 */
test.describe('broken spec', () => {
  test('the reducer REJECTS a mis-authored spec at CREATE (validation)', async ({ page }) => {
    await page.request.post('http://localhost:8787/__reset');
    await page.goto('/?s=e2e');
    await expect(page.locator('.abra-cell .abra-canvas')).toHaveCount(2);

    // ask the owner to create a spec with a ghost layout option (`layout: "circle"`)
    const input = page.locator('.abra-composer-input');
    await input.fill('create broken');
    await input.press('Enter');

    // rejected at CREATE → no third canvas, and the rejection is surfaced with its code
    await expect(page.getByText(/\[rejected: VALIDATION\]/)).toBeVisible();
    await expect(page.getByText(/expected one of force \| dagre \| group/)).toBeVisible();
    await expect(page.locator('.abra-cell .abra-canvas')).toHaveCount(2);
  });

  test('a malformed value that slips through still renders without crashing the view', async ({
    page,
  }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));

    // a pre-existing canvas whose presentation was mis-shaped (collapsed:{}, find:42)
    await page.request.post('http://localhost:8787/__reset?scenario=malformed');
    await page.goto('/?s=e2e');

    await expect(page.locator('.abra-cell [data-view="text"]')).toBeVisible();
    await expect(page.getByText('A brief line survives a broken spec.')).toBeVisible();
    expect(errors, `uncaught page errors: ${errors.join(' | ')}`).toHaveLength(0);
  });
});
