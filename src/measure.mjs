/**
 * Compaction measurement, separated from the library so it can be run at a
 * chosen size.
 *
 *   node src/measure.mjs 1000 10000 50000
 *
 * Note on cost: this RGA is O(n) per operation (`originForIndex` and `toArray`
 * walk the whole tree), so the measurement itself gets quadratic. That is a
 * property of the educational implementation, not of RGA -- production CRDTs use
 * a block-wise representation with an index. The runtime is reported per size so
 * the cost is visible rather than surprising.
 */
import { Replica } from './rga.mjs';
import { Network, makeRng, isMainModule } from './network.mjs';
import { compact, stableVersion, serializedSize, opLogSize } from './snapshot.mjs';

export function measure(nOps, { clients = 3, seed = 42, deleteRate = 0.4 } = {}) {
  const t0 = Date.now();
  const rng = makeRng(seed);
  const replicas = [];
  for (let i = 0; i < clients; i += 1) replicas.push(new Replica(`s${i}`));
  const net = new Network(replicas, { dropRate: 0, duplicateRate: 0, minLatency: 1, maxLatency: 5 }, rng);

  const opLog = [];
  const per = Math.max(1, Math.floor(nOps / 200));
  for (let i = 0; i < nOps; i += 1) {
    const r = replicas[Math.floor(rng() * replicas.length)];
    const len = r.doc.length;
    const op = (len > 0 && rng() < deleteRate)
      ? r.localDelete(Math.floor(rng() * len))
      : r.localInsert(Math.floor(rng() * (len + 1)), String.fromCharCode(97 + Math.floor(rng() * 26)));
    if (op) { opLog.push(op); net.broadcast(r.site, op); }
    if (i % per === 0) net.tick(10);
  }
  net.quiesce();
  const buildMs = Date.now() - t0;

  const doc = replicas[0].doc;
  const textBefore = doc.toString();
  const before = { ...doc.stats(), bytes: serializedSize(doc) };

  const stable = stableVersion(replicas);
  const tc = Date.now();
  const removed = compact(doc, stable);
  const compactMs = Date.now() - tc;
  const after = { ...doc.stats(), bytes: serializedSize(doc) };

  return {
    ops: nOps,
    visibleChars: after.visible,
    opLogKB: Math.round(opLogSize(opLog) / 1024),
    beforeKB: Math.round(before.bytes / 1024),
    afterKB: Math.round(after.bytes / 1024),
    tombstonesBefore: before.tombstones,
    tombstonesAfter: after.tombstones,
    removed,
    reductionPct: Number((100 * (1 - after.bytes / before.bytes)).toFixed(1)),
    buildMs,
    compactMs,
    // The property that makes compaction safe rather than merely small.
    textUnchanged: doc.toString() === textBefore,
  };
}

if (isMainModule(import.meta.url)) {
  const sizes = process.argv.slice(2).map(Number).filter(Boolean);
  const rows = (sizes.length ? sizes : [1000, 10000]).map((n) => measure(n));
  console.log('| ops | visible chars | op log | doc before | doc after | tombstones before → after | reduction | compact ms | text unchanged |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const r of rows) {
    console.log(`| ${r.ops} | ${r.visibleChars} | ${r.opLogKB} KB | ${r.beforeKB} KB | ${r.afterKB} KB | ${r.tombstonesBefore} → ${r.tombstonesAfter} | ${r.reductionPct}% | ${r.compactMs} | ${r.textUnchanged} |`);
  }
  console.log(JSON.stringify(rows, null, 1));
  process.exit(rows.every((r) => r.textUnchanged) ? 0 : 1);
}
