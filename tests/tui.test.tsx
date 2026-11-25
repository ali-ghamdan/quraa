import { afterEach, describe, expect, test } from "bun:test"
import { testRender } from "@opentui/solid"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FALLBACK_STATIONS } from "../src/core/catalog.ts"
import { type QuraaPaths, resolvePaths } from "../src/core/paths.ts"
import { atomicWriteJson, loadCustomStations, loadState } from "../src/core/store.ts"
import type { PlaybackSnapshot, Station } from "../src/core/types.ts"
import { App, type MpvController } from "../src/ui/App.tsx"

class FakeMpvController implements MpvController {
  isConnected: boolean
  calls: string[] = []
  private snapshot: PlaybackSnapshot
  private snapshotListeners = new Set<(snap: PlaybackSnapshot) => void>()
  private disconnectListeners = new Set<() => void>()

  constructor(initial?: Partial<PlaybackSnapshot> & { connected?: boolean }) {
    const { connected = false, ...snap } = initial ?? {}
    this.isConnected = connected
    this.snapshot = {
      state: "stopped",
      stationId: null,
      title: null,
      metadata: null,
      volume: 80,
      muted: false,
      sleepUntil: 0,
      error: null,
      ...snap,
    }
  }

  getSnapshot(): PlaybackSnapshot {
    return { ...this.snapshot }
  }

  onSnapshot(listener: (snap: PlaybackSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => this.snapshotListeners.delete(listener)
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => this.disconnectListeners.delete(listener)
  }

  pushSnapshot(patch: Partial<PlaybackSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch }
    const next = this.getSnapshot()
    for (const listener of this.snapshotListeners) listener(next)
  }

  async connect(): Promise<void> {
    this.calls.push("connect")
    this.isConnected = true
  }

  async ensureConnected(): Promise<number> {
    this.calls.push("ensureConnected")
    this.isConnected = true
    return 99999
  }

  disconnect(): void {
    this.calls.push("disconnect")
    this.isConnected = false
  }

  async playStation(station: Station, displayName?: string): Promise<void> {
    this.calls.push(`playStation:${station.id}`)
    this.pushSnapshot({
      state: "playing",
      stationId: station.id,
      title: displayName ?? station.nameEn,
      error: null,
    })
  }

  async togglePause(): Promise<void> {
    this.calls.push("togglePause")
    this.pushSnapshot({
      state: this.snapshot.state === "paused" ? "playing" : "paused",
    })
  }

  async setVolume(volume: number): Promise<number> {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)))
    this.calls.push(`setVolume:${clamped}`)
    this.pushSnapshot({ volume: clamped })
    return clamped
  }

  async toggleMute(): Promise<void> {
    this.calls.push("toggleMute")
    this.pushSnapshot({ muted: !this.snapshot.muted })
  }

  async setSleepTimer(seconds: number): Promise<void> {
    this.calls.push(`setSleepTimer:${seconds}`)
    this.pushSnapshot({
      sleepUntil: seconds > 0 ? Date.now() + seconds * 1000 : 0,
    })
  }

  async stopDaemon(): Promise<void> {
    this.calls.push("stopDaemon")
    this.isConnected = false
    this.pushSnapshot({ state: "stopped", stationId: null, sleepUntil: 0 })
  }
}

let setup: Awaited<ReturnType<typeof testRender>> | null = null
const tempDirs: string[] = []

function makeTempPaths(): QuraaPaths {
  const root = mkdtempSync(join(tmpdir(), "quraa-tui-test-"))
  tempDirs.push(root)
  return resolvePaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, "cfg"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
  })
}

async function flushUi(ms = 25): Promise<void> {
  await Bun.sleep(ms)
  if (setup && !setup.renderer.isDestroyed) {
    await setup.renderOnce()
  }
}

