import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CATALOG_CACHE_TTL_MS,
  FALLBACK_STATIONS,
  classifyStationCategory,
  filterStations,
  fuzzyMatchStations,
  getStationDisplayName,
  loadCatalog,
  mergeBilingualRadios,
} from "../src/core/catalog.ts"
import { resolvePaths } from "../src/core/paths.ts"
import {
  DEFAULT_PERSISTED_STATE,
  MAX_RECENTS,
  cleanArabicName,
  cleanStationName,
  createCustomStation,
  loadCustomStations,
  loadState,
  recordRecent,
  saveCustomStations,
  saveState,
  toggleFavorite,
  validateStationUrl,
} from "../src/core/store.ts"

const tempDirs: string[] = []

function makeTempPaths() {
  const root = mkdtempSync(join(tmpdir(), "quraa-test-"))
  tempDirs.push(root)
  return resolvePaths({
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("store", () => {
  test("returns default state on missing or corrupted state file", async () => {
    const paths = makeTempPaths()
    expect(await loadState(paths.stateFile)).toEqual(DEFAULT_PERSISTED_STATE)

    await saveState(paths.stateFile, { ...DEFAULT_PERSISTED_STATE, volume: 220, arabicNames: true })
    expect((await loadState(paths.stateFile)).volume).toBe(150)

    writeFileSync(paths.stateFile, "{corrupt json")
    expect(await loadState(paths.stateFile)).toEqual(DEFAULT_PERSISTED_STATE)
  })

  test("toggles favorites and maintains bounded MRU recents", () => {
    let state = { ...DEFAULT_PERSISTED_STATE }
    state = toggleFavorite(state, "17")
    state = toggleFavorite(state, "58")
    expect(state.favorites).toEqual(["17", "58"])
    state = toggleFavorite(state, "17")
    expect(state.favorites).toEqual(["58"])

    for (let i = 1; i <= MAX_RECENTS + 5; i++) {
      state = recordRecent(state, String(i))
    }
    expect(state.recents).toHaveLength(MAX_RECENTS)
    expect(state.recents[0]).toBe(String(MAX_RECENTS + 5))
    state = recordRecent(state, "10")
    expect(state.recents[0]).toBe("10")
    expect(state.lastStationId).toBe("10")
  })

  test("validates custom stream URLs and persists custom stations atomically", async () => {
    expect(validateStationUrl("https://stream.example.org/radio.mp3")).toEqual({
      ok: true,
      url: "https://stream.example.org/radio.mp3",
    })
    expect(validateStationUrl("http://localhost:8000/live").ok).toBe(true)
    expect(validateStationUrl("file:///etc/passwd").ok).toBe(false)
    expect(validateStationUrl("ftp://example.org/a.mp3").ok).toBe(false)
    expect(validateStationUrl("not a url").ok).toBe(false)
    expect(validateStationUrl("").ok).toBe(false)

    const paths = makeTempPaths()
    const created = createCustomStation({
      name: "Radio Local Masjid",
      nameAr: "-إذاعة المسجد-",
      url: "https://live.example.org/masjid",
    })
    expect(created.ok).toBe(true)
    if (!created.ok) throw new Error(created.error)

    expect(created.station.category).toBe("custom")
    expect(created.station.nameEn).toBe("Local Masjid")
    expect(created.station.nameAr).toBe("إذاعة المسجد")

    await saveCustomStations(paths.customStationsFile, [created.station])
    const reloaded = await loadCustomStations(paths.customStationsFile)
    expect(reloaded).toHaveLength(1)
    expect(reloaded[0]?.url).toBe("https://live.example.org/masjid")
    expect(reloaded[0]?.nameEn).toBe("Local Masjid")
  })
})

describe("catalog cleanup & classification", () => {
  test("cleans noisy prefixes, suffixes, and dashes without erasing real Radio labels", () => {
    expect(cleanStationName("Radio Ibrahim Al-Akdar")).toBe("Ibrahim Al-Akdar")
    expect(cleanStationName("Abdullah Al-Mousa - Radio")).toBe("Abdullah Al-Mousa")
    expect(cleanStationName("-Main Radio-")).toBe("Main Radio")
    expect(cleanStationName("---Amazing short Recitations---")).toBe("Amazing short Recitations")
    expect(cleanArabicName("تلاوات خاشعة-")).toBe("تلاوات خاشعة")
    expect(cleanArabicName("سورة البقرة - لعدد من القراء---")).toBe("سورة البقرة - لعدد من القراء")
  })

  test("classifies reciters vs thematic streams accurately", () => {
    expect(classifyStationCategory("Radio Yasser Al-Dosari")).toBe("reciter")
    expect(classifyStationCategory("Abdullah Al-Mousa - Radio")).toBe("reciter")
    expect(classifyStationCategory("-Main Radio-")).toBe("thematic")
    expect(classifyStationCategory("General Fatwa Radio")).toBe("thematic")
    expect(classifyStationCategory("Sharia ruqyah")).toBe("thematic")
    expect(classifyStationCategory("--Quran Tafseer--")).toBe("thematic")
    expect(classifyStationCategory("-Surah Al-Baqarah - Many Reciters-")).toBe("thematic")
    expect(classifyStationCategory("Words of remembrance for morning")).toBe("thematic")
    expect(classifyStationCategory("Quran translation into English - AbdulBasit Abdul Samad")).toBe("thematic")
    expect(classifyStationCategory("The virtue of the month of Ramadan")).toBe("thematic")
    expect(classifyStationCategory("Sahih Muslim")).toBe("thematic")
  })

  test("merges bilingual API arrays by id cleanly", () => {
    const merged = mergeBilingualRadios(
      [
        { id: 1, name: "Radio Ibrahim Al-Akdar", url: "https://backup.qurango.net/radio/ibrahim_alakdar" },
        { id: 114, name: "Sharia ruqyah", url: "https://backup.qurango.net/radio/roqiah" },
        { id: 999, name: "Bad Url", url: "file:///tmp/bad.mp3" },
      ],
      [
        { id: 1, name: "إبراهيم الأخضر", url: "https://backup.qurango.net/radio/ibrahim_alakdar" },
        { id: 114, name: "الرقية الشرعية-", url: "https://backup.qurango.net/radio/roqiah" },
      ],
    )
    expect(merged).toHaveLength(2)
    expect(merged[0]).toMatchObject({
      id: "1",
      nameEn: "Ibrahim Al-Akdar",
      rawNameEn: "Radio Ibrahim Al-Akdar",
      nameAr: "إبراهيم الأخضر",
      category: "reciter",
    })
    expect(merged[1]).toMatchObject({
      id: "114",
      nameEn: "Sharia ruqyah",
      nameAr: "الرقية الشرعية",
      category: "thematic",
    })
  })
})

describe("catalog loading, cache & search", () => {
  test("bundles ~20 curated offline fallback stations across reciters and thematic streams", () => {
    expect(FALLBACK_STATIONS.length).toBeGreaterThanOrEqual(18)
    expect(FALLBACK_STATIONS.some((s) => s.category === "reciter")).toBe(true)
    expect(FALLBACK_STATIONS.some((s) => s.category === "thematic")).toBe(true)
    expect(FALLBACK_STATIONS.every((s) => Boolean(s.nameAr))).toBe(true)
  })

  test("falls back cleanly offline, writes fresh cache online, and refreshes stale cache in background", async () => {
    const paths = makeTempPaths()
    const custom = createCustomStation({ name: "My Custom Stream", url: "https://radio.local/stream" })
    if (!custom.ok) throw new Error("unexpected")
    await saveCustomStations(paths.customStationsFile, [custom.station])

    // 1. Network failure + empty cache -> fallback + custom
    const offlineFetch = (async () => {
      throw new Error("network down")
    }) as unknown as typeof fetch
    const fallbackResult = await loadCatalog({ paths, fetchImpl: offlineFetch })
    expect(fallbackResult.source).toBe("fallback")
    expect(fallbackResult.stations.some((s) => s.id === custom.station.id)).toBe(true)
    expect(fallbackResult.stations.length).toBe(FALLBACK_STATIONS.length + 1)

    // 2. Network success -> caches & serves fresh cache on next call without hitting network
    let fetchCalls = 0
    const liveFetch = (async (input: string | URL | Request) => {
      fetchCalls++
      const url = String(input)
      if (url.includes("language=eng")) {
        return Response.json({
          radios: [{ id: 17, name: "Radio Saad Al-Ghamdi", url: "https://backup.qurango.net/radio/saad_alghamdi" }],
        })
      }
      return Response.json({
        radios: [{ id: 17, name: "سعد الغامدي", url: "https://backup.qurango.net/radio/saad_alghamdi" }],
      })
    }) as unknown as typeof fetch

    let nowMs = 1_000_000
    const netResult = await loadCatalog({ paths, fetchImpl: liveFetch, now: () => nowMs })
    expect(netResult.source).toBe("network")
    expect(fetchCalls).toBe(2)
    expect(netResult.stations.map((s) => s.id)).toEqual(["17", custom.station.id])

    fetchCalls = 0
    const cachedResult = await loadCatalog({ paths, fetchImpl: liveFetch, now: () => nowMs + 60_000 })
    expect(cachedResult.source).toBe("cache")
    expect(fetchCalls).toBe(0)

    // 3. Stale cache (>24h) serves cached immediately and refreshes in background
    let bgUpdatedLen = 0
    const staleResult = await loadCatalog({
      paths,
      fetchImpl: liveFetch,
      now: () => nowMs + CATALOG_CACHE_TTL_MS + 10,
      onBackgroundRefresh: (stations) => {
        bgUpdatedLen = stations.length
      },
    })
    expect(staleResult.source).toBe("stale-cache")
    const refreshed = await staleResult.refreshPromise
    expect(refreshed?.length).toBe(2)
    expect(bgUpdatedLen).toBe(2)
    expect(fetchCalls).toBe(2)
  })

  test("filters tabs and fuzzy-matches across clean EN, raw EN, and normalized Arabic", () => {
    const state = {
      ...DEFAULT_PERSISTED_STATE,
      favorites: ["69"],
      recents: ["108", "3"],
      arabicNames: true,
    }
    const custom = createCustomStation({
      name: "Masjid Stream",
      url: "https://stream.example.net/live",
    })
    if (!custom.ok) throw new Error("unexpected")
    const stations = [...FALLBACK_STATIONS, custom.station]

    expect(filterStations(stations, "favorites", "", state).map((s) => s.id)).toEqual(["69"])
    expect(filterStations(stations, "recent", "", state).map((s) => s.id)).toEqual(["108", "3"])
    expect(filterStations(stations, "custom", "", state).map((s) => s.id)).toEqual([custom.station.id])
    expect(filterStations(stations, "thematic", "", state).every((s) => s.category === "thematic")).toBe(true)

    // Fuzzy subsequence on clean English name
    const minshawiMatches = fuzzyMatchStations(stations, "mnsw")
    expect(minshawiMatches[0]?.nameEn).toBe("Mohammed Siddiq Al-Minshawi")

    // Raw English search still matches stripped "Radio " prefix
    const rawMatches = filterStations(stations, "all", "Radio Fares", state)
    expect(rawMatches[0]?.id).toBe("52")

    // Arabic search matches without hamza normalization differences
    const arMatches = filterStations(stations, "all", "احمد العجمي", state)
    expect(arMatches[0]?.id).toBe("3")

    // Display name helper respects arabicNames and falls back to nameEn when absent
    expect(getStationDisplayName(arMatches[0]!, true)).toBe("أحمد العجمي")
    expect(getStationDisplayName(arMatches[0]!, false)).toBe("Ahmad Al-Ajmy")
    expect(getStationDisplayName(custom.station, true)).toBe("Masjid Stream")
  })
})
