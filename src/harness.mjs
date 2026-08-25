/**
 * The convergence harness - the centerpiece artifact.
 *
 * N simulated clients issue randomised concurrent edits over a hostile network.
 * After quiescence, every replica must be **byte-identical**, and not merely in
 * its visible text: the full structural fingerprint including tombstones must
 * match, because two replicas that agree on text today but disagree on structure
 * will diverge on the very next concurrent insert.
 *
 *   node src/harness.mjs --trials 1000 --clients 3
 */
import { Replica } from './rga.mjs';
import { Network, PartitionedNetwork, makeRng, DEFAULT_CONDITIONS, isMainModule } from './network.mjs';
import { IndexReplica } from './broken.mjs';
import { YjsReplica } from './yjs-replica.mjs';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz \n';

/** One randomised trial. Returns a verdict object; never throws on divergence. */
export function runTrial({ seed, clients = 3, rounds = 30, editsPerRound = 3, conditions = {},
                           broken = false, impl = 'rga' } = {}) {
  const rng = makeRng(seed);
  // Three implementations behind one interface: the hand-rolled RGA, Yjs as the
  // production path, and the deliberately broken control. The SAME harness runs
  // all three, which is what makes the comparison worth anything.
  const Impl = broken ? IndexReplica : (impl === 'yjs' ? YjsReplica : Replica);
  const replicas = [];
  for (let i = 0; i < clients; i += 1) replicas.push(new Impl(`s${i}`));

  const net = new Network(replicas, conditions, rng);

  for (let round = 0; round < rounds; round += 1) {
    for (const replica of replicas) {
      for (let e = 0; e < editsPerRound; e += 1) {
        const len = replica.doc.length;
        // Bias toward inserts so the document grows; deletes still fire often
        // enough to produce concurrent delete/insert interleavings, which is
        // where sequence CRDTs actually break.
        if (len > 0 && rng() < 0.3) {
          const op = replica.localDelete(Math.floor(rng() * len));
          if (op) net.broadcast(replica.site, op);
        } else {
          const ch = ALPHABET[Math.floor(rng() * ALPHABET.length)];
          const op = replica.localInsert(Math.floor(rng() * (len + 1)), ch);
          net.broadcast(replica.site, op);
        }
      }
    }
    net.tick(120);   // partial delivery between rounds -> genuine concurrency
  }

  net.quiesce();

  const fingerprints = replicas.map((r) => r.fingerprint());
  const texts = replicas.map((r) => r.text);
  const converged = fingerprints.every((f) => f === fingerprints[0]);
  const textsMatch = texts.every((t) => t === texts[0]);

  return {
    seed,
    clients,
    converged,
    textsMatch,
    length: texts[0].length,
    stats: net.stats,
    docStats: typeof replicas[0].doc.stats === 'function' ? replicas[0].doc.stats() : null,
    // Only populated on failure, so a passing run stays cheap to store.
    divergence: converged ? null : { fingerprints, texts },
  };
}

/** Offline-edit scenario: a client is partitioned, edits, and reconnects. */
export function runOfflineTrial({ seed, clients = 3, offlineRounds = 20, conditions = {} } = {}) {
  const rng = makeRng(seed);
  const replicas = [];
  for (let i = 0; i < clients; i += 1) replicas.push(new Replica(`s${i}`));

  // s0 goes offline; the rest keep collaborating.
  const net = new PartitionedNetwork(replicas, conditions, rng, ['s0']);

  for (let round = 0; round < offlineRounds; round += 1) {
    for (const replica of replicas) {
      const len = replica.doc.length;
      if (len > 0 && rng() < 0.25) {
        const op = replica.localDelete(Math.floor(rng() * len));
        if (op) net.broadcast(replica.site, op);
      } else {
        const ch = ALPHABET[Math.floor(rng() * ALPHABET.length)];
        const op = replica.localInsert(Math.floor(rng() * (len + 1)), ch);
        net.broadcast(replica.site, op);
      }
    }
    net.tick(120);
  }

  const offlineEdits = net.held.length;
  net.heal();
  net.quiesce();

  const fingerprints = replicas.map((r) => r.fingerprint());
  const converged = fingerprints.every((f) => f === fingerprints[0]);
  return {
    seed,
    converged,
    offlineEditsFlushed: offlineEdits,
    length: replicas[0].text.length,
    divergence: converged ? null : { fingerprints, texts: replicas.map((r) => r.text) },
  };
}

export function runSuite({ trials = 1000, clients = 3, conditions = {}, startSeed = 1, broken = false, impl = 'rga' } = {}) {
  const failures = [];
  let totalOps = 0;
  const t0 = Date.now();

  for (let i = 0; i < trials; i += 1) {
    const result = runTrial({ seed: startSeed + i, clients, conditions, broken, impl });
    totalOps += result.docStats?.appliedOps ?? 0;
    if (!result.converged) failures.push({ seed: result.seed, divergence: result.divergence });
  }

  return {
    trials,
    clients,
    implementation: broken ? 'IndexReplica (deliberately broken control)' : (impl === 'yjs' ? 'Yjs' : 'RGA'),
    conditions: { ...DEFAULT_CONDITIONS, ...conditions },
    passed: trials - failures.length,
    failed: failures.length,
    // Seeds are the whole point: a failure is reproducible with
    // `runTrial({ seed })` and nothing else.
    failingSeeds: failures.slice(0, 10).map((f) => f.seed),
    totalOpsApplied: totalOps,
    wallMs: Date.now() - t0,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    out[key] = Number(argv[i + 1]) || argv[i + 1];
  }
  return out;
}

// pathToFileURL rather than string-building a file:// URL: on Windows the naive
// version produces file://C:/... while import.meta.url is file:///C:/..., so the
// main-module check silently never fires and the script does nothing at all.
if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv);
  const trials = args.trials ?? 1000;
  const clients = args.clients ?? 3;
  const broken = Boolean(args.broken);
  const impl = args.impl === 'yjs' ? 'yjs' : 'rga';
  console.log(`running ${trials} randomised trials with ${clients} clients` +
              (broken ? ' against the DELIBERATELY BROKEN index-based replica...' : '...'));
  const summary = runSuite({ trials, clients, broken, impl });
  console.log(JSON.stringify(summary, null, 2));
  if (broken) {
    // Inverted exit code: the broken implementation MUST diverge. If it does
    // not, the harness is not actually testing anything.
    console.log(summary.failed > 0
      ? `\nthe harness caught the broken implementation on ${summary.failed}/${trials} trials, as it must`
      : '\nERROR: the broken implementation converged. The harness has no teeth.');
    process.exit(summary.failed > 0 ? 0 : 1);
  }
  process.exit(summary.failed === 0 ? 0 : 1);
}
