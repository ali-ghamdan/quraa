import { type ColorInput, RGBA, type TerminalColors, type ThemeMode } from "@opentui/core"
import type { CategoryTab } from "../core/types.ts"

export interface ThemePalette {
  mode: "dark" | "light"
  bgBase: ColorInput
  bgSurface: ColorInput
  bgModal: ColorInput
  bgSelected: ColorInput
  borderSubtle: ColorInput
  borderInteractive: ColorInput
  accent: ColorInput
  textPrimary: ColorInput
  textSecondary: ColorInput
  textMuted: ColorInput
  fav: ColorInput
  danger: ColorInput
}

function mixHex(hexA: string | null | undefined, hexB: string | null | undefined, weightA: number): string | null {
  if (!hexA || !hexB) return null
  try {
    const a = RGBA.fromHex(hexA).toInts()
    const b = RGBA.fromHex(hexB).toInts()
    const w = Math.max(0, Math.min(1, weightA))
    const r = Math.round(a[0] * w + b[0] * (1 - w))
    const g = Math.round(a[1] * w + b[1] * (1 - w))
    const bl = Math.round(a[2] * w + b[2] * (1 - w))
    return `#${[r, g, bl].map((n) => n.toString(16).padStart(2, "0")).join("")}`
  } catch {
    return null
  }
}

function inferMode(mode: ThemeMode | null | undefined, defaultBg?: string | null): "dark" | "light" {
  if (mode === "light" || mode === "dark") return mode
  if (defaultBg) {
    try {
      const [r, g, b] = RGBA.fromHex(defaultBg).toInts()
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
      return luminance > 0.5 ? "light" : "dark"
    } catch {
      return "dark"
    }
  }
  return "dark"
}

export function resolveTerminalPalette(
  mode: ThemeMode | null | undefined,
  colors?: TerminalColors | null,
): ThemePalette {
  const defaultBg = colors?.defaultBackground ?? null
  const defaultFg = colors?.defaultForeground ?? null
  const resolvedMode = inferMode(mode, defaultBg)
  const light = resolvedMode === "light"

  const bgBase = RGBA.defaultBackground(defaultBg ?? undefined)
  const bgSurface = mixHex(defaultFg, defaultBg, 0.05) ?? bgBase
  const bgModal =
    mixHex(defaultFg, defaultBg, 0.07) ?? (light ? "#f4f4f5" : "#1c1c1e")
  const bgSelected =
    colors?.highlightBackground ??
    mixHex(defaultFg, defaultBg, 0.14) ??
    (light ? "#e4e4e7" : "#262626")

  const textPrimary = RGBA.defaultForeground(defaultFg ?? undefined)
  const textSecondary = mixHex(defaultFg, defaultBg, 0.75) ?? textPrimary
  const textMuted =
    mixHex(defaultFg, defaultBg, 0.48) ??
    RGBA.fromIndex(8, colors?.palette?.[8] ?? undefined)

  const borderSubtle =
    mixHex(defaultFg, defaultBg, 0.25) ??
    RGBA.fromIndex(8, colors?.palette?.[8] ?? undefined)
  const borderInteractive =
    mixHex(defaultFg, defaultBg, 0.45) ??
    RGBA.fromIndex(7, colors?.palette?.[7] ?? undefined)

  return {
    mode: resolvedMode,
    bgBase,
    bgSurface,
    bgModal,
    bgSelected,
    borderSubtle,
    borderInteractive,
    accent: RGBA.fromIndex(2, colors?.palette?.[2] ?? undefined),
    textPrimary,
    textSecondary,
    textMuted,
    fav: RGBA.fromIndex(3, colors?.palette?.[3] ?? undefined),
    danger: RGBA.fromIndex(1, colors?.palette?.[1] ?? undefined),
  }
}

export const DARK_PALETTE: ThemePalette = resolveTerminalPalette("dark")
export const LIGHT_PALETTE: ThemePalette = resolveTerminalPalette("light")

export function resolveThemePalette(
  mode: ThemeMode | null | undefined,
  colors?: TerminalColors | null,
): ThemePalette {
  return resolveTerminalPalette(mode, colors)
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
