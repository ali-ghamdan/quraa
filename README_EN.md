# Quraa

> **[التوثيق باللغة العربية (README.md)](./README.md)**

Terminal and CLI Quran radio player built with **Bun**, **OpenTUI** (`@opentui/solid`), and a detached `mpv` daemon over Unix IPC.

## Features

- **Bilingual station catalog**: Fetches live stations from `mp3quran.net/api/v3/radios` (`eng` + `ar`) with a 24-hour XDG cache and a built-in 20-station offline fallback.
- **Persistent background playback**: Runs `mpv` detached with auto-reconnect, zero-buffer pause, and an embedded Lua sleep timer (`assets/sleep-timer.lua`) that outlives TUI exits.
- **MPRIS2 & `playerctl` integration**: Exposes `org.mpris.MediaPlayer2.quraa` via PyGObject (`assets/mpris-bridge.py`, falling back to `/usr/lib64/mpv/mpris.so`), splitting live ICY stream tags into `xesam:artist` (reciter/author), `xesam:title` (surah/verse), `xesam:album` (station name), and `mpris:artUrl`.
- **Three display modes (`EN` / `AR` / `AR-Fixed`)**: Cycles English, logical Arabic UTF-8, and terminal-shaped visual BiDi Arabic (`U+FE80–U+FEFC` presentation forms + UAX #9 ordering) for terminals without Arabic shaping or BiDi support, while automatically repairing common CP1256 and double-UTF-8 ICY mojibake.
- **Adaptive terminal palette**: Derives colors dynamically from the terminal's foreground, background, and palette slots.
- **Custom stations & artwork**: Supports user station feeds (`stations.json`) and custom reciter/station artwork (`images.json`).

## Requirements

- **Bun** `>= 1.3.14`
- **mpv**
- **MPRIS2 support (optional)**:
  - `python3` with PyGObject (`gi.repository.Gio` / `GLib`, e.g. `python3-gobject` on Fedora or `python3-gi` on Debian/Ubuntu) for full live ICY artist/title/artwork metadata and paused state, or
  - `/usr/lib64/mpv/mpris.so` (`mpv-mpris`) as fallback.
  - `playerctl` for inspecting or controlling playback from shell/keybindings.

## Installation

Clone the repository, install dependencies, and link globally (replace `<username>` with the repository owner):

```bash
git clone https://github.com/<username>/quraa.git
cd quraa
bun install
bun link
```

Verify `quraa` is available on `PATH` (typically `~/.bun/bin/quraa`):

```bash
quraa --version
```

Or run directly without linking globally:

```bash
bun run start
```

## Usage

### Interactive TUI

```bash
quraa                 # Launch the interactive TUI
quraa --resume        # Launch and automatically play the last station
quraa --no-motion     # Disable motion/animations
```

Pressing `q` in browse mode opens the **Stop Radio?** confirmation dialog (`Cancel`, `No` to detach and keep playing in the background, `Yes` to stop the daemon and quit). Pressing `Q` stops the daemon immediately; `Ctrl+C` detaches without stopping playback.

### CLI Commands

Control or query the background daemon from scripts, window-manager hotkeys, or bars (e.g. Waybar):

```bash
quraa play <query>          # Fuzzy-match a station (by ID, English, or Arabic name) and play
quraa toggle                # Pause/resume active stream, or resume the last played station
quraa next                  # Play next station (cycles Favorites when on a favorite)
quraa prev                  # Play previous station
quraa vol <0-100|+n|-n>     # Set absolute volume or adjust relative volume (clamped 0-100)
quraa status                # Print human-readable playback status
quraa status --json         # Print machine-readable status JSON
quraa stop                  # Stop the background mpv daemon
```

Example `status --json` payload fields:

```json
{
  "state": "playing",
  "stationId": "79",
  "name": "Mishary Alafasi",
  "nameAr": "مشاري العفاسي",
  "trackTitle": "Al-Baqarah",
  "author": "Mishary Alafasi",
  "artUrl": "file:///.../assets/quraa-reciter.png",
  "metadata": "Mishary Alafasi - Al-Baqarah",
  "volume": 80,
  "muted": false,
  "sleepRemainingSec": 0
}
```

### Desktop Media Controls (`playerctl`)

```bash
playerctl -p quraa status
playerctl -p quraa metadata
playerctl -p quraa play-pause
playerctl -p quraa next
```

## TUI Keyboard Shortcuts

| Keys | Action |
| --- | --- |
| `j` / `k` / `↑` / `↓` | Move selection |
| `g` / `G` | Jump to top / bottom |
| `/` (`Esc` to clear, `↓` to keep filter) | Search stations |
| `Tab` / `Shift+Tab` / `1–6` | Switch category tabs (`All`, `Favorites`, `Recent`, `Reciters`, `Theme`, `Custom`) |
| `Enter` | Play selected station (or retry on error) |
| `Space` / `p` | Pause or resume playback |
| `-` / `=` or `h` / `l` or `←` / `→` | Adjust volume `-5%` / `+5%` |
| `m` | Toggle mute |
| `t` | Cycle sleep timer (`Off` → `15m` → `30m` → `45m` → `60m`) |
| `f` | Star / unstar favorite |
| `a` | Cycle display language (`EN` → `AR` → `AR-Fixed`) |
| `+` / `n` | Add custom station (`http://` or `https://`) |
| `d` / `u` | Delete selected custom station / undo (6s window) |
| `?` | Toggle keyboard shortcuts help modal |
| `q` | Quit confirmation dialog (`Cancel` / `No` / `Yes`) |
| `Q` | Stop daemon and quit |
| `Ctrl+C` | Detach from TUI (daemon keeps playing) |

## Configuration & Data Paths

Quraa follows XDG Base Directory paths:

| Purpose | Path |
| --- | --- |
| Custom stations | `~/.config/quraa/stations.json` |
| Custom artwork map | `~/.config/quraa/images.json` |
| Catalog cache (24h TTL) | `~/.cache/quraa/stations.json` |
| Persistent state | `~/.local/state/quraa/state.json` |
| Daemon IPC socket & PID | `$XDG_RUNTIME_DIR/quraa/mpv.{sock,pid}` (fallback `/tmp/quraa-<uid>/mpv.{sock,pid}`) |

### Custom Artwork (`~/.config/quraa/images.json`)

Override bundled category emblems (`assets/quraa-reciter.png`, `assets/quraa-thematic.png`, `assets/quraa-default.png`) by reciter name, station ID/name, or fallback default using local paths (`~/` supported), `file://`, or `http(s)://` URLs:

```json
{
  "default": "~/Pictures/quraa/default.png",
  "authors": {
    "Mishary Alafasi": "~/Pictures/quraa/alafasi.jpg"
  },
  "stations": {
    "79": "~/Pictures/quraa/alafasi.jpg",
    "thematic": "https://example.com/thematic.png"
  }
}
```

Resolution order: user `authors` → user `stations` → custom station `image` → bundled `station-images.json` → `default`.

### Custom Stations (`~/.config/quraa/stations.json`)

Stations added via `+` / `n` in the TUI are stored here, or can be edited manually with optional `nameAr` and `image` fields:

```json
[
  {
    "id": "custom-makkah",
    "name": "Makkah Live FM",
    "nameAr": "إذاعة مكة",
    "url": "https://stream.example.com/quran.mp3",
    "image": "~/Pictures/quraa/makkah.png"
  }
]
```

## Development

```bash
bun run dev         # Run CLI/TUI in watch mode
bun run typecheck   # TypeScript check (tsc --noEmit)
bun test            # Run unit and integration test suites
```
