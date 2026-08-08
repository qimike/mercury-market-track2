/**
 * Lightweight file-based persistence for the demo CLI only. The in-memory
 * stores (src/advisor/packetStore.ts, src/approvals/store.ts) are
 * per-process by design (so tests stay hermetic and fast) — this module
 * lets the CLI survive across separate `tsx src/cli/index.ts <command>`
 * invocations (each a new process) by snapshotting current state to
 * `.mercury-state/` (gitignored) on every mutating command and reloading it
 * on startup. This is demo-only convenience, not a real persistence
 * adapter — a production deployment would swap in a real database behind
 * the same store interfaces.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { recordSuggestionPacket, listAllSuggestionPackets } from "../advisor/packetStore.js";
import { recordApproval, listApprovals } from "../approvals/store.js";
import type { SessionManager } from "../agent/session.js";

const STATE_DIR = path.join(process.cwd(), ".mercury-state");
const PACKETS_FILE = path.join(STATE_DIR, "packets.json");
const APPROVALS_FILE = path.join(STATE_DIR, "approvals.json");
const SESSIONS_FILE = path.join(STATE_DIR, "sessions.json");

export async function loadState(sessions: SessionManager): Promise<void> {
  try {
    const raw = await readFile(PACKETS_FILE, "utf-8");
    for (const packet of JSON.parse(raw)) recordSuggestionPacket(packet);
  } catch {
    // No prior state yet — fine, this is expected on first run.
  }
  try {
    const raw = await readFile(APPROVALS_FILE, "utf-8");
    for (const approval of JSON.parse(raw)) recordApproval(approval);
  } catch {
    // No prior state yet.
  }
  try {
    const raw = await readFile(SESSIONS_FILE, "utf-8");
    sessions.loadAll(JSON.parse(raw));
  } catch {
    // No prior state yet.
  }
}

export async function saveState(sessions: SessionManager): Promise<void> {
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(PACKETS_FILE, JSON.stringify(listAllSuggestionPackets(), null, 2), "utf-8");
  await writeFile(APPROVALS_FILE, JSON.stringify(listApprovals(), null, 2), "utf-8");
  await writeFile(SESSIONS_FILE, JSON.stringify(sessions.listAll(), null, 2), "utf-8");
}
