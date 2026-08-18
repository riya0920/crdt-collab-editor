import test from 'node:test';
import assert from 'node:assert/strict';

import { RGA, Replica, compareIds } from '../src/rga.mjs';
import { Network, makeRng } from '../src/network.mjs';
import { runTrial, runOfflineTrial, runSuite } from '../src/harness.mjs';
import { compact, stableVersion, serializedSize } from '../src/snapshot.mjs';

/* ---------------------------------------------------------------- basics */

test('local edits produce the expected text', () => {
  const doc = new RGA('a');
  doc.insertText(0, 'hello');
  assert.equal(doc.toString(), 'hello');
  doc.insertText(5, ' world');
  assert.equal(doc.toString(), 'hello world');
  doc.delete(0);
  assert.equal(doc.toString(), 'ello world');
});

test('deleting leaves a tombstone rather than removing the node', () => {
  const doc = new RGA('a');
  doc.insertText(0, 'abc');
  doc.delete(1);
  assert.equal(doc.toString(), 'ac');
  const s = doc.stats();
  assert.equal(s.visible, 2);
  assert.equal(s.tombstones, 1);
  assert.equal(s.total, 3, 'the node must still exist: a concurrent insert may name it as origin');
});

test('id ordering is a strict total order', () => {
  assert.ok(compareIds({ site: 'a', counter: 2 }, { site: 'z', counter: 1 }) > 0, 'counter dominates');
  assert.ok(compareIds({ site: 'b', counter: 1 }, { site: 'a', counter: 1 }) > 0, 'site breaks exact ties');
  assert.equal(compareIds({ site: 'a', counter: 1 }, { site: 'a', counter: 1 }), 0);
});

/* --------------------------------------------------- CRDT algebraic laws */

test('apply is idempotent: replaying an op changes nothing', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const ops = a.doc.insertText(0, 'hi');
  for (const op of ops) { b.receive(op); b.receive(op); b.receive(op); }
  assert.equal(b.text, 'hi');
  assert.equal(b.doc.stats().total, 2);
});

test('apply is commutative: op order does not change the result', () => {
  const source = new Replica('a');
  const ops = source.doc.insertText(0, 'abcdef');

  const forward = new Replica('x');
  for (const op of ops) forward.receive(op);

  const backward = new Replica('y');
  for (const op of [...ops].reverse()) backward.receive(op);

  assert.equal(forward.text, backward.text);
  assert.equal(forward.doc.fingerprint(), backward.doc.fingerprint());
});

test('concurrent inserts at the same position converge on both replicas', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const seed = a.doc.insertText(0, 'XY');
  for (const op of seed) b.receive(op);

  // Both insert between X and Y with no knowledge of each other.
  const opA = a.localInsert(1, 'A');
  const opB = b.localInsert(1, 'B');
  a.receive(opB);
  b.receive(opA);

  assert.equal(a.text, b.text, 'replicas must agree');
  assert.equal(a.doc.fingerprint(), b.doc.fingerprint());
  assert.ok(a.text.includes('A') && a.text.includes('B'), 'neither insert may be lost');
  assert.equal(a.text.length, 4);
});

test('concurrent delete of the same character is not a double delete', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  for (const op of a.doc.insertText(0, 'abc')) b.receive(op);

  const delA = a.localDelete(1);
  const delB = b.localDelete(1);
  a.receive(delB);
  b.receive(delA);

  assert.equal(a.text, 'ac');
  assert.equal(b.text, 'ac');
  assert.equal(a.doc.fingerprint(), b.doc.fingerprint());
});

test('an insert arriving before its origin is buffered, not dropped', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const [op1, op2, op3] = a.doc.insertText(0, 'xyz');

  b.receive(op3);            // depends on op2, which b has not seen
  assert.equal(b.text, '', 'nothing applicable yet');
  assert.equal(b.pending.length, 1);

  b.receive(op2);
  b.receive(op1);
  assert.equal(b.text, 'xyz', 'the buffered op must be applied once its origin arrives');
  assert.equal(b.pending.length, 0);
});

