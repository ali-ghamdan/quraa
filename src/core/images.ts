import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import type { QuraaPaths } from "./paths.ts"
import type { Station } from "./types.ts"

const ASSETS_DIR = fileURLToPath(new URL("../../assets/", import.meta.url))
export const DEFAULT_ARTWORK_PATH = join(ASSETS_DIR, "quraa-default.png")
export const DEFAULT_ARTWORK_URI = pathToFileURL(DEFAULT_ARTWORK_PATH).href
export const BUNDLED_STATION_IMAGES_PATH = join(ASSETS_DIR, "station-images.json")

export interface ImageConfigMap {
  default?: string
  authors: Record<string, string>
  stations: Record<string, string>
}

export function normalizeArtworkKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^radio\s+/i, "")
    .replace(/\s+-\s*radio$/i, "")
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

/** Convert a local file path, asset relative path, `file://`, or `http(s)://` URL into an MPRIS URI. */
export function normalizeImageUri(
  raw: string | undefined | null,
  relativeBaseDir = ASSETS_DIR,
): string | null {
  if (typeof raw !== "string") return null
  const trimmed = raw.trim()
  if (!trimmed) return null

  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname) {
        return trimmed
      }
    } catch {
      return null
    }
    return null
  }

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol === "file:") {
        const fsPath = fileURLToPath(parsed)
        return existsSync(fsPath) ? parsed.href : null
      }
    } catch {
      return null
    }
    return null
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null
  }

  const resolvedPath = trimmed.startsWith("~/")
    ? resolve(homedir(), trimmed.slice(2))
    : trimmed === "~"
      ? homedir()
      : isAbsolute(trimmed)
        ? trimmed
        : resolve(relativeBaseDir, trimmed)

  return existsSync(resolvedPath) ? pathToFileURL(resolvedPath).href : null
}

function parseImageMapFile(filePath: string, relativeBaseDir: string): ImageConfigMap {
  const result: ImageConfigMap = { authors: {}, stations: {} }
  if (!existsSync(filePath)) return result
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result

    const defaultUri = normalizeImageUri(
      typeof parsed.default === "string" ? parsed.default : undefined,
      relativeBaseDir,
    )
    if (defaultUri) result.default = defaultUri

    const ingestEntries = (
      target: Record<string, string>,
      obj: unknown,
    ) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return
      for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        if (typeof val !== "string") continue
        const uri = normalizeImageUri(val, relativeBaseDir)
        const normKey = normalizeArtworkKey(key)
        if (uri && normKey) target[normKey] = uri
      }
    }

    ingestEntries(result.authors, parsed.authors)
    ingestEntries(result.stations, parsed.stations)

    // Support flat { "79": "/path/to/art.png", "mishary alafasi": "https://..." } shorthand
    for (const [key, val] of Object.entries(parsed)) {
      if (key === "default" || key === "authors" || key === "stations") continue
      if (typeof val !== "string") continue
      const uri = normalizeImageUri(val, relativeBaseDir)
      const normKey = normalizeArtworkKey(key)
      if (!uri || !normKey) continue
      result.stations[normKey] = uri
      result.authors[normKey] = uri
    }
    return result
  } catch {
    return result
  }
}

export function loadImageConfig(paths: QuraaPaths): {
  bundled: ImageConfigMap
  user: ImageConfigMap
} {
  return {
    bundled: parseImageMapFile(BUNDLED_STATION_IMAGES_PATH, ASSETS_DIR),
    user: parseImageMapFile(paths.imagesConfigFile, paths.configDir),
  }
}

function lookupAuthor(map: ImageConfigMap, candidate: string | null | undefined): string | null {
  if (!candidate) return null
  const key = normalizeArtworkKey(candidate)
  if (!key) return null
  return map.authors[key] ?? map.stations[key] ?? null
}

function lookupStation(map: ImageConfigMap, station: Station | null | undefined): string | null {
  if (!station) return null
  const byId = map.stations[normalizeArtworkKey(station.id)]
  if (byId) return byId
  const byEn = map.stations[normalizeArtworkKey(station.nameEn)] ?? map.authors[normalizeArtworkKey(station.nameEn)]
  if (byEn) return byEn
  if (station.nameAr) {
    const byAr = map.stations[normalizeArtworkKey(station.nameAr)] ?? map.authors[normalizeArtworkKey(station.nameAr)]
    if (byAr) return byAr
  }
  const byCategory = map.stations[normalizeArtworkKey(station.category)]
  if (byCategory) return byCategory
  return null
}

/** Resolve artwork URI: user author -> user station -> custom station image -> bundled map -> default PNG. */
export function resolveStationArtUrl(input: {
  station?: Station | null
  author?: string | null
  fallbackUri?: string | null
  config: { bundled: ImageConfigMap; user: ImageConfigMap }
}): string {
  const { station, author, fallbackUri, config } = input

  const userAuthorHit = lookupAuthor(config.user, author)
  if (userAuthorHit) return userAuthorHit

  const userStationHit = lookupStation(config.user, station)
  if (userStationHit) return userStationHit

  const customStationUri = normalizeImageUri(station?.image)
  if (customStationUri) return customStationUri

  const bundledAuthorHit = lookupAuthor(config.bundled, author)
  if (bundledAuthorHit) return bundledAuthorHit

  const bundledStationHit = lookupStation(config.bundled, station)
  if (bundledStationHit) return bundledStationHit

  const explicitFallback = normalizeImageUri(fallbackUri)
  if (explicitFallback) return explicitFallback

  return (
    config.user.default ??
    config.bundled.default ??
    normalizeImageUri(DEFAULT_ARTWORK_PATH) ??
    DEFAULT_ARTWORK_URI
  )
}
