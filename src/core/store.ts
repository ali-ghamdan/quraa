import { existsSync, renameSync, unlinkSync } from "node:fs"
import { dirname } from "node:path"
import { ensureDir } from "./paths.ts"
import type { PersistedState, Station } from "./types.ts"

export const MAX_RECENTS = 30

export const DEFAULT_PERSISTED_STATE: PersistedState = {
  volume: 80,
  muted: false,
  arabicNames: false,
  favorites: [],
  recents: [],
  lastStationId: null,
}

export interface CustomStationRecord {
  id: string
  name: string
  nameAr?: string
  url: string
}

export type UrlValidationResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

export function validateStationUrl(rawUrl: string): UrlValidationResult {
  const trimmed = rawUrl.trim()
  if (!trimmed) {
    return { ok: false, error: "Stream URL is required" }
  }
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return { ok: false, error: "Enter a valid http:// or https:// stream URL" }
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Only http:// and https:// stream URLs are allowed" }
  }
  if (!parsed.hostname) {
    return { ok: false, error: "Stream URL must include a host name" }
  }
  return { ok: true, url: trimmed }
}

export function cleanStationName(raw: string): string {
  const trimmed = raw.trim()
  const cleaned = trimmed
    .replace(/^Radio\s+/i, "")
    .replace(/\s+-\s*Radio$/i, "")
    .replace(/^[-\s]+|[-\s]+$/g, "")
    .replace(/\s+/g, " ")
  return cleaned || trimmed
}

export function cleanArabicName(raw: string): string {
  const trimmed = raw.trim()
  const cleaned = trimmed.replace(/^[-\s]+|[-\s]+$/g, "").replace(/\s+/g, " ")
  return cleaned || trimmed
}

export function makeCustomStationId(name: string, url: string): string {
  const slug = cleanStationName(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24)
  const hash = Bun.hash(url).toString(36).slice(0, 6)
  return `custom-${slug || "stream"}-${hash}`
}

export async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
  ensureDir(dirname(filePath))
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await Bun.write(tmpPath, `${JSON.stringify(data, null, 2)}\n`)
    renameSync(tmpPath, filePath)
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath)
      } catch {
        // Ignore cleanup failure after write/rename error
      }
    }
    throw err
  }
}

function uniqueStrings(value: unknown, limit?: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of value) {
    if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
      seen.add(item)
      out.push(item)
      if (limit !== undefined && out.length >= limit) break
    }
  }
  return out
}

export function sanitizePersistedState(raw: unknown): PersistedState {
  if (typeof raw !== "object" || raw === null) {
    return { ...DEFAULT_PERSISTED_STATE, favorites: [], recents: [] }
  }
  const obj = raw as Record<string, unknown>
  const volume =
    typeof obj.volume === "number" && Number.isFinite(obj.volume)
      ? Math.max(0, Math.min(150, Math.round(obj.volume)))
      : DEFAULT_PERSISTED_STATE.volume
  return {
    volume,
    muted: typeof obj.muted === "boolean" ? obj.muted : DEFAULT_PERSISTED_STATE.muted,
    arabicNames:
      typeof obj.arabicNames === "boolean"
        ? obj.arabicNames
        : DEFAULT_PERSISTED_STATE.arabicNames,
    favorites: uniqueStrings(obj.favorites),
    recents: uniqueStrings(obj.recents, MAX_RECENTS),
    lastStationId:
      typeof obj.lastStationId === "string" && obj.lastStationId.length > 0
        ? obj.lastStationId
        : null,
  }
}

export async function loadState(stateFile: string): Promise<PersistedState> {
  try {
    const file = Bun.file(stateFile)
    if (!(await file.exists())) {
      return sanitizePersistedState(null)
    }
    return sanitizePersistedState(await file.json())
  } catch {
    return sanitizePersistedState(null)
  }
}

export async function saveState(stateFile: string, state: PersistedState): Promise<void> {
  await atomicWriteJson(stateFile, sanitizePersistedState(state))
}

export async function loadCustomStations(customStationsFile: string): Promise<Station[]> {
  try {
    const file = Bun.file(customStationsFile)
    if (!(await file.exists())) return []
    const parsed = await file.json()
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { stations?: unknown }).stations)
        ? (parsed as { stations: unknown[] }).stations
        : []

    const stations: Station[] = []
    const seenIds = new Set<string>()
    for (const item of list) {
      if (typeof item !== "object" || item === null) continue
      const rec = item as Record<string, unknown>
      const rawName = typeof rec.name === "string" ? rec.name.trim() : ""
      const rawUrl = typeof rec.url === "string" ? rec.url : ""
      const urlCheck = validateStationUrl(rawUrl)
      if (!rawName || !urlCheck.ok) continue

      const baseId =
        typeof rec.id === "string" && rec.id.trim().length > 0
          ? rec.id.trim()
          : makeCustomStationId(rawName, urlCheck.url)
      let id = baseId
      let suffix = 2
      while (seenIds.has(id)) {
        id = `${baseId}-${suffix++}`
      }
      seenIds.add(id)

      const nameAr =
        typeof rec.nameAr === "string" && rec.nameAr.trim().length > 0
          ? cleanArabicName(rec.nameAr)
          : undefined

      stations.push({
        id,
        nameEn: cleanStationName(rawName),
        ...(nameAr ? { nameAr } : {}),
        rawNameEn: rawName,
        url: urlCheck.url,
        category: "custom",
      })
    }
    return stations
  } catch {
    return []
  }
}

export async function saveCustomStations(
  customStationsFile: string,
  stations: Station[],
): Promise<void> {
  const records: CustomStationRecord[] = stations
    .filter((s) => s.category === "custom")
    .filter((s) => validateStationUrl(s.url).ok)
    .map((s) => ({
      id: s.id,
      name: s.rawNameEn || s.nameEn,
      ...(s.nameAr ? { nameAr: s.nameAr } : {}),
      url: s.url,
    }))
  await atomicWriteJson(customStationsFile, records)
}

export function createCustomStation(input: {
  name: string
  url: string
  nameAr?: string
  existingIds?: Iterable<string>
}): { ok: true; station: Station } | { ok: false; error: string } {
  const name = input.name.trim()
  if (!name) {
    return { ok: false, error: "Station name is required" }
  }
  const urlCheck = validateStationUrl(input.url)
  if (!urlCheck.ok) {
    return urlCheck
  }

  const used = new Set(input.existingIds ?? [])
  const baseId = makeCustomStationId(name, urlCheck.url)
  let id = baseId
  let suffix = 2
  while (used.has(id)) {
    id = `${baseId}-${suffix++}`
  }

  const nameAr = input.nameAr?.trim() ? cleanArabicName(input.nameAr) : undefined
  return {
    ok: true,
    station: {
      id,
      nameEn: cleanStationName(name),
      ...(nameAr ? { nameAr } : {}),
      rawNameEn: name,
      url: urlCheck.url,
      category: "custom",
    },
  }
}

export function toggleFavorite(state: PersistedState, stationId: string): PersistedState {
  const exists = state.favorites.includes(stationId)
  const favorites = exists
    ? state.favorites.filter((id) => id !== stationId)
    : [...state.favorites, stationId]
  return { ...state, favorites }
}

export function recordRecent(
  state: PersistedState,
  stationId: string,
  maxRecents = MAX_RECENTS,
): PersistedState {
  const recents = [stationId, ...state.recents.filter((id) => id !== stationId)].slice(
    0,
    maxRecents,
  )
  return {
    ...state,
    recents,
    lastStationId: stationId,
  }
}
