/**
 * Keystroke-to-remote-render latency, measured against the real server.
 *
 *   node src/latency.mjs --clients 4 --keystrokes 300
 *
 * Definition, because this number is meaningless without one: the interval from
 * the moment client A applies a local edit to the moment client B has APPLIED
 * that same operation to its own replica. That is the delay a human perceives - * not the socket round trip, and not the server's processing time.
 *
 * Local echo is deliberately excluded. A CRDT applies the local edit
 * immediately, so keystroke-to-LOCAL-render is sub-millisecond by construction
 * and quoting it would be meaningless. The interesting number is when the other
 * person sees it.
 */
import { performance } from 'node:perf_hooks';

import WebSocket from 'ws';

import { Replica } from './rga.mjs';
import { isMainModule } from './network.mjs';
import { createCollabServer } from './server.mjs';

function percentile(sorted, p) {
  if (!sorted.length) return NaN;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

class Client {
  constructor(url, docId, clientId) {
    this.replica = new Replica(clientId);
    this.clientId = clientId;
    this.docId = docId;
    this.url = url;
    // Send time of every op this client ORIGINATED, so a peer can compute the
    // one-way delay when it applies that op.
    this.sentAt = new Map();
    this.received = [];
  }

  connect(onOp) {
    return new Promise((resolve) => {
      this.ws = new WebSocket(this.url);
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'join', docId: this.docId, clientId: this.clientId }));
        resolve();
      });
      this.ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'snapshot') {
          for (const op of msg.ops) this.replica.receive(op);
        } else if (msg.type === 'op') {
          this.replica.receive(msg.op);
          onOp?.(msg.op, performance.now());
        }
      });
    });
  }

  typeChar(ch) {
    const len = this.replica.doc.length;
    const op = this.replica.localInsert(Math.min(len, Math.floor(Math.random() * (len + 1))), ch);
    const t = performance.now();
    this.ws.send(JSON.stringify({ type: 'op', op }));
    return { op, t };
  }

  close() { this.ws?.close(); }
}

export async function measure({ clients = 4, keystrokes = 200, port = 0, dir = './data/latency',
                                intervalMs = 8 } = {}) {
  const server = await createCollabServer({ port, dir, snapshotEvery: 10_000 });
  const url = `ws://127.0.0.1:${server.port}`;
  const docId = 'latency-' + Date.now();

  // Shared clock: all clients are in one process, so performance.now() is
  // directly comparable between them. That removes clock skew from the
  // measurement -- and also means this does NOT capture real cross-machine
  // clock differences, which is stated in the README.
  const originTimes = new Map();
  const samples = [];

  const cs = [];
  for (let i = 0; i < clients; i += 1) {
    const c = new Client(url, docId, `c${i}`);
    await c.connect((op, at) => {
      const sent = originTimes.get(`${op.id.site}:${op.id.counter}`);
      if (sent !== undefined) samples.push(at - sent);
    });
    cs.push(c);
  }

  await new Promise((r) => setTimeout(r, 150));

  const alphabet = 'abcdefghijklmnopqrstuvwxyz ';
  for (let i = 0; i < keystrokes; i += 1) {
    const c = cs[i % cs.length];
    const ch = alphabet[Math.floor(Math.random() * alphabet.length)];
    const { op, t } = c.typeChar(ch);
    originTimes.set(`${op.id.site}:${op.id.counter}`, t);
    await new Promise((r) => setTimeout(r, intervalMs));
  }

  // Let the tail drain.
  await new Promise((r) => setTimeout(r, 800));

  const texts = cs.map((c) => c.replica.text);
  const fingerprints = cs.map((c) => c.replica.fingerprint());
  const converged = fingerprints.every((f) => f === fingerprints[0]);

  for (const c of cs) c.close();
  await server.close();

  const sorted = [...samples].sort((a, b) => a - b);
  return {
    clients,
    keystrokes,
    interval_ms: intervalMs,
    samples: sorted.length,
    expected_samples: keystrokes * (clients - 1),
    p50_ms: Number(percentile(sorted, 50)?.toFixed(2)),
    p95_ms: Number(percentile(sorted, 95)?.toFixed(2)),
    p99_ms: Number(percentile(sorted, 99)?.toFixed(2)),
    max_ms: Number(sorted[sorted.length - 1]?.toFixed(2)),
    converged,
    doc_length: texts[0].length,
    definition: ('keystroke-to-remote-APPLY: local edit on client A -> operation applied to '
                 + 'replica B. Local echo excluded (sub-ms by construction in a CRDT).'),
    caveat: ('all clients share one Node process and one clock, over loopback. This measures '
             + 'the server + fan-out path with no network and no clock skew, so it is a FLOOR.'),
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = Number(argv[i + 1]);
  return out;
}

if (isMainModule(import.meta.url)) {
  const args = parseArgs(process.argv);
  measure({ clients: args.clients ?? 4, keystrokes: args.keystrokes ?? 200 }).then((r) => {
    console.log(JSON.stringify(r, null, 2));
    process.exit(r.converged ? 0 : 1);
  });
}
