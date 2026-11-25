import { For, Show } from "solid-js"
import type { AppLanguage, CategoryTab } from "../../core/types.ts"
import { CATEGORY_TABS, type ThemePalette } from "../theme.ts"

export interface HeaderBarProps {
  theme: ThemePalette
  width: number
  catalogSource: "network" | "cache" | "stale-cache" | "fallback"
  totalCount: number
  matchCount: number
  language: AppLanguage
  activeTab: CategoryTab
  searchQuery: string
  searchFocused: boolean
  onSearchInput: (value: string) => void
  onSearchSubmit: () => void
  onSelectTab: (tab: CategoryTab) => void
}

function formatLanguageBadge(lang: AppLanguage, compact: boolean): string {
  switch (lang) {
    case "en":
      return "EN"
    case "ar":
      return "AR"
    case "ar-fixed":
      return compact ? "FIX" : "AR-FIX"
  }
}

function formatCatalogBadge(
  source: HeaderBarProps["catalogSource"],
  total: number,
  compact: boolean,
): string {
  switch (source) {
    case "network":
      return compact ? `Live ${total}` : `Live · ${total}`
    case "cache":
    case "stale-cache":
      return compact ? `Cache ${total}` : `Cached · ${total}`
    case "fallback":
      return compact ? `Offline ${total}` : `Offline · ${total}`
  }
}

export function HeaderBar(props: HeaderBarProps) {
  const wide = () => props.width >= 80
  const compact = () => props.width < 68

  const countText = () => {
    const padWidth = Math.max(3, String(props.totalCount).length)
    const matched = String(props.matchCount).padStart(padWidth, "0")
    const total = String(props.totalCount).padStart(padWidth, "0")
    return `${matched}/${total}`
  }

  return (
    <box
      flexShrink={0}
      flexDirection="column"
      backgroundColor={props.theme.bgSurface}
      border={["bottom"]}
      borderColor={props.searchFocused ? props.theme.accent : props.theme.borderSubtle}
      paddingX={1}
    >
      <box flexDirection="row" justifyContent="space-between" height={1}>
        <box flexDirection="row">
          <text fg={props.theme.accent}>
            <strong>Quraa</strong>
          </text>
          <text fg={props.theme.textMuted}>
            {" "}
            · {formatCatalogBadge(props.catalogSource, props.totalCount, compact())}
          </text>
        </box>
        <box flexDirection="row">
          <text fg={props.language !== "en" ? props.theme.accent : props.theme.textSecondary}>
            [{formatLanguageBadge(props.language, compact())}]
          </text>
          <Show when={!compact()}>
            <text fg={props.theme.textMuted}> · ? Help</text>
          </Show>
        </box>
      </box>

      <box flexDirection="row" alignItems="center" gap={1} height={1}>
        <text fg={props.searchFocused ? props.theme.accent : props.theme.textMuted}>
          <strong>/</strong>
        </text>
        <input
          flexGrow={1}
          focused={props.searchFocused}
          value={props.searchQuery}
          placeholder={
            props.searchFocused
              ? "Filter stations EN/AR (Enter keep, Esc clear)"
              : "Search stations (press /)"
          }
          onInput={props.onSearchInput}
          onSubmit={props.onSearchSubmit}
          backgroundColor={props.theme.bgSurface}
          focusedBackgroundColor={props.theme.bgSelected}
          textColor={props.theme.textPrimary}
          placeholderColor={props.theme.textMuted}
          cursorColor={props.theme.accent}
        />
        <text fg={props.theme.textMuted}>{countText()}</text>
      </box>

      <box flexDirection="row" gap={1} height={1} overflow="hidden">
        <For each={[...CATEGORY_TABS]}>
          {(tab) => {
            const isActive = () => props.activeTab === tab.id
            const label = () => {
              const name = wide() ? tab.label : tab.shortLabel
              return wide() ? `${tab.shortcut}:${name}` : name
            }
            return (
              <box
                paddingX={compact() ? 0 : 1}
                backgroundColor={
                  isActive() ? props.theme.bgSelected : props.theme.bgSurface
                }
              >
                <text
                  fg={isActive() ? props.theme.accent : props.theme.textSecondary}
                >
                  <Show when={isActive()} fallback={<span>{label()}</span>}>
                    <strong>
                      <u>{label()}</u>
                    </strong>
                  </Show>
                </text>
              </box>
            )
          }}
        </For>
      </box>
    </box>
  )
}
