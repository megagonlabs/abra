// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Cross-view coordination — a graph node and a table row share a `ref` (p:alice). Hovering the
 * node must brush its co-referent element in the OTHER view: the reducer writes the source-keyed
 * highlight overlay (joinKey = ref) and fans it out across visible canvases; both views render
 * `.abra-coord`. Pure substrate (reducer + views), agent-independent.
 */
test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
  await expect(page.locator('.abra-cell [data-view="table"]')).toBeVisible();
});

test('hovering a graph node lights its co-referent table row (and clears on leave)', async ({
  page,
}) => {
  const litInTable = page.locator('.abra-table .abra-coord');
  await expect(litInTable).toHaveCount(0); // nothing brushed yet

  await page.locator('.react-flow__node[data-id="n1"]').hover(); // n1 shares ref p:alice with row r1
  await expect(litInTable.first()).toBeVisible(); // the table lit its co-referent element
  // the lit element belongs to Alice's row (the shared referent), not Bob's
  await expect(page.locator('.abra-table tr', { has: page.locator('.abra-coord') })).toContainText(
    'Alice Ng',
  );

  await page.mouse.move(0, 0); // leave the node
  await expect(litInTable).toHaveCount(0); // coordination cleared per-source
});
