/**
 * RGA (Replicated Growable Array) - a sequence CRDT for plain text.
 *
 * This is the *educational* implementation. The production path in this project
 * would use Yjs; the point of writing one by hand is that "I npm-installed
 * correctness" and "I understand why it converges" are different claims, and
 * only the second one survives an interview.
 *
 * ## Why it converges without coordination
 *
 * Every character is an immutable node with a globally unique id
 * `{ site, counter }`. A node is inserted *after* a specific existing node
 * (its `origin`), never at an index - indices are the thing that shifts under
 * concurrent edits, which is exactly why last-write-wins over indices breaks.
 *
 * When two sites insert after the SAME origin concurrently, both inserts are
 * kept, and their order among the siblings is decided by a total order on ids
 * (counter descending, then site ascending). Every replica applies the same
 * tie-break to the same set of nodes, so every replica reaches the same
 * sequence - regardless of the order the operations arrived in.
 *
 * Deletion is a **tombstone**: the node stays in the structure with
 * `deleted: true`. It cannot be removed, because a concurrent insert may still
 * name it as an origin. That is where CRDT metadata growth comes from, and it is
 * the real-world pain point - addressed by `snapshot.mjs` rather than ignored.
 *
 * The three properties that make this a CRDT: applying operations is
 * **commutative** (order does not matter), **associative** (grouping does not
 * matter), and **idempotent** (re-applying a seen operation is a no-op). Those
 * are asserted directly in the test suite rather than assumed.
 */

/** Total order over node ids. Higher counter wins; site id breaks exact ties. */
export function compareIds(a, b) {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (a.counter !== b.counter) return a.counter - b.counter;
  return a.site < b.site ? -1 : a.site > b.site ? 1 : 0;
}

export function idToString(id) {
  return id === null ? 'ROOT' : `${id.site}:${id.counter}`;
}

export class RGA {
  constructor(site) {
    this.site = site;
    this.counter = 0;
    // Nodes keyed by id string. ROOT is a virtual head so that inserting at
    // position 0 has a real origin to name -- without it, "insert at the start"
    // is a special case and special cases are where convergence bugs live.
    this.nodes = new Map();
    this.root = { id: null, value: null, deleted: true, deletedBy: null, originId: null, children: [] };
    this.nodes.set('ROOT', this.root);
    this.applied = new Set();
  }

  nextId() {
    this.counter += 1;
    return { site: this.site, counter: this.counter };
  }

  /** Visible characters, in order. */
  toString() {
    return this.toArray().map((n) => n.value).join('');
  }

  toArray() {
    const out = [];
    const walk = (node) => {
      if (node !== this.root && !node.deleted) out.push(node);
      for (const child of node.children) walk(child);
    };
    walk(this.root);
    return out;
  }

  /** All nodes including tombstones - used by the compaction measurements. */
  allNodes() {
    const out = [];
    const walk = (node) => {
      if (node !== this.root) out.push(node);
      for (const child of node.children) walk(child);
    };
    walk(this.root);
    return out;
  }

  get length() {
    return this.toArray().length;
  }

  /** Map a visible index to the node it should be inserted after. */
  originForIndex(index) {
    if (index <= 0) return null;
    const visible = this.toArray();
    const node = visible[Math.min(index, visible.length) - 1];
    return node ? node.id : null;
  }

  /** Local edit: insert `value` at visible `index`. Returns the operation. */
  insert(index, value) {
    const op = {
      type: 'insert',
      id: this.nextId(),
      value,
      originId: this.originForIndex(index),
    };
    this.apply(op);
    return op;
  }

  /** Local edit: delete the character at visible `index`. */
  delete(index) {
    const visible = this.toArray();
    const target = visible[index];
    if (!target) return null;
    const op = { type: 'delete', id: this.nextId(), targetId: target.id };
    this.apply(op);
    return op;
  }

