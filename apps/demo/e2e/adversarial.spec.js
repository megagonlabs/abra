// @ts-check
/**
 * Adversarial wire tests — try things that MUST be rejected, assert they were.
 *
 * The other specs drive the browser through the happy path; this one talks raw WS to the
 * SAME deterministic mock-hub (which runs the REAL reducer) and attempts forbidden moves as
 * a chosen participant, asserting the reducer's closed ERROR code + that no state leaked.
 * JOIN picks the source (unspoofable — the hub stamps it), so we can act AS the owner, a
 * non-owner agent, or an outsider and watch each guard fire. Each write is reqId-correlated:
 * the reducer echoes our reqId on BOTH the accepted broadcast and the ERROR, so `act()`
 * resolves with whichever came back — an ERROR (rejected) or the accepted delta (applied).
 *
 * Fixture canvases (see fixtures.mjs): g1 = graph, owner agent:alice, mode exclusive;
 * t1 = table, owner agent:bob, mode exclusive.
 */
import { expect, test } from '@playwright/test';
import { WebSocket } from 'ws';

const HUB = 'ws://localhost:8787';
const RESET = 'http://localhost:8787/__reset';

/** Open a WS, JOIN as `source`, and expose a reqId-correlated `act(frame)`. */
async function join(/** @type {string} */ source) {
  const ws = new WebSocket(HUB);
  /** @type {any[]} */
  const inbox = [];
  /** @type {{pred:(f:any)=>boolean, resolve:(f:any)=>void}[]} */
  const waiters = [];
  const pump = () => {
    for (let i = 0; i < waiters.length; ) {
      const idx = inbox.findIndex(waiters[i].pred);
      if (idx >= 0) waiters.splice(i, 1)[0].resolve(inbox[idx]);
      else i++;
    }
  };
  ws.on('message', (raw) => {
    inbox.push(JSON.parse(String(raw)));
    pump();
  });
  await new Promise((res, rej) => {
    ws.once('open', () => res(undefined));
    ws.once('error', rej);
  });
  const waitFor = (/** @type {(f:any)=>boolean} */ pred, ms = 6000) =>
    new Promise((res, rej) => {
      waiters.push({ pred, resolve: res });
      pump();
      setTimeout(() => rej(new Error('timeout waiting for frame')), ms).unref?.();
    });
  ws.send(JSON.stringify({ type: 'JOIN', source }));
  await waitFor((f) => f.type === 'SNAPSHOT'); // handshake complete
  let n = 0;
  return {
    /** send a write; resolve with the frame carrying our reqId (ERROR or accepted delta). */
    act: (/** @type {any} */ frame) => {
      const reqId = `${source}#${++n}`;
      const p = waitFor((f) => f.reqId === reqId);
      ws.send(JSON.stringify({ ...frame, reqId, seq: n }));
      return /** @type {Promise<any>} */ (p);
    },
    close: () => ws.close(),
  };
}

/** Assert a frame is a rejection with the given closed-set code AND a surfaced reason. */
function expectReject(/** @type {any} */ f, /** @type {string} */ code) {
  expect(f.type, `expected ERROR ${code}, got ${JSON.stringify(f).slice(0, 120)}`).toBe('ERROR');
  expect(f.code).toBe(code);
  expect(typeof f.message, 'reducer attaches a human-readable reason').toBe('string');
  expect(f.message.length).toBeGreaterThan(0);
}

test.beforeEach(async () => {
  await fetch(RESET, { method: 'POST' }); // pristine SNAPSHOT per test — no cross-test leakage
});

