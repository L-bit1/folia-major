#!/usr/bin/env node
/**
 * Folia macOS Now Playing bridge
 *
 * Speaks the same WebSocket protocol Folia expects from Widdit's Now Playing service:
 *   ws://localhost:9863/api/ws/lyric
 *
 * Also implements Folia's precise progress HTTP probe:
 *   GET http://localhost:9863/api/query/progress → { "progress": <ms> }
 *
 * Events: Track | Lyric | PlayerPauseState | PlayerProgress | PlayerProgressReplay
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { readMusicSnapshot } from './musicSource.js';
import { fetchLyrics } from './lyrics.js';

const PORT = Number(process.env.FOLIA_NP_PORT || 9863);
const HOST = process.env.FOLIA_NP_HOST || '127.0.0.1';
const POLL_MS = Number(process.env.FOLIA_NP_POLL_MS || 250);
/** Positive = delay lyrics vs audio (lyrics currently too early → try 300~800). Unit: ms. */
const OFFSET_MS = Number(process.env.FOLIA_NP_OFFSET_MS || 350);
const WS_PATH = '/api/ws/lyric';
const DEMO = process.env.FOLIA_NP_DEMO === '1' || process.argv.includes('--demo');

const DEMO_LRC = `[00:00.00]Folia macOS Now Playing demo
[00:04.00]Music.app is the audio source
[00:08.00]Folia renders the lyric stage
[00:12.00]Protocol: ws://localhost:9863/api/ws/lyric
[00:16.00]Events: Track / Lyric / Progress`;

function readDemoSnapshot(startedAt) {
  const elapsedSec = (Date.now() - startedAt) / 1000;
  const duration = 24;
  const position = elapsedSec % duration;
  return {
    ok: true,
    state: 'playing',
    hasSong: true,
    id: 'demo-1',
    title: 'Folia macOS Now Playing Demo',
    artist: 'Folia Tools',
    album: 'tools/macos-nowplaying',
    duration,
    position,
    sampledAtMs: Date.now(),
    readLatencyMs: 0,
  };
}

/** @type {Set<import('ws').WebSocket>} */
const clients = new Set();

let lastTrackId = null;
let lastTitle = '';
let lastArtist = '';
let lastPaused = true;
let lastProgressMs = -1;
let lyricTrackKey = '';
let lyricInFlight = null;
let tickRunning = false;
/** @type {{ progressMs: number, paused: boolean, atMs: number } | null} */
let lastProgressSample = null;

