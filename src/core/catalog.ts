import type { QuraaPaths } from "./paths.ts"
import {
  atomicWriteJson,
  cleanArabicName,
  cleanStationName,
  loadCustomStations,
  validateStationUrl,
} from "./store.ts"
import type { CategoryTab, PersistedState, Station } from "./types.ts"

export const MP3QURAN_ENG_URL = "https://www.mp3quran.net/api/v3/radios?language=eng"
export const MP3QURAN_AR_URL = "https://www.mp3quran.net/api/v3/radios?language=ar"
export const CATALOG_CACHE_TTL_MS = 24 * 60 * 60 * 1000
export const FETCH_TIMEOUT_MS = 5_000

const THEMATIC_PATTERN =
  /(main radio|recitations|takbeer|fatwa|ruqyah|surah|tafse?er|serenity|stories|interpretation|remembrance|biography|jurisprudential|translat|quran in |ramadan|sahih|saudia arabia|رياض الصالحين|تفسير|الشمائل)/i

export interface ApiRadioEntry {
  id: number
  name: string
  url: string
  recent_date?: string
}

interface CatalogCachePayload {
  fetchedAt: number
  stations: Station[]
}

export type CatalogSource = "network" | "cache" | "stale-cache" | "fallback"

export interface LoadCatalogResult {
  stations: Station[]
  source: CatalogSource
  refreshPromise?: Promise<Station[] | null>
}

export interface LoadCatalogOptions {
  paths: QuraaPaths
  fetchImpl?: typeof fetch
  now?: () => number
  onBackgroundRefresh?: (stations: Station[]) => void
}

const FALLBACK_SEEDS: Array<{ id: number; en: string; ar: string; url: string }> = [
  { id: 2, en: "Radio Shaik Abu Bakr Al Shatri", ar: "شيخ أبو بكر الشاطري", url: "https://backup.qurango.net/radio/shaik_abu_bakr_al_shatri" },
  { id: 3, en: "Radio Ahmad Al-Ajmy", ar: "أحمد العجمي", url: "https://backup.qurango.net/radio/ahmad_alajmy" },
  { id: 17, en: "Radio Saad Al-Ghamdi", ar: "سعد الغامدي", url: "https://backup.qurango.net/radio/saad_alghamdi" },
  { id: 18, en: "Radio Saud Al-Shuraim", ar: "سعود الشريم", url: "https://backup.qurango.net/radio/saud_alshuraim" },
  { id: 30, en: "Radio Abdulbasit Abdulsamad", ar: "عبدالباسط عبدالصمد", url: "https://backup.qurango.net/radio/abdulbasit_abdulsamad_mojawwad" },
  { id: 32, en: "Radio Abdulbasit Abdulsamad", ar: "عبدالباسط عبدالصمد", url: "https://backup.qurango.net/radio/abdulbasit_abdulsamad" },
  { id: 52, en: "Radio Fares Abbad", ar: "فارس عباد", url: "https://backup.qurango.net/radio/fares_abbad" },
  { id: 53, en: "Radio Nasser Alqatami", ar: "ناصر القطامي", url: "https://backup.qurango.net/radio/nasser_alqatami" },
  { id: 58, en: "Radio Yasser Al-Dosari", ar: "ياسر الدوسري", url: "https://backup.qurango.net/radio/yasser_aldosari" },
  { id: 69, en: "Radio Mohammed Siddiq Al-Minshawi", ar: "محمد صديق المنشاوي", url: "https://backup.qurango.net/radio/mohammed_siddiq_alminshawi" },
  { id: 70, en: "Radio Mohammed Siddiq Al-Minshawi", ar: "محمد صديق المنشاوي", url: "https://backup.qurango.net/radio/mohammed_siddiq_alminshawi_mojawwad" },
  { id: 91, en: "Radio Ibrahim Aldosari", ar: "ابراهيم الدوسري", url: "https://backup.qurango.net/radio/ibrahim_aldosari" },
  { id: 108, en: "-Main Radio-", ar: "العامة - متنوعة لمختلف القراء", url: "https://backup.qurango.net/radio/mix" },
  { id: 109, en: "-Beautiful Recitations-", ar: "تلاوات خاشعة-", url: "https://backup.qurango.net/radio/salma" },
  { id: 114, en: "Sharia ruqyah", ar: "الرقية الشرعية", url: "https://backup.qurango.net/radio/roqiah" },
  { id: 115, en: "-Surah Al-Baqarah - Many Reciters-", ar: "سورة البقرة - لعدد من القراء---", url: "https://backup.qurango.net/radio/albaqarah" },
  { id: 116, en: "--Quran Tafseer--", ar: "تفسير القران الكريم--", url: "https://backup.qurango.net/radio/tafseer" },
  { id: 10906, en: "Words of remembrance for morning", ar: "أذكار الصباح", url: "https://backup.qurango.net/radio/athkar_sabah" },
  { id: 10907, en: "Words of remembrance for evening", ar: "أذكار المساء", url: "https://backup.qurango.net/radio/athkar_masa" },
  { id: 109046, en: "Quran translation into English - AbdulBasit Abdul Samad", ar: "ترجمة معاني القرآن باللغة الإنجليزية", url: "https://backup.qurango.net/radio/translation_quran_english_basit" },
]

