// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Dead / ghost affordance — a view must never OFFER an interaction the canvas didn't bind.
 * The cursor is class-driven off the published binding (derive.affordanceClass): an element
 * with a bound action gets an interactive cursor, an UNBOUND element gets the plain arrow
 * (abra-cur-default), and clicking it is inert because the view's published gate suppresses
 * the gesture. Fixture t1 (table) publishes select_row but NO cell/column action, so within
 * ONE canvas the row handle is live while the cells and columns are dead — a clean contrast
 * proving the affordance tracks the binding, not a blanket default.
 */
test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
  await expect(page.locator('.abra-cell [data-view="table"]')).toBeVisible();
});

test('an unbound element offers no affordance (plain arrow), a bound one does', async ({
  page,
}) => {
  const table = page.locator('.abra-cell [data-view="table"]');

  // select_row IS published → the row handle is a LIVE affordance (pointer)
  await expect(table.locator('.abra-row-handle-button').first()).toHaveClass(/abra-cur-pointer/);

  // NO cell action (select_cell / edit_cell / highlight_block) published → cells are INERT
  const cell = table.locator('.abra-cell-button').first();
  await expect(cell).toHaveClass(/abra-cur-default/);
  await expect(cell).not.toHaveClass(/abra-cur-pointer/);

  // NO select_column published → the column headers are inert too (the row-handle th has no cursor class)
  await expect(table.locator('th.abra-cur-default').first()).toBeVisible();

  // clicking the dead cell is a no-op: the published gate never emits, so the cell stays inert
  // (and the app does not crash). Ghost affordance = an element that looks clickable but isn't;
  // here it correctly neither looks nor acts clickable.
  await cell.click();
  await expect(cell).toHaveClass(/abra-cur-default/);
});

test('the affordance is derived per binding, across views', async ({ page }) => {
  // g1 publishes select_node → its nodes carry the interactive (pointer) cursor, NOT the arrow.
  await expect(page.locator('.react-flow__node[data-id="n1"] .abra-node')).toHaveClass(
    /abra-cur-pointer/,
  );
});