function broadcast(event, data) {
  const payload = JSON.stringify({ event, data });
  for (const client of clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

function sendTo(client, event, data) {
  if (client.readyState === 1) {
    client.send(JSON.stringify({ event, data }));
  }
}

function trackKey(snap) {
  return `${snap.id || ''}|${snap.title || ''}|${snap.artist || ''}|${Math.round(snap.duration || 0)}`;
}

/**
 * Convert Music.app position into Folia progress ms.
 * - Compensates AppleScript read latency (sample ≈ midpoint of the call)
 * - Applies OFFSET_MS so lyrics can be delayed when they run ahead of audio
 */
function toProgressMs(snap, { extrapolate = false } = {}) {
  const positionSec = Number(snap.position) || 0;
  const readLatencyMs = Number(snap.readLatencyMs) || 0;
  const isPlaying = String(snap.state).toLowerCase() === 'playing';
  let ms = positionSec * 1000;

  // AppleScript returns a position captured during the call; advance by half the call time.
  if (isPlaying) {
    ms += readLatencyMs / 2;
  }

  // If this sample is reused a moment later (HTTP probe cache), keep wall-clock going.
  if (extrapolate && isPlaying && snap.sampledAtMs) {
    ms += Math.max(0, Date.now() - snap.sampledAtMs);
  }

  ms -= OFFSET_MS;
  return Math.max(0, Math.floor(ms));
}

async function readLiveSnapshot() {
  if (DEMO) {
    return readDemoSnapshot(demoStartedAt);
  }
  const started = Date.now();
  const snap = await readMusicSnapshot();
  const readLatencyMs = Date.now() - started;
  return {
    ...snap,
    sampledAtMs: started + Math.floor(readLatencyMs / 2),
    readLatencyMs,
  };
}

function broadcastLyric(snap, lrc, source) {
  broadcast('Lyric', {
    source: lrc ? (source || 'lrclib') : null,
    title: snap.title,
    author: snap.artist,
    duration: snap.duration,
    hasLyric: Boolean(lrc),
    hasTranslatedLyric: false,
    hasKaraokeLyric: false,
    lrc: lrc || '',
    translatedLyric: '',
    karaokeLyric: '',
  });
}

async function ensureLyrics(snap) {
  const key = trackKey(snap);
  if (key === lyricTrackKey) return;
  lyricTrackKey = key;

  if (DEMO) {
    broadcastLyric(snap, DEMO_LRC, 'demo');
    return;
  }

  const request = fetchLyrics({
    title: snap.title,
    artist: snap.artist,
    album: snap.album,
    duration: snap.duration,
  }).then((result) => {
    if (lyricTrackKey !== key) return;
    broadcastLyric(snap, result.lrc, result.source);
  }).finally(() => {
    if (lyricInFlight === request) lyricInFlight = null;
  });

  lyricInFlight = request;
  await request;
}

function emitTrack(snap) {
  broadcast('Track', {
    id: snap.id || `${snap.title}-${snap.artist}`,
    title: snap.title || 'Now Playing',
    author: snap.artist || 'Unknown',
    album: snap.album || '',
    cover: '',
    duration: Number(snap.duration) || 0,
  });
}

function emitPauseState(snap, isPaused, progressMs) {
  const durationSec = Number(snap.duration) || 0;
  const positionSec = progressMs / 1000;
  broadcast('PlayerPauseState', {
    hasSong: true,
    isPaused,
    seekbarCurrentPosition: positionSec,
    statePercent: durationSec > 0 ? Math.min(1, Math.max(0, positionSec / durationSec)) : 0,
  });
}

function emitProgress(progressMs) {
  if (Math.abs(progressMs - lastProgressMs) < 40) return;
  lastProgressMs = progressMs;
  lastProgressSample = {
    progressMs,
    paused: lastPaused,
    atMs: Date.now(),
  };
  broadcast('PlayerProgress', { progress: progressMs });
}

const demoStartedAt = Date.now();

async function tick() {
  if (tickRunning) return;
  tickRunning = true;
  try {
    const snap = await readLiveSnapshot();

    if (!snap.ok || !snap.hasSong) {
      if (lastTrackId !== null) {
        lastTrackId = null;
        lastTitle = '';
        lastArtist = '';
        lastPaused = true;
        lastProgressMs = -1;
        lastProgressSample = null;
        lyricTrackKey = '';
        broadcast('PlayerProgressReplay', {});
        broadcast('PlayerPauseState', {
          hasSong: false,
          isPaused: true,
          seekbarCurrentPosition: 0,
          statePercent: 0,
        });
      }
      return;
    }

    const id = String(snap.id || `${snap.title}|${snap.artist}`);
    const changed = id !== lastTrackId
      || snap.title !== lastTitle
      || snap.artist !== lastArtist;

    const progressMs = toProgressMs(snap);

    if (changed) {
      lastTrackId = id;
      lastTitle = snap.title || '';
      lastArtist = snap.artist || '';
      lastProgressMs = -1;
      broadcast('PlayerProgressReplay', {});
      emitTrack(snap);
      void ensureLyrics(snap);
    }

    const isPaused = String(snap.state).toLowerCase() !== 'playing';
    if (isPaused !== lastPaused || changed) {
      lastPaused = isPaused;
      emitPauseState(snap, isPaused, progressMs);
    }

    if (!isPaused) {
      emitProgress(progressMs);
    } else {
      lastProgressSample = {
        progressMs,
        paused: true,
        atMs: Date.now(),
      };
    }
  } finally {
    tickRunning = false;
  }
}

/** Snapshot used to catch up newly connected Folia clients. */
async function pushSnapshotTo(client) {
  const snap = await readLiveSnapshot();
  if (!snap.ok || !snap.hasSong) {
    sendTo(client, 'PlayerPauseState', {
      hasSong: false,
      isPaused: true,
      seekbarCurrentPosition: 0,
      statePercent: 0,
    });
    return;
  }

  const progressMs = toProgressMs(snap);
  const isPaused = String(snap.state).toLowerCase() !== 'playing';

  sendTo(client, 'Track', {
    id: snap.id || `${snap.title}-${snap.artist}`,
    title: snap.title || 'Now Playing',
    author: snap.artist || 'Unknown',
    album: snap.album || '',
    cover: '',
    duration: Number(snap.duration) || 0,
  });

  sendTo(client, 'PlayerPauseState', {
    hasSong: true,
    isPaused,
    seekbarCurrentPosition: progressMs / 1000,
    statePercent: snap.duration > 0
      ? Math.min(1, Math.max(0, (progressMs / 1000) / snap.duration))
      : 0,
  });
  sendTo(client, 'PlayerProgress', { progress: progressMs });
  lastProgressSample = { progressMs, paused: isPaused, atMs: Date.now() };

  if (DEMO) {
    sendTo(client, 'Lyric', {
      source: 'demo',
      title: snap.title,
      author: snap.artist,
      duration: snap.duration,
      hasLyric: true,
      hasTranslatedLyric: false,
      hasKaraokeLyric: false,
      lrc: DEMO_LRC,
      translatedLyric: '',
      karaokeLyric: '',
    });
    return;
  }

  void fetchLyrics({
    title: snap.title,
    artist: snap.artist,
    album: snap.album,
    duration: snap.duration,
  }).then((result) => {
    sendTo(client, 'Lyric', {
      source: result.lrc ? (result.source || 'lrclib') : null,
      title: snap.title,
      author: snap.artist,
      duration: snap.duration,
      hasLyric: Boolean(result.lrc),
      hasTranslatedLyric: false,
      hasKaraokeLyric: false,
      lrc: result.lrc || '',
      translatedLyric: '',
      karaokeLyric: '',
    });
  });
}

async function handleProgressQuery(res) {
  try {
    const snap = await readLiveSnapshot();
    if (!snap.ok || !snap.hasSong) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ progress: 0 }));
      return;
    }
    const progress = toProgressMs(snap);
    lastProgressSample = {
      progressMs: progress,
      paused: String(snap.state).toLowerCase() !== 'playing',
      atMs: Date.now(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ progress }));
  } catch (error) {
    // Fall back to last WS sample with light extrapolation so Folia can still correct.
    if (lastProgressSample) {
      let progress = lastProgressSample.progressMs;
      if (!lastProgressSample.paused) {
        progress += Math.max(0, Date.now() - lastProgressSample.atMs);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ progress: Math.max(0, Math.floor(progress)) }));
      return;
    }
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    }));
  }
}

