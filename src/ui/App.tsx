import type { TerminalColors } from "@opentui/core"
import { KeymapProvider } from "@opentui/keymap/solid"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import {
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js"
import { formatDisplayText } from "../core/arabic.ts"
import {
  FALLBACK_STATIONS,
  filterStations,
  getStationDisplayName,
  loadCatalog,
} from "../core/catalog.ts"
import { loadImageConfig, resolveStationArtUrl } from "../core/images.ts"
import { isDaemonAlive, MpvClient } from "../core/mpv.ts"
import { type QuraaPaths, resolvePaths } from "../core/paths.ts"
import {
  createCustomStation,
  DEFAULT_PERSISTED_STATE,
  loadCustomStations,
  loadState,
  nextLanguage,
  recordRecent,
  saveCustomStations,
  saveState,
  toggleFavorite,
  validateStationUrl,
} from "../core/store.ts"
import type {
  CategoryTab,
  PersistedState,
  PlaybackSnapshot,
  QuitConfirmChoice,
  Station,
  UiMode,
} from "../core/types.ts"
import { HeaderBar } from "./components/HeaderBar.tsx"
import { AddCustomModal, HelpModal, QuitConfirmModal } from "./components/Modals.tsx"
import { NowPlayingBar } from "./components/NowPlayingBar.tsx"
import { StationList } from "./components/StationList.tsx"
import { createQuraaKeymap, useQuraaBindings } from "./keymap.ts"
import { CATEGORY_TABS, resolveTerminalPalette } from "./theme.ts"

export type MpvController = Pick<
  MpvClient,
  | "isConnected"
  | "getSnapshot"
  | "onSnapshot"
  | "onDisconnect"
  | "connect"
  | "ensureConnected"
  | "disconnect"
  | "playStation"
  | "togglePause"
  | "setVolume"
  | "toggleMute"
  | "setSleepTimer"
  | "stopDaemon"
>

export interface AppProps {
  paths?: QuraaPaths
  autoResume?: boolean
  noMotion?: boolean
  initialCatalog?: Station[]
  initialPalette?: TerminalColors | null
  skipPaletteDetection?: boolean
  clientFactory?: (paths: QuraaPaths, state: PersistedState) => MpvController
  fetchImpl?: typeof fetch
}

const SLEEP_CYCLE_SECONDS = [0, 15 * 60, 30 * 60, 45 * 60, 60 * 60] as const
const QUIT_CHOICES: readonly QuitConfirmChoice[] = ["cancel", "no", "yes"]

function defaultSnapshot(state: PersistedState): PlaybackSnapshot {
  return {
    state: "stopped",
    stationId: state.lastStationId,
    title: null,
    trackTitle: null,
    author: null,
    artUrl: null,
    metadata: null,
    volume: state.volume,
    muted: state.muted,
    sleepUntil: 0,
    error: null,
  }
}

function nextSleepSeconds(remainingSec: number): number {
  if (remainingSec <= 0) return SLEEP_CYCLE_SECONDS[1]
  for (const preset of SLEEP_CYCLE_SECONDS) {
    if (preset > remainingSec + 30) return preset
  }
  return 0
}

export function App(props: AppProps = {}) {
  const renderer = useRenderer()
  const keymap = createQuraaKeymap(renderer)

  return (
    <KeymapProvider keymap={keymap}>
      <QuraaShell {...props} />
    </KeymapProvider>
  )
}

function QuraaShell(props: AppProps) {
  const renderer = useRenderer()
  const dimensions = useTerminalDimensions()
  const paths = props.paths ?? resolvePaths()
  const imageConfig = loadImageConfig(paths)

  const [themeMode, setThemeMode] = createSignal(renderer.themeMode)
  const [terminalColors, setTerminalColors] = createSignal<TerminalColors | null>(
    props.initialPalette ?? null,
  )
  const theme = createMemo(() => resolveTerminalPalette(themeMode(), terminalColors()))

  const [state, setState] = createSignal<PersistedState>(DEFAULT_PERSISTED_STATE)
  const [baseStations, setBaseStations] = createSignal<Station[]>(
    props.initialCatalog ?? FALLBACK_STATIONS,
  )
  const [customStations, setCustomStations] = createSignal<Station[]>([])
  const [catalogSource, setCatalogSource] = createSignal<
    "network" | "cache" | "stale-cache" | "fallback"
  >(props.initialCatalog ? "cache" : "fallback")

  const [activeTab, setActiveTab] = createSignal<CategoryTab>("all")
  const [searchQuery, setSearchQuery] = createSignal("")
  const [uiMode, setUiMode] = createSignal<UiMode>("browse")
  const [priorFocusMode, setPriorFocusMode] = createSignal<"browse" | "search">("browse")
  const [cursorIndex, setCursorIndex] = createSignal(0)

  const [snapshot, setSnapshot] = createSignal<PlaybackSnapshot>(
    defaultSnapshot(DEFAULT_PERSISTED_STATE),
  )
  const [nowMs, setNowMs] = createSignal(Date.now())
  const [spinnerTick, setSpinnerTick] = createSignal(0)

  const [customName, setCustomName] = createSignal("")
  const [customUrl, setCustomUrl] = createSignal("")
  const [customField, setCustomField] = createSignal<"name" | "url">("name")
  const [customError, setCustomError] = createSignal<string | null>(null)
  const [quitChoice, setQuitChoice] = createSignal<QuitConfirmChoice>("no")

  const [undoState, setUndoState] = createSignal<{
    station: Station
    index: number
  } | null>(null)
  const [statusNotice, setStatusNotice] = createSignal<string | null>(null)

  let client: MpvController | null = null
  let undoTimer: ReturnType<typeof setTimeout> | null = null
  let noticeTimer: ReturnType<typeof setTimeout> | null = null
  let sleepInterval: ReturnType<typeof setInterval> | null = null
  let spinnerInterval: ReturnType<typeof setInterval> | null = null
  let userMovedCursor = false
  let exiting = false
  let disposed = false

  const allStations = createMemo<Station[]>(() => {
    const customIds = new Set(customStations().map((s) => s.id))
    const mergedBase = baseStations().filter((s) => !customIds.has(s.id))
    return [...mergedBase, ...customStations()]
  })

  const filteredStations = createMemo<Station[]>(() =>
    filterStations(allStations(), activeTab(), searchQuery(), state()),
  )

  const favoriteSet = createMemo(() => new Set(state().favorites))

  const activeStation = createMemo<Station | null>(() => {
    const sid = snapshot().stationId
    if (!sid) return null
    return allStations().find((s) => s.id === sid) ?? null
  })

  const playingTitle = createMemo<string | null>(() => {
    const active = activeStation()
    if (active) return getStationDisplayName(active, state().language)
    const rawTitle = snapshot().title
    return rawTitle ? formatDisplayText(rawTitle, state().language) : null
  })

  const sleepRemainingSec = createMemo<number>(() => {
    const until = snapshot().sleepUntil
    if (!until || until <= nowMs()) return 0
    return Math.ceil((until - nowMs()) / 1000)
  })

  const undoMessage = createMemo<string | null>(() => {
    const pending = undoState()
    if (!pending) return null
    return `Removed "${pending.station.nameEn}" — press u to undo`
  })

  // Clamp cursor automatically whenever filtered list length changes
  createEffect(() => {
    const len = filteredStations().length
    if (len === 0) {
      if (cursorIndex() !== 0) setCursorIndex(0)
      return
    }
    if (cursorIndex() >= len) {
      setCursorIndex(len - 1)
    }
  })

  // 1s sleep timer display tick active strictly while countdown is running
  createEffect(() => {
    const until = snapshot().sleepUntil
    if (until > Date.now()) {
      setNowMs(Date.now())
      if (!sleepInterval) {
        sleepInterval = setInterval(() => {
          const now = Date.now()
          setNowMs(now)
          if (snapshot().sleepUntil <= now && sleepInterval) {
            clearInterval(sleepInterval)
            sleepInterval = null
          }
        }, 1000)
      }
    } else if (sleepInterval) {
      clearInterval(sleepInterval)
      sleepInterval = null
    }
  })

  // Motion-safe spinner tick active strictly while connecting/reconnecting
  createEffect(() => {
    const active =
      !props.noMotion &&
      (snapshot().state === "connecting" || snapshot().state === "reconnecting")
    if (active && !spinnerInterval) {
      spinnerInterval = setInterval(() => setSpinnerTick((n) => n + 1), 160)
    } else if (!active && spinnerInterval) {
      clearInterval(spinnerInterval)
      spinnerInterval = null
    }
  })

  const showNotice = (msg: string) => {
    if (noticeTimer) clearTimeout(noticeTimer)
    setStatusNotice(msg)
    noticeTimer = setTimeout(() => setStatusNotice(null), 2600)
  }

  const persistState = (next: PersistedState) => {
    setState(next)
    void saveState(paths.stateFile, next).catch(() => undefined)
  }

  const getOrCreateClient = (): MpvController => {
    if (client) return client
    const created = props.clientFactory
      ? props.clientFactory(paths, state())
      : new MpvClient(paths, {
          initialVolume: state().volume,
          muted: state().muted,
        })

    created.onSnapshot((next) => {
      if (!disposed) setSnapshot(next)
    })
    created.onDisconnect(() => {
      if (disposed || exiting) return
      setSnapshot((prev) => ({
        ...prev,
        state: "stopped",
        metadata: null,
        trackTitle: null,
        author: null,
        sleepUntil: 0,
      }))
    })
    client = created
    return created
  }

  const highlightStationById = (id: string | null) => {
    if (!id || userMovedCursor) return
    const idx = filteredStations().findIndex((s) => s.id === id)
    if (idx >= 0) setCursorIndex(idx)
  }

  const playStation = async (station: Station) => {
    try {
      const mpv = getOrCreateClient()
      if (!mpv.isConnected) {
        await mpv.ensureConnected()
      }
      const lang = state().language
      const logicalName = lang === "en" ? station.nameEn : (station.nameAr ?? station.nameEn)
      const author =
        station.category === "reciter"
          ? lang === "en"
            ? station.nameEn
            : (station.nameAr ?? station.nameEn)
          : null
      const artUrl = resolveStationArtUrl({
        station,
        author: station.category === "reciter" ? station.nameEn : null,
        config: imageConfig,
      })
      const nextState = recordRecent({ ...state(), lastStationId: station.id }, station.id)
      persistState(nextState)
      await mpv.playStation(station, {
        displayName: logicalName,
        author,
        artUrl,
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to start playback"
      setSnapshot((prev) => ({ ...prev, state: "error", error: msg }))
    }
  }

  const playSelected = () => {
    const selected = filteredStations()[cursorIndex()]
    if (!selected) return
    void playStation(selected)
  }

  const togglePause = () => {
    void (async () => {
      const mpv = getOrCreateClient()
      if (mpv.isConnected && snapshot().state !== "stopped") {
        await mpv.togglePause().catch(() => undefined)
        return
      }
      const targetId = snapshot().stationId ?? state().lastStationId
      const target =
        (targetId ? allStations().find((s) => s.id === targetId) : undefined) ??
        filteredStations()[cursorIndex()]
      if (target) {
        await playStation(target)
      }
    })()
  }

  const adjustVolume = (delta: number) => {
    const nextVol = Math.max(0, Math.min(100, state().volume + delta))
    persistState({ ...state(), volume: nextVol })
    setSnapshot((prev) => ({ ...prev, volume: nextVol }))
    if (client?.isConnected) {
      void client.setVolume(nextVol).catch(() => undefined)
    }
  }

  const toggleMute = () => {
    const nextMuted = !state().muted
    persistState({ ...state(), muted: nextMuted })
    setSnapshot((prev) => ({ ...prev, muted: nextMuted }))
    if (client?.isConnected) {
      void client.toggleMute().catch(() => undefined)
    }
  }

  const cycleSleepTimer = () => {
    const nextSec = nextSleepSeconds(sleepRemainingSec())
    void (async () => {
      try {
        const mpv = getOrCreateClient()
        if (!mpv.isConnected) {
          await mpv.ensureConnected()
        }
        await mpv.setSleepTimer(nextSec)
        setNowMs(Date.now())
        showNotice(nextSec > 0 ? `Sleep timer: ${Math.round(nextSec / 60)}m` : "Sleep timer: Off")
      } catch {
        showNotice("Unable to set sleep timer")
      }
    })()
  }

  const toggleFavoriteSelected = () => {
    const selected = filteredStations()[cursorIndex()]
    if (!selected) return
    const next = toggleFavorite(state(), selected.id)
    persistState(next)
  }

  const cycleLanguage = () => {
    const next = nextLanguage(state().language)
    persistState({ ...state(), language: next })
  }

  const openModal = (target: "modal:help" | "modal:add-custom" | "modal:quit-confirm") => {
    const current = uiMode()
    if (current === "browse" || current === "search") {
      setPriorFocusMode(current)
    }
    setUiMode(target)
  }

  const closeModal = () => {
    const current = uiMode()
    if (
      current !== "modal:help" &&
      current !== "modal:add-custom" &&
      current !== "modal:quit-confirm"
    ) {
      return
    }
    setCustomError(null)
    setUiMode(priorFocusMode())
  }

  const submitCustomStation = () => {
    const name = customName().trim()
    if (!name) {
      setCustomError("Enter a station name")
      setCustomField("name")
      return
    }

    const urlCheck = validateStationUrl(customUrl())
    if (!urlCheck.ok) {
      setCustomError(urlCheck.error)
      setCustomField("url")
      return
    }

    const created = createCustomStation({
      name,
      url: urlCheck.url,
      existingIds: allStations().map((s) => s.id),
    })
    if (!created.ok) {
      setCustomError(created.error)
      setCustomField("url")
      return
    }
    const station = created.station

    const nextCustom = [...customStations(), station]
    setCustomStations(nextCustom)
    void saveCustomStations(paths.customStationsFile, nextCustom).catch(() => undefined)

    setCustomError(null)
    setUiMode("browse")
    setActiveTab("custom")
    setSearchQuery("")
    userMovedCursor = true
    const idx = filterStations([...baseStations(), ...nextCustom], "custom", "", state()).findIndex(
      (s) => s.id === station.id,
    )
    setCursorIndex(idx >= 0 ? idx : 0)
    showNotice(`Added "${station.nameEn}"`)
  }

  const deleteCustomSelected = () => {
    const selected = filteredStations()[cursorIndex()]
    if (!selected) return
    if (selected.category !== "custom") {
      showNotice("Only custom stations can be deleted")
      return
    }

    const currentCustom = customStations()
    const index = currentCustom.findIndex((s) => s.id === selected.id)
    if (index < 0) return

    const nextCustom = currentCustom.filter((s) => s.id !== selected.id)
    setCustomStations(nextCustom)
    void saveCustomStations(paths.customStationsFile, nextCustom).catch(() => undefined)

    if (undoTimer) clearTimeout(undoTimer)
    setUndoState({ station: selected, index })
    undoTimer = setTimeout(() => {
      setUndoState(null)
      undoTimer = null
    }, 6000)
  }

  const undoDeleteCustom = () => {
    const pending = undoState()
    if (!pending) return
    if (undoTimer) {
      clearTimeout(undoTimer)
      undoTimer = null
    }
    const nextCustom = [...customStations()]
    const insertAt = Math.min(pending.index, nextCustom.length)
    nextCustom.splice(insertAt, 0, pending.station)
    setCustomStations(nextCustom)
    void saveCustomStations(paths.customStationsFile, nextCustom).catch(() => undefined)
    setUndoState(null)
    showNotice(`Restored "${pending.station.nameEn}"`)
  }

  const selectTab = (tab: CategoryTab) => {
    if (tab === activeTab()) return
    setActiveTab(tab)
    setCursorIndex(0)
    userMovedCursor = true
  }

  const cycleTab = (dir: 1 | -1) => {
    const currentIdx = CATEGORY_TABS.findIndex((t) => t.id === activeTab())
    const nextIdx = (currentIdx + dir + CATEGORY_TABS.length) % CATEGORY_TABS.length
    const nextTab = CATEGORY_TABS[nextIdx]
    if (nextTab) selectTab(nextTab.id)
  }

  const moveCursor = (delta: number) => {
    const len = filteredStations().length
    if (len === 0) return
    userMovedCursor = true
    setCursorIndex((prev) => Math.max(0, Math.min(len - 1, prev + delta)))
  }

  const detachQuit = () => {
    if (exiting) return
    exiting = true
    client?.disconnect()
    renderer.destroy()
  }

  const stopAndQuit = () => {
    if (exiting) return
    exiting = true
    void (async () => {
      const mpv = client
      if (mpv) {
        await mpv.stopDaemon().catch(() => undefined)
      } else if (await isDaemonAlive(paths, 250).catch(() => false)) {
        const temp = getOrCreateClient()
        await temp.stopDaemon().catch(() => undefined)
      }
      renderer.destroy()
    })()
  }

  const requestQuit = () => {
    if (snapshot().state === "stopped") {
      detachQuit()
      return
    }
    setQuitChoice("no")
    openModal("modal:quit-confirm")
  }

  const moveQuitChoice = (dir: 1 | -1) => {
    const idx = QUIT_CHOICES.indexOf(quitChoice())
    const nextIdx = (idx + dir + QUIT_CHOICES.length) % QUIT_CHOICES.length
    setQuitChoice(QUIT_CHOICES[nextIdx] ?? "no")
  }

  const confirmQuitChoice = (explicitChoice?: QuitConfirmChoice) => {
    const choice = explicitChoice ?? quitChoice()
    if (choice === "cancel") {
      closeModal()
      return
    }
    if (choice === "no") {
      detachQuit()
      return
    }
    stopAndQuit()
  }

  useQuraaBindings({
    uiMode,
    moveCursor,
    jumpTop: () => {
      userMovedCursor = true
      setCursorIndex(0)
    },
    jumpBottom: () => {
      const len = filteredStations().length
      if (len > 0) {
        userMovedCursor = true
        setCursorIndex(len - 1)
      }
    },
    playSelected,
    togglePause,
    focusSearch: () => setUiMode("search"),
    exitSearchKeepingFilter: () => setUiMode("browse"),
    clearSearchAndExit: () => {
      setSearchQuery("")
      setCursorIndex(0)
      setUiMode("browse")
    },
    cycleTab,
    selectTab,
    adjustVolume,
    toggleMute,
    toggleFavoriteSelected,
    cycleSleepTimer,
    cycleLanguage,
    openAddCustomModal: () => {
      setCustomName("")
      setCustomUrl("")
      setCustomField("name")
      setCustomError(null)
      openModal("modal:add-custom")
    },
    deleteCustomSelected,
    undoDeleteCustom,
    toggleHelpModal: () => {
      if (uiMode() === "modal:help") closeModal()
      else openModal("modal:help")
    },
    closeModal,
    switchModalField: () => setCustomField((f) => (f === "name" ? "url" : "name")),
    requestQuit,
    moveQuitChoice,
    confirmQuitChoice,
    detachQuit,
    stopAndQuit,
  })

  onMount(() => {
    const onThemeMode = (mode: typeof themeMode extends () => infer T ? T : never) => {
      setThemeMode(mode)
    }
    const onPalette = (colors: TerminalColors) => {
      if (!disposed) setTerminalColors(colors)
    }
    renderer.on("theme_mode", onThemeMode)
    renderer.on("palette", onPalette)

    if (!props.skipPaletteDetection && !props.initialPalette) {
      void renderer
        .getPalette({ timeout: 250 })
        .then((colors) => {
          if (!disposed) setTerminalColors(colors)
        })
        .catch(() => undefined)
    }

    void (async () => {
      const [loadedState, loadedCustom] = await Promise.all([
        loadState(paths.stateFile),
        loadCustomStations(paths.customStationsFile),
      ])
      if (disposed) return

      setState(loadedState)
      setCustomStations(loadedCustom)
      setSnapshot((prev) => ({
        ...prev,
        volume: loadedState.volume,
        muted: loadedState.muted,
        stationId: loadedState.lastStationId,
      }))

      if (!props.initialCatalog) {
        const catalog = await loadCatalog({
          paths,
          fetchImpl: props.fetchImpl,
          onBackgroundRefresh: (fresh) => {
            if (!disposed) {
              setBaseStations(fresh)
              setCatalogSource("network")
            }
          },
        })
        if (disposed) return
        setBaseStations(catalog.stations)
        setCatalogSource(catalog.source)
      }

      let attachedLive = false
      const mpv = getOrCreateClient()
      if (props.clientFactory) {
        if (mpv.isConnected) {
          attachedLive = true
          setSnapshot(mpv.getSnapshot())
        }
      } else if (await isDaemonAlive(paths, 350).catch(() => false)) {
        await mpv.connect().catch(() => undefined)
        if (!disposed && mpv.isConnected) {
          attachedLive = true
          setSnapshot(mpv.getSnapshot())
        }
      }

      if (disposed) return

      const liveSnap = mpv.getSnapshot()
      if (attachedLive && liveSnap.state !== "stopped") {
        highlightStationById(liveSnap.stationId)
        return
      }

      highlightStationById(loadedState.lastStationId)
      if (props.autoResume && loadedState.lastStationId) {
        const target = allStations().find((s) => s.id === loadedState.lastStationId)
        if (target) await playStation(target)
      }
    })()

    onCleanup(() => {
      disposed = true
      renderer.off("theme_mode", onThemeMode)
      renderer.off("palette", onPalette)
      if (undoTimer) clearTimeout(undoTimer)
      if (noticeTimer) clearTimeout(noticeTimer)
      if (sleepInterval) clearInterval(sleepInterval)
      if (spinnerInterval) clearInterval(spinnerInterval)
      client?.disconnect()
    })
  })

  return (
    <box
      width="100%"
      height="100%"
      flexDirection="column"
      backgroundColor={theme().bgBase}
    >
      <HeaderBar
        theme={theme()}
        width={dimensions().width}
        catalogSource={catalogSource()}
        totalCount={allStations().length}
        matchCount={filteredStations().length}
        language={state().language}
        activeTab={activeTab()}
        searchQuery={searchQuery()}
        searchFocused={uiMode() === "search"}
        onSearchInput={(val) => {
          setSearchQuery(val)
          setCursorIndex(0)
        }}
        onSearchSubmit={() => setUiMode("browse")}
        onSelectTab={selectTab}
      />

      <StationList
        theme={theme()}
        width={dimensions().width}
        stations={filteredStations()}
        cursorIndex={cursorIndex()}
        activeTab={activeTab()}
        searchQuery={searchQuery()}
        favorites={favoriteSet()}
        playingStationId={snapshot().stationId}
        playbackState={snapshot().state}
        language={state().language}
      />

      <NowPlayingBar
        theme={theme()}
        width={dimensions().width}
        snapshot={snapshot()}
        language={state().language}
        stationTitle={playingTitle()}
        sleepRemainingSec={sleepRemainingSec()}
        spinnerTick={spinnerTick()}
        noMotion={Boolean(props.noMotion)}
        undoMessage={undoMessage()}
        statusNotice={statusNotice()}
      />

      <HelpModal
        open={uiMode() === "modal:help"}
        theme={theme()}
        width={dimensions().width}
      />

      <AddCustomModal
        open={uiMode() === "modal:add-custom"}
        theme={theme()}
        width={dimensions().width}
        name={customName()}
        url={customUrl()}
        focusField={customField()}
        error={customError()}
        onNameInput={(val) => {
          setCustomName(val)
          if (customError()) setCustomError(null)
        }}
        onUrlInput={(val) => {
          setCustomUrl(val)
          if (customError()) setCustomError(null)
        }}
        onNameSubmit={() => {
          if (!customName().trim()) {
            setCustomError("Enter a station name")
            return
          }
          if (!customUrl().trim()) {
            setCustomField("url")
            return
          }
          submitCustomStation()
        }}
        onUrlSubmit={submitCustomStation}
      />

      <QuitConfirmModal
        open={uiMode() === "modal:quit-confirm"}
        theme={theme()}
        width={dimensions().width}
        stationTitle={playingTitle()}
        focusedChoice={quitChoice()}
      />
    </box>
  )
}
