# Quraa — Project Milestones & Tasks

## Milestone 1: Project Foundation & Tooling
- **Goal**: Establish a working Bun + `@opentui/solid` workspace with global CLI entry point (`quraa`), strict TypeScript/Solid JSX configuration, XDG directory resolution, and automated test execution.
- **Tasks**:
  - [x] Scaffold project using `bunx create-tui@latest -t solid` and merge generated files into `/home/ali-ghamdan/Projects/quraa`
  - [x] Configure `package.json` with `@opentui/core`, `@opentui/solid`, `@opentui/keymap`, `solid-js`, `bin: { "quraa": "./src/cli.ts" }`, and `start` / `dev` / `test` / `typecheck` scripts
  - [x] Configure `bunfig.toml` (`preload = ["@opentui/solid/preload"]`) and `tsconfig.json` (`jsx: "preserve"`, `jsxImportSource: "@opentui/solid"`, `moduleResolution: "bundler"` from template, `strict: true`)
  - [x] Create `src/core/paths.ts` for XDG directory resolution (`config`, `cache`, `state`, `runtime` with `/tmp/quraa-<uid>` fallback)
  - [x] Create `src/core/types.ts` defining `Station`, `CategoryTab`, `PlaybackState`, `UiMode`, and `PersistedState`
  - [x] Run `bun link` and verify `bunx tsc --noEmit` and `bun test` execute cleanly
- **Exit Criteria**: Empty app renders via OpenTUI Solid, `bunx tsc --noEmit` and `bun test` execute cleanly, and `quraa` resolves on `PATH`.

---

## Milestone 2: Station Catalog & Persistent State
- **Goal**: Deliver a resilient Quran radio catalog combining live `mp3quran.net` v3 bilingual (`eng` / `ar`) station data, local XDG caching, curated offline fallback, custom user stations, and atomic state persistence (favorites, recents, volume, language toggle, last played).
- **Tasks**:
  - [x] Implement `src/core/store.ts` with atomic temp-file + rename read/write for `state.json` and custom `stations.json`
  - [x] Bundle curated offline fallback stations (~20 flagship reciters & thematic streams) inside `src/core/catalog.ts`
  - [x] Implement `mp3quran.net/api/v3/radios` bilingual fetch (`?language=eng` + `?language=ar`), 5s timeout, ID-based merge, and 24h XDG cache with background refresh
  - [x] Implement title normalization (strip `"Radio "` / `"---"` noise while retaining raw names for search), thematic vs reciter classification, and `http:`/`https:` custom station URL validation
  - [x] Implement category filtering (`all`, `favorites`, `recent`, `reciter`, `thematic`, `custom`) and fuzzy search matching across `nameEn`, `rawNameEn`, and `nameAr`
  - [x] Write `tests/catalog.test.ts` covering API merge, title cleanup, Arabic toggle, thematic classification, offline fallback, custom validation, and fuzzy search
- **Exit Criteria**: Station lookup, prefix cleanup, thematic/reciter categorization, Arabic/English switching, and fuzzy search operate seamlessly both online and offline.

---

## Milestone 3: Detached `mpv` Daemon & Sleep Timer
- **Goal**: Run `mpv` persistently in the background over a native Bun Unix IPC socket with live state/ICY metadata observation, stream auto-reconnect, MPRIS media key support, and an embedded Lua sleep timer that outlives TUI detachment.
- **Tasks**:
  - [x] Write `assets/sleep-timer.lua` handling `script-message quraa-sleep <seconds>` (`0` cancels), auto-quitting `mpv` on expiry, and syncing `user-data/quraa/sleep-until`
  - [x] Implement daemon detection (`get_property pid` + stale socket cleanup) and detached `mpv` spawning in `src/core/mpv.ts` (`--no-config`, `--load-scripts=no`, `--no-video`, `--audio-display=no`, `--idle=yes`, `--cache=yes`, `--demuxer-max-bytes=2MiB`, `--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5`, conditional `/usr/lib64/mpv/mpris.so`, `sleep-timer.lua`)
  - [x] Build native `Bun.connect({ unix })` JSON IPC client with `request_id` correlation and line-delimited message parsing
  - [x] Subscribe to `observe_property` (`pause`, `core-idle`, `idle-active`, `paused-for-cache`, `volume`, `mute`, `media-title`, `metadata`, `path`, `user-data/quraa/sleep-until`) and `start-file`/`end-file` events to drive `PlaybackState`
  - [x] Implement playback & control methods (`playStation` with `force-media-title`, `togglePause`, `setVolume`, `toggleMute`, `setSleepTimer`, `stopDaemon`)
  - [x] Write `tests/mpv-ipc.test.ts` testing real `mpv --idle=yes` IPC socket communication, `sleep-timer.lua` countdown property updates, and clean daemon shutdown
