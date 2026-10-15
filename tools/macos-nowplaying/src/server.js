#!/usr/bin/env node
/**
 * Folia macOS Now Playing bridge
 *
 * Speaks the same WebSocket protocol Folia expects from Widdit's Now Playing service:
 *   ws://localhost:9863/api/ws/lyric
 *
 * Events: Track | Lyric | PlayerPauseState | PlayerProgress | PlayerProgressReplay
 *
 * Music.app (Apple Music) is the audio source; Folia only renders lyrics / visualizer.
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import { readMusicSnapshot } from './musicSource.js';
import { fetchLyrics } from './lyrics.js';

const PORT = Number(process.env.FOLIA_NP_PORT || 9863);
const HOST = process.env.FOLIA_NP_HOST || '127.0.0.1';
const POLL_MS = Number(process.env.FOLIA_NP_POLL_MS || 400);
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

function emitPauseState(snap, isPaused) {
  const positionSec = Number(snap.position) || 0;
  const durationSec = Number(snap.duration) || 0;
  broadcast('PlayerPauseState', {
    hasSong: true,
    isPaused,
    seekbarCurrentPosition: positionSec,
    statePercent: durationSec > 0 ? Math.min(1, Math.max(0, positionSec / durationSec)) : 0,
  });
}

function emitProgress(positionSec) {
  const progressMs = Math.max(0, Math.floor(positionSec * 1000));
  if (Math.abs(progressMs - lastProgressMs) < 80) return;
  lastProgressMs = progressMs;
  broadcast('PlayerProgress', { progress: progressMs });
}

const demoStartedAt = Date.now();

async function tick() {
  const snap = DEMO ? readDemoSnapshot(demoStartedAt) : await readMusicSnapshot();

  if (!snap.ok || !snap.hasSong) {
    if (lastTrackId !== null) {
      lastTrackId = null;
      lastTitle = '';
      lastArtist = '';
      lastPaused = true;
      lastProgressMs = -1;
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
    emitPauseState(snap, isPaused);
  }

  if (!isPaused) {
    emitProgress(Number(snap.position) || 0);
  }
}

/** Snapshot used to catch up newly connected Folia clients. */
async function pushSnapshotTo(client) {
  const snap = DEMO ? readDemoSnapshot(demoStartedAt) : await readMusicSnapshot();
  if (!snap.ok || !snap.hasSong) {
    sendTo(client, 'PlayerPauseState', {
      hasSong: false,
      isPaused: true,
      seekbarCurrentPosition: 0,
      statePercent: 0,
    });
    return;
  }

  sendTo(client, 'Track', {
    id: snap.id || `${snap.title}-${snap.artist}`,
    title: snap.title || 'Now Playing',
    author: snap.artist || 'Unknown',
    album: snap.album || '',
    cover: '',
    duration: Number(snap.duration) || 0,
  });

  const isPaused = String(snap.state).toLowerCase() !== 'playing';
  sendTo(client, 'PlayerPauseState', {
    hasSong: true,
    isPaused,
    seekbarCurrentPosition: Number(snap.position) || 0,
    statePercent: snap.duration > 0
      ? Math.min(1, Math.max(0, (Number(snap.position) || 0) / snap.duration))
      : 0,
  });
  sendTo(client, 'PlayerProgress', {
    progress: Math.max(0, Math.floor((Number(snap.position) || 0) * 1000)),
  });

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

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: 'folia-macos-nowplaying',
      port: PORT,
      ws: `ws://${HOST}:${PORT}${WS_PATH}`,
      clients: clients.size,
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(`Folia macOS Now Playing bridge\nWebSocket: ws://${HOST}:${PORT}${WS_PATH}\n`);
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
  console.log(`[np]   WS    ws://${HOST}:${PORT}${WS_PATH}`);
  console.log(`[np]   mode  ${DEMO ? 'demo' : 'Music.app'}`);
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
