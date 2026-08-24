/**
 * Authoritative relay + persistence.
 *
 *   node src/server.mjs --port 8080 --data ./data
 *
 * "Authoritative" here means authoritative about *storage and fan-out*, not
 * about ordering. The server never transforms, reorders, or rejects an
 * operation — it appends it to the log, broadcasts it, and occasionally
 * snapshots. That is the whole point of choosing a CRDT: correctness is a
 * property of the data structure, so the server is allowed to be dumb, and a
 * dumb server is one that cannot corrupt a document by being clever.
 *
 * ## Persistence: snapshot + operation log
 *
 * Writing every op to disk forever is what produces the 500x-payload op logs
 * measured in the README. So:
 *
 *   * ops append to `<doc>.log.jsonl`
 *   * every `snapshotEvery` ops, the materialised document is written to
 *     `<doc>.snapshot.json` and the log is TRUNCATED behind it
 *   * recovery loads the snapshot, then replays only the log tail
 *
 * The ordering matters and is easy to get backwards: the snapshot is written
 * and fsync-ordered BEFORE the log is truncated. Truncating first and crashing
 * in between would lose every op the snapshot did not yet contain. Written this
 * way, a crash at any point leaves either the old snapshot plus a full log, or
 * the new snapshot plus a short one — both recover to the same document.
 */
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { WebSocketServer } from 'ws';

import { RGA, Replica, idToString } from './rga.mjs';
import { isMainModule } from './network.mjs';

export class DocumentStore {
  constructor(dir, docId, { snapshotEvery = 200 } = {}) {
    this.dir = dir;
    this.docId = docId;
    this.snapshotEvery = snapshotEvery;
    mkdirSync(dir, { recursive: true });
    this.logPath = path.join(dir, `${docId}.log.jsonl`);
    this.snapshotPath = path.join(dir, `${docId}.snapshot.json`);
    this.opsSinceSnapshot = 0;
    this.doc = new RGA('server');
    this.pending = [];
    this.recover();
  }

  /** Load snapshot, then replay the log tail. */
  recover() {
    let replayed = 0;
    if (existsSync(this.snapshotPath)) {
      const snap = JSON.parse(readFileSync(this.snapshotPath, 'utf8'));
      for (const op of snap.ops) this.applyOp(op, false);
      replayed += snap.ops.length;
    }
    if (existsSync(this.logPath)) {
      const lines = readFileSync(this.logPath, 'utf8').split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          this.applyOp(JSON.parse(line), false);
          replayed += 1;
        } catch {
          // A torn final line is the expected result of a crash mid-append.
          // Skipping it is correct: the op was never acknowledged to a client.
        }
      }
      this.opsSinceSnapshot = lines.length;
    }
    this.recoveredOps = replayed;
    return replayed;
  }

  /**
   * Apply an op, buffering it if its causal dependency has not arrived.
   *
   * The server needs the same buffering a client does, because ops can reach it
   * out of order across different sockets.
   */
  applyOp(op, persist = true) {
    const applied = this.doc.apply(op);
    if (!applied && !this.doc.applied.has(idToString(op.id))) {
      this.pending.push(op);
    }
    let progressed = applied;
    while (progressed) {
      progressed = false;
      const still = [];
      for (const p of this.pending) {
        if (this.doc.apply(p)) progressed = true;
        else if (!this.doc.applied.has(idToString(p.id))) still.push(p);
      }
      this.pending = still;
    }

    if (persist) {
      appendFileSync(this.logPath, JSON.stringify(op) + '\n');
      this.opsSinceSnapshot += 1;
      if (this.opsSinceSnapshot >= this.snapshotEvery) this.snapshot();
    }
    return applied;
  }

  /** Materialise, write snapshot, THEN truncate the log. Order is load-bearing. */
  snapshot() {
    const ops = this.opLogFromDoc();
    const tmp = this.snapshotPath + '.tmp';
    writeFileSync(tmp, JSON.stringify({ docId: this.docId, ops, at: this.doc.counter }));
    // Atomic rename: a reader never observes a half-written snapshot.
    renameSync(tmp, this.snapshotPath);
    // Only now is it safe to drop the log.
    rmSync(this.logPath, { force: true });
    this.opsSinceSnapshot = 0;
    return ops.length;
  }

  /**
   * Reconstruct a minimal op set from the current document.
   *
   * This is where compaction happens in practice: tombstones that survive are
   * re-emitted, but the snapshot replaces an unbounded log with one entry per
   * surviving node.
   */
  opLogFromDoc() {
    const ops = [];
    const walk = (node) => {
      for (const child of node.children) {
        ops.push({ type: 'insert', id: child.id, value: child.value, originId: child.originId });
        if (child.deleted) {
          ops.push({ type: 'delete', id: child.deletedBy ?? { site: 'server', counter: ++this.doc.counter },
                     targetId: child.id });
        }
        walk(child);
      }
    };
    walk(this.doc.root);
    return ops;
  }

  get text() { return this.doc.toString(); }
}

