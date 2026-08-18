/**
 * Snapshots and tombstone compaction — the real-world CRDT pain point.
 *
 * Tombstones cannot be deleted eagerly, because a concurrent insert may still
 * name one as its origin. So a long-lived document accumulates metadata for
 * every character ever typed, and a 10 KB document ends up with a 50 MB op log.
 * Addressing this is the difference between having read about CRDTs and having
 * operated one.
 *
 * **When is it safe to drop a tombstone?** When no operation that could name it
 * as an origin can still arrive. That is decided by a *stable version vector*:
 * the per-site counter that every site has acknowledged receiving. Any future
 * operation is causally after that point, so its origin is a node that survives
 * compaction. Compacting past the stable frontier is how you corrupt a document,
 * and `compact()` refuses to look beyond it.
 *
 *   node src/snapshot.mjs
 */
import { RGA, Replica, idToString } from './rga.mjs';
import { Network, makeRng, isMainModule } from './network.mjs';

/** Per-site max counter acknowledged by EVERY site. The safe compaction frontier. */
export function stableVersion(replicas) {
  const sites = replicas.map((r) => r.site);
  const stable = new Map();
  for (const site of sites) {
    let min = Infinity;
    for (const r of replicas) {
      // Highest counter from `site` that this replica has applied.
      let seen = 0;
      for (const key of r.doc.applied) {
        const [s, c] = key.split(':');
        if (s === site) seen = Math.max(seen, Number(c));
      }
      min = Math.min(min, seen);
    }
    stable.set(site, min === Infinity ? 0 : min);
  }
  return stable;
}

function isStable(id, stable) {
  if (id === null) return true;
  return (stable.get(id.site) ?? 0) >= id.counter;
}

/**
 * Remove tombstones that are provably unreferenceable, re-parenting their
 * children in place so the visible sequence is unchanged.
 *
 * Returns the number of nodes removed.
 */
export function compact(doc, stable) {
  let removed = 0;

  const prune = (parent) => {
    const next = [];
    for (const child of parent.children) {
      prune(child);
      // A tombstone can go only when the DELETE that created it is stable --
      // i.e. every replica has seen the deletion. Checking the node's insert id
      // instead is a corruption bug: the node may be ancient (and so "stable")
      // while its deletion is seconds old, and a peer that has not seen the
      // delete can still emit an insert naming this node as its origin. Drop it
      // and that insert can never be placed. A test asserts this directly.
      if (child.deleted && child.deletedBy !== null && isStable(child.deletedBy, stable)) {
        doc.nodes.delete(idToString(child.id));
        removed += 1;
        next.push(...child.children);
      } else {
        next.push(child);
      }
    }
    parent.children = next;
  };

  prune(doc.root);
  return removed;
}

/** Rough serialised size of the document structure, in bytes. */
export function serializedSize(doc) {
  const payload = doc.allNodes().map((n) => ({
    i: idToString(n.id),
    o: idToString(n.originId),
    v: n.deleted ? null : n.value,
    d: n.deleted ? 1 : 0,
  }));
  return Buffer.byteLength(JSON.stringify(payload), 'utf8');
}

/** Size of a full op log, for comparison -- this is what grows without bound. */
export function opLogSize(ops) {
  return Buffer.byteLength(JSON.stringify(ops), 'utf8');
}

