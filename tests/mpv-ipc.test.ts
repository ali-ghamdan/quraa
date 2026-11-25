import { afterEach, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  derivePlaybackState,
  extractMetadataText,
  isDaemonAlive,
  MpvClient,
  probeDaemonPid,
} from "../src/core/mpv.ts"
import type { QuraaPaths } from "../src/core/paths.ts"
import type { PlaybackSnapshot } from "../src/core/types.ts"

const tempDirs: string[] = []
const activePids = new Set<number>()

function makeTempPaths(): QuraaPaths {
  const dir = mkdtempSync(join(tmpdir(), "quraa-mpv-test-"))
  tempDirs.push(dir)
  return {
    configDir: join(dir, "config"),
    cacheDir: join(dir, "cache"),
    stateDir: join(dir, "state"),
    runtimeDir: join(dir, "run"),
    customStationsFile: join(dir, "config", "stations.json"),
    cacheStationsFile: join(dir, "cache", "stations.json"),
    stateFile: join(dir, "state", "state.json"),
    mpvSocketFile: join(dir, "run", "mpv.sock"),
    mpvPidFile: join(dir, "run", "mpv.pid"),
  }
}

async function waitFor<T>(
  fn: () => T | null | false | Promise<T | null | false>,
  timeoutMs = 3000,
  stepMs = 40,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const res = await fn()
    if (res) return res
    await new Promise((r) => setTimeout(r, stepMs))
  }
  throw new Error(`Timed out waiting after ${timeoutMs}ms`)
}

