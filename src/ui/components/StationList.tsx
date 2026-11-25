import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, For, Show } from "solid-js"
import { getStationDisplayName } from "../../core/catalog.ts"
import type { CategoryTab, PlaybackState, Station } from "../../core/types.ts"
import type { ThemePalette } from "../theme.ts"

export interface StationListProps {
  theme: ThemePalette
  width: number
  stations: Station[]
  cursorIndex: number
  activeTab: CategoryTab
  searchQuery: string
  favorites: ReadonlySet<string>
  playingStationId: string | null
  playbackState: PlaybackState
  arabicNames: boolean
}

export function stationRowId(stationId: string): string {
  return `quraa-row-${stationId}`
}

function formatCategoryTag(station: Station): string {
  if (station.category === "thematic") return "[Theme]"
  if (station.category === "custom") return "[Custom]"
  return ""
}

function emptyStateCopy(
  tab: CategoryTab,
  query: string,
): { title: string; hint: string } {
  if (query.trim()) {
    return {
      title: `No stations match "${query.trim()}".`,
      hint:
        tab === "all"
          ? "Press Esc to clear search."
          : "Press Esc to clear search, or press 1 for All stations.",
    }
  }

  switch (tab) {
    case "favorites":
      return {
        title: "No favorites yet.",
        hint: "Press f on any station to star it.",
      }
    case "recent":
      return {
        title: "No recent stations yet.",
        hint: "Press Enter on a station to start listening.",
      }
    case "custom":
      return {
        title: "No custom stations yet.",
        hint: "Press + or n to add a custom stream URL.",
      }
    default:
      return {
        title: "No stations in this category.",
        hint: "Press 1 to view all stations.",
      }
  }
}

export function StationList(props: StationListProps) {
  let scrollRef: ScrollBoxRenderable | undefined

  createEffect(() => {
    const list = props.stations
    const idx = props.cursorIndex
    const current = list[idx]
    if (!current || !scrollRef) return
    scrollRef.scrollChildIntoView(stationRowId(current.id), { align: "nearest" })
  })

  const empty = () => emptyStateCopy(props.activeTab, props.searchQuery)

  return (
    <box
      flexGrow={1}
      flexShrink={1}
      flexDirection="column"
      backgroundColor={props.theme.bgBase}
    >
      <Show
        when={props.stations.length > 0}
        fallback={
          <box
            flexGrow={1}
            justifyContent="center"
            alignItems="center"
            flexDirection="column"
            paddingX={2}
            gap={1}
          >
            <text fg={props.theme.textPrimary}>
              <strong>{empty().title}</strong>
            </text>
            <text fg={props.theme.textMuted}>{empty().hint}</text>
          </box>
        }
      >
        <scrollbox
          ref={scrollRef}
          flexGrow={1}
          scrollY
          focused={false}
          backgroundColor={props.theme.bgBase}
        >
          <For each={props.stations}>
            {(station, idx) => {
              const isSelected = () => idx() === props.cursorIndex
              const isPlayingHere = () =>
                props.playingStationId === station.id &&
                props.playbackState !== "stopped"
              const isFav = () => props.favorites.has(station.id)
              const tag = () => formatCategoryTag(station)
              const showTag = () => props.width >= 58 && tag().length > 0
              const displayName = () =>
                getStationDisplayName(station, props.arabicNames)

              const playGlyph = () => {
                if (!isPlayingHere()) return " "
                if (props.playbackState === "paused") return "⏸"
                if (props.playbackState === "error") return "!"
                return "▶"
              }

              return (
                <box
                  id={stationRowId(station.id)}
                  flexDirection="row"
                  justifyContent="space-between"
                  height={1}
                  paddingX={1}
                  backgroundColor={
                    isSelected() ? props.theme.bgSelected : props.theme.bgBase
                  }
                >
                  <box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
                    <text
                      fg={isPlayingHere() ? props.theme.accent : props.theme.textMuted}
                      wrapMode="none"
                    >
                      {playGlyph()}{" "}
                    </text>
                    <text
                      fg={isFav() ? props.theme.fav : props.theme.textMuted}
                      wrapMode="none"
                    >
                      {isFav() ? "★" : " "}{" "}
                    </text>
                    <text
                      fg={
                        isPlayingHere()
                          ? props.theme.accent
                          : isSelected()
                            ? props.theme.textPrimary
                            : props.theme.textSecondary
                      }
                      flexShrink={1}
                      wrapMode="none"
                    >
                      <Show
                        when={isSelected() || isPlayingHere()}
                        fallback={displayName()}
                      >
                        <strong>{displayName()}</strong>
                      </Show>
                    </text>
                  </box>
                  <Show when={showTag()}>
                    <text fg={props.theme.textMuted}> {tag()}</text>
                  </Show>
                </box>
              )
            }}
          </For>
        </scrollbox>
      </Show>
    </box>
  )
}
