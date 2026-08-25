/**
 * A deliberately hostile network simulator.
 *
 * Convergence under a *good* network is not evidence of anything - every broken
 * design converges when messages arrive once, in order, immediately. The claim
 * worth making is convergence under latency, reordering, duplication and loss,
 * so that is what this produces.
 *
 * Everything is driven by a seeded PRNG, so a failing trial is reproducible from
 * its seed alone. A property test you cannot replay is a flaky test.
 */

import { pathToFileURL } from 'node:url';

/** True only when this file is the process entry point.
 *
 * Guarded on argv[1] existing: under `node -e` or `node --eval` there is no
 * script path, and calling pathToFileURL(undefined) throws -- which would make
 * merely IMPORTING this module crash the caller.
 */
export function isMainModule(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}

/** mulberry32: small, fast, seedable. Deterministic across runs and platforms. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DEFAULT_CONDITIONS = {
  minLatency: 50,
  maxLatency: 500,
  dropRate: 0.05,
  duplicateRate: 0.03,
  // With retransmission on, a "dropped" message is eventually redelivered, which
  // is what a real transport does. Without it, a dropped op is gone forever and
  // no CRDT can converge -- that is a transport failure, not a CRDT failure, and
  // conflating the two produces a test that "proves" the wrong thing.
  retransmit: true,
  retransmitDelay: 800,
};

export class Network {
  constructor(replicas, conditions = {}, rng = makeRng(1)) {
    this.replicas = new Map(replicas.map((r) => [r.site, r]));
    this.conditions = { ...DEFAULT_CONDITIONS, ...conditions };
    this.rng = rng;
    this.clock = 0;
    this.queue = [];          // { deliverAt, to, op }
    this.stats = { sent: 0, delivered: 0, dropped: 0, duplicated: 0, retransmitted: 0 };
  }

  /** Broadcast an op from one site to all others, subject to the conditions. */
  broadcast(fromSite, op) {
    for (const [site] of this.replicas) {
      if (site === fromSite) continue;
      this.send(site, op, false);
    }
  }

  send(to, op, isRetransmit) {
    const c = this.conditions;
    this.stats.sent += 1;

    if (this.rng() < c.dropRate) {
      this.stats.dropped += 1;
      if (c.retransmit) {
        this.stats.retransmitted += 1;
        this.queue.push({ deliverAt: this.clock + c.retransmitDelay, to, op });
      }
      return;
    }

    const latency = c.minLatency + this.rng() * (c.maxLatency - c.minLatency);
    this.queue.push({ deliverAt: this.clock + latency, to, op });

    // Duplicates: the same op delivered twice. The CRDT must absorb it via its
    // idempotence, and this is the cheapest way to test that continuously.
    if (this.rng() < c.duplicateRate) {
      this.stats.duplicated += 1;
      const dupLatency = c.minLatency + this.rng() * (c.maxLatency - c.minLatency);
      this.queue.push({ deliverAt: this.clock + dupLatency, to, op });
    }
    if (isRetransmit) this.stats.retransmitted += 1;
  }

  /** Advance time, delivering everything due. Delivery order is by time, so
   *  messages sent earlier can and do arrive after messages sent later. */
  tick(ms = 100) {
    this.clock += ms;
    const due = this.queue.filter((m) => m.deliverAt <= this.clock);
    this.queue = this.queue.filter((m) => m.deliverAt > this.clock);
    // Sort by delivery time; ties keep queue order. Reordering across sites is
    // the natural consequence of variable latency, not something forced here.
    due.sort((a, b) => a.deliverAt - b.deliverAt);
    for (const m of due) {
      const replica = this.replicas.get(m.to);
      if (replica) {
        replica.receive(m.op);
        this.stats.delivered += 1;
      }
    }
    return due.length;
  }

  /** Run until the network is empty and every replica has drained its buffer. */
  quiesce(maxSteps = 10000) {
    let steps = 0;
    while (steps < maxSteps) {
      steps += 1;
      const delivered = this.tick(100);
      const pending = [...this.replicas.values()].reduce((n, r) => n + r.pending.length, 0);
      if (this.queue.length === 0 && delivered === 0 && pending === 0) return steps;
    }
    throw new Error(`network did not quiesce within ${maxSteps} steps`);
  }
}

/** Partition helper: nothing crosses between the two groups until healed. */
export class PartitionedNetwork extends Network {
  constructor(replicas, conditions, rng, groupA = []) {
    super(replicas, conditions, rng);
    this.groupA = new Set(groupA);
    this.partitioned = groupA.length > 0;
    this.held = [];
  }

  sameSide(a, b) {
    return this.groupA.has(a) === this.groupA.has(b);
  }

  broadcast(fromSite, op) {
    for (const [site] of this.replicas) {
      if (site === fromSite) continue;
      if (this.partitioned && !this.sameSide(fromSite, site)) {
        // Held, not dropped: this models an offline client whose edits are
        // buffered locally and flushed on reconnect.
        this.held.push({ to: site, op });
        continue;
      }
      this.send(site, op, false);
    }
  }

  heal() {
    this.partitioned = false;
    for (const { to, op } of this.held) this.send(to, op, false);
    const n = this.held.length;
    this.held = [];
    return n;
  }
}
