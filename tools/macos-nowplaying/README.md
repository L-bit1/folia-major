# Folia macOS Now Playing

macOS bridge for Folia's existing **Now Playing** stage source.

- Speaks `ws://localhost:9863/api/ws/lyric`
- Reads **Music.app** (Apple Music / local library) via AppleScript
- Fetches LRC from [lrclib.net](https://lrclib.net)
- Does **not** embed Apple Music streaming inside Folia

See also: [docs/desktop/macos-now-playing.md](../../docs/desktop/macos-now-playing.md)

## Requirements

- macOS
- Node.js 18+
- Folia desktop app
- Music.app playing audio

## Usage

```bash
cd tools/macos-nowplaying
npm install
npm start          # follow Music.app
npm run demo       # protocol self-test without Music.app / lyric APIs
```

In Folia:

1. Settings → Options → Connection & Integration
2. Enable Stage Mode
3. Source: **Now Playing**
4. Play a song in Music.app

Health check:

```bash
curl http://127.0.0.1:9863/health
```

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `FOLIA_NP_HOST` | `127.0.0.1` | Bind host |
| `FOLIA_NP_PORT` | `9863` | Port (Folia Now Playing is fixed to this) |
| `FOLIA_NP_POLL_MS` | `400` | Music.app poll interval |

## Protocol

Events mirror Folia's `NowPlayingProvider` consumer:

`Track` · `Lyric` · `PlayerPauseState` · `PlayerProgress` · `PlayerProgressReplay`

## License

Same as the Folia repository (AGPL-3.0), unless otherwise noted for third-party lyric providers' terms of use.
