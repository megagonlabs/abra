// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Chat coordination chip — path resolution. A chip `{ref:key}` points at a canvas element
 * (`paths:['node/n1']`). It is live only when its canvas is open AND its path resolves to a
 * REAL element; a dangling path (a missing id, or a malformed one like cell/r1) greys out
 * (`abra-refchip--gone`) instead of silently lighting nothing when hovered. Fixture message
 * seq 4 carries one resolving chip (node/n1 exists in g1) and one dangling (node/ghost).
 */
test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
  await expect(page.locator('.abra-cell [data-view="graph"]')).toBeVisible();
});

test('a chip whose path exists is live; a dangling path greys out', async ({ page }) => {
  const live = page.locator('.abra-refchip', { hasText: 'live node' });
  const dead = page.locator('.abra-refchip', { hasText: 'dead node' });

  await expect(live).toBeVisible();
  await expect(dead).toBeVisible();

  // node/n1 exists → the chip is NOT marked gone
  await expect(live).not.toHaveClass(/abra-refchip--gone/);
  // node/ghost does not exist → the chip IS marked gone (dangling, hover lights nothing)
  await expect(dead).toHaveClass(/abra-refchip--gone/);
});
