// @ts-check
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import * as C from './lib.mjs';

/**
 * Generated-interface conformance — drives the REAL agent stack. Sends the same query N times;
 * for whatever the agents author, asserts the catalogue-declared invariants (see properties.mjs).
 * Non-deterministic + slow + costs API calls → a CANARY, not a CI gate. Requires the full demo
 * running (`pnpm demo`) on :5173 → :8787, with ANTHROPIC + GOOGLE keys in .env.
 */
const QUERY =
  process.env.CONF_QUERY ||
  'Show me the main DC superheroes, a graph of their relationships, a details table, and a gallery of what they look like.';
const RUNS = Number(process.env.CONF_RUNS || 5);
const STAMP = Date.now();

test.describe.configure({ timeout: 240_000 });

for (let run = 1; run <= RUNS; run++) {
  test(`conformance run ${run}/${RUNS}`, async ({ page }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));

    /** @type {{prop:string, canvas:string, status:'pass'|'fail'|'skip', note:string}[]} */
    const findings = [];
    const add = (prop, canvas, status, note = '') => findings.push({ prop, canvas, status, note });

    await page.goto(`/?s=conf-${STAMP}-${run}`);
    await page.locator('.abra-composer-input').fill(QUERY);
    await page.locator('.abra-composer-input').press('Enter');

    // let the agents build; wait until the canvas count stops changing
    await page
      .locator('.abra-cell .abra-canvas')
      .first()
      .waitFor({ timeout: 90_000 })
      .catch(() => {});
    await C.waitForStable(page, '.abra-cell .abra-canvas', { idle: 8_000, timeout: 150_000 });
    await page.waitForTimeout(4_000); // give images a beat to load

    const canvases = await C.authoredCanvases(page);
    if (canvases.length === 0)
      throw new Error('no canvas authored — the agent stack did not respond');

    for (const cv of canvases) {
      const id = `${cv.view}#${String(cv.canvasId || '').slice(0, 6)}`;
      const view = cv.view;
      const cfg = cv.config || {};
      const actions = cfg.actions || {};

      // P0 — the view renders live (not raw JSON / empty)
      const panel = page.locator(`.abra-cell [data-view="${view}"]`);
      add(
        'P0.render-health',
        id,
        (await panel.count()) > 0 ? 'pass' : 'fail',
        'view panel present',
      );

      // P1 — every action is a real action of the view
      const known = new Set(Object.keys(C.viewActions(view)));
      const unknown = Object.keys(actions).filter((a) => !known.has(a));
      add(
        'P1.actions-known',
        id,
        unknown.length ? 'fail' : 'pass',
        unknown.join(',') || 'all known',
      );

      // P2 — meanings present + hover/select pairs whole
      const noMeaning = Object.entries(actions).filter(([, b]) => !(b?.meaning || '').trim());
      let pairBad = '';
      for (const a of Object.keys(actions)) {
        const end = C.pairEnd(a);
        if (end && known.has(end) && actions[end] === undefined) pairBad = `${a} missing ${end}`;
      }
      add(
        'P2.actions-have-meaning',
        id,
        noMeaning.length || pairBad ? 'fail' : 'pass',
        pairBad || noMeaning.map((x) => x[0]).join(','),
      );

      // P3 — presentation values conform to their domains (catches layout:"circle")
      let presBad = '';
      for (const [k, v] of Object.entries(cfg.presentation || {})) {
        const e = C.checkDomain(v, C.presDomain(view, k));
        if (e) presBad = `${k}: ${e}`;
      }
      add('P3.presentation-in-domain', id, presBad ? 'fail' : 'pass', presBad || 'all in domain');

      // P5 — writes-select control options within domain (no ghost options)
      let optBad = '';
      for (const ctl of cfg.controls || []) {
        if (ctl.writes && ctl.options) {
          const key = String(ctl.writes).split('.')[0];
          const dom = C.presDomain(view, key);
          if (dom?.kind === 'enum') {
            const ghosts = ctl.options.filter((o) => !dom.values.includes(o));
            if (ghosts.length)
              optBad = `${ctl.id}: ghost ${ghosts.join(',')} (∉ ${dom.values.join('|')})`;
          }
        }
      }
      add('P5.control-options-valid', id, optBad ? 'fail' : 'pass', optBad || 'ok');
    }

    // P4 — controls render (aggregate)
    const published = canvases.reduce((n, c) => n + (c.config?.controls?.length || 0), 0);
    if (published > 0) {
      const rendered = await page.locator('.abra-ctrl-btn, .abra-ctrl').count();
      add(
        'P4.controls-render',
        'all',
        rendered >= published ? 'pass' : 'fail',
        `${rendered} rendered / ${published} published`,
      );
    }

    // P11 — every display image loads (or a fallback shows). Catches broken image URLs.
    const displays = canvases.filter((c) => c.view === 'display');
    if (displays.length) {
      const imgs = page.locator('.abra-cell [data-view="display"] img');
      const n = await imgs.count();
      let broken = 0;
      for (let i = 0; i < n; i++) {
        const ok = await imgs
          .nth(i)
          .evaluate(
            (el) =>
              /** @type {HTMLImageElement} */ (el).complete &&
              /** @type {HTMLImageElement} */ (el).naturalWidth > 0,
          )
          .catch(() => false);
        if (!ok) broken += 1;
      }
      const hasFallback =
        (await page.locator('.abra-cell [data-view="display"] .abra-display-fallback').count()) > 0;
      add(
        'P11.images-load',
        'display',
        broken === 0 || hasFallback ? 'pass' : 'fail',
        `${n - broken}/${n} imgs loaded`,
      );
    }

    add(
      'P0.render-health',
      'session',
      pageErrors.length ? 'fail' : 'pass',
      pageErrors.join(' | ') || 'no page errors',
    );

    // record
    mkdirSync('conformance/results', { recursive: true });
    writeFileSync(
      `conformance/results/run-${run}.json`,
      JSON.stringify(
        {
          run,
          query: QUERY,
          canvases: canvases.map((c) => ({ view: c.view, title: c.title, source: c.source })),
          pageErrors,
          findings,
        },
        null,
        2,
      ),
    );

    // hard-fail only on the clear bugs (crash + broken images); the rest is recorded for review
    const critical = findings.filter((f) => f.status === 'fail' && /^(P0|P11)/.test(f.prop));
    expect(
      critical,
      `critical conformance failures:\n${critical.map((f) => `  ${f.prop} [${f.canvas}] ${f.note}`).join('\n')}`,
    ).toEqual([]);
  });
}
