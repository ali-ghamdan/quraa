#!/usr/bin/env bun

import {
  fuzzyMatchStations,
  getStationDisplayName,
  loadCatalog,
  loadLocalCatalog,
} from "./core/catalog.ts"
import { isDaemonAlive, MpvClient } from "./core/mpv.ts"
import { type QuraaPaths, resolvePaths } from "./core/paths.ts"
import { loadState, recordRecent, saveState } from "./core/store.ts"
import type { PersistedState, PlaybackSnapshot, PlaybackState, Station } from "./core/types.ts"

export const CLI_VERSION = "0.1.0"

export interface CliMpvClient {
  readonly isConnected: boolean
  getSnapshot(): PlaybackSnapshot
  connect(): Promise<void>
  ensureConnected(): Promise<number>
  disconnect(): void
  playStation(station: Station, displayName?: string): Promise<void>
  togglePause(): Promise<void>
  setVolume(volume: number): Promise<number>
  stopDaemon(): Promise<void>
}

export interface CliStatusPayload {
  state: PlaybackState
  stationId: string | null
  name: string | null
  nameAr: string | null
  metadata: string | null
  volume: number
  muted: boolean
  sleepRemainingSec: number
}

export interface CliDeps {
  paths?: QuraaPaths
  fetchImpl?: typeof fetch
  now?: () => number
  createClient?: (
    paths: QuraaPaths,
    options?: { initialVolume?: number; muted?: boolean },
  ) => CliMpvClient
  isDaemonAliveFn?: (paths: QuraaPaths) => Promise<boolean>
  launchTui?: (options: { autoResume: boolean; noMotion: boolean }) => Promise<void>
  stdout?: (line: string) => void
  stderr?: (line: string) => void
}

const HELP_TEXT = [
  "quraa — OpenTUI Quran radio player (mpv daemon)",
  "",
  "Usage:",
  "  quraa [--resume] [--no-motion]   Launch interactive TUI",
  "  quraa play <query>               Fuzzy-match and play a station",
  "  quraa toggle                     Pause/resume playback (or resume last station)",
  "  quraa stop                       Stop the background mpv daemon",
  "  quraa next | prev                Cycle to next or previous station",
  "  quraa vol <0-100|+n|-n>          Set or adjust volume (clamped 0-100)",
  "  quraa status [--json]            Show live daemon status (or Waybar JSON)",
  "  quraa --help | --version         Show help or version",
].join("\n")

function clampVol(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)))
}

function findStationByQuery(stations: Station[], query: string): Station | null {
  const exactId = stations.find((s) => s.id === query)
  if (exactId) return exactId
  return fuzzyMatchStations(stations, query)[0] ?? null
}

function resolveCycleList(
  stations: Station[],
  favorites: string[],
  activeId: string | null,
): Station[] {
  if (activeId && favorites.includes(activeId)) {
    const favSet = new Set(favorites)
    const favStations = stations.filter((s) => favSet.has(s.id))
    if (favStations.length > 1) return favStations
  }
  return stations
}

function pickNextStation(
  cycleList: Station[],
  activeId: string | null,
  delta: 1 | -1,
): Station | null {
  if (cycleList.length === 0) return null
  const idx = activeId ? cycleList.findIndex((s) => s.id === activeId) : -1
  if (idx === -1) {
    return delta === 1 ? cycleList[0]! : cycleList[cycleList.length - 1]!
  }
  const targetIdx = (idx + delta + cycleList.length) % cycleList.length
  return cycleList[targetIdx]!
}

function formatDurationShort(totalSec: number): string {
  const mins = Math.ceil(totalSec / 60)
  return `${mins}m`
}

function formatHumanStatus(payload: CliStatusPayload, displayName: string | null): string {
  const label = payload.state.toUpperCase()
  const volText = `VOL ${String(payload.volume).padStart(3, "0")}%`
  const extras: string[] = [volText]
  if (payload.muted) extras.push("MUTED")
  if (payload.sleepRemainingSec > 0) {
    extras.push(`SLEEP ${formatDurationShort(payload.sleepRemainingSec)}`)
  }
  const stationPart = displayName ?? payload.name
  const head = stationPart ? `${label}: ${stationPart} (${extras.join(", ")})` : `${label} (${extras.join(", ")})`
  return payload.metadata ? `${head} — ${payload.metadata}` : head
}

async function defaultLaunchTui(options: {
  autoResume: boolean
  noMotion: boolean
}): Promise<void> {
  // Register Solid JSX transform before importing TSX when invoked via global `bun link`.
  const { ensureSolidTransformPlugin } = await import("@opentui/solid/bun-plugin")
  ensureSolidTransformPlugin()
  const { render } = await import("@opentui/solid")
  const { App } = await import("./ui/App.tsx")
  await new Promise<void>((resolve, reject) => {
    render(() => App(options), {
      exitOnCtrlC: false,
      onDestroy: () => resolve(),
    }).catch(reject)
  })
}

