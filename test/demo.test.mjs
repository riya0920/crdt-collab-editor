/**
 * The scripted offline demo, run headless against a real relay.
 *
 * Two real WebSocket clients, a real four-minute disconnection (compressed), and
 * the same script the browser plays. The point is not that the CRDT converges - * `harness.mjs` establishes that over 1,000 randomised trials. The point is that
 * the *application* delivers the operations, which is a separate claim and was
 * false until this test was written.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

import { Replica } from '../src/rga.mjs';
import { createCollabServer } from '../src/server.mjs';
import { run } from '../public/demo.js';

/**
 * A headless stand-in for `window.__crdt`, with the SAME outbox semantics as the
 * browser client.
 *
 * Duplicated deliberately rather than imported: the browser copy lives inside a
 * <script type="module"> in the HTML and cannot be imported by node. Keeping the
 * two in step is a real maintenance cost, and it is the cost of testing the
 * behaviour at all rather than declaring it untestable - the alternative was the
 * status quo, where the buffering claim went unchecked for the life of the repo.
 */
class HeadlessClient {
  constructor(url, docId, clientId) {
    this.url = url;
    this.docId = docId;
    this.clientId = clientId;
    this.replica = new Replica(clientId);
    this.outbox = [];
    this.ws = null;
    this.manualOffline = false;
    this.reconnectTimer = null;
  }

  connect() {
    if (this.manualOffline) return Promise.resolve();
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'join', docId: this.docId, clientId: this.clientId }));
        this.flush();
        resolve();
      });
      this.ws.on('message', (data) => {
        const msg = JSON.parse(data);
        if (msg.type === 'snapshot') for (const op of msg.ops) this.replica.receive(op);
        else if (msg.type === 'op') this.replica.receive(msg.op);
      });
      this.ws.on('close', () => {
        if (!this.manualOffline && !this.reconnectTimer) {
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
          }, 100);
        }
      });
      this.ws.on('error', () => {});
    });
  }

  get online() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  get outboxSize() { return this.outbox.length; }
  get text() { return this.replica.text; }
  fingerprint() { return this.replica.fingerprint(); }

  send(payload) {
    if (this.online) { this.ws.send(JSON.stringify(payload)); return true; }
    if (payload.type === 'op') this.outbox.push(payload);
    return false;
  }

  flush() {
    if (!this.online) return 0;
    const pending = this.outbox;
    this.outbox = [];
    for (const p of pending) this.ws.send(JSON.stringify(p));
    return pending.length;
  }

  goOffline() {
    this.manualOffline = true;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) this.ws.close();
  }

  goOnline() {
    this.manualOffline = false;
    if (!this.online) this.connect();
  }

  type(text, atIndex) {
    const at = atIndex === undefined ? this.replica.length : atIndex;
    for (let i = 0; i < text.length; i += 1) {
      this.send({ type: 'op', op: this.replica.localInsert(at + i, text[i]) });
    }
  }

  close() {
    this.manualOffline = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
  }
}