afterEach(async () => {
  if (setup) {
    try {
      if (!setup.renderer.isDestroyed) {
        await setup.dispose()
      }
    } catch {
      // ignore if test already triggered renderer.destroy() via q/Q
    }
    setup = null
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe("Quraa TUI matrix", () => {
  test("renders cleanly across narrow (60x16), standard (80x24), and wide (140x40) viewports", async () => {
    const paths = makeTempPaths()
    const client = new FakeMpvController()

    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 60, height: 16 },
    )
    await flushUi()
    const narrow = setup.captureCharFrame()
    expect(narrow).toContain("Quraa")
    expect(narrow).toContain("All Fav")
    expect(narrow).toContain("VOL 080%")
    expect(narrow).toContain("? Help")
    await setup.dispose()
    setup = null

    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 80, height: 24 },
    )
    await flushUi()
    const standard = setup.captureCharFrame()
    expect(standard).toContain("1:All")
    expect(standard).toContain("VOL 080% [")
    expect(standard).toContain("q Detach")
    expect(standard).toContain("Q Stop")
    await setup.dispose()
    setup = null

    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 140, height: 40 },
    )
    await flushUi()
    const wide = setup.captureCharFrame()
    expect(wide).toContain("-/= Vol")
    expect(wide).toContain("a AR/EN")
    expect(wide).toContain("+ Add")
  })

  test("displays playing + ICY metadata, connecting/reconnecting + no-motion, paused, error retry, and sleep timer", async () => {
    const paths = makeTempPaths()
    const client = new FakeMpvController()

    setup = await testRender(
      () => (
        <App
          paths={paths}
          noMotion
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 96, height: 24 },
    )
    await flushUi()

    expect(setup.captureCharFrame()).toContain("■ IDLE")

    // Play highlighted station
    setup.mockInput.pressEnter()
    await flushUi()
    const first = FALLBACK_STATIONS[0]!
    expect(client.calls).toContain(`playStation:${first.id}`)
    expect(setup.captureCharFrame()).toContain("▶ PLAYING")
    expect(setup.captureCharFrame()).toContain(first.nameEn)

    // Long ICY metadata updates live
    client.pushSnapshot({ metadata: "Surah Al-Kahf — Live Recitation Stream" })
    await flushUi()
    expect(setup.captureCharFrame()).toContain("Surah Al-Kahf")

    // Buffering / reconnecting with --no-motion uses static glyph "◌"
    client.pushSnapshot({ state: "connecting" })
    await flushUi()
    expect(setup.captureCharFrame()).toContain("◌ BUFFERING…")

    client.pushSnapshot({ state: "reconnecting" })
    await flushUi()
    expect(setup.captureCharFrame()).toContain("◌ RECONNECTING…")

    // Paused state via Space
    client.pushSnapshot({ state: "playing" })
    await flushUi()
    setup.mockInput.pressKey(" ")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("⏸ PAUSED")

    // Error state + Enter retries
    client.pushSnapshot({ state: "error", error: "Network timeout" })
    await flushUi()
    expect(setup.captureCharFrame()).toContain("✕ UNAVAILABLE (Network timeout) — Enter retry")

    setup.mockInput.pressEnter()
    await flushUi()
    expect(setup.captureCharFrame()).toContain("▶ PLAYING")

    // Sleep timer toggle (t -> 15m)
    setup.mockInput.pressKey("t")
    await flushUi()
    expect(client.calls).toContain("setSleepTimer:900")
    expect(setup.captureCharFrame()).toContain("SLP ")
  })

  test("handles empty tabs (Favorites/Recent/Custom), zero search hits + Esc recovery, favorites star, and Arabic toggle", async () => {
    const paths = makeTempPaths()
    const client = new FakeMpvController()

    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 90, height: 24 },
    )
    await flushUi()

    // Empty Favorites tab (2)
    setup.mockInput.pressKey("2")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("No favorites yet.")

    // Empty Recent tab (3)
    setup.mockInput.pressKey("3")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("No recent stations yet.")

    // Empty Custom tab (6)
    setup.mockInput.pressKey("6")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("No custom stations yet.")

    // Back to All (1), star first station with f, verify Favorites tab populated
    setup.mockInput.pressKey("1")
    await flushUi()
    setup.mockInput.pressKey("f")
    await flushUi()
    setup.mockInput.pressKey("2")
    await flushUi()
    expect(setup.captureCharFrame()).toContain(FALLBACK_STATIONS[0]!.nameEn)
    expect(setup.captureCharFrame()).toContain("★")

    // Arabic toggle (a)
    setup.mockInput.pressKey("a")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("[AR]")
    expect(setup.captureCharFrame()).toContain(FALLBACK_STATIONS[0]!.nameAr!)

    // Switch back to All and EN, search zero hits -> Esc recovers
    setup.mockInput.pressKey("a")
    setup.mockInput.pressKey("1")
    await flushUi()
    setup.mockInput.pressKey("/")
    await flushUi()
    await setup.mockInput.typeText("zzzzunlikely")
    await flushUi()
    expect(setup.captureCharFrame()).toContain('No stations match "zzzzunlikely".')

    setup.mockInput.pressEscape()
    await flushUi()
    expect(setup.captureCharFrame()).toContain(FALLBACK_STATIONS[0]!.nameEn)
  })

  test("validates Add Custom modal, saves custom station, deletes with d, and restores via u undo", async () => {
    const paths = makeTempPaths()
    const client = new FakeMpvController()

    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 96, height: 26 },
    )
    await flushUi()

    // Deleting non-custom station shows protective notice
    setup.mockInput.pressKey("d")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("Only custom stations can be deleted")

    // Open Add Custom modal (+)
    setup.mockInput.pressKey("+")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("Add Custom Station")

    // Submit empty name -> inline validation error
    setup.mockInput.pressEnter()
    await flushUi()
    expect(setup.captureCharFrame()).toContain("✕ Enter a station name")

    // Enter name, switch to URL with Tab, enter invalid URL -> inline validation error
    await setup.mockInput.typeText("My Test Radio")
    await flushUi()
    setup.mockInput.pressTab()
    await flushUi()
    await setup.mockInput.typeText("ftp://bad-stream")
    await flushUi()
    setup.mockInput.pressEnter()
    await flushUi()
    expect(setup.captureCharFrame()).toContain("Only http:// and https:// stream URLs are allowed")

    // Clear URL via Backspace loop and type valid HTTPS URL
    for (let i = 0; i < 20; i++) {
      setup.mockInput.pressBackspace()
    }
    await flushUi()
    await setup.mockInput.typeText("https://stream.example.com/quran.mp3")
    await flushUi()
    setup.mockInput.pressEnter()
    await flushUi()

    const afterAdd = setup.captureCharFrame()
    expect(afterAdd).toContain("My Test Radio")
    expect(afterAdd).toContain("[Custom]")
    const savedCustom = await loadCustomStations(paths.customStationsFile)
    expect(savedCustom.some((s) => s.nameEn === "My Test Radio")).toBe(true)

    // Delete with d -> shows undo toast -> restore with u
    setup.mockInput.pressKey("d")
    await flushUi()
    expect(setup.captureCharFrame()).toContain('Removed "My Test Radio" — press u to undo')

    setup.mockInput.pressKey("u")
    await flushUi()
    expect(setup.captureCharFrame()).toContain('Restored "My Test Radio"')
    expect(setup.captureCharFrame()).toContain("My Test Radio")
  })

  test("Help modal (?) restores browse mode on Esc, and q/Q detach vs stopDaemon cleanly", async () => {
    const paths = makeTempPaths()
    await atomicWriteJson(paths.customStationsFile, [])
    const client = new FakeMpvController({ connected: true, state: "playing", stationId: FALLBACK_STATIONS[0]!.id })

    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client}
        />
      ),
      { width: 96, height: 28 },
    )
    await flushUi()

    // Open Help modal
    setup.mockInput.pressKey("?")
    await flushUi()
    expect(setup.captureCharFrame()).toContain("Keyboard Shortcuts")
    expect(setup.captureCharFrame()).toContain("Toggle this help")

    // Close Help via Esc -> focus returns cleanly to browse mode (navigation works)
    setup.mockInput.pressEscape()
    await flushUi()
    expect(setup.captureCharFrame()).not.toContain("Keyboard Shortcuts")

    // Volume step persists and updates client
    setup.mockInput.pressKey("=")
    await flushUi()
    expect(client.calls).toContain("setVolume:85")
    expect((await loadState(paths.stateFile)).volume).toBe(85)

    // q detaches cleanly without stopping daemon
    let destroyCount = 0
    const origDestroy = setup.renderer.destroy.bind(setup.renderer)
    setup.renderer.destroy = (() => {
      destroyCount += 1
      origDestroy()
    }) as typeof setup.renderer.destroy

    setup.mockInput.pressKey("q")
    await flushUi()
    expect(client.calls).toContain("disconnect")
    expect(client.calls).not.toContain("stopDaemon")
    expect(destroyCount).toBe(1)
    setup = null

    // Fresh session pressing Shift+Q stops daemon + destroys renderer
    const client2 = new FakeMpvController({ connected: true, state: "playing", stationId: FALLBACK_STATIONS[0]!.id })
    setup = await testRender(
      () => (
        <App
          paths={paths}
          initialCatalog={FALLBACK_STATIONS}
          clientFactory={() => client2}
        />
      ),
      { width: 96, height: 28 },
    )
    await flushUi()

    let stopDestroyCount = 0
    const origDestroy2 = setup.renderer.destroy.bind(setup.renderer)
    setup.renderer.destroy = (() => {
      stopDestroyCount += 1
      origDestroy2()
    }) as typeof setup.renderer.destroy

    setup.mockInput.pressKey("q", { shift: true })
    await flushUi(40)
    expect(client2.calls).toContain("stopDaemon")
    expect(stopDestroyCount).toBe(1)
    setup = null
  })
})