async function playAndPersist(
  client: CliMpvClient,
  paths: QuraaPaths,
  state: PersistedState,
  station: Station,
): Promise<string> {
  const displayName = getStationDisplayName(station, state.arabicNames)
  await client.playStation(station, displayName)
  const nextState = recordRecent({ ...state, lastStationId: station.id }, station.id)
  await saveState(paths.stateFile, nextState)
  return displayName
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number> {
  const paths = deps.paths ?? resolvePaths()
  const fetchImpl = deps.fetchImpl ?? fetch
  const now = deps.now ?? Date.now
  const createClient =
    deps.createClient ??
    ((p: QuraaPaths, opts?: { initialVolume?: number; muted?: boolean }) =>
      new MpvClient(p, opts))
  const checkAlive = deps.isDaemonAliveFn ?? isDaemonAlive
  const launchTui = deps.launchTui ?? defaultLaunchTui
  const stdout = deps.stdout ?? ((line: string) => console.log(line))
  const stderr = deps.stderr ?? ((line: string) => console.error(line))

  const cmd = argv[0]

  if (cmd === "--help" || cmd === "-h" || cmd === "help") {
    stdout(HELP_TEXT)
    return 0
  }

  if (cmd === "--version" || cmd === "-v") {
    stdout(CLI_VERSION)
    return 0
  }

  // TUI mode: no args or TUI launch flags only
  if (!cmd || cmd.startsWith("-")) {
    let autoResume = false
    let noMotion = false
    for (const arg of argv) {
      if (arg === "--resume") {
        autoResume = true
      } else if (arg === "--no-motion") {
        noMotion = true
      } else {
        stderr(`Unknown option: ${arg}\nRun 'quraa --help' for usage.`)
        return 1
      }
    }
    await launchTui({ autoResume, noMotion })
    return 0
  }

  if (cmd === "play") {
    const query = argv.slice(1).join(" ").trim()
    if (!query) {
      stderr("Usage: quraa play <query>")
      return 1
    }

    const [state, catalog] = await Promise.all([
      loadState(paths.stateFile),
      loadCatalog({ paths, fetchImpl }),
    ])
    const match = findStationByQuery(catalog.stations, query)
    if (!match) {
      stderr(`No station matched "${query}".`)
      return 1
    }

    const client = createClient(paths, { initialVolume: state.volume, muted: state.muted })
    try {
      await client.ensureConnected()
      const displayName = await playAndPersist(client, paths, state, match)
      stdout(`Playing: ${displayName}`)
      return 0
    } finally {
      client.disconnect()
    }
  }

  if (cmd === "toggle") {
    if (argv.length > 1) {
      stderr("Usage: quraa toggle")
      return 1
    }
    const [state, alive] = await Promise.all([
      loadState(paths.stateFile),
      checkAlive(paths),
    ])

    if (alive) {
      const client = createClient(paths, { initialVolume: state.volume, muted: state.muted })
      try {
        await client.connect()
        const snap = client.getSnapshot()
        if (snap.state === "stopped" || snap.state === "error") {
          const targetId = snap.stationId ?? state.lastStationId
          const stations = await loadLocalCatalog(paths)
          const target = targetId ? stations.find((s) => s.id === targetId) : undefined
          if (!target) {
            stderr("No active stream or previous station to resume.")
            return 1
          }
          const label = await playAndPersist(client, paths, state, target)
          stdout(`Playing: ${label}`)
          return 0
        }

        const wasPaused = snap.state === "paused"
        await client.togglePause()
        const activeId = snap.stationId ?? state.lastStationId
        const stations = await loadLocalCatalog(paths)
        const active = activeId ? stations.find((s) => s.id === activeId) : undefined
        const label = active
          ? getStationDisplayName(active, state.arabicNames)
          : (snap.title ?? "stream")
        stdout(`${wasPaused ? "Playing" : "Paused"}: ${label}`)
        return 0
      } finally {
        client.disconnect()
      }
    }

    if (!state.lastStationId) {
      stderr("No running daemon and no previous station to resume. Run 'quraa play <query>' first.")
      return 1
    }
    const stations = (await loadCatalog({ paths, fetchImpl })).stations
    const target = stations.find((s) => s.id === state.lastStationId)
    if (!target) {
      stderr(`Last station (${state.lastStationId}) is no longer in the catalog.`)
      return 1
    }
    const client = createClient(paths, { initialVolume: state.volume, muted: state.muted })
    try {
      await client.ensureConnected()
      const label = await playAndPersist(client, paths, state, target)
      stdout(`Playing: ${label}`)
      return 0
    } finally {
      client.disconnect()
    }
  }

  if (cmd === "stop") {
    if (argv.length > 1) {
      stderr("Usage: quraa stop")
      return 1
    }
    const client = createClient(paths)
    await client.stopDaemon()
    stdout("Stopped")
    return 0
  }

  if (cmd === "next" || cmd === "prev") {
    if (argv.length > 1) {
      stderr(`Usage: quraa ${cmd}`)
      return 1
    }
    const delta: 1 | -1 = cmd === "next" ? 1 : -1
    const [state, catalog, alive] = await Promise.all([
      loadState(paths.stateFile),
      loadCatalog({ paths, fetchImpl }),
      checkAlive(paths),
    ])

    const client = createClient(paths, { initialVolume: state.volume, muted: state.muted })
    try {
      let activeId = state.lastStationId
      if (alive) {
        await client.connect()
        activeId = client.getSnapshot().stationId ?? activeId
      }

      const cycleList = resolveCycleList(catalog.stations, state.favorites, activeId)
      const target = pickNextStation(cycleList, activeId, delta)
      if (!target) {
        stderr("No stations available.")
        return 1
      }

      if (!client.isConnected) {
        await client.ensureConnected()
      }
      const label = await playAndPersist(client, paths, state, target)
      stdout(`Playing: ${label}`)
      return 0
    } finally {
      client.disconnect()
    }
  }

  if (cmd === "vol") {
    const rawArg = argv[1]
    if (!rawArg || argv.length > 2 || !/^[+-]?\d+$/.test(rawArg)) {
      stderr("Usage: quraa vol <0-100|+n|-n>")
      return 1
    }

    const [state, alive] = await Promise.all([
      loadState(paths.stateFile),
      checkAlive(paths),
    ])

    const isRelative = rawArg.startsWith("+") || rawArg.startsWith("-")
    const value = Number(rawArg)
    let baseVol = state.volume

    const client = createClient(paths, { initialVolume: state.volume, muted: state.muted })
    try {
      if (alive) {
        await client.connect()
        if (isRelative) {
          baseVol = client.getSnapshot().volume
        }
      }

      const nextVol = clampVol(isRelative ? baseVol + value : value)
      if (client.isConnected) {
        await client.setVolume(nextVol)
      }
      await saveState(paths.stateFile, { ...state, volume: nextVol })
      stdout(`Volume: ${nextVol}%`)
      return 0
    } finally {
      client.disconnect()
    }
  }

  if (cmd === "status") {
    let jsonMode = false
    for (const arg of argv.slice(1)) {
      if (arg === "--json") {
        jsonMode = true
      } else {
        stderr(`Unknown option for status: ${arg}`)
        return 1
      }
    }

    const [state, stations, alive] = await Promise.all([
      loadState(paths.stateFile),
      loadLocalCatalog(paths),
      checkAlive(paths),
    ])

    let playbackState: PlaybackState = "stopped"
    let stationId: string | null = state.lastStationId
    let fallbackTitle: string | null = null
    let metadata: string | null = null
    let volume = clampVol(state.volume)
    let muted = state.muted
    let sleepRemainingSec = 0

    if (alive) {
      const client = createClient(paths, { initialVolume: state.volume, muted: state.muted })
      try {
        await client.connect()
        const snap = client.getSnapshot()
        playbackState = snap.state
        stationId = snap.stationId ?? state.lastStationId
        fallbackTitle = snap.title
        metadata = snap.metadata
        volume = clampVol(snap.volume)
        muted = snap.muted
        sleepRemainingSec =
          snap.sleepUntil > now() ? Math.ceil((snap.sleepUntil - now()) / 1000) : 0
      } finally {
        client.disconnect()
      }
    }

    const station = stationId ? stations.find((s) => s.id === stationId) : undefined
    const payload: CliStatusPayload = {
      state: playbackState,
      stationId: stationId ?? null,
      name: station ? station.nameEn : fallbackTitle,
      nameAr: station?.nameAr ?? null,
      metadata,
      volume,
      muted,
      sleepRemainingSec,
    }

    if (jsonMode) {
      stdout(JSON.stringify(payload))
    } else {
      const displayName = station ? getStationDisplayName(station, state.arabicNames) : null
      stdout(formatHumanStatus(payload, displayName))
    }
    return 0
  }

  stderr(`Unknown command: ${cmd}\nRun 'quraa --help' for usage.`)
  return 1
}

if (import.meta.main) {
  const exitCode = await runCli(Bun.argv.slice(2))
  process.exit(exitCode)
}
