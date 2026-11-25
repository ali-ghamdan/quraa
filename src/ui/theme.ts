import type { ThemeMode } from "@opentui/core"
import type { CategoryTab } from "../core/types.ts"

export interface ThemePalette {
  mode: "dark" | "light"
  bgBase: string
  bgSurface: string
  bgSelected: string
  borderSubtle: string
  borderInteractive: string
  accent: string
  textPrimary: string
  textSecondary: string
  textMuted: string
  fav: string
  danger: string
}

export const DARK_PALETTE: ThemePalette = {
  mode: "dark",
  bgBase: "#0d1311",
  bgSurface: "#131c19",
  bgSelected: "#1a2b24",
  borderSubtle: "#2c3f37",
  borderInteractive: "#516b60",
  accent: "#34d399",
  textPrimary: "#edf5f1",
  textSecondary: "#a8bdb3",
  textMuted: "#789186",
  fav: "#fbbf24",
  danger: "#f87171",
}

export const LIGHT_PALETTE: ThemePalette = {
  mode: "light",
  bgBase: "#f6f8f7",
  bgSurface: "#ebf0ed",
  bgSelected: "#d7ebe1",
  borderSubtle: "#9eb0a7",
  borderInteractive: "#63786e",
  accent: "#065f46",
  textPrimary: "#0f1c16",
  textSecondary: "#354a40",
  textMuted: "#4e655a",
  fav: "#92400e",
  danger: "#b91c1c",
}

export function resolveThemePalette(mode: ThemeMode | null | undefined): ThemePalette {
  return mode === "light" ? LIGHT_PALETTE : DARK_PALETTE
}

export interface TabDefinition {
  id: CategoryTab
  label: string
  shortLabel: string
  shortcut: string
}

export const CATEGORY_TABS: readonly TabDefinition[] = [
  { id: "all", label: "All", shortLabel: "All", shortcut: "1" },
  { id: "favorites", label: "Favorites", shortLabel: "Fav", shortcut: "2" },
  { id: "recent", label: "Recent", shortLabel: "Recent", shortcut: "3" },
  { id: "reciter", label: "Reciters", shortLabel: "Reciter", shortcut: "4" },
  { id: "thematic", label: "Thematic", shortLabel: "Theme", shortcut: "5" },
  { id: "custom", label: "Custom", shortLabel: "Custom", shortcut: "6" },
]
