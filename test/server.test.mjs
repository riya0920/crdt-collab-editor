import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import WebSocket from 'ws';

import { DocumentStore, createCollabServer } from '../src/server.mjs';
import { Replica } from '../src/rga.mjs';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'crdt-'));

function connect(url, docId, clientId) {
  const replica = new Replica(clientId);
  const ws = new WebSocket(url);
  const ready = new Promise((resolve) => {
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'join', docId, clientId }));
    });
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'snapshot') {
        for (const op of msg.ops) replica.receive(op);
        resolve();
      } else if (msg.type === 'op') {
        replica.receive(msg.op);
      }
    });
  });
  const type = (text, at = null) => {
    const ops = [];
    for (const ch of text) {
      const idx = at === null ? replica.doc.length : at + ops.length;
      const op = replica.localInsert(idx, ch);
      ops.push(op);
      ws.send(JSON.stringify({ type: 'op', op }));
    }
    return ops;
  };
  return { ws, replica, ready, type, close: () => ws.close() };
}

const settle = (ms = 250) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------ persistence */

test('document survives a restart via snapshot + log replay', () => {
  const dir = tmp();
  const a = new DocumentStore(dir, 'doc1', { snapshotEvery: 1000 });
  const client = new Replica('c1');
  for (const op of client.doc.insertText(0, 'hello world')) a.applyOp(op, true);
  assert.equal(a.text, 'hello world');

  // A fresh store over the same directory = a server restart.
  const b = new DocumentStore(dir, 'doc1', { snapshotEvery: 1000 });
  assert.equal(b.text, 'hello world');
  assert.ok(b.recoveredOps >= 11);
});

test('snapshot is written BEFORE the log is truncated', () => {
  const dir = tmp();
  const store = new DocumentStore(dir, 'doc2', { snapshotEvery: 5 });
  const client = new Replica('c1');
  for (const op of client.doc.insertText(0, 'abcdefgh')) store.applyOp(op, true);

  assert.ok(existsSync(store.snapshotPath), 'snapshot must exist after the threshold');
  const snap = JSON.parse(readFileSync(store.snapshotPath, 'utf8'));
  assert.ok(snap.ops.length > 0, 'snapshot must contain the document, not be empty');

  const recovered = new DocumentStore(dir, 'doc2', { snapshotEvery: 5 });
  assert.equal(recovered.text, store.text);
});

test('a torn final log line does not break recovery', () => {
  const dir = tmp();
  const store = new DocumentStore(dir, 'doc3', { snapshotEvery: 1000 });
  const client = new Replica('c1');
  for (const op of client.doc.insertText(0, 'stable')) store.applyOp(op, true);

  // Simulate a crash mid-append: a half-written JSON line.
  appendFileSync(store.logPath, '{"type":"insert","id":{"site":"c1","cou');

  const recovered = new DocumentStore(dir, 'doc3', { snapshotEvery: 1000 });
  assert.equal(recovered.text, 'stable', 'the complete prefix must still recover');
});

test('recovery after a snapshot preserves deletions', () => {
  const dir = tmp();
  const store = new DocumentStore(dir, 'doc4', { snapshotEvery: 4 });
  const client = new Replica('c1');
  for (const op of client.doc.insertText(0, 'abcdef')) store.applyOp(op, true);
  const del = client.localDelete(2);
  store.applyOp(del, true);
  const expected = store.text;

  const recovered = new DocumentStore(dir, 'doc4', { snapshotEvery: 4 });
  assert.equal(recovered.text, expected, 'a tombstone must survive snapshot + reload');
});

/* ------------------------------------------------------ relay */

test('two clients converge through the server', async () => {
  const dir = tmp();
  const server = await createCollabServer({ port: 0, dir, snapshotEvery: 1000 });
  const url = `ws://127.0.0.1:${server.port}`;

  const a = connect(url, 'shared', 'a');
  const b = connect(url, 'shared', 'b');
  await Promise.all([a.ready, b.ready]);

  a.type('hello');
  b.type('world');
  await settle(400);

  assert.equal(a.replica.text.length, 10);
  assert.equal(a.replica.fingerprint(), b.replica.fingerprint(),
    'replicas must converge structurally, not merely in visible text');

  a.close(); b.close();
  await server.close();
});

test('a late joiner receives the existing document', async () => {
  const dir = tmp();
  const server = await createCollabServer({ port: 0, dir, snapshotEvery: 1000 });
  const url = `ws://127.0.0.1:${server.port}`;

  const a = connect(url, 'late', 'a');
  await a.ready;
  a.type('already here');
  await settle(300);

  const b = connect(url, 'late', 'b');
  await b.ready;
  await settle(200);

  assert.equal(b.replica.text, a.replica.text);

  a.close(); b.close();
  await server.close();
});

test('the server persists what it relayed, and survives its own restart', async () => {
  const dir = tmp();
  let server = await createCollabServer({ port: 0, dir, snapshotEvery: 1000 });
  const port = server.port;
  const url = `ws://127.0.0.1:${port}`;

  const a = connect(url, 'persist', 'a');
  await a.ready;
  a.type('durable');
  await settle(300);
  const expected = a.replica.text;
  a.close();
  await server.close();

  // Restart on the same data directory.
  server = await createCollabServer({ port, dir, snapshotEvery: 1000 });
  const b = connect(`ws://127.0.0.1:${port}`, 'persist', 'b');
  await b.ready;
  await settle(200);

  assert.equal(b.replica.text, expected, 'the document must survive a server restart');
  b.close();
  await server.close();
});

test('the browser client and the tests share one rga.mjs', () => {
  const html = readFileSync(path.join(process.cwd(), 'public', 'index.html'), 'utf8');
  assert.ok(html.includes("from './rga.mjs'"),
    'the UI must import the same module, not a vendored copy that can drift');
});
