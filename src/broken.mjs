/**
 * The naive implementation, kept deliberately, so the harness can be shown to
 * FAIL on it.
 *
 * A convergence test that has never failed proves nothing - it may be asserting
 * something trivially true, or comparing replicas that were never given a chance
 * to diverge. This is the control group.
 *
 * `IndexReplica` is "two browser tabs and socket.io broadcasting keystrokes":
 * operations carry an **index**, and remote operations are applied at that index.
 * It is the design almost every tutorial collaborative editor uses, and it is
 * broken for one reason: an index is only meaningful relative to the document
 * state that produced it. By the time the operation arrives, concurrent edits
 * have shifted everything after that position, so the character lands in the
 * wrong place - and once two replicas disagree, they never recover.
 *
 * Run `node src/harness.mjs --broken 1` to watch it diverge.
 */

export class IndexDoc {
  constructor(site) {
    this.site = site;
    this.chars = [];
    this.counter = 0;
  }

  nextId() {
    this.counter += 1;
    return { site: this.site, counter: this.counter };
  }

  toString() { return this.chars.join(''); }
  get length() { return this.chars.length; }

  insert(index, value) {
    const i = Math.max(0, Math.min(index, this.chars.length));
    this.chars.splice(i, 0, value);
    return { type: 'insert', id: this.nextId(), index: i, value };
  }

  delete(index) {
    if (index < 0 || index >= this.chars.length) return null;
    this.chars.splice(index, 1);
    return { type: 'delete', id: this.nextId(), index };
  }

  apply(op) {
    // The bug, in two lines: the index came from ANOTHER replica's document
    // state, and is applied to this one as if the two were identical.
    if (op.type === 'insert') {
      const i = Math.max(0, Math.min(op.index, this.chars.length));
      this.chars.splice(i, 0, op.value);
      return true;
    }
    if (op.type === 'delete') {
      if (op.index < this.chars.length) this.chars.splice(op.index, 1);
      return true;
    }
    return false;
  }

  fingerprint() { return this.chars.join(''); }
  stats() {
    return { visible: this.chars.length, tombstones: 0, total: this.chars.length, appliedOps: this.counter };
  }
}

export class IndexReplica {
  constructor(site) {
    this.doc = new IndexDoc(site);
    this.site = site;
    this.pending = [];
    this.maxPending = 0;
  }

  localInsert(index, value) { return this.doc.insert(index, value); }
  localDelete(index) { return this.doc.delete(index); }
  receive(op) { this.doc.apply(op); }
  drain() {}
  get text() { return this.doc.toString(); }
  fingerprint() { return this.doc.fingerprint(); }
}
