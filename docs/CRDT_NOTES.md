# CRDT notes: why it converges, and CRDT vs OT

## Why CRDTs converge without coordination

The intuition on a three-operation example, which is the version worth being able
to draw on a whiteboard.

Start: both replicas hold `XY`, with node ids `X = a:1`, `Y = a:2`.

Concurrently:
* Replica **a** inserts `A` between them → op `{id: a:3, origin: X}`
* Replica **b** inserts `B` between them → op `{id: b:3, origin: X}`

Both operations name the **same origin** (`X`), not the same *index*. That is the
whole trick: an index means "position 1 in the document I was looking at", which
is a statement about a document state the other replica never had. An origin
means "immediately after this specific character", which is true in every replica
that has seen that character.

Now both replicas have two children of `X`: `a:3` and `b:3`. They order siblings
by the same total order on ids (counter descending, then site id). Both compute
the identical order, so both produce `X B A Y` or both produce `X A B Y` —
whichever the comparison says, but **the same one**, and without exchanging
another message.

Formally the three properties are:
* **commutative** — applying `{opA, opB}` in either order gives the same state
* **associative** — grouping does not matter
* **idempotent** — re-applying a seen op is a no-op

`test/rga.test.mjs` asserts each of these directly rather than assuming them.

## Two clients delete overlapping ranges offline, then reconnect

Replica **a** deletes characters 2–5; replica **b** deletes 4–7. Neither has seen
the other.

Deletion is a **tombstone flag on a node**, not a splice of a range. So `a`'s
operation set is `delete(n2), delete(n3), delete(n4), delete(n5)` by *node id*,
and `b`'s is `delete(n4) … delete(n7)`. On reconnect both sets are applied
everywhere.

Nodes `n4` and `n5` receive a delete twice. Because deletion sets a flag rather
than removing an element, the second delete is a no-op — the flag is already
true. The result is `n2..n7` all deleted, on both replicas.

**This is exactly the case that breaks index-based (last-write-wins)
replication**: `b`'s "delete 4–7" applied after `a`'s deletion of 2–5 would
delete four characters starting at what is *now* position 4, which is a
completely different set of characters. `test/rga.test.mjs` covers the
concurrent-delete case, and `src/broken.mjs` is the control that demonstrates the
failure.

## CRDT vs OT — and what Google Docs knew

**Why CRDT here:** it needs no central server for correctness. Convergence is a
property of the data structure, so peers can merge directly, offline editing is
natural, and the server can be a dumb relay. For this project, that also makes
the correctness claim *testable in isolation* — the 1,000-trial harness never
starts a server.

**What OT gives up and gains:** Operational Transformation transforms incoming
operations against concurrent ones so that index-based ops become correct. It
needs a central authority to impose a total order, and the transformation
functions are famously hard to get right (several published OT algorithms were
later shown incorrect).

**What Google Docs knew.** Google Docs was built in the mid-2000s, when:

1. **The metadata cost was prohibitive.** CRDTs carry per-character metadata
   forever — the tombstone problem this project measures. At 2006 bandwidth and
   memory budgets, a 10× document overhead was not affordable.
2. **They already had a central server**, so OT's main drawback cost them
   nothing. If every edit flows through your infrastructure anyway, the
   "requires a central authority" objection is free.
3. **OT sends smaller operations.** An OT insert is a position and a character; a
   CRDT insert carries a unique id and an origin id.
4. **Rich text was the requirement from day one**, and rich-text CRDTs were not a
   solved problem then.

The honest summary: **OT was the right call for Google Docs in 2006, and CRDTs
are usually the right call for a new system today** — bandwidth and memory are
cheaper, offline-first is expected, and the peer-to-peer property has become
valuable rather than exotic.

## "Your op log is 50 MB for a 10 KB document. What now?"

This is the real operational pain of CRDTs, and it has two separate answers
because it is two separate problems.

**1. The op log grows without bound.** Every operation ever performed is in it.
Fix: **snapshot**. Persist the materialised document state periodically and
truncate the log behind the snapshot. A new client loads the snapshot plus the
tail, not the whole history.

**2. The document itself carries tombstones.** Even with a perfect snapshot, the
structure holds a node for every character ever typed. Fix: **compaction**, which
requires knowing when a tombstone can never be referenced again.

**When is that?** When every replica has seen the *deletion*. This is decided by a
**stable version vector** — the per-site counter every site has acknowledged.

**The subtle bug, which the test suite caught here:** it is tempting to check
whether the *node's insert id* is stable. That is wrong. A node inserted an hour
ago is stable, but if its *deletion* happened two seconds ago and a peer has not
seen it yet, that peer can still emit an insert naming the node as its origin.
Compact it away and that insert can never be placed — permanent divergence. The
check must be on the **delete operation's** id.
`test('compaction refuses to remove tombstones past the stable frontier')` fails
against the wrong version.

**Measured effect** (3 replicas, 40% delete rate, this machine):

| ops | visible chars | op log | doc before | doc after | tombstones removed | reduction | text unchanged |
|---|---|---|---|---|---|---|---|
| 1,000 | 216 | 94 KB | 25 KB | 9 KB | 390 | 64.5% | true |
| 10,000 | 2,097 | 961 KB | 258 KB | 90 KB | 3,928 | 65.2% | true |
| 100,000 | 19,682 | 9,799 KB | 2,668 KB | 882 KB | 39,881 | 67.0% | true |

Reproduce the first two rows with `npm run compaction`; the 100K row is
`npm run compaction:big` and takes about ten minutes, because this RGA is O(n)
per operation and building the document is therefore quadratic in its size.

Note the ratio that motivates all of this: at 100K operations the op log is
**9.8 MB for a 19.7 KB document** — roughly 500× the payload. Compaction takes
the live structure from 2.67 MB to 882 KB, and the text is byte-identical before
and after — which is the property that makes it safe rather than merely small.