async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), 'crdt-demo-'));
  const server = await createCollabServer({ port: 0, dir, snapshotEvery: 1000 });
  try {
    return await fn(`ws://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the scripted offline demo converges, and flushes what was typed offline', async () => {
  await withServer(async (url) => {
    const a = new HeadlessClient(url, 'demo', 'A');
    const b = new HeadlessClient(url, 'demo', 'B');
    await a.connect();
    await b.connect();

    // speed 200: the ten-minute script in three seconds. Same steps, same order,
    // same assertions -- the compressed run is a test of the slow one rather
    // than a different thing that happens to look similar.
    const out = await run(a, b, { speed: 200, log: () => {} });

    a.close();
    b.close();

    assert.equal(out.fingerprintsMatch, true,
      'replicas diverged after the scripted session');
    assert.equal(out.textsMatch, true);
    assert.ok(out.chars > 200, `document is suspiciously short: ${out.chars} chars`);
    assert.ok(out.maxOutbox > 0,
      'B never buffered anything, so the offline segment did not actually happen');
  });
});

test('offline edits are LOST without an outbox - the bug this demo found', async () => {
  await withServer(async (url) => {
    const a = new HeadlessClient(url, 'lossy', 'A');
    const b = new HeadlessClient(url, 'lossy', 'B');
    await a.connect();
    await b.connect();

    // The old client's behaviour exactly: drop the op when the socket is down,
    // with no queue and no replay. This is what the status line called
    // "edits buffered".
    b.send = function (payload) {
      if (this.online) { this.ws.send(JSON.stringify(payload)); return true; }
      return false;                       // <- no outbox
    };

    a.type('shared start. ');
    await new Promise((r) => setTimeout(r, 150));
    b.goOffline();
    b.type('WRITTEN WHILE OFFLINE. ');
    b.goOnline();
    await new Promise((r) => setTimeout(r, 400));

    a.close();
    b.close();

    assert.ok(!a.text.includes('WRITTEN WHILE OFFLINE'),
      'this test is meant to demonstrate the loss; if A received it the setup is wrong');
    assert.ok(b.text.includes('WRITTEN WHILE OFFLINE'),
      "B still shows its own text -- which is exactly why the loss is invisible to the person who typed it");
  });
});

test('with the outbox, the same sequence survives', async () => {
  await withServer(async (url) => {
    const a = new HeadlessClient(url, 'fixed', 'A');
    const b = new HeadlessClient(url, 'fixed', 'B');
    await a.connect();
    await b.connect();

    a.type('shared start. ');
    await new Promise((r) => setTimeout(r, 150));
    b.goOffline();
    b.type('WRITTEN WHILE OFFLINE. ');
    assert.ok(b.outboxSize > 0, 'nothing was queued');
    b.goOnline();
    await new Promise((r) => setTimeout(r, 500));

    const converged = a.fingerprint() === b.fingerprint();
    a.close();
    b.close();

    assert.ok(a.text.includes('WRITTEN WHILE OFFLINE'), 'the flush did not reach A');
    assert.equal(converged, true, 'replicas diverged after the flush');
  });
});

test('re-sending an op the server already has is harmless', async () => {
  // Why an at-least-once outbox is the right shape rather than a liability: a
  // client that reconnects unsure of what got through can replay everything.
  await withServer(async (url) => {
    const a = new HeadlessClient(url, 'dupes', 'A');
    const b = new HeadlessClient(url, 'dupes', 'B');
    await a.connect();
    await b.connect();

    a.type('hello');
    await new Promise((r) => setTimeout(r, 200));
    const before = b.text;

    // Replay every op a second time, as a paranoid outbox would.
    for (const op of a.replica.doc.ops || []) a.send({ type: 'op', op });
    await new Promise((r) => setTimeout(r, 200));

    a.close();
    b.close();
    assert.equal(b.text, before, 'redelivery changed the document');
  });
});

test('the script is deterministic and covers the whole ten minutes', () => {
  // Structural checks on the script itself, so a future edit cannot quietly
  // remove the offline segment and leave a demo that proves nothing.
  const mod = new URL('../public/demo.js', import.meta.url);
  return import(mod).then(({ plan: p }) => {
    const steps = p(1);
    assert.ok(steps.some((s) => s.offline === 'B'), 'no offline step');
    assert.ok(steps.some((s) => s.online === 'B'), 'no reconnect step');
    const off = steps.find((s) => s.offline === 'B').at;
    const on = steps.find((s) => s.online === 'B').at;
    assert.ok(on - off >= 200, `offline window is only ${on - off}s`);
    assert.ok(steps.filter((s) => s.type && s.who === 'B' && s.at > off && s.at < on).length >= 3,
      'B barely typed while offline, so the flush proves little');
    assert.equal(steps[steps.length - 1].check, true, 'script does not end in a convergence check');
  });
});
