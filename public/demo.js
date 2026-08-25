/**
 * The scripted offline demo.
 *
 *   http://localhost:8080/?demo=offline&speed=60
 *
 * Ten minutes of a two-writer session with one of them disconnected for four of
 * them, played as a fixed script so it produces the same story every time and
 * can be asserted on at the end instead of admired.
 *
 * ## Why it drives the UI rather than the CRDT
 *
 * Every step goes through `window.__crdt.type`, which writes into the textarea
 * and dispatches a real `input` event - so it runs the diff, the outbox and the
 * socket exactly as a human's keystroke does. A demo that called
 * `replica.localInsert` directly would prove the CRDT converges, which the
 * 1,000-trial harness already proves, and would say nothing about the
 * application wrapped around it.
 *
 * That distinction is not hypothetical. Writing this demo is what surfaced the
 * fact that the status line had always claimed "offline (edits buffered)" while
 * the send was guarded by `if (ws.readyState === 1)` with no else branch and no
 * reconnect. Offline edits were applied locally, shown to the user, and
 * silently dropped. The convergence harness could never have caught it: the bug
 * was not in the CRDT, it was in never handing the CRDT the operations.
 *
 * ## Compressed time
 *
 * `speed` divides every delay. `speed=1` is a real ten-minute demo to watch;
 * `speed=60` is a ten-second one for a check. The *script* is identical either
 * way - same steps, same order, same assertions - so the fast version is a test
 * of the slow one rather than a different thing that happens to look similar.
 */

const SCRIPT = [
  { at: 0, who: 'A', say: 'both writers connected', type: 'Design doc: rollout plan\n\n' },
  { at: 20, who: 'B', type: '1. Ship behind a flag\n' },
  { at: 40, who: 'A', type: '2. Canary to 5% of traffic\n' },
  { at: 60, who: 'B', say: 'B goes offline - lift, tunnel, flaky hotel wifi', offline: 'B' },
  { at: 75, who: 'B', type: '3. Watch error rate for 30 minutes\n' },
  { at: 110, who: 'A', type: '4. Roll forward to 50%\n' },
  { at: 150, who: 'B', type: '5. Have a rollback plan written down\n' },
  { at: 190, who: 'A', type: '6. Announce in #eng before 100%\n' },
  { at: 230, who: 'B', type: '   (B is still offline and still typing)\n' },
  { at: 300, who: 'B', say: 'B reconnects - four minutes of edits flush', online: 'B' },
  { at: 340, who: 'A', type: '7. Post-launch review the next morning\n' },
  { at: 380, who: 'B', type: '8. Delete the flag once it has soaked\n' },
  { at: 420, who: null, say: 'quiescent - both replicas must now be identical', check: true },
];

const TOTAL_SECONDS = 600;

export function plan(speedFactor = 1) {
  return SCRIPT.map((step) => ({ ...step, atMs: (step.at * 1000) / speedFactor }));
}

/**
 * Run the script against two `window.__crdt` surfaces.
 *
 * `a` and `b` are the two clients. In-page there is only one, so the runner
 * accepts a peer proxy - the browser demo drives its own window and reports what
 * it can see; `test/demo.test.mjs` drives two real WebSocket clients through the
 * same script and asserts convergence properly.
 */
export async function run(a, b, { speed = 1, log = console.log } = {}) {
  const steps = plan(speed);
  const started = Date.now();
  const events = [];

  for (const step of steps) {
    const wait = step.atMs - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const client = step.who === 'A' ? a : step.who === 'B' ? b : null;
    if (step.offline) (step.offline === 'A' ? a : b).goOffline();
    if (step.online) (step.online === 'A' ? a : b).goOnline();
    if (step.type && client) client.type(step.type);

    const line = {
      t: step.at,
      who: step.who,
      note: step.say || (step.type ? `typed ${JSON.stringify(step.type.trim().slice(0, 40))}` : ''),
      aOnline: a.online, bOnline: b.online,
      aOutbox: a.outboxSize, bOutbox: b.outboxSize,
      aChars: a.text.length, bChars: b.text.length,
    };
    events.push(line);
    log(`[${String(step.at).padStart(3)}s] ${step.who || '--'} ${line.note}` +
        `  A=${line.aChars}ch B=${line.bChars}ch` +
        (line.bOutbox ? `  B outbox=${line.bOutbox}` : ''));
  }

  // Quiescence. The last flush has to reach the relay and come back, and on a
  // compressed run that round trip is a larger share of the timeline than the
  // demo's own delays -- so it is waited for explicitly rather than assumed.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (a.fingerprint() === b.fingerprint() && a.outboxSize === 0 && b.outboxSize === 0) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  const converged = a.fingerprint() === b.fingerprint();
  return {
    converged,
    // Structural, not textual. Two replicas that agree on text but differ in
    // tombstone structure will diverge on the very next concurrent insert, so
    // the fingerprint is what the harness compares and it is what this compares.
    fingerprintsMatch: converged,
    textsMatch: a.text === b.text,
    chars: a.text.length,
    offlineEditsFlushed: events.some((e) => e.bOutbox > 0),
    maxOutbox: Math.max(...events.map((e) => e.bOutbox || 0)),
    events,
    totalSeconds: TOTAL_SECONDS,
    speed,
  };
}