test.describe('adversarial — forbidden moves are rejected by the reducer', () => {
  test('IMMUTABLE_FIELD — even the owner cannot rewrite config.actions', async () => {
    const alice = await join('agent:alice'); // owner of g1
    expectReject(
      await alice.act({
        type: 'UPDATE_CANVAS',
        canvasId: 'g1',
        config: { actions: { hacked: { meaning: 'x' } } },
      }),
      'IMMUTABLE_FIELD',
    );
    alice.close();
  });

  test('IMMUTABLE_FIELD — the owner cannot change the view', async () => {
    const alice = await join('agent:alice');
    expectReject(
      await alice.act({ type: 'UPDATE_CANVAS', canvasId: 'g1', view: 'table' }),
      'IMMUTABLE_FIELD',
    );
    alice.close();
  });

  test('NOT_OWNER — a non-owner cannot write content on an exclusive canvas', async () => {
    const eve = await join('agent:eve'); // NOT the owner of g1
    expectReject(
      await eve.act({
        type: 'UPDATE_CANVAS',
        canvasId: 'g1',
        content: { nodes: { nEvil: { label: 'injected' } } },
      }),
      'NOT_OWNER',
    );
    eve.close();
  });

  test('NOT_OWNER — a non-owner cannot set an owner field (title)', async () => {
    const eve = await join('agent:eve');
    expectReject(
      await eve.act({ type: 'UPDATE_CANVAS', canvasId: 'g1', title: 'hijacked' }),
      'NOT_OWNER',
    );
    eve.close();
  });

  test('NOT_OWNER — a non-owner cannot resolve a pending', async () => {
    const eve = await join('agent:eve');
    expectReject(
      await eve.act({
        type: 'UPDATE_CANVAS',
        canvasId: 'g1',
        resolves: 'whatever',
        content: { nodes: {} },
      }),
      'NOT_OWNER',
    );
    eve.close();
  });

  test('NOT_A_CONSEQUENCE — firing an UNPUBLISHED action is rejected', async () => {
    const eve = await join('agent:eve');
    // reposition_node is NOT in g1's config.actions
    expectReject(
      await eve.act({
        type: 'CANVAS_EVENT',
        canvasId: 'g1',
        action: 'reposition_node',
        value: { x: 0, y: 0 },
        timestamp: 0,
      }),
      'NOT_A_CONSEQUENCE',
    );
    eve.close();
  });

  test('NOT_A_CONSEQUENCE — firing an unknown control is rejected', async () => {
    const eve = await join('agent:eve');
    expectReject(
      await eve.act({ type: 'CANVAS_EVENT', canvasId: 'g1', control: 'ghost_btn', timestamp: 0 }),
      'NOT_A_CONSEQUENCE',
    );
    eve.close();
  });

  test('CANVAS_NOT_FOUND — writing to a canvas that does not exist', async () => {
    const eve = await join('agent:eve');
    expectReject(
      await eve.act({ type: 'UPDATE_CANVAS', canvasId: 'ghost', content: {} }),
      'CANVAS_NOT_FOUND',
    );
    eve.close();
  });

  test('UNKNOWN_PENDING — the owner cannot resolve a pending that is not open', async () => {
    const alice = await join('agent:alice'); // owner of g1
    expectReject(
      await alice.act({
        type: 'UPDATE_CANVAS',
        canvasId: 'g1',
        resolves: 'no-such-pending',
        content: { nodes: { n9: { label: 'x' } } },
      }),
      'UNKNOWN_PENDING',
    );
    alice.close();
  });

  test('VALIDATION — a CREATE with a ghost presentation option is rejected at authoring', async () => {
    const alice = await join('agent:alice');
    expectReject(
      await alice.act({
        type: 'CREATE_CANVAS',
        view: 'graph',
        content: { nodes: {} },
        config: { actions: {}, presentation: { layout: 'circle' } }, // 'circle' ∉ {force,dagre,group}
      }),
      'VALIDATION',
    );
    alice.close();
  });

  test('VALIDATION — a bad presentation is also rejected on UPDATE, not only CREATE', async () => {
    const alice = await join('agent:alice'); // owner of g1
    expectReject(
      await alice.act({
        type: 'UPDATE_CANVAS',
        canvasId: 'g1',
        config: { presentation: { layout: 'circle' } },
      }),
      'VALIDATION',
    );
    alice.close();
  });

  test('VALIDATION — a fire_action value with a bad enum is rejected', async () => {
    const eve = await join('agent:eve');
    // sort_rows_by_column is published on t1; its value is { dir: "asc | desc" }
    expectReject(
      await eve.act({
        type: 'CANVAS_EVENT',
        canvasId: 't1',
        action: 'sort_rows_by_column',
        value: { dir: 'ascending' },
        timestamp: 0,
      }),
      'VALIDATION',
    );
    eve.close();
  });

  test('VALIDATION — a fire_action value with wrong keys is rejected', async () => {
    const eve = await join('agent:eve');
    // add_column value is { label, type }; {name} is missing both → rejected up front
    expectReject(
      await eve.act({
        type: 'CANVAS_EVENT',
        canvasId: 't1',
        action: 'add_column',
        value: { name: 'Awards' },
        timestamp: 0,
      }),
      'VALIDATION',
    );
    eve.close();
  });

  test('VALIDATION — a fire_action value with the wrong TYPE is rejected', async () => {
    const eve = await join('agent:eve');
    // add_column value is { label:string, type:string }; label as a number violates the contract
    expectReject(
      await eve.act({
        type: 'CANVAS_EVENT',
        canvasId: 't1',
        action: 'add_column',
        value: { label: 123, type: 'string' },
        timestamp: 0,
      }),
      'VALIDATION',
    );
    eve.close();
  });

  test('VALIDATION — a fire_action value that references a NONEXISTENT element is rejected', async () => {
    const eve = await join('agent:eve');
    // add_edge value {from,to} must name REAL nodes; g1 has n1,n2 but no "ghost" → referential reject
    expectReject(
      await eve.act({
        type: 'CANVAS_EVENT',
        canvasId: 'g1',
        action: 'add_edge',
        value: { from: 'node/n1', to: 'node/ghost' },
        timestamp: 0,
      }),
      'VALIDATION',
    );
    eve.close();
  });
});

