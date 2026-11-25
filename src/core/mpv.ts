import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { StringDecoder } from "node:string_decoder"
import { fileURLToPath } from "node:url"
import type { Socket } from "bun"
import {
  DEFAULT_ARTWORK_PATH,
  type ImageConfigMap,
  loadImageConfig,
  resolveStationArtUrl,
} from "./images.ts"
import { parseLiveStreamMetadata } from "./metadata.ts"
import { ensureDir, type QuraaPaths } from "./paths.ts"
import type { PlaybackSnapshot, PlaybackState, Station } from "./types.ts"

const DEFAULT_MPRIS_PATH = "/usr/lib64/mpv/mpris.so"
const ASSETS_DIR = fileURLToPath(new URL("../../assets/", import.meta.url))
const DEFAULT_SLEEP_SCRIPT_PATH = fileURLToPath(
  new URL("../../assets/sleep-timer.lua", import.meta.url),
)
const DEFAULT_MPRIS_BRIDGE_PATH = fileURLToPath(
  new URL("../../assets/mpris-bridge.py", import.meta.url),
)
const DEFAULT_CLI_ENTRY_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url))

export { extractMetadataText } from "./metadata.ts"

const OBSERVED_PROPERTIES = [
  "idle-active",
  "pause",
  "paused-for-cache",
  "core-idle",
  "volume",
  "mute",
  "media-title",
  "metadata",
  "path",
  "user-data/quraa/sleep-until",
  "user-data/quraa/station-id",
  "user-data/quraa/station-url",
  "user-data/quraa/station-name",
  "user-data/quraa/station-author",
  "user-data/quraa/station-art",
  "user-data/quraa/paused",
] as const

type ObservedProperty = (typeof OBSERVED_PROPERTIES)[number]

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface RawSignals {
  pause: boolean
  pausedFlag?: boolean
  coreIdle: boolean
  idleActive: boolean
  pausedForCache: boolean
  connecting: boolean
  hasStartedAudio: boolean
  error: string | null
  volume: number
  muted: boolean
  mediaTitle: string | null
  forcedTitle: string | null
  metadataRaw: Record<string, unknown> | null
  path: string | null
  stationId: string | null
  stationUrl?: string | null
  stationName?: string | null
  stationAuthor?: string | null
  stationArt?: string | null
  sleepUntil: number
}

export interface DaemonOptions {
  initialVolume?: number
  muted?: boolean
  mprisPath?: string | null
  useNativeMprisBridge?: boolean
  mprisBusName?: string
  sleepScriptPath?: string
  mprisBridgePath?: string
  startupTimeoutMs?: number
}

export interface PlayStationOptions {
  displayName?: string
  author?: string | null
  artUrl?: string | null
}

let cachedPyGObjectAvailable: boolean | null = null

