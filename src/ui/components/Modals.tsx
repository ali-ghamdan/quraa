import type { BoxRenderable } from "@opentui/core"
import { Portal, useRenderer } from "@opentui/solid"
import { For, type JSX, Show } from "solid-js"
import type { QuitConfirmChoice } from "../../core/types.ts"
import type { ThemePalette } from "../theme.ts"

export interface HelpModalProps {
  open: boolean
  theme: ThemePalette
  width: number
}

function ModalOverlay(props: {
  open: boolean
  modalWidth: number
  title: string
  theme: ThemePalette
  children: JSX.Element
}) {
  const renderer = useRenderer()

  return (
    <Show when={props.open}>
      <Portal
        mount={renderer.root}
        ref={(el) => {
          const box = el as BoxRenderable
          box.position = "absolute"
          box.top = 0
          box.left = 0
          box.width = "100%"
          box.height = "100%"
          box.zIndex = 50
        }}
      >
        <box
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <box
            width={props.modalWidth}
            border
            borderStyle="rounded"
            borderColor={props.theme.accent}
            backgroundColor={props.theme.bgModal}
            title={props.title}
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            gap={1}
          >
            {props.children}
          </box>
        </box>
      </Portal>
    </Show>
  )
}

const HELP_GROUPS = [
  {
    title: "Navigation",
    items: [
      ["j / k / ↑ / ↓", "Move selection"],
      ["g / G", "Jump top / bottom"],
      ["/", "Focus search (Esc clears)"],
      ["Tab / 1–6", "Switch category tabs"],
    ],
  },
  {
    title: "Playback",
    items: [
      ["Enter", "Play selected / retry stream"],
      ["Space / p", "Pause or resume"],
      ["- / = or h / l", "Volume -5% / +5%"],
      ["m", "Toggle mute"],
      ["t", "Cycle sleep: Off → 15 → 30 → 45 → 60m"],
    ],
  },
  {
    title: "Library & Session",
    items: [
      ["f", "Star / unstar favorite"],
      ["a", "Cycle language: EN / AR / AR-Fixed"],
      ["+ / n", "Add custom station URL"],
      ["d / u", "Delete custom / undo (6s)"],
      ["?", "Toggle this help"],
      ["q", "Quit dialog (Cancel / No / Yes)"],
      ["Q", "Stop daemon and quit"],
    ],
  },
] as const

export function HelpModal(props: HelpModalProps) {
  const modalWidth = () => Math.min(68, Math.max(44, props.width - 4))

  return (
    <ModalOverlay
      open={props.open}
      modalWidth={modalWidth()}
      title=" Keyboard Shortcuts "
      theme={props.theme}
    >
      <For each={[...HELP_GROUPS]}>
        {(group) => (
          <box flexDirection="column">
            <text fg={props.theme.accent}>
              <strong>{group.title}</strong>
            </text>
            <For each={[...group.items]}>
              {([keys, desc]) => (
                <box flexDirection="row">
                  <text fg={props.theme.textPrimary}>
                    <strong>{keys.padEnd(18, " ")}</strong>
                  </text>
                  <text fg={props.theme.textSecondary}>{desc}</text>
                </box>
              )}
            </For>
          </box>
        )}
      </For>
      <text fg={props.theme.textMuted}>Press Esc or ? to close</text>
    </ModalOverlay>
  )
}

export interface AddCustomModalProps {
  open: boolean
  theme: ThemePalette
  width: number
  name: string
  url: string
  focusField: "name" | "url"
  error: string | null
  onNameInput: (value: string) => void
  onUrlInput: (value: string) => void
  onNameSubmit: () => void
  onUrlSubmit: () => void
}

export function AddCustomModal(props: AddCustomModalProps) {
  const modalWidth = () => Math.min(64, Math.max(46, props.width - 4))

  return (
    <ModalOverlay
      open={props.open}
      modalWidth={modalWidth()}
      title=" Add Custom Station "
      theme={props.theme}
    >
      <box flexDirection="column">
        <text
          fg={
            props.focusField === "name"
              ? props.theme.accent
              : props.theme.textSecondary
          }
        >
          <strong>Name</strong>
        </text>
        <input
          focused={props.focusField === "name"}
          value={props.name}
          placeholder="e.g. Makkah Live FM"
          onInput={props.onNameInput}
          onSubmit={props.onNameSubmit}
          backgroundColor={props.theme.bgBase}
          focusedBackgroundColor={props.theme.bgSelected}
          textColor={props.theme.textPrimary}
          placeholderColor={props.theme.textMuted}
          cursorColor={props.theme.accent}
        />
      </box>

      <box flexDirection="column">
        <text
          fg={
            props.focusField === "url"
              ? props.theme.accent
              : props.theme.textSecondary
          }
        >
          <strong>Stream URL (http:// or https://)</strong>
        </text>
        <input
          focused={props.focusField === "url"}
          value={props.url}
          placeholder="https://stream.example.com/quran.mp3"
          onInput={props.onUrlInput}
          onSubmit={props.onUrlSubmit}
          backgroundColor={props.theme.bgBase}
          focusedBackgroundColor={props.theme.bgSelected}
          textColor={props.theme.textPrimary}
          placeholderColor={props.theme.textMuted}
          cursorColor={props.theme.accent}
        />
      </box>

      <Show when={props.error}>
        <text fg={props.theme.danger}>
          <strong>✕ {props.error}</strong>
        </text>
      </Show>

      <text fg={props.theme.textMuted}>
        Tab Switch field · Enter Save station · Esc Cancel
      </text>
    </ModalOverlay>
  )
}

export interface QuitConfirmModalProps {
  open: boolean
  theme: ThemePalette
  width: number
  stationTitle: string | null
  focusedChoice: QuitConfirmChoice
}

const QUIT_BUTTONS: ReadonlyArray<{
  id: QuitConfirmChoice
  label: string
}> = [
  { id: "cancel", label: "Cancel" },
  { id: "no", label: "No" },
  { id: "yes", label: "Yes" },
]

export function QuitConfirmModal(props: QuitConfirmModalProps) {
  const modalWidth = () => Math.min(54, Math.max(40, props.width - 4))

  return (
    <ModalOverlay
      open={props.open}
      modalWidth={modalWidth()}
      title=" Stop Radio? "
      theme={props.theme}
    >
      <text fg={props.theme.textPrimary}>
        {props.stationTitle
          ? `Stop playing "${props.stationTitle}" before exiting?`
          : "Stop the background radio daemon before exiting?"}
      </text>

      <box flexDirection="row" justifyContent="center" gap={2}>
        <For each={[...QUIT_BUTTONS]}>
          {(btn) => {
            const active = () => props.focusedChoice === btn.id
            const activeColor = () =>
              btn.id === "yes" ? props.theme.danger : props.theme.accent
            return (
              <box
                paddingX={2}
                border
                borderStyle="rounded"
                borderColor={active() ? activeColor() : props.theme.borderSubtle}
                backgroundColor={active() ? props.theme.bgSelected : props.theme.bgModal}
              >
                <text fg={active() ? activeColor() : props.theme.textSecondary}>
                  <Show when={active()} fallback={btn.label}>
                    <strong>{btn.label}</strong>
                  </Show>
                </text>
              </box>
            )
          }}
        </For>
      </box>

      <text fg={props.theme.textMuted}>
        ←/→/Tab Choose · Enter Confirm · y Yes · n No · Esc Cancel
      </text>
    </ModalOverlay>
  )
}
