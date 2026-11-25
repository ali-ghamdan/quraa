import { Show } from "solid-js"
import { formatDisplayText } from "../../core/arabic.ts"
import type { AppLanguage, PlaybackSnapshot, PlaybackState } from "../../core/types.ts"
import type { ThemePalette } from "../theme.ts"

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

export interface NowPlayingBarProps {
  theme: ThemePalette
  width: number
  snapshot: PlaybackSnapshot
  language: AppLanguage
  stationTitle: string | null
  sleepRemainingSec: number
  spinnerTick: number
  noMotion: boolean
  undoMessage: string | null
  statusNotice: string | null
}

function formatSleepCountdown(seconds: number): string {
  const clamped = Math.max(0, Math.floor(seconds))
  const mins = Math.floor(clamped / 60)
  const secs = clamped % 60
  return `${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`
}

function formatVolumeBar(volume: number): string {
  const filled = Math.round((Math.max(0, Math.min(100, volume)) / 100) * 8)
  return `[${"█".repeat(filled)}${"░".repeat(8 - filled)}]`
}

function statusBadge(
  state: PlaybackState,
  spinnerTick: number,
  noMotion: boolean,
  error: string | null,
): { glyph: string; label: string; tone: "accent" | "fav" | "danger" | "muted" } {
  const spin = noMotion ? "◌" : SPINNER_FRAMES[spinnerTick % SPINNER_FRAMES.length]!
  switch (state) {
    case "playing":
      return { glyph: "▶", label: "PLAYING", tone: "accent" }
    case "paused":
      return { glyph: "⏸", label: "PAUSED", tone: "fav" }
    case "connecting":
      return { glyph: spin, label: "BUFFERING…", tone: "accent" }
    case "reconnecting":
      return { glyph: spin, label: "RECONNECTING…", tone: "fav" }
    case "error":
      return {
        glyph: "✕",
        label: error ? `UNAVAILABLE (${error}) — Enter retry` : "UNAVAILABLE — Enter retry",
        tone: "danger",
      }
    case "stopped":
      return { glyph: "■", label: "IDLE", tone: "muted" }
  }
}

export function NowPlayingBar(props: NowPlayingBarProps) {
  const wide = () => props.width >= 80
  const badge = () =>
    statusBadge(
      props.snapshot.state,
      props.spinnerTick,
      props.noMotion,
      props.snapshot.error,
    )

  const badgeColor = () => {
    switch (badge().tone) {
      case "accent":
        return props.theme.accent
      case "fav":
        return props.theme.fav
      case "danger":
        return props.theme.danger
      case "muted":
        return props.theme.textMuted
    }
  }

  const volLabel = () => {
    if (props.snapshot.muted) return "MUTED"
    const pct = `${String(props.snapshot.volume).padStart(3, "0")}%`
    return wide() ? `VOL ${pct} ${formatVolumeBar(props.snapshot.volume)}` : `VOL ${pct}`
  }

  const titleLine = () => {
    const raw =
      props.stationTitle ??
      props.snapshot.title ??
      "Select a station and press Enter to listen"
    return formatDisplayText(raw, props.language)
  }

  const metadataLine = () =>
    props.snapshot.metadata
      ? formatDisplayText(props.snapshot.metadata, props.language)
      : null

  const footerBanner = () => {
    if (props.undoMessage) {
      return { text: props.undoMessage, color: props.theme.accent }
    }
    if (props.statusNotice) {
      return { text: props.statusNotice, color: props.theme.fav }
    }
    if (props.width < 78) {
      return {
        text: "Enter Play  Space Pause  / Search  f Fav  ? Help  q Quit",
        color: props.theme.textMuted,
      }
    }
    if (props.width < 118) {
      return {
        text: "j/k Move  Enter Play  Space Pause  / Search  t Sleep  ? Help  q Quit  Q Stop",
        color: props.theme.textMuted,
      }
    }
    return {
      text: "j/k Move  Enter Play  Space Pause  / Search  Tab/1-6 Tabs  -/= Vol  f Fav  t Sleep  a EN/AR/Fix  + Add  ? Help  q Quit  Q Stop",
      color: props.theme.textMuted,
    }
  }

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      border={["top"]}
      borderColor={props.theme.borderSubtle}
      backgroundColor={props.theme.bgSurface}
      paddingX={1}
    >
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <text fg={badgeColor()}>
          <strong>
            {badge().glyph} {badge().label}
          </strong>
        </text>
        <box flexDirection="row" gap={2}>
          <Show when={props.sleepRemainingSec > 0}>
            <text fg={props.theme.fav}>
              SLP {formatSleepCountdown(props.sleepRemainingSec)}
            </text>
          </Show>
          <text fg={props.snapshot.muted ? props.theme.danger : props.theme.textSecondary}>
            {volLabel()}
          </text>
        </box>
      </box>

      <text fg={props.theme.textPrimary} wrapMode="word">
        <strong>{titleLine()}</strong>
        <Show when={metadataLine()}> · {metadataLine()}</Show>
      </text>

      <text fg={footerBanner().color} wrapMode="none">
        {footerBanner().text}
      </text>
    </box>
  )
}
