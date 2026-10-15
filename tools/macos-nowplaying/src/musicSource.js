import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_SCRIPT = path.join(SCRIPT_DIR, 'musicMonitor.applescript');
const ONESHOT_SCRIPT = path.join(SCRIPT_DIR, 'music.applescript');

/**
 * @typedef {{
 *   ok: boolean,
 *   reason?: string,
 *   state?: string,
 *   hasSong?: boolean,
 *   id?: string,
 *   title?: string,
 *   artist?: string,
 *   album?: string,
 *   duration?: number,
 *   position?: number,
 *   sampledAtMs?: number,
 *   readLatencyMs?: number,
 * }} MusicSnapshot
 */

/** @type {MusicSnapshot} */
let latest = { ok: false, reason: 'starting', sampledAtMs: Date.now(), readLatencyMs: 0 };
/** @type {import('node:child_process').ChildProcess | null} */
let child = null;
let buffer = '';
let restartTimer = null;
let starting = false;

function remember(snap) {
  latest = {
    ...snap,
    sampledAtMs: Date.now(),
    readLatencyMs: 0,
  };
}

function stopMonitor() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
  if (child) {
    child.removeAllListeners();
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    child = null;
  }
}

function scheduleRestart() {
  if (restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startMonitor();
  }, 1000);
}

export function startMonitor() {
  if (child || starting) return;
  starting = true;
  try {
    const proc = spawn('osascript', [MONITOR_SCRIPT], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    buffer = '';

    const onChunk = (chunk) => {
      buffer += String(chunk);
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        let line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        // osascript `log` prefixes with timestamp-ish noise sometimes; keep JSON object only.
        const jsonStart = line.indexOf('{');
        if (jsonStart > 0) line = line.slice(jsonStart);
        if (!line.startsWith('{')) continue;
        try {
          remember(JSON.parse(line));
        } catch {
          // ignore malformed line
        }
      }
    };

    proc.stdout?.on('data', onChunk);
    // AppleScript `log` goes to stderr
    proc.stderr?.on('data', onChunk);
    proc.on('exit', () => {
      child = null;
      starting = false;
      scheduleRestart();
    });
    proc.on('error', () => {
      child = null;
      starting = false;
      scheduleRestart();
    });
  } finally {
    starting = false;
  }
}

export function stopMusicMonitor() {
  stopMonitor();
}

/** Latest cached snapshot from the persistent monitor (non-blocking). */
export function getCachedMusicSnapshot() {
  return latest;
}

/** One-shot fallback used when monitor has not produced data yet / for HTTP probe refresh. */
export async function readMusicSnapshot() {
  // Prefer fresh cache if recent.
  if (latest.ok && latest.sampledAtMs && Date.now() - latest.sampledAtMs < 1200) {
    return { ...latest, readLatencyMs: 0 };
  }

  try {
    const started = Date.now();
    const { stdout, stderr } = await execFileAsync('osascript', [ONESHOT_SCRIPT], {
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout || stderr || '').trim();
    const jsonStart = text.indexOf('{');
    const payload = jsonStart >= 0 ? text.slice(jsonStart) : text;
    if (!payload) {
      return { ok: false, reason: 'empty', sampledAtMs: Date.now(), readLatencyMs: Date.now() - started };
    }
    const snap = JSON.parse(payload);
    const readLatencyMs = Date.now() - started;
    remember({ ...snap, readLatencyMs });
    return { ...latest, readLatencyMs };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
      sampledAtMs: Date.now(),
      readLatencyMs: 0,
    };
  }
}

// Auto-start monitor when module loads.
startMonitor();
