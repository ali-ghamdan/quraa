export type StationCategory = "reciter" | "thematic" | "custom"

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

export type UiMode = "browse" | "search" | "modal:help" | "modal:add-custom"

export type FocusZone = "search" | "tabs" | "list"

export interface Station {
  id: string
  apiId?: number
  nameEn: string
  nameAr?: string
  rawNameEn: string
  url: string
  category: StationCategory
}

export interface PersistedState {
  volume: number
  muted: boolean
  arabicNames: boolean
  favorites: string[]
  recents: string[]
  lastStationId: string | null
}

export interface PlaybackSnapshot {
  state: PlaybackState
  stationId: string | null
  title: string | null
  metadata: string | null
  volume: number
  muted: boolean
  sleepUntil: number
  error: string | null
}