- **Exit Criteria**: TUI and scripts can start, attach to, control, detach from, and stop the daemon cleanly while sleep countdown and playback state stay synchronized across reattachments.

---

## Milestone 4: OpenTUI Interface & Interaction Polish
- **Goal**: Implement the responsive two-region `@opentui/solid` interface featuring adaptive dark/light WCAG-verified color tokens, layered `@opentui/keymap/solid` navigation, deterministic UI/playback state handling, Help and Add Custom Station modals, undoable custom deletion, and clean terminal restoration on exit.
- **Tasks**:
  - [ ] Create `src/ui/theme.ts` with measured WCAG 2.2 dark & light semantic token palettes (`bgBase`, `bgSurface`, `bgSelected`, `borderSubtle`, `borderInteractive`, `accent`, `textPrimary`, `textSecondary`, `textMuted`, `fav`, `danger`) reactive to `renderer.themeMode`
  - [ ] Create `src/ui/keymap.ts` using `@opentui/keymap/solid` with layered `browse`, `search`, and `modal` bindings (`j/k`/arrows, `g/G`, `/`, `Enter`, `Space`/`p`, `Tab`/`1`–`6`, `+/-`/`h/l`, `m`, `f`, `t`, `a`, `+`/`d`/`u`, `?`, `q`, `Q`)
  - [ ] Build `src/ui/components/HeaderBar.tsx` with brand header, offline/live catalog pill, `EN`/`AR` indicator, focus-bordered search `<input>`, and responsive category tabs
  - [ ] Build `src/ui/components/StationList.tsx` using `<scrollbox>`, `<For>`, `scrollChildIntoView`, `▶`/`★` row glyphs, nested `<text>` modifiers, and actionable empty states per tab/query
  - [ ] Build `src/ui/components/NowPlayingBar.tsx` with paired glyph+label status badges, optional reduced-motion-safe spinner (`--no-motion`), live ICY metadata, tabular volume/sleep countdown (`075%`, `29:45`), and responsive footer hints / undo toast slot
  - [ ] Build `src/ui/components/Modals.tsx` using `<Portal>` overlays for Help (`?`) and Add Custom Station (`+`) with inline validation, `Esc` close, and focus restoration
  - [ ] Wire `src/ui/App.tsx` with explicit `UiMode` + `PlaybackState` state machine, live daemon reattach on startup, last-station highlight (`--resume` auto-play), 6s custom-delete undo toast, 1s sleep countdown tick, and `renderer.destroy()` clean exit (`q` detach / `Q` stop)
- **Exit Criteria**: All user flows work keyboard-only without layout clipping across narrow (`60×16`), standard (`80×24`), and wide (`140×40`) terminals, with color always paired with text/glyph cues.

---

## Milestone 5: Headless CLI Control
- **Goal**: Expose full background daemon control from the terminal via `quraa` subcommands (`--resume`, `play`, `toggle`, `stop`, `next`, `prev`, `vol`, `status --json`).
- **Tasks**:
  - [ ] Create `src/cli.ts` (`#!/usr/bin/env bun`) routing TUI startup (`quraa`, `--resume`, `--no-motion`) vs headless commands
  - [ ] Implement `quraa play <query>` with fuzzy station matching, daemon launch, and confirmation output
  - [ ] Implement `quraa toggle`, `quraa stop`, `quraa next`, `quraa prev`, and `quraa vol <0-100|+n|-n>` with state persistence
  - [ ] Implement `quraa status [--json]` outputting human summary or Waybar/Polybar-ready JSON (`state`, `stationId`, `name`, `nameAr`, `metadata`, `volume`, `muted`, `sleepRemainingSec`)
- **Exit Criteria**: Scripts and status bars (Waybar/Polybar/tmux) can inspect live playback/timer JSON and control audio without launching the TUI.

---

## Milestone 6: Verification & Ship Readiness
- **Goal**: Validate full reliability across unit tests, live `mpv` IPC integration, headless `testRender` snapshots/stress states, and interactive manual playback checks.
- **Tasks**:
  - [ ] Write `tests/tui.test.tsx` using `@opentui/solid` `testRender` covering `state-machine` + `break` matrix (`60×16`, `80×24`, `140×40`, idle, playing+ICY, buffering/reconnecting, error, empty tabs, zero search hits + `Esc`, Arabic toggle, Add Custom modal validation, Delete + `u` undo, Help modal focus restore)
  - [ ] Run `bunx tsc --noEmit` and full `bun test` suite and fix all failures or snapshot regressions
  - [ ] Perform manual end-to-end verification (`quraa`, `playerctl`, sleep timer `t`, detach `q`, `quraa status --json`, reattach, `Q` clean exit) and create walkthrough summary
- **Exit Criteria**: Full test suite, typecheck, and end-to-end daemon attach/detach/sleep-timer/MPRIS checks pass with zero regressions.
