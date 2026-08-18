# Real-Time Collaborative Editor (CRDT)

A hand-rolled RGA sequence CRDT, a deliberately hostile network simulator, and a
randomised convergence harness that runs **1,000 trials** — plus a broken control
implementation kept in the repo to prove the harness can actually fail.

> **Status: ~40% built.** The CRDT, the network simulator, the convergence
> harness, offline merge, and tombstone compaction are done and **measured**. The
> server, the browser UI, presence and the Yjs production path are not — see
> [Roadmap](#roadmap). There is no running editor yet, and no
> keystroke-to-render latency number is claimed.

## The headline result

```
$ npm run converge

trials              1000
clients                3
implementation       RGA
conditions   { latency 50-500ms, dropRate 0.05, duplicateRate 0.03 }
passed              1000
failed                 0
```

| suite | trials | clients | result |
|---|---|---|---|
| standard conditions | 1,000 | 3 | **1000 / 1000 converged** |
| standard conditions | 200 | 10 | **200 / 200 converged** |
| heavy chaos (25% loss, 20% duplication) | 50 | 4 | **50 / 50 converged** |
| **broken control** | 200 | 3 | **0 / 200 converged** — as it must |

Convergence is checked on the **full structural fingerprint including
tombstones**, not just the visible text. Two replicas that agree on text but
disagree on structure will diverge on the very next concurrent insert, so
comparing text alone is a test that passes right up until it matters.

## The control group is the point

A convergence test that has never failed proves nothing — it may be asserting
something trivially true. So `src/broken.mjs` contains `IndexReplica`: the naive
"two browser tabs and socket.io broadcasting keystrokes" design, where operations
carry an **index** and remote ops are applied at that index.

```
$ node src/harness.mjs --trials 200 --broken 1

passed    0
failed  200
the harness caught the broken implementation on 200/200 trials, as it must
```

It is broken for exactly one reason: an index is only meaningful relative to the
document state that produced it. By the time the op arrives, concurrent edits
have shifted everything after that position. The exit code for this run is
**inverted** — if the broken implementation ever converges, the harness has no
teeth and the build should fail.

Every failure reports a **seed**, and `runTrial({ seed })` replays it exactly. A
property test you cannot replay is a flaky test.

## Why it converges (the whiteboard version)

Every character is an immutable node with a unique id `{site, counter}`, inserted
**after a specific node** (its origin) — never at an index.

When two sites insert after the *same* origin concurrently, both inserts are kept
and their sibling order is decided by a total order on ids. Every replica applies
the same comparison to the same set of nodes, so every replica reaches the same
sequence with no further messages.

The worked three-op example, the CRDT-vs-OT comparison, and the
overlapping-offline-delete walkthrough are in
**[docs/CRDT_NOTES.md](docs/CRDT_NOTES.md)**.

## The network simulator is hostile on purpose

Convergence under a *good* network is not evidence of anything — every broken
design converges when messages arrive once, in order, immediately.

Latency 50–500 ms, 5% loss, 3% duplication, reordering as a natural consequence
of variable latency, and **retransmission on loss**. That last one matters: a
permanently dropped op means no CRDT can converge, so testing without
retransmission "proves" a transport failure rather than a CRDT failure.
Everything is driven by a seeded PRNG.

## Offline editing

`PartitionedNetwork` holds a client's operations rather than dropping them —
modelling a client that buffers locally while offline. On `heal()`, the buffered
edits flush and the harness asserts every replica converges.
`test('offline edits merge on reconnect')` runs five seeded scenarios and also
asserts the partition actually held edits back, so the test cannot pass
vacuously.

## Tombstone compaction, and the bug the test caught

Tombstones cannot be removed eagerly, because a concurrent insert may still name
one as its origin — that is where CRDT metadata growth comes from. Compaction
needs a **stable version vector**: the per-site counter every site has
acknowledged.

**The subtle part.** It is tempting to check whether the *node's insert id* is
stable. That is wrong, and the first version of this code did exactly that. A
node inserted an hour ago is stable, but if its *deletion* is two seconds old and
a peer has not seen it yet, that peer can still emit an insert naming the node as
its origin — compact it away and that insert can never be placed. Permanent
divergence. The check must be on the **delete operation's** id, which is why
nodes now carry `deletedBy`.

`test('compaction refuses to remove tombstones past the stable frontier')` fails
against the wrong version. That is how the bug was found.

Measured (3 replicas, 40% delete rate, this machine):

| ops | visible chars | op log | doc before | doc after | tombstones removed | reduction | text unchanged |
|---|---|---|---|---|---|---|---|
| 1,000 | 216 | 94 KB | 25 KB | 9 KB | 390 | 64.5% | true |
| 10,000 | 2,097 | 961 KB | 258 KB | 90 KB | 3,928 | 65.2% | true |
| 100,000 | 19,682 | 9,799 KB | 2,668 KB | 882 KB | 39,881 | 67.0% | true |

Note the ratio that motivates all of this: at 100K operations the op log is
**9.8 MB for a 19.7 KB document** — roughly 500× the payload. Compaction takes
the live structure from 2.67 MB to 882 KB and the text is byte-identical before
and after, which is the property that makes it safe rather than merely small.

## Scope: plain text only, deliberately

Rich text is a scope trap. Concurrent formatting over overlapping ranges is a
substantially harder problem than sequence convergence, and a half-finished
rich-text CRDT with flaky bold buttons is worth less than bulletproof plain text.
This project does plain text and says so.

## Run it

```bash
npm test                # 17 tests, no dependencies
npm run converge        # 1000 trials, 3 clients
npm run converge:10     # 200 trials, 10 clients
npm run compaction      # tombstone growth at 1K and 10K ops
npm run compaction:big  # the 100K row (slow -- see the O(n) note below)
node src/harness.mjs --trials 200 --broken 1   # the control group
```

**Zero dependencies.** Node's built-in test runner and a hand-written seeded
PRNG. `fast-check` would be the conventional choice for property testing and is
the right one for a larger surface; the harness here is ~40 lines of generator
plus a seed, and vendoring a dependency for that was not worth it.

## Roadmap (the remaining ~60%)

| Milestone | Status |
|---|---|
| RGA CRDT with tombstones and causal buffering | done |
| Hostile network simulator (latency/loss/dup/reorder) | done |
| 1,000-trial randomised convergence harness | done |
| Broken control implementation proving the harness fails | done |
| Offline partition + reconnect merge | done |
| Tombstone compaction with a stable version vector | done |
| CRDT vs OT write-up | done |
| **Yjs integration as the production path** | not started |
| **WebSocket relay server with snapshot + op-log persistence** | not started |
| **Document recovery on server restart** | not started |
| **Browser UI, cursors, presence (who's online)** | not started |
| **Keystroke-to-remote-render latency distribution** | **not measured** |
| **Scripted 10-minute offline demo** | not started (simulated equivalent exists) |

## Honesty notes

* **There is no editor.** No server, no UI, no browser. This is the correctness
  core plus its test harness, and every claim above is about convergence, not
  about a running product.
* **No latency number is claimed.** Keystroke-to-remote-render requires the UI
  and server that do not exist yet. The simulator's latency figures are *inputs*
  to the chaos conditions, not measurements of anything.
* **The clients are simulated, in one process.** They exercise genuine concurrent
  edits and out-of-order delivery, but not real sockets, real clock skew, or
  browser event-loop behaviour.
* **This RGA is O(n) per operation** — `originForIndex` and `toArray` walk the
  whole tree, so building the document is quadratic in its size and the 100K-op
  measurement takes about ten minutes to produce. That is a property of the
  educational implementation, not of RGA: production CRDTs use a block-wise
  representation with an index structure. The measurement is honest about what it
  cost.
* The "500× the payload" figure is for a workload with a 40% delete rate and
  single-character operations, which is deliberately pessimistic. Real editing
  has run-length structure that block-wise CRDTs exploit heavily.