test('delete arriving before its insert is buffered', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  const [ins] = a.doc.insertText(0, 'q');
  const del = a.localDelete(0);

  b.receive(del);
  assert.equal(b.pending.length, 1);
  b.receive(ins);
  assert.equal(b.text, '');
  assert.equal(b.doc.stats().tombstones, 1);
});

/* -------------------------------------------------- convergence harness */

test('3 clients converge over a hostile network (200 randomised trials)', () => {
  const summary = runSuite({ trials: 200, clients: 3 });
  assert.equal(summary.failed, 0, `failing seeds: ${JSON.stringify(summary.failingSeeds)}`);
  assert.ok(summary.totalOpsApplied > 10000, 'the trials must actually do work');
});

test('10 clients converge (60 randomised trials)', () => {
  const summary = runSuite({ trials: 60, clients: 10 });
  assert.equal(summary.failed, 0, `failing seeds: ${JSON.stringify(summary.failingSeeds)}`);
});

test('convergence holds under heavy loss and duplication', () => {
  const summary = runSuite({
    trials: 50,
    clients: 4,
    conditions: { dropRate: 0.25, duplicateRate: 0.20, minLatency: 10, maxLatency: 1500 },
  });
  assert.equal(summary.failed, 0, `failing seeds: ${JSON.stringify(summary.failingSeeds)}`);
});

test('THE HARNESS HAS TEETH: the naive index-based replica diverges', () => {
  // Control group. If this ever passes, the convergence tests above are
  // asserting something trivially true and mean nothing.
  const summary = runSuite({ trials: 40, clients: 3, broken: true });
  assert.ok(summary.failed > 0, 'the broken implementation must diverge');
  assert.equal(summary.passed, 0, 'index-based replication should not converge at all here');
});

test('a divergence report names a reproducible seed', () => {
  const summary = runSuite({ trials: 5, clients: 3, broken: true });
  const seed = summary.failingSeeds[0];
  const replay = runTrial({ seed, clients: 3, broken: true });
  assert.equal(replay.converged, false, 'a reported seed must reproduce the failure exactly');
});

/* ------------------------------------------------------ offline merging */

test('offline edits merge on reconnect', () => {
  for (const seed of [1, 2, 3, 4, 5]) {
    const r = runOfflineTrial({ seed, clients: 3 });
    assert.equal(r.converged, true, `offline merge diverged at seed ${seed}`);
    assert.ok(r.offlineEditsFlushed > 0, 'the partition must actually have held edits back');
  }
});

/* ---------------------------------------------------------- compaction */

test('compaction removes tombstones without changing the text', () => {
  const rng = makeRng(9);
  const replicas = [new Replica('s0'), new Replica('s1')];
  const net = new Network(replicas, { dropRate: 0, duplicateRate: 0, minLatency: 1, maxLatency: 3 }, rng);

  for (let i = 0; i < 400; i += 1) {
    const r = replicas[i % 2];
    const len = r.doc.length;
    const op = (len > 0 && rng() < 0.5)
      ? r.localDelete(Math.floor(rng() * len))
      : r.localInsert(Math.floor(rng() * (len + 1)), 'x');
    if (op) net.broadcast(r.site, op);
  }
  net.quiesce();

  const doc = replicas[0].doc;
  const textBefore = doc.toString();
  const bytesBefore = serializedSize(doc);
  assert.ok(doc.stats().tombstones > 0, 'the scenario must produce tombstones');

  const removed = compact(doc, stableVersion(replicas));
  assert.ok(removed > 0, 'compaction must remove something');
  assert.equal(doc.toString(), textBefore, 'compaction must be text-preserving');
  assert.ok(serializedSize(doc) < bytesBefore, 'compaction must shrink the document');
});

test('compaction refuses to remove tombstones past the stable frontier', () => {
  const a = new Replica('a');
  const b = new Replica('b');
  for (const op of a.doc.insertText(0, 'abc')) b.receive(op);

  // `a` deletes locally; `b` has NOT seen it, so it is not stable.
  a.localDelete(1);
  const stable = stableVersion([a, b]);
  const removed = compact(a.doc, stable);
  assert.equal(removed, 0, 'an unacknowledged tombstone must survive compaction');
  assert.equal(a.text, 'ac');
});
