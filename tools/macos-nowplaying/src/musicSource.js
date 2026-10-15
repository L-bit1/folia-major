import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'music.applescript');

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
 * }} MusicSnapshot
 */

/** @returns {Promise<MusicSnapshot>} */
export async function readMusicSnapshot() {
  try {
    const { stdout, stderr } = await execFileAsync('osascript', [SCRIPT_PATH], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const text = String(stdout || '').trim();
    if (!text) {
      return { ok: false, reason: stderr?.trim() || 'empty' };
    }
    return JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}
