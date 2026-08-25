/**
 * A two-replica CRDT sandbox that runs entirely in the page.
 *
 * This imports the SAME `Replica` class the server and the convergence harness
 * use. Nothing here reimplements the CRDT for the browser, because a demo built
 * on a second implementation would prove that the second implementation
 * converges and say nothing about the one that ships.
 *
 * The only thing the page adds is transport: instead of a WebSocket relay, ops
 * are handed straight to the other replica, optionally through a queue that the
 * Disconnect button holds shut. That is enough to show the property that makes a
 * CRDT worth the trouble, which is that concurrent edits made while apart merge
 * without a central arbiter deciding who wins.
 */
import { Replica } from "./rga.mjs";

const peers = {
  A: { rep: new Replica("A"), queue: [], el: null, mirror: "" },
  B: { rep: new Replica("B"), queue: [], el: null, mirror: "" },
};
let connected = true;

const $ = (id) => document.getElementById(id);
const other = (name) => (name === "A" ? "B" : "A");

/**
 * Turn a textarea edit into CRDT operations.
 *
 * The textarea gives us the new string, not the edit that produced it, so the
 * edit is recovered by trimming the common prefix and suffix. That is enough for
 * ordinary typing, paste and selection-replace, which is what this demo has to
 * survive.
 */
function diffToOps(peer, next) {
  const prev = peer.mirror;
  if (prev === next) return [];

  let start = 0;
  const max = Math.min(prev.length, next.length);
  while (start < max && prev[start] === next[start]) start++;

  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--;
    endNext--;
  }

  const ops = [];
  // Delete back to front: deleting front to back would shift every index that
  // has not been processed yet.
  for (let i = endPrev - 1; i >= start; i--) ops.push(peer.rep.localDelete(i));
  for (let i = start; i < endNext; i++) ops.push(peer.rep.localInsert(i, next[i]));

  peer.mirror = peer.rep.text;
  return ops.filter(Boolean);
}

function deliver(fromName, ops) {
  const target = peers[other(fromName)];
  if (connected) {
    for (const op of ops) target.rep.receive(op);
    syncView(other(fromName));
  } else {
    target.queue.push(...ops);
  }
  render();
}

function syncView(name) {
  const peer = peers[name];
  const text = peer.rep.text;
  if (peer.el.value !== text) {
    const pos = peer.el.selectionStart;
    peer.el.value = text;
    // Keep the caret where the typist left it rather than snapping to the end,
    // which is what makes a remote edit feel like a collaborator and not a reset.
    const delta = text.length - peer.mirror.length;
    const next = pos + (pos >= text.length - Math.max(delta, 0) ? delta : 0);
    peer.el.setSelectionRange(Math.max(0, next), Math.max(0, next));
  }
  peer.mirror = text;
}

function onInput(name) {
  const peer = peers[name];
  const ops = diffToOps(peer, peer.el.value);
  if (ops.length) deliver(name, ops);
  render();
}

function flush() {
  for (const name of ["A", "B"]) {
    const queued = peers[name].queue;
    peers[name].queue = [];
    for (const op of queued) peers[name].rep.receive(op);
  }
  for (const name of ["A", "B"]) syncView(name);
  render();
}

function render() {
  const fa = peers.A.rep.fingerprint();
  const fb = peers.B.rep.fingerprint();
  const same = fa === fb;

  $("fp-a").textContent = String(fa).slice(0, 16);
  $("fp-b").textContent = String(fb).slice(0, 16);
  $("len-a").textContent = peers.A.rep.length;
  $("len-b").textContent = peers.B.rep.length;
  $("q-a").textContent = peers.B.queue.length;
  $("q-b").textContent = peers.A.queue.length;

  const verdict = $("verdict");
  if (!connected) {
    const held = peers.A.queue.length + peers.B.queue.length;
    verdict.textContent = held
      ? "Disconnected. " + held + " operation(s) buffered, nothing lost."
      : "Disconnected. Type in both panes, then reconnect.";
    verdict.className = "verdict warn";
  } else if (same) {
    verdict.textContent = "Converged. Both replicas agree on every character and its order.";
    verdict.className = "verdict ok";
  } else {
    verdict.textContent = "Diverged (mid-delivery).";
    verdict.className = "verdict warn";
  }
}

function setConnected(next) {
  connected = next;
  $("toggle").textContent = connected ? "Disconnect them" : "Reconnect and merge";
  $("toggle").className = connected ? "btn out" : "btn solid";
  document.body.classList.toggle("offline", !connected);
  if (connected) flush();
  render();
}

function seedConflict() {
  setConnected(false);
  const a = peers.A;
  const b = peers.B;
  a.el.value = a.mirror + "the meeting is on Tuesday";
  onInput("A");
  b.el.value = b.mirror + " and Ana is presenting";
  onInput("B");
  render();
}

window.addEventListener("DOMContentLoaded", () => {
  peers.A.el = $("ta-a");
  peers.B.el = $("ta-b");
  for (const name of ["A", "B"]) {
    peers[name].el.addEventListener("input", () => onInput(name));
  }
  $("toggle").addEventListener("click", () => setConnected(!connected));
  $("conflict").addEventListener("click", seedConflict);
  $("reset").addEventListener("click", () => {
    peers.A = { rep: new Replica("A"), queue: [], el: peers.A.el, mirror: "" };
    peers.B = { rep: new Replica("B"), queue: [], el: peers.B.el, mirror: "" };
    peers.A.el.value = "";
    peers.B.el.value = "";
    setConnected(true);
  });
  render();
});
