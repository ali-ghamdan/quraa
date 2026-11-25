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
    imagesConfigFile: join(dir, "config", "images.json"),
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
        idleActive: true,
        pausedFlag: true,
        stationId: "79",
      }),
    ).toBe("paused")
    expect(
      derivePlaybackState({
        ...baseSignals,
        idleActive: true,
        pausedFlag: false,
        stationId: "79",
      }),
    ).toBe("stopped")
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

  it("stops demuxer/buffering on pause without killing mpv or sleep timer, and resumes cleanly", async () => {
    const paths = makeTempPaths()
    let openStreams = 0
    let closedStreams = 0
    const timers = new Set<ReturnType<typeof setInterval>>()

    const buildWavHeader = (): Uint8Array => {
      const buf = new ArrayBuffer(44)
      const view = new DataView(buf)
      const writeAscii = (off: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
      }
      writeAscii(0, "RIFF")
      view.setUint32(4, 0x7fffffff, true)
      writeAscii(8, "WAVE")
      writeAscii(12, "fmt ")
      view.setUint32(16, 16, true) // PCM
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true) // mono
      view.setUint32(24, 8000, true) // 8kHz
      view.setUint32(28, 16000, true) // bytes/sec
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(36, "data")
      view.setUint32(40, 0x7ffff000, true)
      return new Uint8Array(buf)
    }

    const header = buildWavHeader()
    const chunk = new Uint8Array(1600)
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        let timer: ReturnType<typeof setInterval> | null = null
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            openStreams++
            controller.enqueue(header)
            controller.enqueue(chunk)
            timer = setInterval(() => {
              try {
                controller.enqueue(chunk)
              } catch {
                if (timer) clearInterval(timer)
              }
            }, 50)
            timers.add(timer)
          },
          cancel() {
            closedStreams++
            if (timer) {
              clearInterval(timer)
              timers.delete(timer)
            }
          },
        })
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        })
      },
    })

    const client = new MpvClient(paths, { mprisPath: null })
    try {
      const pid = await client.ensureConnected()
      activePids.add(pid)
      await client.setSleepTimer(120)

      const station = {
        id: "test-wav",
        nameEn: "Local Test Stream",
        rawNameEn: "Local Test Stream",
        url: `http://127.0.0.1:${server.port}/stream.wav`,
        category: "custom" as const,
      }

      await client.playStation(station, station.nameEn)
      await waitFor(() => (client.getSnapshot().state === "playing" ? true : false), 4000, 30)
      expect(openStreams).toBe(1)

      // Pausing stops mpv demuxer (zero buffering) without killing process or timer
      await client.togglePause()
      await waitFor(async () => {
        const idle = await client.getProperty<boolean>("idle-active").catch(() => false)
        return idle && closedStreams >= 1 ? true : false
      }, 3000, 30)

      expect(await isDaemonAlive(paths)).toBe(true)
      expect(client.getSnapshot().state).toBe("paused")
      expect(client.getSnapshot().sleepUntil).toBeGreaterThan(Date.now() + 50_000)

      // Fresh reattached IPC client sees paused state + metadata preserved
      client.disconnect()
      const reattached = new MpvClient(paths, { mprisPath: null })
      await reattached.connect()
      expect(reattached.getSnapshot().state).toBe("paused")
      expect(reattached.getSnapshot().stationId).toBe(station.id)

      // Resuming opens a fresh live stream connection
      await reattached.togglePause()
      await waitFor(() => (reattached.getSnapshot().state === "playing" ? true : false), 4000, 30)
      expect(openStreams).toBe(2)

      await reattached.stopDaemon()
      activePids.delete(pid)
    } finally {
      client.disconnect()
      for (const t of timers) clearInterval(t)
      server.stop(true)
    }
  })

  it("publishes author, artwork, and Paused status via native MPRIS bridge during zero-buffer pause", async () => {
    const paths = makeTempPaths()
    const customPng = join(paths.configDir, "custom-reciter.png")
    Bun.spawnSync(["mkdir", "-p", paths.configDir])
    writeFileSync(customPng, "png-stub")

    const busSuffix = `test_${process.pid}_${Date.now()}`
    const busName = `org.mpris.MediaPlayer2.quraa.${busSuffix}`
    const playerName = `quraa.${busSuffix}`

    const buildWavHeader = (): Uint8Array => {
      const buf = new ArrayBuffer(44)
      const view = new DataView(buf)
      const writeAscii = (off: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i))
      }
      writeAscii(0, "RIFF")
      view.setUint32(4, 0x7fffffff, true)
      writeAscii(8, "WAVE")
      writeAscii(12, "fmt ")
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 8000, true)
      view.setUint32(28, 16000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeAscii(36, "data")
      view.setUint32(40, 0x7ffff000, true)
      return new Uint8Array(buf)
    }

    const header = buildWavHeader()
    const chunk = new Uint8Array(1600)
    const timers = new Set<ReturnType<typeof setInterval>>()
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch() {
        let timer: ReturnType<typeof setInterval> | null = null
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(header)
            controller.enqueue(chunk)
            timer = setInterval(() => {
              try {
                controller.enqueue(chunk)
              } catch {
                if (timer) clearInterval(timer)
              }
            }, 50)
            timers.add(timer)
          },
          cancel() {
            if (timer) {
              clearInterval(timer)
              timers.delete(timer)
            }
          },
        })
        return new Response(body, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        })
      },
    })

    const client = new MpvClient(paths, {
      useNativeMprisBridge: true,
      mprisBusName: busName,
    })
    try {
      const pid = await client.ensureConnected()
      activePids.add(pid)

      // Wait until Python MPRIS bridge claims test D-Bus name
      await waitFor(() => {
        const res = Bun.spawnSync(["playerctl", "-p", playerName, "status"], {
          stdout: "pipe",
          stderr: "ignore",
        })
        return res.exitCode === 0 ? res.stdout.toString().trim() : false
      }, 4000, 60)

      await client.playStation(
        {
          id: "79",
          nameEn: "Mishary Alafasi",
          rawNameEn: "Radio Mishary Alafasi",
          url: `http://127.0.0.1:${server.port}/stream.wav`,
          category: "reciter",
          image: customPng,
        },
        {
          displayName: "Mishary Alafasi",
          author: "Mishary Alafasi",
          artUrl: `file://${customPng}`,
        },
      )

      await waitFor(() => (client.getSnapshot().state === "playing" ? true : false), 4000, 40)
      const playingMeta = await waitFor(() => {
        const res = Bun.spawnSync(["playerctl", "-p", playerName, "metadata"], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const out = res.stdout.toString()
        return out.includes("Mishary Alafasi") && out.includes(customPng) ? out : false
      }, 3000, 60)
      expect(playingMeta).toContain("xesam:artist")
      expect(playingMeta).toContain("Mishary Alafasi")
      expect(playingMeta).toContain(`file://${customPng}`)

      // Zero-buffer pause reports Paused on MPRIS even though mpv demuxer stopped
      await client.togglePause()
      const pausedStatus = await waitFor(() => {
        const res = Bun.spawnSync(["playerctl", "-p", playerName, "status"], {
          stdout: "pipe",
          stderr: "ignore",
        })
        const out = res.stdout.toString().trim()
        return out === "Paused" ? out : false
      }, 3000, 60)
      expect(pausedStatus).toBe("Paused")

      await client.stopDaemon()
      activePids.delete(pid)

      // MPRIS bridge exits automatically once daemon shuts down
      await waitFor(() => {
        const res = Bun.spawnSync(["playerctl", "-p", playerName, "status"], {
          stdout: "ignore",
          stderr: "ignore",
        })
        return res.exitCode !== 0 ? true : false
      }, 3000, 60)
    } finally {
      client.disconnect()
      for (const t of timers) clearInterval(t)
      server.stop(true)
    }
  })
})
