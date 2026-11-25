import type { CliRenderer } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { reactiveMatcherFromSignal, useBindings } from "@opentui/keymap/solid"
import type { Accessor } from "solid-js"
import type { CategoryTab, QuitConfirmChoice, UiMode } from "../core/types.ts"
import { CATEGORY_TABS } from "./theme.ts"

export interface QuraaKeymapHandlers {
  uiMode: Accessor<UiMode>
  moveCursor: (delta: number) => void
  jumpTop: () => void
  jumpBottom: () => void
  playSelected: () => void
  togglePause: () => void
  focusSearch: () => void
  exitSearchKeepingFilter: () => void
  clearSearchAndExit: () => void
  cycleTab: (dir: 1 | -1) => void
  selectTab: (tab: CategoryTab) => void
  adjustVolume: (delta: number) => void
  toggleMute: () => void
  toggleFavoriteSelected: () => void
  cycleSleepTimer: () => void
  cycleLanguage: () => void
  openAddCustomModal: () => void
  deleteCustomSelected: () => void
  undoDeleteCustom: () => void
  toggleHelpModal: () => void
  closeModal: () => void
  switchModalField: (dir: 1 | -1) => void
  requestQuit: () => void
  moveQuitChoice: (dir: 1 | -1) => void
  confirmQuitChoice: (choice?: QuitConfirmChoice) => void
  detachQuit: () => void
  stopAndQuit: () => void
}

export function createQuraaKeymap(renderer: CliRenderer) {
  return createDefaultOpenTuiKeymap(renderer)
}

export function useQuraaBindings(handlers: QuraaKeymapHandlers): void {
  const isBrowse = reactiveMatcherFromSignal(handlers.uiMode, (m) => m === "browse")
  const isSearch = reactiveMatcherFromSignal(handlers.uiMode, (m) => m === "search")
  const isModal = reactiveMatcherFromSignal(
    handlers.uiMode,
    (m) => m === "modal:help" || m === "modal:add-custom" || m === "modal:quit-confirm",
  )
  const isHelpModal = reactiveMatcherFromSignal(
    handlers.uiMode,
    (m) => m === "modal:help",
  )
  const isCustomModal = reactiveMatcherFromSignal(
    handlers.uiMode,
    (m) => m === "modal:add-custom",
  )
  const isQuitModal = reactiveMatcherFromSignal(
    handlers.uiMode,
    (m) => m === "modal:quit-confirm",
  )

  useBindings(() => ({
    priority: 10,
    enabled: isBrowse,
    bindings: [
      { key: "j", cmd: () => handlers.moveCursor(1) },
      { key: "down", cmd: () => handlers.moveCursor(1) },
      { key: "k", cmd: () => handlers.moveCursor(-1) },
      { key: "up", cmd: () => handlers.moveCursor(-1) },
      { key: "g", cmd: () => handlers.jumpTop() },
      { key: "shift+g", cmd: () => handlers.jumpBottom() },
      { key: "return", cmd: () => handlers.playSelected() },
      { key: "enter", cmd: () => handlers.playSelected() },
      { key: "space", cmd: () => handlers.togglePause() },
      { key: "p", cmd: () => handlers.togglePause() },
      { key: "/", cmd: () => handlers.focusSearch() },
      { key: "tab", cmd: () => handlers.cycleTab(1) },
      { key: "shift+tab", cmd: () => handlers.cycleTab(-1) },
      ...CATEGORY_TABS.map((tab) => ({
        key: tab.shortcut,
        cmd: () => handlers.selectTab(tab.id),
      })),
      { key: "=", cmd: () => handlers.adjustVolume(5) },
      { key: "l", cmd: () => handlers.adjustVolume(5) },
      { key: "right", cmd: () => handlers.adjustVolume(5) },
      { key: "-", cmd: () => handlers.adjustVolume(-5) },
      { key: "h", cmd: () => handlers.adjustVolume(-5) },
      { key: "left", cmd: () => handlers.adjustVolume(-5) },
      { key: "m", cmd: () => handlers.toggleMute() },
      { key: "f", cmd: () => handlers.toggleFavoriteSelected() },
      { key: "t", cmd: () => handlers.cycleSleepTimer() },
      { key: "a", cmd: () => handlers.cycleLanguage() },
      { key: "+", cmd: () => handlers.openAddCustomModal() },
      { key: "plus", cmd: () => handlers.openAddCustomModal() },
      { key: "n", cmd: () => handlers.openAddCustomModal() },
      { key: "d", cmd: () => handlers.deleteCustomSelected() },
      { key: "u", cmd: () => handlers.undoDeleteCustom() },
      { key: "?", cmd: () => handlers.toggleHelpModal() },
      { key: "shift+?", cmd: () => handlers.toggleHelpModal() },
      { key: "q", cmd: () => handlers.requestQuit() },
      { key: "shift+q", cmd: () => handlers.stopAndQuit() },
      { key: "ctrl+c", cmd: () => handlers.detachQuit() },
    ],
  }))

  useBindings(() => ({
    priority: 20,
    enabled: isSearch,
    bindings: [
      { key: "escape", cmd: () => handlers.clearSearchAndExit() },
      { key: "down", cmd: () => handlers.exitSearchKeepingFilter() },
      { key: "ctrl+c", cmd: () => handlers.detachQuit() },
    ],
  }))

  useBindings(() => ({
    priority: 30,
    enabled: isModal,
    bindings: [
      { key: "escape", cmd: () => handlers.closeModal() },
      { key: "ctrl+c", cmd: () => handlers.detachQuit() },
    ],
  }))

  useBindings(() => ({
    priority: 35,
    enabled: isHelpModal,
    bindings: [
      { key: "?", cmd: () => handlers.closeModal() },
      { key: "shift+?", cmd: () => handlers.closeModal() },
      { key: "q", cmd: () => handlers.closeModal() },
    ],
  }))

  useBindings(() => ({
    priority: 35,
    enabled: isCustomModal,
    bindings: [
      { key: "tab", cmd: () => handlers.switchModalField(1) },
      { key: "shift+tab", cmd: () => handlers.switchModalField(-1) },
    ],
  }))

  useBindings(() => ({
    priority: 35,
    enabled: isQuitModal,
    bindings: [
      { key: "left", cmd: () => handlers.moveQuitChoice(-1) },
      { key: "h", cmd: () => handlers.moveQuitChoice(-1) },
      { key: "shift+tab", cmd: () => handlers.moveQuitChoice(-1) },
      { key: "right", cmd: () => handlers.moveQuitChoice(1) },
      { key: "l", cmd: () => handlers.moveQuitChoice(1) },
      { key: "tab", cmd: () => handlers.moveQuitChoice(1) },
      { key: "return", cmd: () => handlers.confirmQuitChoice() },
      { key: "enter", cmd: () => handlers.confirmQuitChoice() },
      { key: "y", cmd: () => handlers.confirmQuitChoice("yes") },
      { key: "n", cmd: () => handlers.confirmQuitChoice("no") },
      { key: "c", cmd: () => handlers.confirmQuitChoice("cancel") },
      { key: "q", cmd: () => handlers.confirmQuitChoice("cancel") },
    ],
  }))
}
