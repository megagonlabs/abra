// @ts-check
import { expect, test } from '@playwright/test';

/**
 * Consequence round-trip — the core interaction contract. A controller `fires` a consequence
 * action (+Node); the user click must NOT mutate content directly. Instead: fire → the server
 * mints a pending → the OWNER resolves it → the node appears. The mock's stub-owner stands in
 * for "an owner that resolves this way", so we assert the MECHANISM, not any LLM's judgment.
 */
test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
});

test('a +Node controller round-trips: fire → pending → owner resolves → node added', async ({
  page,
}) => {
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(2); // the scripted spec starts with two nodes

  await page.getByRole('button', { name: '+ Node' }).click();

  // the owner (stub) resolves the consequence → exactly one node appears (no double-apply)
  await expect(nodes).toHaveCount(3);
  await expect(page.locator('.react-flow__node', { hasText: 'Added node' })).toHaveCount(1);
});
