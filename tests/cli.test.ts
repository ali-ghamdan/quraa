import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type CliMpvClient, type CliStatusPayload, runCli } from "../src/cli.ts"
import { FALLBACK_STATIONS } from "../src/core/catalog.ts"
import { type QuraaPaths, resolvePaths } from "../src/core/paths.ts"
import { atomicWriteJson, loadState, saveState } from "../src/core/store.ts"
import type { PlaybackSnapshot, Station } from "../src/core/types.ts"

const tempDirs: string[] = []

function makeTempPaths(): QuraaPaths {
  const root = mkdtempSync(join(tmpdir(), "quraa-cli-test-"))
  tempDirs.push(root)
  return resolvePaths({
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
  })
}

class FakeCliClient implements CliMpvClient {
  isConnected = false
  calls: string[] = []
  snapshot: PlaybackSnapshot

  constructor(initial?: Partial<PlaybackSnapshot>) {
    this.snapshot = {
      state: "stopped",
      stationId: null,
      title: null,
      metadata: null,
      volume: 80,
      muted: false,
      sleepUntil: 0,
      error: null,
      ...initial,
    }
  }

  getSnapshot(): PlaybackSnapshot {
    return { ...this.snapshot }
  }

  async connect(): Promise<void> {
    this.calls.push("connect")
    this.isConnected = true
  }

  async ensureConnected(): Promise<number> {
    this.calls.push("ensureConnected")
    this.isConnected = true
    return 12345
  }

  disconnect(): void {
    this.calls.push("disconnect")
    this.isConnected = false
  }

  async playStation(station: Station, displayName?: string): Promise<void> {
    this.calls.push(`playStation:${station.id}`)
    this.snapshot = {
      ...this.snapshot,
      state: "playing",
      stationId: station.id,
      title: displayName ?? station.nameEn,
    }
  }

  async togglePause(): Promise<void> {
    this.calls.push("togglePause")
    this.snapshot = {
      ...this.snapshot,
      state: this.snapshot.state === "paused" ? "playing" : "paused",
    }
  }

  async setVolume(volume: number): Promise<number> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)))
    this.calls.push(`setVolume:${clamped}`)
    this.snapshot = { ...this.snapshot, volume: clamped }
    return clamped
  }

  async stopDaemon(): Promise<void> {
    this.calls.push("stopDaemon")
    this.snapshot = {
      ...this.snapshot,
      state: "stopped",
      stationId: null,
      sleepUntil: 0,
    }
  }
}