  insertText(index, text) {
    const ops = [];
    for (let i = 0; i < text.length; i += 1) {
      ops.push(this.insert(index + i, text[i]));
    }
    return ops;
  }

  /**
   * Apply an operation from anywhere (local or remote).
   *
   * Idempotent by the `applied` set, so a duplicated delivery is a no-op - which
   * is what lets the network layer retry freely.
   */
  apply(op) {
    const key = idToString(op.id);
    if (this.applied.has(key)) return false;

    if (op.type === 'insert') {
      const parent = this.nodes.get(idToString(op.originId));
      // Causal readiness: an insert whose origin has not arrived yet cannot be
      // placed. The caller (Replica) buffers it and retries. Dropping it here
      // instead would be a silent, unrecoverable divergence.
      if (!parent) return false;

      const node = { id: op.id, value: op.value, deleted: false, deletedBy: null, originId: op.originId, children: [] };
      // Insert among siblings by the total order on ids. Every replica runs this
      // same comparison over the same sibling set, which is the convergence
      // argument in one line.
      const siblings = parent.children;
      let i = 0;
      while (i < siblings.length && compareIds(siblings[i].id, op.id) > 0) i += 1;
      siblings.splice(i, 0, node);
      this.nodes.set(idToString(op.id), node);
      this.applied.add(key);
      // Keep the local counter ahead of anything seen, so ids stay unique.
      if (op.id.counter > this.counter) this.counter = op.id.counter;
      return true;
    }

    if (op.type === 'delete') {
      const target = this.nodes.get(idToString(op.targetId));
      if (!target) return false;      // delete arrived before its insert
      target.deleted = true;          // tombstone, never removed eagerly
      // Record WHICH operation deleted it. Compaction needs the delete op's id,
      // not the node's insert id: a node inserted long ago is stable, but if its
      // deletion is not yet known to every replica, removing it here would leave
      // us unable to place a peer's insert that names it as an origin.
      target.deletedBy = op.id;
      this.applied.add(key);
      if (op.id.counter > this.counter) this.counter = op.id.counter;
      return true;
    }

    throw new Error(`unknown op type: ${op.type}`);
  }

  /** Structural fingerprint including tombstones - replicas must match exactly. */
  fingerprint() {
    return this.allNodes()
      .map((n) => `${idToString(n.id)}${n.deleted ? '-' : '+'}${n.value ?? ''}`)
      .join('|');
  }

  stats() {
    const all = this.allNodes();
    return {
      visible: all.filter((n) => !n.deleted).length,
      tombstones: all.filter((n) => n.deleted).length,
      total: all.length,
      appliedOps: this.applied.size,
    };
  }
}

/**
 * A replica: an RGA plus the buffer that makes out-of-order delivery safe.
 *
 * Operations arriving before their causal dependencies are held and retried, not
 * dropped. This is what lets the network simulator reorder freely.
 */
export class Replica {
  constructor(site) {
    this.doc = new RGA(site);
    this.site = site;
    this.pending = [];
    this.maxPending = 0;
  }

  localInsert(index, value) { return this.doc.insert(index, value); }
  localDelete(index) { return this.doc.delete(index); }

  receive(op) {
    this.pending.push(op);
    this.drain();
  }

  /** Retry buffered ops until no further progress is possible. */
  drain() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const still = [];
      for (const op of this.pending) {
        if (this.doc.apply(op)) progressed = true;
        else if (!this.doc.applied.has(idToString(op.id))) still.push(op);
      }
      this.pending = still;
      this.maxPending = Math.max(this.maxPending, still.length);
    }
  }

  get text() { return this.doc.toString(); }

  /**
   * Visible length. `YjsReplica` has always had this and `Replica` had not,
   * which quietly broke the substitutability the two implementations are
   * supposed to have: anything reading `replica.length` got `undefined` from one
   * of them and a number from the other. The convergence harness never touched
   * it, so the gap survived until the demo client did.
   */
  get length() { return this.doc.length; }

  fingerprint() { return this.doc.fingerprint(); }
}