export function hasPyGObjectSupport(): boolean {
  if (cachedPyGObjectAvailable !== null) return cachedPyGObjectAvailable
  try {
    const res = Bun.spawnSync(
      [
        "python3",
        "-c",
        "import gi; gi.require_version('Gio','2.0'); from gi.repository import Gio, GLib",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    )
    cachedPyGObjectAvailable = res.exitCode === 0
  } catch {
    cachedPyGObjectAvailable = false
  }
  return cachedPyGObjectAvailable
}

function clampVolume(vol: number): number {
  if (!Number.isFinite(vol)) return 80
  return Math.max(0, Math.min(100, Math.round(vol)))
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function cleanupSocketArtifacts(paths: QuraaPaths): void {
  rmSync(paths.mpvSocketFile, { force: true })
  rmSync(paths.mpvPidFile, { force: true })
}

function readPidFile(pidFile: string): number | null {
  try {
    const raw = readFileSync(pidFile, "utf8").trim()
    const pid = Number(raw)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Derive Quraa's explicit PlaybackState from raw mpv property signals. */
export function derivePlaybackState(s: RawSignals): PlaybackState {
  if (s.error) return "error"
  if (s.idleActive) {
    if (s.connecting) return "connecting"
    if (s.pausedFlag && s.stationId) return "paused"
    return "stopped"
  }
  if (s.pause) return "paused"
  if (s.pausedForCache || s.coreIdle) {
    return s.hasStartedAudio ? "reconnecting" : "connecting"
  }
  return "playing"
}

/** Probe a Unix mpv IPC socket via `get_property pid` without attaching event observers. */
export async function probeDaemonPid(
  socketPath: string,
  timeoutMs = 500,
): Promise<number | null> {
  if (!existsSync(socketPath)) return null

  return new Promise<number | null>((resolve) => {
    let settled = false
    let buf = ""
    const decoder = new StringDecoder("utf8")
    let sock: Socket<undefined> | null = null

    const finish = (pid: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock?.end()
      } catch {
        // ignore close errors
      }
      resolve(pid)
    }

    const timer = setTimeout(() => finish(null), timeoutMs)

    Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          sock = socket
          socket.write('{"command":["get_property","pid"],"request_id":1}\n')
        },
        data(_socket, chunk) {
          buf += decoder.write(chunk)
          const lines = buf.split("\n")
          buf = lines.pop() ?? ""
          for (const line of lines) {
            if (!line.trim()) continue
            try {
              const msg = JSON.parse(line) as {
                request_id?: number
                error?: string
                data?: unknown
              }
              if (msg.request_id === 1) {
                finish(
                  msg.error === "success" && typeof msg.data === "number"
                    ? msg.data
                    : null,
                )
                return
              }
            } catch {
              // skip malformed line
            }
          }
        },
        error() {
          finish(null)
        },
        close() {
          finish(null)
        },
        connectError() {
          finish(null)
        },
      },
    }).then(
      (connected) => {
        sock = connected
        if (settled) {
          try {
            connected.end()
          } catch {
            // ignore
          }
        }
      },
      () => finish(null),
    )
  })
}

/** Check whether the background mpv daemon responds to IPC; cleans up stale socket/PID files. */
export async function isDaemonAlive(
  paths: QuraaPaths,
  timeoutMs = 500,
): Promise<boolean> {
  const pid = await probeDaemonPid(paths.mpvSocketFile, timeoutMs)
  if (pid !== null) return true
  cleanupSocketArtifacts(paths)
  return false
}

/** Ensure a detached mpv daemon is running on `paths.mpvSocketFile`, returning its PID. */
export async function ensureDaemon(
  paths: QuraaPaths,
  options: DaemonOptions = {},
): Promise<number> {
  const existingPid = await probeDaemonPid(paths.mpvSocketFile)
  if (existingPid !== null) return existingPid

  cleanupSocketArtifacts(paths)
  ensureDir(paths.runtimeDir, 0o700)

  const sleepScriptPath = options.sleepScriptPath ?? DEFAULT_SLEEP_SCRIPT_PATH
  const mprisPath =
    options.mprisPath === undefined ? DEFAULT_MPRIS_PATH : options.mprisPath
  const bridgePath = options.mprisBridgePath ?? DEFAULT_MPRIS_BRIDGE_PATH
  const wantBridge =
    mprisPath !== null &&
    (options.useNativeMprisBridge ?? hasPyGObjectSupport()) &&
    existsSync(bridgePath)

  const args = [
    "--no-config",
    "--load-scripts=no",
    "--no-video",
    "--audio-display=no",
    "--idle=yes",
    "--cache=yes",
    "--demuxer-max-bytes=2MiB",
    "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5",
    `--volume=${clampVolume(options.initialVolume ?? 80)}`,
    `--mute=${options.muted ? "yes" : "no"}`,
    `--script=${sleepScriptPath}`,
  ]

  if (wantBridge) {
    const busOpt = options.mprisBusName ? `,quraa_mpris_name=${options.mprisBusName}` : ""
    args.push(
      `--script-opts=quraa_mpris_bridge=${bridgePath},quraa_ipc=${paths.mpvSocketFile},quraa_assets=${ASSETS_DIR},quraa_config=${paths.configDir},quraa_cli=${DEFAULT_CLI_ENTRY_PATH}${busOpt}`,
    )
  } else if (mprisPath && existsSync(mprisPath)) {
    args.push(`--cover-art-files=${DEFAULT_ARTWORK_PATH}`)
    args.push(`--script=${mprisPath}`)
  }

  args.push(`--input-ipc-server=${paths.mpvSocketFile}`)

  const proc = Bun.spawn(["mpv", ...args], {
    detached: true,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })

  if (proc.pid) {
    writeFileSync(paths.mpvPidFile, `${proc.pid}\n`, { mode: 0o600 })
  }
  proc.unref()

  const deadline = Date.now() + (options.startupTimeoutMs ?? 4000)
  while (Date.now() < deadline) {
    if (proc.exitCode !== null && proc.exitCode !== 0) {
      cleanupSocketArtifacts(paths)
      throw new Error(`mpv exited unexpectedly with code ${proc.exitCode}`)
    }
    const pid = await probeDaemonPid(paths.mpvSocketFile, 300)
    if (pid !== null) return pid
    await sleep(40)
  }

  cleanupSocketArtifacts(paths)
  throw new Error(`Timed out waiting for mpv IPC socket at ${paths.mpvSocketFile}`)
}

