import test from 'node:test';
import assert from 'node:assert/strict';

import { YjsReplica } from '../src/yjs-replica.mjs';
import { Replica } from '../src/rga.mjs';
import { runSuite } from '../src/harness.mjs';
import { serializedSize } from '../src/snapshot.mjs';
import { makeRng } from '../src/network.mjs';

test('the Yjs replica satisfies the same interface as the RGA', () => {
  const y = new YjsReplica('a');
  for (const m of ['localInsert', 'localDelete', 'receive', 'fingerprint', 'drain']) {
    assert.equal(typeof y[m], 'function', `missing ${m}`);
  }
  y.localInsert(0, 'h');
  y.localInsert(1, 'i');
  assert.equal(y.text, 'hi');
  assert.equal(y.length, 2);
});

test('Yjs converges through the SAME harness as the RGA', () => {
  const summary = runSuite({ trials: 60, clients: 3, impl: 'yjs' });
  assert.equal(summary.implementation, 'Yjs');
  assert.equal(summary.failed, 0, `failing seeds: ${JSON.stringify(summary.failingSeeds)}`);
});

test('Yjs converges under heavy loss and duplication', () => {
  const summary = runSuite({
    trials: 25, clients: 4, impl: 'yjs',
    conditions: { dropRate: 0.25, duplicateRate: 0.20, minLatency: 10, maxLatency: 1200 },
  });
  assert.equal(summary.failed, 0);
});

test('Yjs updates are idempotent under redelivery', () => {
  const a = new YjsReplica('a');
  const b = new YjsReplica('b');
  const ops = a.insertText(0, 'abc');
  for (const op of ops) { b.receive(op); b.receive(op); b.receive(op); }
  assert.equal(b.text, 'abc');
});

test('Yjs applies updates arriving out of order', () => {
  const a = new YjsReplica('a');
  const b = new YjsReplica('b');
  const ops = a.insertText(0, 'wxyz');
  for (const op of [...ops].reverse()) b.receive(op);
  assert.equal(b.text, 'wxyz', 'Yjs buffers causally-unready updates internally');
});

test('the fingerprint is content-addressed, not the state vector', () => {
  // Two replicas reaching identical content by DIFFERENT delivery orders must
  // agree. Yjs state vectors encode per-client clocks and would not.
  const source = new YjsReplica('s');
  const ops = source.insertText(0, 'abcdef');

  const fwd = new YjsReplica('x');
  for (const op of ops) fwd.receive(op);
  const rev = new YjsReplica('y');
  for (const op of [...ops].reverse()) rev.receive(op);

  assert.equal(fwd.text, rev.text);
  assert.equal(fwd.fingerprint(), rev.fingerprint());
});

test('Yjs encodes the same document more compactly than the RGA', () => {
  const rng = makeRng(11);
  const rga = new Replica('a');
  const yjs = new YjsReplica('a');
  for (let i = 0; i < 800; i += 1) {
    const len = rga.doc.length;
    const del = len > 0 && rng() < 0.35;
    const idx = Math.floor(rng() * (del ? len : len + 1));
    const ch = String.fromCharCode(97 + Math.floor(rng() * 26));
    if (del) { rga.localDelete(idx); yjs.localDelete(idx); }
    else { rga.localInsert(idx, ch); yjs.localInsert(idx, ch); }
  }
  assert.equal(rga.text, yjs.text, 'an identical edit script must produce identical text');
  assert.ok(yjs.byteSize() < serializedSize(rga.doc),
    'Yjs run-length encoding should beat one node per character');
});