const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/health' || url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'folia-macos-nowplaying',
      port: PORT,
      ws: `ws://${HOST}:${PORT}${WS_PATH}`,
      clients: clients.size,
      offsetMs: OFFSET_MS,
      pollMs: POLL_MS,
      mode: DEMO ? 'demo' : 'Music.app',
    }));
    return;
  }

  // Folia stage controller polls this every ~7s for drift correction.
  if (url === '/api/query/progress' || url.startsWith('/api/query/progress?')) {
    void handleProgressQuery(res);
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    `Folia macOS Now Playing bridge\n`
    + `WebSocket: ws://${HOST}:${PORT}${WS_PATH}\n`
    + `Progress:  GET /api/query/progress\n`
    + `Offset:    ${OFFSET_MS}ms (FOLIA_NP_OFFSET_MS)\n`,
  );
});

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on('connection', (socket) => {
  clients.add(socket);
  console.log(`[np] client connected (${clients.size})`);
  void pushSnapshotTo(socket);
  socket.on('close', () => {
    clients.delete(socket);
    console.log(`[np] client disconnected (${clients.size})`);
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[np] Folia macOS Now Playing bridge listening`);
  console.log(`[np]   HTTP  http://${HOST}:${PORT}/health`);
  console.log(`[np]   PROG  http://${HOST}:${PORT}/api/query/progress`);
  console.log(`[np]   WS    ws://${HOST}:${PORT}${WS_PATH}`);
  console.log(`[np]   mode  ${DEMO ? 'demo' : 'Music.app'}`);
  console.log(`[np]   offset ${OFFSET_MS}ms (lyrics early → increase FOLIA_NP_OFFSET_MS)`);
  console.log(`[np] Open Folia → 设置 → 连接与集成 → 舞台模式 → Now Playing`);
});

setInterval(() => {
  void tick().catch((err) => {
    console.warn('[np] poll error:', err instanceof Error ? err.message : err);
  });
}, POLL_MS);

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