function createHarness(options?: {
  alive?: boolean
  client?: FakeCliClient
  now?: number
  paths?: QuraaPaths
}) {
  const paths = options?.paths ?? makeTempPaths()
  const client = options?.client ?? new FakeCliClient()
  const out: string[] = []
  const err: string[] = []
  const launchedTui: Array<{ autoResume: boolean; noMotion: boolean }> = []

  const offlineFetch = (async () => {
    throw new Error("offline in test")
  }) as unknown as typeof fetch

  return {
    paths,
    client,
    out,
    err,
    launchedTui,
    run: (argv: string[]) =>
      runCli(argv, {
        paths,
        fetchImpl: offlineFetch,
        now: () => options?.now ?? 1_000_000,
        isDaemonAliveFn: async () => options?.alive ?? false,
        createClient: () => client,
        launchTui: async (opts) => {
          launchedTui.push(opts)
        },
        stdout: (line) => out.push(line),
        stderr: (line) => err.push(line),
      }),
  }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("CLI router", () => {
  test("prints help and version cleanly", async () => {
    const h = createHarness()
    expect(await h.run(["--help"])).toBe(0)
    expect(h.out[0]).toContain("quraa play <query>")

    const hVer = createHarness()
    expect(await hVer.run(["--version"])).toBe(0)
    expect(hVer.out[0]).toBe("0.1.0")
  })

  test("routes TUI launch with --resume and --no-motion and rejects unknown flags/commands", async () => {
    const h = createHarness()
    expect(await h.run([])).toBe(0)
    expect(await h.run(["--resume", "--no-motion"])).toBe(0)
    expect(h.launchedTui).toEqual([
      { autoResume: false, noMotion: false },
      { autoResume: true, noMotion: true },
    ])

    expect(await h.run(["--bogus"])).toBe(1)
    expect(h.err[0]).toContain("Unknown option")

    expect(await h.run(["foobar"])).toBe(1)
    expect(h.err[1]).toContain("Unknown command")
  })

  test("play <query> fuzzy matches catalog, connects daemon, saves state & recents", async () => {
    const h = createHarness({ alive: false })
    await atomicWriteJson(h.paths.cacheStationsFile, {
      fetchedAt: Date.now(),
      stations: FALLBACK_STATIONS,
    })

    const code = await h.run(["play", "shatri"])
    expect(code).toBe(0)
    expect(h.out[0]).toContain("Playing: Shaik Abu Bakr Al Shatri")
    expect(h.client.calls).toEqual([
      "ensureConnected",
      `playStation:${FALLBACK_STATIONS[0]!.id}`,
      "disconnect",
    ])

    const saved = await loadState(h.paths.stateFile)
    expect(saved.lastStationId).toBe(FALLBACK_STATIONS[0]!.id)
    expect(saved.recents[0]).toBe(FALLBACK_STATIONS[0]!.id)

    expect(await h.run(["play"])).toBe(1)
    expect(await h.run(["play", "nonexistent-xyz-12345"])).toBe(1)
  })

  test("toggle pauses active stream, resumes paused stream, and resumes lastStationId when stopped", async () => {
    const s0 = FALLBACK_STATIONS[0]!
    const paths = makeTempPaths()
    await atomicWriteJson(paths.cacheStationsFile, {
      fetchedAt: Date.now(),
      stations: FALLBACK_STATIONS,
    })
    await saveState(paths.stateFile, {
      volume: 75,
      muted: false,
      arabicNames: false,
      favorites: [],
      recents: [s0.id],
      lastStationId: s0.id,
    })

    // 1. Daemon dead + lastStationId -> boots daemon & plays
    const cold = createHarness({ alive: false, paths })
    expect(await cold.run(["toggle"])).toBe(0)
    expect(cold.out[0]).toBe(`Playing: ${s0.nameEn}`)
    expect(cold.client.calls).toContain("ensureConnected")

    // 2. Daemon playing -> pauses
    const livePlaying = new FakeCliClient({
      state: "playing",
      stationId: s0.id,
      volume: 75,
    })
    const pauseRun = createHarness({ alive: true, client: livePlaying, paths })
    expect(await pauseRun.run(["toggle"])).toBe(0)
    expect(pauseRun.out[0]).toBe(`Paused: ${s0.nameEn}`)
    expect(livePlaying.snapshot.state).toBe("paused")

    // 3. Daemon paused -> plays
    const resumeRun = createHarness({ alive: true, client: livePlaying, paths })
    expect(await resumeRun.run(["toggle"])).toBe(0)
    expect(resumeRun.out[0]).toBe(`Playing: ${s0.nameEn}`)
    expect(livePlaying.snapshot.state).toBe("playing")
  })

  test("next and prev cycle within favorites when active station is favorited, else full catalog", async () => {
    const [s0, s1, s2] = FALLBACK_STATIONS
    const paths = makeTempPaths()
    await atomicWriteJson(paths.cacheStationsFile, {
      fetchedAt: Date.now(),
      stations: FALLBACK_STATIONS,
    })
    await saveState(paths.stateFile, {
      volume: 80,
      muted: false,
      arabicNames: false,
      favorites: [s0!.id, s2!.id],
      recents: [s0!.id],
      lastStationId: s0!.id,
    })

    const live = new FakeCliClient({ state: "playing", stationId: s0!.id })
    const hNext = createHarness({ alive: true, client: live, paths })
    expect(await hNext.run(["next"])).toBe(0)
    expect(hNext.out[0]).toBe(`Playing: ${s2!.nameEn}`)

    const hPrev = createHarness({ alive: true, client: live, paths })
    expect(await hPrev.run(["prev"])).toBe(0)
    expect(hPrev.out[0]).toBe(`Playing: ${s0!.nameEn}`)

    // When active station is NOT in favorites, cycle full catalog (s0 -> s1)
    await saveState(paths.stateFile, {
      volume: 80,
      muted: false,
      arabicNames: false,
      favorites: [s1!.id, s2!.id],
      recents: [s0!.id],
      lastStationId: s0!.id,
    })
    const liveOutsideFavs = new FakeCliClient({ state: "playing", stationId: s0!.id })
    const hFull = createHarness({ alive: true, client: liveOutsideFavs, paths })
    expect(await hFull.run(["next"])).toBe(0)
    expect(hFull.out[0]).toBe(`Playing: ${s1!.nameEn}`)
  })

  test("vol sets exact or relative volume, clamps 0-100, persists state, and updates live daemon", async () => {
    const paths = makeTempPaths()
    await saveState(paths.stateFile, {
      volume: 70,
      muted: false,
      arabicNames: false,
      favorites: [],
      recents: [],
      lastStationId: null,
    })

    const live = new FakeCliClient({ state: "playing", volume: 70 })
    const hUp = createHarness({ alive: true, client: live, paths })
    expect(await hUp.run(["vol", "+15"])).toBe(0)
    expect(hUp.out[0]).toBe("Volume: 85%")
    expect((await loadState(paths.stateFile)).volume).toBe(85)

    const hDown = createHarness({ alive: true, client: live, paths })
    expect(await hDown.run(["vol", "-120"])).toBe(0)
    expect(hDown.out[0]).toBe("Volume: 0%")

    const hExact = createHarness({ alive: false, paths })
    expect(await hExact.run(["vol", "55"])).toBe(0)
    expect(hExact.out[0]).toBe("Volume: 55%")
    expect((await loadState(paths.stateFile)).volume).toBe(55)

    expect(await hExact.run(["vol", "loud"])).toBe(1)
  })

  test("status --json outputs Waybar/Polybar payload when idle and playing with sleep timer", async () => {
    const s0 = FALLBACK_STATIONS[0]!
    const paths = makeTempPaths()
    await atomicWriteJson(paths.cacheStationsFile, {
      fetchedAt: Date.now(),
      stations: FALLBACK_STATIONS,
    })
    await saveState(paths.stateFile, {
      volume: 65,
      muted: true,
      arabicNames: false,
      favorites: [],
      recents: [s0.id],
      lastStationId: s0.id,
    })

    const idleRun = createHarness({ alive: false, paths, now: 1_000_000 })
    expect(await idleRun.run(["status", "--json"])).toBe(0)
    const idleJson = JSON.parse(idleRun.out[0]!) as CliStatusPayload
    expect(idleJson).toEqual({
      state: "stopped",
      stationId: s0.id,
      name: s0.nameEn,
      nameAr: s0.nameAr ?? null,
      metadata: null,
      volume: 65,
      muted: true,
      sleepRemainingSec: 0,
    })

    const live = new FakeCliClient({
      state: "playing",
      stationId: s0.id,
      metadata: "Surah Al-Baqarah",
      volume: 90,
      muted: false,
      sleepUntil: 1_090_500,
    })
    const liveRun = createHarness({ alive: true, client: live, paths, now: 1_000_000 })
    expect(await liveRun.run(["status", "--json"])).toBe(0)
    const liveJson = JSON.parse(liveRun.out[0]!) as CliStatusPayload
    expect(liveJson).toEqual({
      state: "playing",
      stationId: s0.id,
      name: s0.nameEn,
      nameAr: s0.nameAr ?? null,
      metadata: "Surah Al-Baqarah",
      volume: 90,
      muted: false,
      sleepRemainingSec: 91,
    })

    const humanRun = createHarness({ alive: true, client: live, paths, now: 1_000_000 })
    expect(await humanRun.run(["status"])).toBe(0)
    expect(humanRun.out[0]).toContain("PLAYING: Shaik Abu Bakr Al Shatri")
    expect(humanRun.out[0]).toContain("SLEEP 2m")
  })

  test("stop shuts down daemon cleanly", async () => {
    const h = createHarness({ alive: true })
    expect(await h.run(["stop"])).toBe(0)
    expect(h.out[0]).toBe("Stopped")
    expect(h.client.calls).toEqual(["stopDaemon"])
  })
})
