const LRU_MAX = 64;
/** @type {Map<string, { lrc: string | null, fetchedAt: number }>} */
const cache = new Map();

const UA = 'folia-macos-nowplaying/0.1 (+https://github.com/chthollyphile/folia-major; tools/macos-nowplaying)';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheKey(title, artist, durationSec) {
  const dur = Number.isFinite(durationSec) ? Math.round(durationSec) : 0;
  return `${title.trim().toLowerCase()}|${artist.trim().toLowerCase()}|${dur}`;
}

function remember(key, lrc) {
  if (cache.size >= LRU_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { lrc, fetchedAt: Date.now() });
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[（(].*?[）)]/g, '')
    .replace(/[-–—:].*$/u, '')
    .replace(/\s+/g, '')
    .trim();
}

function pickLrc(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const synced = typeof entry.syncedLyrics === 'string' ? entry.syncedLyrics.trim() : '';
  if (synced) return synced;
  const plain = typeof entry.plainLyrics === 'string' ? entry.plainLyrics.trim() : '';
  if (!plain) return null;
  return plain
    .split('\n')
    .filter(Boolean)
    .map((line, i) => `[00:${String(i).padStart(2, '0')}.00]${line}`)
    .join('\n');
}

function scoreCandidate(entry, title, artist, durationSec) {
  const nTitle = normalizeName(title);
  const nArtist = normalizeName(artist);
  const eTitle = normalizeName(entry.trackName);
  const eArtist = normalizeName(entry.artistName);
  let score = 0;
  if (eTitle === nTitle) score += 100;
  else if (eTitle.includes(nTitle) || nTitle.includes(eTitle)) score += 50;
  if (nArtist && eArtist === nArtist) score += 40;
  else if (nArtist && (eArtist.includes(nArtist) || nArtist.includes(eArtist))) score += 20;
  if (Number.isFinite(durationSec) && Number.isFinite(entry.duration)) {
    const delta = Math.abs(Number(entry.duration) - Number(durationSec));
    if (delta <= 2) score += 30;
    else if (delta <= 5) score += 15;
    else if (delta <= 12) score += 5;
    else score -= 20;
  }
  if (entry.syncedLyrics) score += 10;
  return score;
}

async function fetchJson(url, { retries = 3 } = {}) {
  for (let attempt = 0; attempt < retries; attempt += 1) {
    const resp = await fetch(url, { headers: { 'User-Agent': UA } });
    if (resp.status === 404) return null;
    if (resp.status === 429) {
      const retryAfter = Number(resp.headers.get('retry-after'));
      const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : 1200 * (attempt + 1);
      await sleep(waitMs);
      continue;
    }
    if (!resp.ok) return null;
    return resp.json();
  }
  return null;
}

/**
 * @param {{ title: string, artist: string, album?: string, duration?: number }} track
 * @returns {Promise<{ lrc: string | null, source: string | null }>}
 */
export async function fetchLyrics(track) {
  const title = track.title?.trim() || '';
  const artist = track.artist?.trim() || '';
  if (!title) {
    return { lrc: null, source: null };
  }

  const key = cacheKey(title, artist, track.duration);
  const hit = cache.get(key);
  if (hit) {
    return { lrc: hit.lrc, source: hit.lrc ? 'lrclib' : null };
  }

  try {
    const getParams = new URLSearchParams({
      track_name: title,
      artist_name: artist || 'Unknown',
    });
    if (track.album?.trim()) getParams.set('album_name', track.album.trim());
    if (Number.isFinite(track.duration) && track.duration > 0) {
      getParams.set('duration', String(Math.round(track.duration)));
    }

    const exact = await fetchJson(`https://lrclib.net/api/get?${getParams}`);
    const exactLrc = pickLrc(exact);
    if (exactLrc) {
      remember(key, exactLrc);
      return { lrc: exactLrc, source: 'lrclib' };
    }

    await sleep(350);

    const searchQueries = [
      new URLSearchParams({ track_name: title, artist_name: artist || '' }),
      new URLSearchParams({ q: [title, artist].filter(Boolean).join(' ') }),
    ];

    /** @type {Array<{ entry: any, score: number }>} */
    let ranked = [];
    for (const params of searchQueries) {
      const results = await fetchJson(`https://lrclib.net/api/search?${params}`);
      if (!Array.isArray(results) || results.length === 0) continue;
      ranked = results
        .map((entry) => ({ entry, score: scoreCandidate(entry, title, artist, track.duration) }))
        .sort((a, b) => b.score - a.score);
      if (ranked[0]?.score >= 60) break;
      await sleep(350);
    }

    const best = ranked[0];
    if (!best || best.score < 60) {
      remember(key, null);
      return { lrc: null, source: null };
    }

    const lrc = pickLrc(best.entry);
    remember(key, lrc);
    return { lrc, source: lrc ? 'lrclib' : null };
  } catch {
    return { lrc: null, source: null };
  }
}