afterEach(() => {
  for (const pid of activePids) {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // already dead
    }
    activePids.delete(pid)
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("mpv state derivation & metadata parsing", () => {
  const baseSignals = {
    pause: false,
    coreIdle: true,
    idleActive: true,
    pausedForCache: false,
    connecting: false,
    hasStartedAudio: false,
    error: null as string | null,
    volume: 80,
    muted: false,
    mediaTitle: null as string | null,
    forcedTitle: null as string | null,
    metadataRaw: null as Record<string, unknown> | null,
    path: null as string | null,
    stationId: null as string | null,
    sleepUntil: 0,
  }

  it("derives all PlaybackState transitions accurately", () => {
    expect(derivePlaybackState(baseSignals)).toBe("stopped")
    expect(derivePlaybackState({ ...baseSignals, connecting: true })).toBe("connecting")
    expect(
      derivePlaybackState({
        ...baseSignals,
        idleActive: false,
        coreIdle: true,
        hasStartedAudio: false,
      }),
    ).toBe("connecting")
    expect(
      derivePlaybackState({
        ...baseSignals,
        idleActive: false,
        coreIdle: false,
        hasStartedAudio: true,
      }),
    ).toBe("playing")
    expect(
      derivePlaybackState({
        ...baseSignals,
        idleActive: false,
        coreIdle: false,
        pausedForCache: true,
        hasStartedAudio: true,
      }),
    ).toBe("reconnecting")
    expect(
      derivePlaybackState({
        ...baseSignals,
        idleActive: false,
        coreIdle: true,
        hasStartedAudio: true,
      }),
    ).toBe("reconnecting")
    expect(
      derivePlaybackState({
        ...baseSignals,
        idleActive: false,
        pause: true,
      }),
    ).toBe("paused")
    expect(
      derivePlaybackState({
        ...baseSignals,
        error: "Failed to open stream",
      }),
    ).toBe("error")
  })

  it("extracts ICY metadata and suppresses duplicated forced titles", () => {
    expect(
      extractMetadataText(
        { "icy-title": "Surah Al-Kahf" },
        "Mishary — Quraa",
        "Mishary — Quraa",
      ),
    ).toBe("Surah Al-Kahf")

    expect(
      extractMetadataText(
        { title: "Mishary — Quraa" },
        "Mishary — Quraa",
        "Mishary — Quraa",
      ),
    ).toBeNull()

    expect(
      extractMetadataText(
        { Artist: "Al-Afasy", Title: "Surah Yasin" },
        null,
        "Al-Afasy — Quraa",
      ),
    ).toBe("Al-Afasy — Surah Yasin")
  })
})

describe("real mpv daemon IPC & sleep-timer integration", () => {
  it("cleans up stale socket and PID artifacts", async () => {
    const paths = makeTempPaths()
    const runDir = paths.runtimeDir
    await Bun.write(join(runDir, "mpv.sock"), "stale")
    writeFileSync(paths.mpvPidFile, "999999\n")

    expect(await isDaemonAlive(paths, 200)).toBe(false)
    expect(existsSync(paths.mpvSocketFile)).toBe(false)
    expect(existsSync(paths.mpvPidFile)).toBe(false)
  })

  it("spawns detached mpv, survives detach/reattach, syncs volume/sleep-timer, and stops cleanly", async () => {
    const paths = makeTempPaths()
    const client1 = new MpvClient(paths, {
      initialVolume: 65,
      muted: false,
      mprisPath: null,
    })

    const pid = await client1.ensureConnected()
    activePids.add(pid)
    expect(pid).toBeGreaterThan(0)
    expect(readFileSync(paths.mpvPidFile, "utf8").trim()).toBe(String(pid))
    expect(await isDaemonAlive(paths)).toBe(true)
    expect(await probeDaemonPid(paths.mpvSocketFile)).toBe(pid)

    await client1.setVolume(42)
    await client1.setMute(true)

    const snap1 = await waitFor(() => {
      const s = client1.getSnapshot()
      return s.volume === 42 && s.muted ? s : false
    })
    expect(snap1.state).toBe("stopped")
    expect(snap1.volume).toBe(42)
    expect(snap1.muted).toBe(true)

    // Sleep timer updates user-data/quraa/sleep-until via sleep-timer.lua
    const snapshots: PlaybackSnapshot[] = []
    const unsub = client1.onSnapshot((s) => snapshots.push(s))
    await client1.setSleepTimer(300)

    const withTimer = await waitFor(() => {
      const s = client1.getSnapshot()
      return s.sleepUntil > Date.now() + 200_000 ? s : false
    })
    expect(withTimer.sleepUntil).toBeGreaterThan(Date.now() + 200_000)
    expect(snapshots.some((s) => s.sleepUntil === withTimer.sleepUntil)).toBe(true)
    unsub()

    // Simulate TUI detach ('q'): daemon stays alive & second client reattaches with preserved state
    client1.disconnect()
    expect(client1.isConnected).toBe(false)
    expect(await isDaemonAlive(paths)).toBe(true)

    const client2 = new MpvClient(paths, { mprisPath: null })
    await client2.connect()

    const reattached = await waitFor(() => {
      const s = client2.getSnapshot()
      return s.volume === 42 && s.muted && s.sleepUntil > 0 ? s : false
    })
    expect(reattached.volume).toBe(42)
    expect(reattached.muted).toBe(true)
    expect(reattached.sleepUntil).toBe(withTimer.sleepUntil)

    // Cancel sleep timer with 0
    await client2.setSleepTimer(0)
    await waitFor(() => (client2.getSnapshot().sleepUntil === 0 ? true : false))
    expect(Number(await client2.getProperty("user-data/quraa/sleep-until"))).toBe(0)

    // Clean daemon shutdown ('Q')
    await client2.stopDaemon()
    activePids.delete(pid)
    expect(await isDaemonAlive(paths, 200)).toBe(false)
    expect(existsSync(paths.mpvSocketFile)).toBe(false)
    expect(existsSync(paths.mpvPidFile)).toBe(false)
  })

  it("auto-quits detached mpv daemon when sleep timer expires", async () => {
    const paths = makeTempPaths()
    const client = new MpvClient(paths, { mprisPath: null })
    const pid = await client.ensureConnected()
    activePids.add(pid)

    await client.setSleepTimer(1)
    client.disconnect()

    // Wait for Lua mp.add_timeout(1, quit) to terminate mpv
    await waitFor(async () => !(await isDaemonAlive(paths, 150)), 4000, 100)
    activePids.delete(pid)
    expect(existsSync(paths.mpvSocketFile)).toBe(false)
  })
})