test.describe('precision — the guards are narrow, not blanket', () => {
  test('the owner CAN patch presentation (applied, not rejected)', async () => {
    const alice = await join('agent:alice');
    const f = await alice.act({
      type: 'UPDATE_CANVAS',
      canvasId: 'g1',
      config: { presentation: { layout: 'dagre' } },
    });
    expect(
      f.type,
      `presentation patch should apply, got ${JSON.stringify(f).slice(0, 120)}`,
    ).not.toBe('ERROR');
    alice.close();
  });

  test('tier boundary — a NON-owner CAN patch presentation but NOT content on the same canvas', async () => {
    const eve = await join('agent:eve');
    // presentation is ungated (view state) — applies even for a non-owner…
    const ok = await eve.act({
      type: 'UPDATE_CANVAS',
      canvasId: 'g1',
      config: { presentation: { layout: 'dagre' } },
    });
    expect(ok.type, 'non-owner presentation patch is ungated').not.toBe('ERROR');
    // …but content is owner-gated on an exclusive canvas.
    expectReject(
      await eve.act({
        type: 'UPDATE_CANVAS',
        canvasId: 'g1',
        content: { nodes: { nX: { label: 'x' } } },
      }),
      'NOT_OWNER',
    );
    eve.close();
  });

  test('a fire_action with a well-formed value is accepted (value guard is not blanket)', async () => {
    const eve = await join('agent:eve');
    const f = await eve.act({
      type: 'CANVAS_EVENT',
      canvasId: 't1',
      action: 'sort_rows_by_column',
      value: { dir: 'asc' }, // matches the { dir: "asc | desc" } signature
      timestamp: 0,
    });
    expect(f.type, `valid value should apply, got ${JSON.stringify(f).slice(0, 120)}`).not.toBe(
      'ERROR',
    );
    eve.close();
  });

  test('a fire_action referencing REAL elements is accepted (referential guard is not blanket)', async () => {
    const eve = await join('agent:eve');
    // add_edge between n1 and n2 — both exist in g1 → accepted (arms a pending for the owner)
    const f = await eve.act({
      type: 'CANVAS_EVENT',
      canvasId: 'g1',
      action: 'add_edge',
      value: { from: 'node/n1', to: 'node/n2' },
      timestamp: 0,
    });
    expect(f.type, `valid ref should apply, got ${JSON.stringify(f).slice(0, 120)}`).not.toBe(
      'ERROR',
    );
    eve.close();
  });
});