export function classifyStationCategory(rawNameEn: string): "reciter" | "thematic" {
  return THEMATIC_PATTERN.test(rawNameEn) ? "thematic" : "reciter"
}

export function mergeBilingualRadios(
  engRadios: ApiRadioEntry[],
  arRadios: ApiRadioEntry[],
): Station[] {
  const arById = new Map<number, string>()
  for (const ar of arRadios) {
    if (typeof ar.id === "number" && typeof ar.name === "string" && ar.name.trim()) {
      arById.set(ar.id, cleanArabicName(ar.name))
    }
  }

  const out: Station[] = []
  const seen = new Set<string>()
  for (const r of engRadios) {
    if (typeof r.id !== "number" || typeof r.name !== "string" || typeof r.url !== "string") {
      continue
    }
    const rawNameEn = r.name.trim()
    const urlCheck = validateStationUrl(r.url)
    if (!rawNameEn || !urlCheck.ok) continue

    const id = String(r.id)
    if (seen.has(id)) continue
    seen.add(id)

    const nameAr = arById.get(r.id)
    out.push({
      id,
      apiId: r.id,
      nameEn: cleanStationName(rawNameEn),
      ...(nameAr ? { nameAr } : {}),
      rawNameEn,
      url: urlCheck.url,
      category: classifyStationCategory(rawNameEn),
    })
  }
  return out
}

export const FALLBACK_STATIONS: Station[] = mergeBilingualRadios(
  FALLBACK_SEEDS.map((s) => ({ id: s.id, name: s.en, url: s.url })),
  FALLBACK_SEEDS.map((s) => ({ id: s.id, name: s.ar, url: s.url })),
)

export function mergeCatalogWithCustom(base: Station[], custom: Station[]): Station[] {
  const seen = new Set<string>()
  const merged: Station[] = []
  for (const s of [...base, ...custom]) {
    if (seen.has(s.id)) continue
    seen.add(s.id)
    merged.push(s)
  }
  return merged
}

