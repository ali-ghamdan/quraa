import { useRenderer } from "@opentui/solid"
import { Portal } from "@opentui/solid"
import { For, Show } from "solid-js"
import type { ThemePalette } from "../theme.ts"

export interface HelpModalProps {
  open: boolean
  theme: ThemePalette
  width: number
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
      ["a", "Toggle English / Arabic names"],
      ["+ / n", "Add custom station URL"],
      ["d / u", "Delete custom / undo (6s)"],
      ["?", "Toggle this help"],
      ["q", "Detach TUI (keeps playing)"],
      ["Q", "Stop daemon and quit"],
    ],
  },
] as const

export function HelpModal(props: HelpModalProps) {
  const renderer = useRenderer()
  const modalWidth = () => Math.min(68, Math.max(44, props.width - 4))

  return (
    <Show when={props.open}>
      <Portal mount={renderer.root}>
        <box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <box
            width={modalWidth()}
            border
            borderStyle="rounded"
            borderColor={props.theme.accent}
            backgroundColor={props.theme.bgSurface}
            title=" Keyboard Shortcuts "
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            gap={1}
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
          </box>
        </box>
      </Portal>
    </Show>
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
  const renderer = useRenderer()
  const modalWidth = () => Math.min(64, Math.max(46, props.width - 4))

  return (
    <Show when={props.open}>
      <Portal mount={renderer.root}>
        <box
          position="absolute"
          top={0}
          left={0}
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
        >
          <box
            width={modalWidth()}
            border
            borderStyle="rounded"
            borderColor={props.theme.accent}
            backgroundColor={props.theme.bgSurface}
            title=" Add Custom Station "
            paddingX={2}
            paddingY={1}
            flexDirection="column"
            gap={1}
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
          </box>
        </box>
      </Portal>
    </Show>
  )
}