/** Measure growth over `nOps` edits, with and without compaction. */
export function measureCompaction({ nOps = 100000, clients = 3, seed = 42, deleteRate = 0.4 } = {}) {
  const rng = makeRng(seed);
  const replicas = [];
  for (let i = 0; i < clients; i += 1) replicas.push(new Replica(`s${i}`));
  const net = new Network(replicas, { dropRate: 0, duplicateRate: 0, minLatency: 1, maxLatency: 5 }, rng);

  const opLog = [];
  const perOp = Math.max(1, Math.floor(nOps / 200));

  for (let i = 0; i < nOps; i += 1) {
    const replica = replicas[Math.floor(rng() * replicas.length)];
    const len = replica.doc.length;
    let op;
    if (len > 0 && rng() < deleteRate) {
      op = replica.localDelete(Math.floor(rng() * len));
    } else {
      op = replica.localInsert(Math.floor(rng() * (len + 1)), String.fromCharCode(97 + Math.floor(rng() * 26)));
    }
    if (op) {
      opLog.push(op);
      net.broadcast(replica.site, op);
    }
    if (i % perOp === 0) net.tick(10);
  }
  net.quiesce();

  const doc = replicas[0].doc;
  const before = { ...doc.stats(), bytes: serializedSize(doc) };
  const logBytes = opLogSize(opLog);

  const stable = stableVersion(replicas);
  const t0 = Date.now();
  const removed = compact(doc, stable);
  const compactMs = Date.now() - t0;
  const after = { ...doc.stats(), bytes: serializedSize(doc) };

  return {
    ops: nOps,
    clients,
    visibleChars: after.visible,
    opLogBytes: logBytes,
    beforeCompaction: before,
    afterCompaction: after,
    tombstonesRemoved: removed,
    bytesSaved: before.bytes - after.bytes,
    reductionPct: Number((100 * (1 - after.bytes / before.bytes)).toFixed(1)),
    compactionMs: compactMs,
    textUnchanged: null,   // filled by the caller that captured the text first
  };
}

if (isMainModule(import.meta.url)) {
  const results = [];
  for (const nOps of [1000, 10000, 100000]) {
    const rng = makeRng(42);
    const replicas = [];
    for (let i = 0; i < 3; i += 1) replicas.push(new Replica(`s${i}`));
    const net = new Network(replicas, { dropRate: 0, duplicateRate: 0, minLatency: 1, maxLatency: 5 }, rng);
    const opLog = [];
    const perOp = Math.max(1, Math.floor(nOps / 200));

    for (let i = 0; i < nOps; i += 1) {
      const replica = replicas[Math.floor(rng() * replicas.length)];
      const len = replica.doc.length;
      const op = (len > 0 && rng() < 0.4)
        ? replica.localDelete(Math.floor(rng() * len))
        : replica.localInsert(Math.floor(rng() * (len + 1)), String.fromCharCode(97 + Math.floor(rng() * 26)));
      if (op) { opLog.push(op); net.broadcast(replica.site, op); }
      if (i % perOp === 0) net.tick(10);
    }
    net.quiesce();

    const doc = replicas[0].doc;
    const textBefore = doc.toString();
    const before = { ...doc.stats(), bytes: serializedSize(doc) };
    const stable = stableVersion(replicas);
    const t0 = Date.now();
    const removed = compact(doc, stable);
    const ms = Date.now() - t0;
    const after = { ...doc.stats(), bytes: serializedSize(doc) };

    results.push({
      ops: nOps,
      visibleChars: after.visible,
      opLogKB: Math.round(opLogSize(opLog) / 1024),
      beforeKB: Math.round(before.bytes / 1024),
      afterKB: Math.round(after.bytes / 1024),
      tombstonesBefore: before.tombstones,
      tombstonesAfter: after.tombstones,
      removed,
      reductionPct: Number((100 * (1 - after.bytes / before.bytes)).toFixed(1)),
      compactionMs: ms,
      // The property that makes compaction safe rather than merely small.
      textUnchanged: doc.toString() === textBefore,
    });
  }

  console.log('| ops | visible chars | op log | doc before | doc after | tombstones removed | reduction | compact ms | text unchanged |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.ops} | ${r.visibleChars} | ${r.opLogKB} KB | ${r.beforeKB} KB | ${r.afterKB} KB | ${r.removed} | ${r.reductionPct}% | ${r.compactionMs} | ${r.textUnchanged} |`);
  }
  process.exit(results.every((r) => r.textUnchanged) ? 0 : 1);
}