/** Native Bun Unix JSON IPC client for the detached mpv daemon. */
export class MpvClient {
  private readonly paths: QuraaPaths
  private readonly daemonOptions: DaemonOptions
  private readonly imageConfig: { bundled: ImageConfigMap; user: ImageConfigMap }
  private activeStation: Station | null = null
  private socket: Socket<undefined> | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly snapshotListeners = new Set<(snap: PlaybackSnapshot) => void>()
  private readonly disconnectListeners = new Set<() => void>()
  private decoder = new StringDecoder("utf8")
  private readBuffer = ""
  private connected = false
  private signals: RawSignals
  private lastSyncedFallbackTitle: string | null = null

  constructor(paths: QuraaPaths, daemonOptions: DaemonOptions = {}) {
    this.paths = paths
    this.daemonOptions = daemonOptions
    this.imageConfig = loadImageConfig(paths)
    this.signals = {
      pause: false,
      pausedFlag: false,
      coreIdle: true,
      idleActive: true,
      pausedForCache: false,
      connecting: false,
      hasStartedAudio: false,
      error: null,
      volume: clampVolume(daemonOptions.initialVolume ?? 80),
      muted: Boolean(daemonOptions.muted),
      mediaTitle: null,
      forcedTitle: null,
      metadataRaw: null,
      path: null,
      stationId: null,
      stationUrl: null,
      stationName: null,
      stationAuthor: null,
      stationArt: null,
      sleepUntil: 0,
    }
  }

  get isConnected(): boolean {
    return this.connected && this.socket !== null
  }

  private isFallbackMprisMode(): boolean {
    const mprisPath =
      this.daemonOptions.mprisPath === undefined
        ? DEFAULT_MPRIS_PATH
        : this.daemonOptions.mprisPath
    if (mprisPath === null) return false
    const usingBridge =
      (this.daemonOptions.useNativeMprisBridge ?? hasPyGObjectSupport()) &&
      existsSync(this.daemonOptions.mprisBridgePath ?? DEFAULT_MPRIS_BRIDGE_PATH)
    return !usingBridge
  }

