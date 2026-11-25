export type StationCategory = "reciter" | "thematic" | "custom"

export type AppLanguage = "en" | "ar" | "ar-fixed"

export type CategoryTab =
  | "all"
  | "favorites"
  | "recent"
  | "reciter"
  | "thematic"
  | "custom"

export type PlaybackState =
  | "stopped"
  | "connecting"
  | "playing"
  | "paused"
  | "reconnecting"
  | "error"

export type UiMode =
  | "browse"
  | "search"
  | "modal:help"
  | "modal:add-custom"
  | "modal:quit-confirm"

export type QuitConfirmChoice = "cancel" | "no" | "yes"

export type FocusZone = "search" | "tabs" | "list"

export interface Station {
  id: string
  apiId?: number
  nameEn: string
  nameAr?: string
  rawNameEn: string
  url: string
  category: StationCategory
  image?: string
}

export interface PersistedState {
  volume: number
  muted: boolean
  language: AppLanguage
  favorites: string[]
  recents: string[]
  lastStationId: string | null
}

export interface PlaybackSnapshot {
  state: PlaybackState
  stationId: string | null
  title: string | null
  trackTitle: string | null
  author: string | null
  artUrl: string | null
  metadata: string | null
  volume: number
  muted: boolean
  sleepUntil: number
  error: string | null
}