async function fetchJsonWithTimeout(
  url: string,
  fetchImpl: typeof fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<ApiRadioEntry[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { signal: controller.signal })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} fetching ${url}`)
    }
    const payload = (await res.json()) as { radios?: unknown }
    if (!payload || !Array.isArray(payload.radios)) {
      throw new Error(`Invalid radio catalog response from ${url}`)
    }
    return payload.radios as ApiRadioEntry[]
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchBilingualCatalog(
  fetchImpl: typeof fetch = fetch,
): Promise<Station[]> {
  const [engResult, arResult] = await Promise.allSettled([
    fetchJsonWithTimeout(MP3QURAN_ENG_URL, fetchImpl),
    fetchJsonWithTimeout(MP3QURAN_AR_URL, fetchImpl),
  ])
  if (engResult.status !== "fulfilled") {
    throw engResult.reason
  }
  const arRadios = arResult.status === "fulfilled" ? arResult.value : []
  const merged = mergeBilingualRadios(engResult.value, arRadios)
  if (merged.length === 0) {
    throw new Error("Empty catalog returned from mp3quran API")
  }
  return merged
}

async function readCatalogCache(cacheFile: string): Promise<CatalogCachePayload | null> {
  try {
    const file = Bun.file(cacheFile)
    if (!(await file.exists())) return null
    const data = (await file.json()) as Partial<CatalogCachePayload>
    if (
      typeof data.fetchedAt !== "number" ||
      !Number.isFinite(data.fetchedAt) ||
      !Array.isArray(data.stations) ||
      data.stations.length === 0
    ) {
      return null
    }
    const stations = data.stations.filter(
      (s): s is Station =>
        typeof s === "object" &&
        s !== null &&
        typeof s.id === "string" &&
        typeof s.nameEn === "string" &&
        typeof s.rawNameEn === "string" &&
        typeof s.url === "string" &&
        validateStationUrl(s.url).ok,
    )
    if (stations.length === 0) return null
    return { fetchedAt: data.fetchedAt, stations }
  } catch {
    return null
  }
}

async function writeCatalogCache(
  cacheFile: string,
  stations: Station[],
  now: () => number,
): Promise<void> {
  const payload: CatalogCachePayload = {
    fetchedAt: now(),
    stations,
  }
  await atomicWriteJson(cacheFile, payload)
}

export async function loadCatalog(options: LoadCatalogOptions): Promise<LoadCatalogResult> {
  const { paths, fetchImpl = fetch, now = Date.now, onBackgroundRefresh } = options
  const [custom, cache] = await Promise.all([
    loadCustomStations(paths.customStationsFile),
    readCatalogCache(paths.cacheStationsFile),
  ])

  if (cache) {
    const ageMs = now() - cache.fetchedAt
    const stations = mergeCatalogWithCustom(cache.stations, custom)
    if (ageMs < CATALOG_CACHE_TTL_MS) {
      return { stations, source: "cache" }
    }

    const refreshPromise = (async () => {
      try {
        const freshBase = await fetchBilingualCatalog(fetchImpl)
        await writeCatalogCache(paths.cacheStationsFile, freshBase, now)
        const freshCustom = await loadCustomStations(paths.customStationsFile)
        const updated = mergeCatalogWithCustom(freshBase, freshCustom)
        onBackgroundRefresh?.(updated)
        return updated
      } catch {
        return null
      }
    })()

    return { stations, source: "stale-cache", refreshPromise }
  }

  try {
    const live = await fetchBilingualCatalog(fetchImpl)
    await writeCatalogCache(paths.cacheStationsFile, live, now)
    return { stations: mergeCatalogWithCustom(live, custom), source: "network" }
  } catch {
    return {
      stations: mergeCatalogWithCustom(FALLBACK_STATIONS, custom),
      source: "fallback",
    }
  }
}

function normalizeSearchText(text: string): string {
  // Strip Arabic diacritics/tatweel and fold Alef/Ta-Marbuta variations for forgiving search
  return text
    .toLowerCase()
    .replace(/[\u064B-\u065F\u0670\u0640]/g, "")
    .replace(/[أإآ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
}

function scoreField(field: string | undefined, query: string): number {
  if (!field) return 0
  const haystack = normalizeSearchText(field)
  const needle = normalizeSearchText(query.trim())
  if (!needle) return 0

  if (haystack === needle) return 400
  if (haystack.startsWith(needle)) return 300

  const idx = haystack.indexOf(needle)
  if (idx >= 0) {
    const prev = haystack[idx - 1]
    const boundary = idx === 0 || prev === " " || prev === "-"
    return boundary ? 240 : 180
  }

  let qIdx = 0
  let firstMatch = -1
  let prevMatch = -1
  let consecutiveBonus = 0
  for (let i = 0; i < haystack.length && qIdx < needle.length; i++) {
    if (haystack[i] === needle[qIdx]) {
      if (firstMatch === -1) firstMatch = i
      if (prevMatch === i - 1) consecutiveBonus += 6
      prevMatch = i
      qIdx++
    }
  }
  if (qIdx !== needle.length) return 0

  const span = prevMatch - firstMatch + 1
  const density = Math.round((needle.length / span) * 60)
  return Math.max(10, 40 + density + consecutiveBonus)
}

export function fuzzyMatchScore(station: Station, query: string): number {
  return Math.max(
    scoreField(station.nameEn, query),
    scoreField(station.rawNameEn, query),
    scoreField(station.nameAr, query),
  )
}

export function fuzzyMatchStations(stations: Station[], query: string): Station[] {
  const trimmed = query.trim()
  if (!trimmed) return stations
  const scored: Array<{ station: Station; score: number; index: number }> = []
  for (let i = 0; i < stations.length; i++) {
    const station = stations[i]!
    const score = fuzzyMatchScore(station, trimmed)
    if (score > 0) {
      scored.push({ station, score, index: i })
    }
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index)
  return scored.map((item) => item.station)
}

export function filterStations(
  stations: Station[],
  tab: CategoryTab,
  query: string,
  state: PersistedState,
): Station[] {
  let tabFiltered: Station[]
  switch (tab) {
    case "all":
      tabFiltered = stations
      break
    case "favorites": {
      const favSet = new Set(state.favorites)
      tabFiltered = stations.filter((s) => favSet.has(s.id))
      break
    }
    case "recent": {
      const byId = new Map(stations.map((s) => [s.id, s]))
      tabFiltered = []
      for (const id of state.recents) {
        const found = byId.get(id)
        if (found) tabFiltered.push(found)
      }
      break
    }
    case "reciter":
      tabFiltered = stations.filter((s) => s.category === "reciter")
      break
    case "thematic":
      tabFiltered = stations.filter((s) => s.category === "thematic")
      break
    case "custom":
      tabFiltered = stations.filter((s) => s.category === "custom")
      break
  }

  return fuzzyMatchStations(tabFiltered, query)
}

export function getStationDisplayName(station: Station, arabicNames: boolean): string {
  if (arabicNames && station.nameAr) return station.nameAr
  return station.nameEn
}