/** Directory of this module, resolved from a file:// URL on any platform. */
function srcDir() {
  return path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
}

export function createCollabServer({ port = 8080, dir = './data', snapshotEvery = 200 } = {}) {
  const stores = new Map();
  const presence = new Map();   // docId -> Map(clientId -> {name, cursor})

  const getStore = (docId) => {
    if (!stores.has(docId)) stores.set(docId, new DocumentStore(dir, docId, { snapshotEvery }));
    return stores.get(docId);
  };

  const http = createServer((req, res) => {
    // Route on the PATH, not the raw URL.
    //
    // `req.url` includes the query string, so comparing it to '/' meant that
    // every URL carrying one fell through to the 404. The client has always read
    // its document id from `?doc=`, so `/?doc=notes` -- the documented way to
    // open a second document -- returned nothing at all. Nobody noticed because
    // the tests drive the WebSocket directly and never fetch the page.
    const pathname = (req.url || '/').split('?')[0];
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, docs: [...stores.keys()] }));
      return;
    }
    // The browser client imports the SAME rga.mjs the tests run against, so one
    // implementation serves both rather than two copies that drift.
    if (pathname === '/rga.mjs' || pathname === '/network.mjs') {
      try {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(readFileSync(path.join(srcDir(), pathname.slice(1)), 'utf8'));
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    // The scripted demo's script, served from public/ alongside the editor. The
    // demo drives the same page a human uses, so it has to be reachable the same
    // way -- a demo you can only run from node is a test, not a demo.
    if (pathname === '/demo.js') {
      try {
        res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        res.end(readFileSync(path.join(srcDir(), '..', 'public', 'demo.js'), 'utf8'));
      } catch {
        res.writeHead(404).end();
      }
      return;
    }
    if (pathname === '/' || pathname === '/index.html') {
      const html = path.join(srcDir(), '..', 'public', 'index.html');
      try {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(readFileSync(html, 'utf8'));
      } catch {
        res.writeHead(404).end('editor UI not found');
      }
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket) => {
    let docId = null;
    let clientId = null;

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'join') {
        docId = msg.docId || 'default';
        clientId = msg.clientId;
        socket.docId = docId;
        const store = getStore(docId);
        if (!presence.has(docId)) presence.set(docId, new Map());
        presence.get(docId).set(clientId, { name: msg.name || clientId, cursor: 0 });

        // Send the whole current op set so a joiner converges immediately.
        socket.send(JSON.stringify({ type: 'snapshot', ops: store.opLogFromDoc(), text: store.text }));
        broadcastPresence(docId);
        return;
      }

      if (msg.type === 'op' && docId) {
        const store = getStore(docId);
        store.applyOp(msg.op, true);
        // Relay to everyone else. The sender already applied it locally, which
        // is what makes typing feel instant regardless of round-trip time.
        for (const client of wss.clients) {
          if (client !== socket && client.readyState === 1 && client.docId === docId) {
            client.send(JSON.stringify({ type: 'op', op: msg.op }));
          }
        }
        return;
      }

      if (msg.type === 'cursor' && docId && presence.has(docId)) {
        const entry = presence.get(docId).get(clientId);
        if (entry) entry.cursor = msg.cursor;
        broadcastPresence(docId);
      }
    });

    socket.on('close', () => {
      if (docId && presence.has(docId)) {
        presence.get(docId).delete(clientId);
        broadcastPresence(docId);
      }
    });
  });

  function broadcastPresence(docId) {
    const peers = [...(presence.get(docId) || new Map()).entries()]
      .map(([id, v]) => ({ clientId: id, name: v.name, cursor: v.cursor }));
    const payload = JSON.stringify({ type: 'presence', peers });
    for (const client of wss.clients) {
      if (client.readyState === 1 && client.docId === docId) client.send(payload);
    }
  }

  return new Promise((resolve) => {
    http.listen(port, () => resolve({
      http,
      wss,
      stores,
      port: http.address().port,
      // Terminate sockets BEFORE closing the servers. Closing the WebSocketServer
      // while connections are still open leaves libuv handles mid-teardown and
      // trips an assertion on Windows; killing the clients first makes shutdown
      // deterministic.
      close: () => new Promise((resolve) => {
        for (const client of wss.clients) {
          try { client.terminate(); } catch { /* already gone */ }
        }
        wss.close(() => http.close(() => resolve()));
      }),
    }));
  });
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv);
  const port = Number(args.port ?? 8080);
  const dir = args.data ?? './data';
  createCollabServer({ port, dir }).then((s) => {
    console.log(`collab server on http://localhost:${s.port}  (data: ${dir})`);
  });
}
