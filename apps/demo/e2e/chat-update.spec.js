// @ts-check
import { expect, test } from '@playwright/test';

/**
 * A view updated via chat WHILE the user is interacting with it. The user selects a node, then a
 * chat message drives the owner agent to author a new node (an UPDATE that lands mid-interaction).
 * The controlled-mirror view must reconcile the pushed content without losing the node the user
 * was working with.
 */
test.beforeEach(async ({ page }) => {
  await page.request.post('http://localhost:8787/__reset');
  await page.goto('/?s=e2e');
});

test('a chat-driven UPDATE lands while interacting and the view reconciles', async ({ page }) => {
  const nodes = page.locator('.react-flow__node');
  await expect(nodes).toHaveCount(2);

  // start interacting: select a node
  await page.locator('.react-flow__node[data-id="n1"]').click();

  // a chat message drives the owner to add a node (a push during interaction)
  const input = page.locator('.abra-composer-input');
  await input.fill('please add node for the new hire');
  await input.press('Enter');

  // the pushed content reconciles into the live view — new node present, existing node kept
  await expect(nodes).toHaveCount(3);
  await expect(page.locator('.react-flow__node', { hasText: 'Node from chat' })).toHaveCount(1);
  await expect(page.locator('.react-flow__node[data-id="n1"]')).toBeVisible();
});
