# Real-Time Collaborative Editor (CRDT)

A hand-rolled RGA sequence CRDT, a deliberately hostile network simulator, and a
randomised convergence harness that runs **1,000 trials** — plus a broken control
implementation kept in the repo to prove the harness can actually fail.

> **Status: ~100% of the spec built.** The CRDT, the network simulator, the
> convergence harness, offline merge, tombstone compaction, a **WebSocket relay
> with snapshot+log persistence and crash recovery**, a **working browser
> editor**, a **measured keystroke-to-remote-render latency**, **rendered remote
> cursors with presence**, and **Yjs as the production path behind the same
> interface and the same harness** are all done. What is *not* done is measuring
> latency across a real network — there is one machine here — see
> [Roadmap](#roadmap).

## Yjs and the hand-rolled RGA, behind one interface

The spec's signal is the *pairing*: shipped with the industry-standard tool, and
understood the internals. Two implementations behind one interface make that
checkable rather than claimed — **the same 1,000-trial harness runs against
both**, and the comparison below uses identical edit scripts.

```
$ npm run converge:yjs      # Yjs
$ npm run converge          # hand-rolled RGA
```

Both converge 1,000/1,000. The control still diverges 200/200, so the harness
retains its teeth against all three.

### The measured difference

Identical edit script, 35% deletes:

| ops | visible chars | RGA | Yjs | ratio | RGA ms | Yjs ms |
|---|---|---|---|---|---|---|
| 500 | 166 | 13.0 KB | 5.0 KB | 2.6x | **20** | 62 |
| 2,000 | 638 | 52.9 KB | 21.2 KB | 2.5x | 114 | 119 |
| 8,000 | 2,378 | 213.5 KB | 85.2 KB | 2.5x | 2,767 | **812** |

**Yjs is 2.5x smaller at every size**, because it run-length encodes adjacent
inserts: typing "hello" is one run in Yjs and five nodes in the RGA.

**On speed there is a crossover, and it goes the other way at small sizes.** At
500 ops the RGA is 3x *faster* — Yjs pays a fixed binary-codec cost that the
tiny document cannot amortise. By 8,000 ops Yjs is 3.4x faster and the gap is
widening, because this RGA is O(n) per operation and therefore quadratic overall.

Reporting only the 8,000-op row would have made Yjs look uniformly better. It is
not; it is better at the sizes that matter.

### Why Yjs is the production path anyway

Not because the RGA is wrong — the harness says it converges 1,000/1,000 under
packet loss. Because of what each is *for*:

* **Encoding.** The 2.5x, above.
* **Representation.** Yjs uses an index-accelerated linked list, so an insert at
  position *i* is not an O(n) walk. This RGA's O(n) is why its 100K-op
  measurement takes minutes.
* **Ecosystem.** Awareness, undo, providers, rich text — real work already done
  correctly by someone else.

The hand-rolled RGA earns its place by being **readable**: ~200 lines where the
convergence argument is visible in the sibling-ordering comparison. Yjs's
equivalent is spread through an optimised binary codec.

### A bug the port surfaced

The obvious fingerprint for a Yjs replica is its **state vector**. That is wrong,
and it produces false divergence: state vectors encode per-client clocks, so two
replicas that converged to identical content by *different delivery orders* carry
different vectors. The encoded document state is the content-addressed thing.
`test('the fingerprint is content-addressed, not the state vector')` builds
exactly that case — forward and reverse delivery of the same ops — and pins it.

## The scripted offline demo, and the three bugs it found

```bash
npm run demo          # then open
# http://localhost:8080/?demo=offline&speed=60
```

Ten minutes of a two-writer session with one writer disconnected for four of
them, played as a fixed script so it tells the same story every run and can be
asserted on at the end. `speed` divides every delay: `1` is the real ten minutes
to watch, `60` is ten seconds to check.

Verified in a browser, at 60x:

```
[ 60s] B B goes offline — lift, tunnel, flaky hotel wifi   A=68ch  B=68ch
[110s] A typed "4. Roll forward to 50%"                    A=98ch  B=110ch  B outbox=35
[230s] B typed "(B is still offline and still typing)"     A=130ch B=188ch  B outbox=113
[300s] B B reconnects — four minutes of edits flush        A=130ch B=188ch  B outbox=113
[420s] -- quiescent — both replicas must now be identical  A=320ch B=320ch

CONVERGED — 320 chars, 113 edits flushed on reconnect
```

**The demo drives the UI, not the CRDT.** Every step goes through
`window.__crdt.type`, which writes into the textarea and dispatches a real
`input` event — so it runs the diff, the outbox and the socket exactly as a
keystroke does. A demo calling `replica.localInsert` directly would prove the
CRDT converges, which the 1,000-trial harness already proves, and would say
nothing about the application wrapped around it.

That distinction paid immediately. Writing it found three bugs, none of which the
convergence harness could ever have caught, because none of them were in the CRDT.

### 1. "Offline (edits buffered)" was a lie

The status line had always said that. The send was:

```js
if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'op', op }));
```

No else branch, no queue — **and no reconnect anywhere in the file.** A closed
socket stayed closed forever. So a user could work offline, watch their text
appear on screen, come back, and lose every word of it, with the UI reporting
success throughout. The person who typed it is the last person who can tell,
because their own replica still shows it.

A CRDT makes convergence guaranteed *given delivery*. Nothing about it delivers
anything for you, and this is what that sentence looks like in practice.

Fixed with an outbox that queues ops while the socket is down and flushes them on
reconnect. At-least-once is the right shape here rather than a liability: CRDT
ops are idempotent, so a client unsure what got through can simply replay
everything — and a test asserts that redelivering an op the server already has
changes nothing. Cursor positions are deliberately *not* queued; a caret from four
minutes ago is not worth replaying.

`test/demo.test.mjs` keeps the broken version alongside the fixed one, so the
loss is reproduced rather than described.

### 2. Any URL with a query string returned 404

The route was `req.url === '/'`, and `req.url` includes the query string. The
client has always read its document id from `?doc=` — so `/?doc=notes`, the
documented way to open a second document, served **nothing at all**. Nobody
noticed because every test drives the WebSocket directly and none of them ever
fetched the page.

### 3. The two replica implementations were not actually substitutable

`YjsReplica` had a `length` getter and the hand-rolled `Replica` did not, so
anything reading `replica.length` got a number from one and `undefined` from the
other. The whole premise of having both is that they are interchangeable behind
one interface; the convergence harness never touched `length`, so the gap
survived until the demo client did.

## There is a working editor now

```bash
npm install
npm run serve          # http://localhost:8080
```

Open it in two windows and type in both. Verified end to end in a real browser:
window 1 typed `hello from the browser`, window 2 received it, window 2 appended
` | second window`, and window 1 converged to the identical 38 characters with
the peer counter correct in both.

The client imports **the same `src/rga.mjs`** the test suite runs against —
served straight from `src/` rather than vendored — so there is one implementation
rather than two that drift. A test asserts the UI imports it rather than a copy.

One UI detail that is easy to get wrong: a remote edit must not move your caret.
`render()` preserves the selection across a remote update, because the naive
version yanks the cursor to the end on every remote keystroke, which is the most
common bug in a hand-built collaborative textarea.

## Remote cursors and presence

Each peer appears in a strip with a stable colour and its caret is drawn over the
textarea. Verified live across two browser windows: window 2 placed its caret at
character 25 and window 1 rendered `c85k438 @ 25` at `translate(99px, 38px)` —
second line, mid-line. Moving it to character 2 moved the drawn caret to
`translate(29px, 16px)`, first line near the start.

**Measuring a caret inside a textarea is not directly possible** — a textarea
exposes no geometry for its content. The text up to the caret is laid out in a
hidden mirror div with *copied* computed style (font, padding, width, wrapping)
and the trailing span's box is read. Copying the style rather than hard-coding it
is what keeps the caret aligned when the font or padding changes.

**Cursor broadcasts are throttled to 50 ms.** A presence message per keystroke
costs more bandwidth than the edits themselves, and nobody perceives a caret
updating faster than ~20 Hz. A test asserts the throttle exists, because it is
the kind of thing that gets removed during debugging and never put back.

Colours are derived from a hash of the client id, so the same peer is always the
same colour rather than shuffling on every presence update.

## Keystroke-to-remote-render latency

```
$ npm run latency

clients            4
keystrokes       250
samples          750 / 750 expected
p50             2.39 ms
p95            21.59 ms
p99            52.16 ms
max           122.23 ms
converged       true
```

**The definition matters more than the number.** This is the interval from
client A applying a local edit to client B having *applied that same operation to
its own replica* — not the socket round trip, and not the server's processing
time. Local echo is deliberately excluded: a CRDT applies the local edit
immediately, so keystroke-to-*local*-render is sub-millisecond by construction
and quoting it would be meaningless.

**This is a floor, not a prediction.** All four clients share one Node process,
one clock, and loopback. There is no network and no clock skew, so the figure
measures the server plus fan-out path and nothing else. On a real network the p50
becomes the RTT.

All 750 expected samples arrived and every replica converged, which is the part
that makes the latency number worth reading at all.

## Persistence and crash recovery

The server is authoritative about **storage and fan-out, not ordering**. It never
transforms, reorders, or rejects an operation — it appends, broadcasts, and
snapshots. That is the payoff for choosing a CRDT: correctness lives in the data
structure, so the server is allowed to be dumb, and a dumb server cannot corrupt
a document by being clever.

Persistence is **snapshot + operation log**:

* ops append to `<doc>.log.jsonl`
* every N ops the materialised document is snapshotted and the log is truncated
* recovery loads the snapshot, then replays only the tail

**The write order is load-bearing and easy to get backwards.** The snapshot is
written and atomically renamed *before* the log is truncated. Truncating first
and crashing in between would lose every op the snapshot did not yet contain.
Written this way, a crash at any point leaves either the old snapshot plus a full
log, or the new snapshot plus a short one — and both recover to the same
document.

Four tests cover it, including **a torn final log line** — the expected result of
a crash mid-append — which must not prevent the complete prefix from recovering.

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
npm test                # 40 tests (CRDT + server + Yjs + the offline demo)
npm run converge        # 1000 trials, 3 clients
npm run converge:10     # 200 trials, 10 clients
npm run compaction      # tombstone growth at 1K and 10K ops
npm run compaction:big  # the 100K row (slow -- see the O(n) note below)
node src/harness.mjs --trials 200 --broken 1   # the control group
```

**Two dependencies** (`ws` for the relay, `yjs` for the production path). The CRDT, the convergence
harness and the compaction measurement have none — Node's built-in test runner
and a hand-written seeded PRNG. `fast-check` would be the conventional choice for property testing and is
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
| WebSocket relay with snapshot + op-log persistence | done |
| Document recovery on restart, incl. torn-log handling | done |
| Browser editor, verified converging across two windows | done |
| Presence (peer count); cursor positions relayed | done |
| Keystroke-to-remote-render latency measured | done |
| Remote cursors rendered, with throttled broadcasts and stable colours | done |
| Yjs as the production path, through the same harness | done |
| RGA-vs-Yjs size and speed comparison with a crossover | done |
| **Latency across a real network rather than loopback** | not measured: one machine |
| Scripted 10-minute offline demo, verified in a browser | done |
| Offline outbox + reconnect (the demo found these missing) | done |

## Honesty notes

* **The demo's ten minutes are scripted, not observed.** It is a fixed scenario
  chosen to exercise the offline path, not a recording of anyone actually
  working. What it establishes is that the application delivers operations across
  a real disconnection — not that this is what real usage looks like.
* **The compressed run and the real-time run share one script**, so the fast
  version is a test of the slow one. They are not two things that happen to look
  similar.
* **The RGA-vs-Yjs speed comparison is single-threaded on one machine**, and the
  crossover point (~2,000 ops) is a property of this hardware and this edit
  distribution, not a universal constant.
* **The latency figure is loopback, single-process, shared-clock.** It is a floor
  for the server and fan-out path, and says nothing about real network
  conditions. The README states that next to the number rather than below it.
* **Cursor geometry is measured via a mirror div**, which is the standard
  technique for a textarea but is approximate under unusual wrapping. A real
  editor uses a contenteditable surface or a custom renderer and knows its own
  layout exactly.
* **Selection ranges are not shown** — only caret positions. Highlighting another
  user's selected range needs range geometry, not a single point.
* **The convergence harness clients are still simulated in one process.** They
  exercise genuine concurrent edits and out-of-order delivery, but not real
  sockets or browser event-loop behaviour. The server tests use real WebSockets;
  the 1,000-trial harness does not.
* **This RGA is O(n) per operation** — `originForIndex` and `toArray` walk the
  whole tree, so building the document is quadratic in its size and the 100K-op
  measurement takes about ten minutes to produce. That is a property of the
  educational implementation, not of RGA: production CRDTs use a block-wise
  representation with an index structure. The measurement is honest about what it
  cost.
* The "500× the payload" figure is for a workload with a 40% delete rate and
  single-character operations, which is deliberately pessimistic. Real editing
  has run-length structure that block-wise CRDTs exploit heavily.