  getSnapshot(): PlaybackSnapshot {
    const stationName =
      this.signals.stationName ??
      (this.signals.forcedTitle ? this.signals.forcedTitle.replace(/ — Quraa$/, "") : null)
    const parsed = parseLiveStreamMetadata({
      metadataRaw: this.signals.metadataRaw,
      mediaTitle: this.signals.mediaTitle,
      forcedTitle: this.signals.forcedTitle,
      stationName,
      stationAuthor: this.signals.stationAuthor ?? null,
      stationUrl: this.signals.stationUrl ?? this.signals.path,
    })

    const artUrl = resolveStationArtUrl({
      station: this.activeStation,
      author: parsed.author ?? this.signals.stationAuthor ?? null,
      fallbackUri: this.signals.stationArt ?? null,
      config: this.imageConfig,
    })

    return {
      state: derivePlaybackState(this.signals),
      stationId: this.signals.stationId,
      title: stationName ?? parsed.trackTitle,
      trackTitle: parsed.trackTitle,
      author: parsed.author,
      artUrl,
      metadata: parsed.metadata,
      volume: this.signals.volume,
      muted: this.signals.muted,
      sleepUntil: this.signals.sleepUntil,
      error: this.signals.error,
    }
  }

  onSnapshot(listener: (snap: PlaybackSnapshot) => void): () => void {
    this.snapshotListeners.add(listener)
    return () => {
      this.snapshotListeners.delete(listener)
    }
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener)
    return () => {
      this.disconnectListeners.delete(listener)
    }
  }

  private emitSnapshot(): void {
    const snap = this.getSnapshot()
    if (this.isConnected && this.isFallbackMprisMode()) {
      const targetTitle = snap.trackTitle
        ? snap.author && !snap.trackTitle.includes(snap.author)
          ? `${snap.author} — ${snap.trackTitle}`
          : snap.trackTitle
        : snap.title
          ? `${snap.title} — Quraa`
          : null
      if (targetTitle && targetTitle !== this.lastSyncedFallbackTitle) {
        this.lastSyncedFallbackTitle = targetTitle
        void this.setProperty("force-media-title", targetTitle).catch(() => undefined)
      }
    }
    if (this.snapshotListeners.size === 0) return
    for (const listener of this.snapshotListeners) {
      listener(snap)
    }
  }

  /** Connect to an already-running daemon socket without spawning one. */
  async connect(): Promise<void> {
    if (this.isConnected) return

    this.decoder = new StringDecoder("utf8")
    this.readBuffer = ""

    await new Promise<void>((resolve, reject) => {
      let opened = false

      Bun.connect({
        unix: this.paths.mpvSocketFile,
        socket: {
          open: (sock) => {
            this.socket = sock
            this.connected = true
            opened = true
            resolve()
          },
          data: (_sock, chunk) => {
            this.handleChunk(chunk)
          },
          close: () => {
            this.handleSocketClosed("mpv IPC connection closed")
          },
          error: (_sock, err) => {
            if (!opened) reject(err)
            this.handleSocketClosed(err.message || "mpv IPC socket error")
          },
          connectError: (_sock, err) => {
            if (!opened) reject(err)
            this.handleSocketClosed(err.message || "Failed to connect to mpv IPC")
          },
        },
      }).catch((err: unknown) => {
        if (!opened) {
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    })

    await Promise.all(
      OBSERVED_PROPERTIES.map((prop, index) =>
        this.command(["observe_property", index + 1, prop]),
      ),
    )

    const initialResults = await Promise.allSettled([
      ...OBSERVED_PROPERTIES.map((prop) => this.getProperty(prop)),
      this.getProperty<string>("force-media-title"),
    ])

    let changed = false
    for (let i = 0; i < OBSERVED_PROPERTIES.length; i++) {
      const res = initialResults[i]
      if (res?.status === "fulfilled") {
        if (this.applyPropertyChange(OBSERVED_PROPERTIES[i]!, res.value)) {
          changed = true
        }
      }
    }
    const forcedRes = initialResults[OBSERVED_PROPERTIES.length]
    if (
      forcedRes?.status === "fulfilled" &&
      typeof forcedRes.value === "string" &&
      forcedRes.value.trim()
    ) {
      this.signals.forcedTitle = forcedRes.value.trim()
      changed = true
    }
    if (changed) {
      this.emitSnapshot()
    }
  }

  /** Spawn the daemon if missing/stale, then connect and subscribe to property events. */
  async ensureConnected(): Promise<number> {
    const pid = await ensureDaemon(this.paths, this.daemonOptions)
    await this.connect()
    return pid
  }

  disconnect(): void {
    const sock = this.socket
    this.socket = null
    this.connected = false
    this.rejectAllPending(new Error("Disconnected from mpv IPC"))
    if (sock) {
      try {
        sock.end()
      } catch {
        // ignore close errors
      }
    }
  }

  async command<T = unknown>(args: unknown[], timeoutMs = 4000): Promise<T> {
    const sock = this.socket
    if (!sock || !this.connected) {
      throw new Error("Not connected to mpv IPC")
    }

    const requestId = this.nextRequestId++
    const payload = JSON.stringify({ command: args, request_id: requestId }) + "\n"

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error(`mpv IPC command timed out: ${String(args[0])}`))
      }, timeoutMs)

      this.pending.set(requestId, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      })

      const written = sock.write(payload)
      if (written < 0) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(new Error("Failed to write to mpv IPC socket"))
      }
    })
  }

  async getProperty<T = unknown>(name: string): Promise<T> {
    return this.command<T>(["get_property", name])
  }

  async setProperty(name: string, value: unknown): Promise<void> {
    await this.command(["set_property", name, value])
  }

  async playStation(
    station: Station,
    options?: string | PlayStationOptions,
  ): Promise<void> {
    const opts: PlayStationOptions =
      typeof options === "string" ? { displayName: options } : (options ?? {})

    const stationName =
      (opts.displayName ?? station.nameEn).trim() || station.rawNameEn
    const defaultAuthor =
      opts.author !== undefined
        ? opts.author
        : station.category === "reciter"
          ? station.nameEn
          : null
    const artUrl =
      opts.artUrl ??
      resolveStationArtUrl({
        station,
        author: defaultAuthor,
        config: this.imageConfig,
      })

    this.activeStation = station
    this.lastSyncedFallbackTitle = null
    this.signals.pausedFlag = false
    this.signals.pause = false
    this.signals.stationId = station.id
    this.signals.stationUrl = station.url
    this.signals.stationName = stationName
    this.signals.stationAuthor = defaultAuthor
    this.signals.stationArt = artUrl
    this.signals.forcedTitle = this.isFallbackMprisMode() ? `${stationName} — Quraa` : null
    this.signals.mediaTitle = null
    this.signals.metadataRaw = null
    this.signals.connecting = true
    this.signals.hasStartedAudio = false
    this.signals.error = null
    this.emitSnapshot()

    await this.setProperty("user-data/quraa/paused", "")
    await this.setProperty("user-data/quraa/station-id", station.id)
    await this.setProperty("user-data/quraa/station-url", station.url)
    await this.setProperty("user-data/quraa/station-name", stationName)
    await this.setProperty("user-data/quraa/station-author", defaultAuthor ?? "")
    await this.setProperty("user-data/quraa/station-art", artUrl)

    if (this.isFallbackMprisMode()) {
      await this.setProperty("force-media-title", `${stationName} — Quraa`)
      if (artUrl.startsWith("file://")) {
        await this.setProperty("cover-art-files", [fileURLToPath(artUrl)]).catch(
          () => undefined,
        )
      }
    } else {
      await this.setProperty("force-media-title", "").catch(() => undefined)
    }

    await this.command(["loadfile", station.url, "replace"])
  }

  async togglePause(): Promise<void> {
    const isPaused = derivePlaybackState(this.signals) === "paused"
    await this.setPause(!isPaused)
  }

  async setPause(paused: boolean): Promise<void> {
    if (paused) {
      // Stop the demuxer under --idle=yes so mpv frees buffers & stops downloading while staying alive.
      this.signals.pausedFlag = true
      this.signals.pause = false
      this.signals.connecting = false
      this.signals.hasStartedAudio = false
      this.signals.error = null
      this.emitSnapshot()
      await this.setProperty("user-data/quraa/paused", "1")
      await this.command(["stop"])
      return
    }

    this.signals.pausedFlag = false
    await this.setProperty("user-data/quraa/paused", "")
    const resumeUrl = this.signals.stationUrl ?? this.signals.path
    if (resumeUrl) {
      this.signals.pause = false
      this.signals.connecting = true
      this.signals.hasStartedAudio = false
      this.signals.error = null
      this.emitSnapshot()
      if (this.isFallbackMprisMode() && this.signals.forcedTitle) {
        await this.setProperty("force-media-title", this.signals.forcedTitle).catch(
          () => undefined,
        )
      }
      await this.command(["loadfile", resumeUrl, "replace"])
      return
    }
    await this.setProperty("pause", false)
  }

  async setVolume(volume: number): Promise<number> {
    const clamped = clampVolume(volume)
    this.signals.volume = clamped
    this.emitSnapshot()
    await this.setProperty("volume", clamped)
    return clamped
  }

  async toggleMute(): Promise<void> {
    await this.command(["cycle", "mute"])
  }

  async setMute(muted: boolean): Promise<void> {
    this.signals.muted = muted
    this.emitSnapshot()
    await this.setProperty("mute", muted)
  }

  async setSleepTimer(seconds: number): Promise<void> {
    const cleanSeconds = Math.max(0, Math.floor(seconds))
    await this.command(["script-message", "quraa-sleep", String(cleanSeconds)])
  }

  async stopPlayback(): Promise<void> {
    this.signals.pausedFlag = false
    this.signals.connecting = false
    this.signals.error = null
    await this.setProperty("user-data/quraa/paused", "").catch(() => undefined)
    await this.command(["stop"])
  }

  /** Gracefully terminate the background mpv daemon and clean up runtime socket/PID files. */
  async stopDaemon(): Promise<void> {
    const pid =
      (await probeDaemonPid(this.paths.mpvSocketFile, 300)) ??
      readPidFile(this.paths.mpvPidFile)

    if (this.isConnected) {
      await this.command(["quit"], 800).catch(() => undefined)
      this.disconnect()
    } else if (existsSync(this.paths.mpvSocketFile)) {
      await sendOneShotQuit(this.paths.mpvSocketFile)
    }

    if (pid !== null) {
      const deadline = Date.now() + 1500
      while (Date.now() < deadline && isPidRunning(pid)) {
        await sleep(40)
      }
      if (isPidRunning(pid)) {
        try {
          process.kill(pid, "SIGTERM")
        } catch {
          // already exited
        }
      }
    }

    cleanupSocketArtifacts(this.paths)
  }

  private handleChunk(chunk: Buffer): void {
    this.readBuffer += this.decoder.write(chunk)
    const lines = this.readBuffer.split("\n")
    this.readBuffer = lines.pop() ?? ""

    for (const line of lines) {
      if (!line.trim()) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }

      if (typeof msg.request_id === "number") {
        this.resolvePending(msg.request_id, msg)
        continue
      }

      if (typeof msg.event === "string") {
        this.handleEvent(msg)
      }
    }
  }

  private resolvePending(requestId: number, msg: Record<string, unknown>): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(requestId)

    const err = typeof msg.error === "string" ? msg.error : "unknown error"
    if (err === "success") {
      entry.resolve(msg.data)
    } else {
      entry.reject(new Error(`mpv command error: ${err}`))
    }
  }

  private handleEvent(msg: Record<string, unknown>): void {
    const event = msg.event

    if (event === "property-change") {
      const name = msg.name as ObservedProperty | undefined
      if (name && this.applyPropertyChange(name, msg.data)) {
        this.emitSnapshot()
      }
      return
    }

    if (event === "start-file") {
      this.signals.connecting = true
      this.signals.hasStartedAudio = false
      this.signals.error = null
      this.emitSnapshot()
      return
    }

    if (event === "playback-restart") {
      this.signals.connecting = false
      this.signals.hasStartedAudio = true
      this.signals.error = null
      this.emitSnapshot()
      return
    }

    if (event === "end-file") {
      const reason = typeof msg.reason === "string" ? msg.reason : ""
      this.signals.connecting = false

      if (reason === "error") {
        const detail =
          typeof msg.file_error === "string" && msg.file_error.trim()
            ? msg.file_error.trim()
            : "Stream unavailable"
        this.signals.error = detail
      } else if (reason === "stop" || reason === "quit") {
        this.signals.error = null
        this.signals.hasStartedAudio = false
      }
      this.emitSnapshot()
      return
    }

    if (event === "shutdown") {
      this.handleSocketClosed("mpv shutdown")
    }
  }

  private applyPropertyChange(name: ObservedProperty, data: unknown): boolean {
    switch (name) {
      case "pause":
        this.signals.pause = Boolean(data)
        return true
      case "core-idle": {
        const next = Boolean(data)
        this.signals.coreIdle = next
        if (!next && !this.signals.idleActive && !this.signals.pause) {
          this.signals.connecting = false
          this.signals.hasStartedAudio = true
          this.signals.error = null
        }
        return true
      }
      case "idle-active": {
        const idle = Boolean(data)
        this.signals.idleActive = idle
        if (idle) {
          this.signals.hasStartedAudio = false
        }
        return true
      }
      case "paused-for-cache":
        this.signals.pausedForCache = Boolean(data)
        return true
      case "volume":
        if (typeof data === "number" && Number.isFinite(data)) {
          this.signals.volume = clampVolume(data)
          return true
        }
        return false
      case "mute":
        this.signals.muted = Boolean(data)
        return true
      case "media-title":
        this.signals.mediaTitle = typeof data === "string" && data ? data : null
        return true
      case "metadata":
        this.signals.metadataRaw =
          data && typeof data === "object" && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : null
        return true
      case "path":
        this.signals.path = typeof data === "string" && data ? data : null
        return true
      case "user-data/quraa/sleep-until": {
        const num = Number(data)
        this.signals.sleepUntil = Number.isFinite(num) && num > 0 ? num : 0
        return true
      }
      case "user-data/quraa/station-id":
        this.signals.stationId = typeof data === "string" && data ? data : null
        return true
      case "user-data/quraa/station-url":
        this.signals.stationUrl = typeof data === "string" && data ? data : null
        return true
      case "user-data/quraa/station-name":
        this.signals.stationName = typeof data === "string" && data ? data : null
        return true
      case "user-data/quraa/station-author":
        this.signals.stationAuthor = typeof data === "string" && data ? data : null
        return true
      case "user-data/quraa/station-art":
        this.signals.stationArt = typeof data === "string" && data ? data : null
        return true
      case "user-data/quraa/paused":
        this.signals.pausedFlag = data === "1" || data === true
        return true
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(err)
      this.pending.delete(id)
    }
  }

  private handleSocketClosed(_reason: string): void {
    const wasConnected = this.connected
    this.socket = null
    this.connected = false
    this.rejectAllPending(new Error(_reason))
    if (wasConnected) {
      for (const listener of this.disconnectListeners) {
        listener()
      }
    }
  }
}

async function sendOneShotQuit(socketPath: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 400)
    Bun.connect({
      unix: socketPath,
      socket: {
        open(sock) {
          sock.write('{"command":["quit"]}\n')
          setTimeout(() => {
            try {
              sock.end()
            } catch {
              // ignore
            }
            clearTimeout(timer)
            resolve()
          }, 50)
        },
        data() {
          // ignore
        },
        error() {
          clearTimeout(timer)
          resolve()
        },
        close() {
          clearTimeout(timer)
          resolve()
        },
        connectError() {
          clearTimeout(timer)
          resolve()
        },
      },
    }).catch(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
