import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  bidiVisualOrder,
  formatArabicFixed,
  formatDisplayText,
  shapeArabicText,
} from "../src/core/arabic.ts"
import {
  DEFAULT_ARTWORK_URI,
  loadImageConfig,
  normalizeImageUri,
  resolveStationArtUrl,
} from "../src/core/images.ts"
import {
  parseLiveStreamMetadata,
  repairStreamText,
  splitAuthorAndTitle,
} from "../src/core/metadata.ts"
import { resolvePaths } from "../src/core/paths.ts"
import type { Station } from "../src/core/types.ts"

const tempDirs: string[] = []

function makeTempPaths() {
  const root = mkdtempSync(join(tmpdir(), "quraa-meta-test-"))
  tempDirs.push(root)
  return resolvePaths({
    HOME: root,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_CACHE_HOME: join(root, "cache"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "run"),
  })
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("stream metadata encoding recovery & ICY parsing", () => {
  test("recovers CP1256-as-Latin-1 and double-UTF-8 mojibake losslessly", () => {
    const hung = repairStreamText(
      "Hungarian Translation ÇáÊÑÌãÉ ÇáãÌÑíÉ - 082 Al-Infitar ÇáÇäÝØÇÑ",
    )
    expect(hung).toEqual({
      text: "Hungarian Translation الترجمة المجرية - 082 Al-Infitar الانفطار",
      corrupted: false,
    })

    const latinDoubleUtf8 = repairStreamText("Ø³Ù„ÙŠÙ…Ø§Ù† Ø¹Ù„ÙŠÙ‡ Ø§Ù„Ø³Ù„Ø§Ù… - 1")
    expect(latinDoubleUtf8).toEqual({
      text: "سليمان عليه السلام - 1",
      corrupted: false,
    })

    const cp1252DoubleUtf8 = repairStreamText("Ù…Ø­Ù…Ø¯")
    expect(cp1252DoubleUtf8).toEqual({
      text: "محمد",
      corrupted: false,
    })
  })

  test("cleans soft hyphens and suppresses unrecoverably damaged '?' server tags", () => {
    expect(repairStreamText("Maher Al-Muaiqly - Ta\u00ADHa")).toEqual({
      text: "Maher Al-Muaiqly - Ta-Ha",
      corrupted: false,
    })
    expect(repairStreamText("Abdulbasit Abdulsamad - Al\u00ADAhzab")).toEqual({
      text: "Abdulbasit Abdulsamad - Al-Ahzab",
      corrupted: false,
    })

    // Salma stream server strips C1 trail bytes to ASCII '?' before UTF-8 emission
    const salma = repairStreamText("Ù?Ø­Ù?Ø¯ Ø·Ù? - Ù?Ù? Ø³Ù?Ø±Ø© Ø§Ù?Ø²Ø®Ø±Ù?")
    expect(salma.corrupted).toBe(true)
    expect(salma.text).toBe("")

    expect(repairStreamText("Bad \uFFFD bytes").corrupted).toBe(true)
  })

  test("splits live ICY <Author> - <Chapter> cleanly and ignores raw URL slug placeholders", () => {
    const basic = parseLiveStreamMetadata({
      metadataRaw: { "icy-title": "Mishary Alafasi - Al-Lail" },
      mediaTitle: "Mishary Alafasi - Al-Lail",
      stationName: "Mishary Alafasi",
      stationAuthor: "Mishary Alafasi",
      stationUrl: "https://backup.qurango.net/radio/mishary_alafasi",
    })
    expect(basic).toEqual({
      trackTitle: "Al-Lail",
      author: "Mishary Alafasi",
      metadata: "Mishary Alafasi - Al-Lail",
      corrupted: false,
    })

    const multi = parseLiveStreamMetadata({
      metadataRaw: {
        "icy-title": "Bandar Balilah  بندر بليلة - 036 Ya-Sin يس",
      },
      mediaTitle: null,
      stationName: "Bandar Balilah",
      stationAuthor: "Bandar Balilah",
      stationUrl: "https://backup.qurango.net/radio/bandar_balilah",
    })
    expect(multi.author).toBe("Bandar Balilah بندر بليلة")
    expect(multi.trackTitle).toBe("036 Ya-Sin يس")

    // URL slug during initial buffering must not leak as trackTitle or metadata
    const slug = parseLiveStreamMetadata({
      metadataRaw: null,
      mediaTitle: "mishary_alafasi",
      stationName: "Mishary Alafasi",
      stationAuthor: "Mishary Alafasi",
      stationUrl: "https://backup.qurango.net/radio/mishary_alafasi",
    })
    expect(slug).toEqual({
      trackTitle: null,
      author: "Mishary Alafasi",
      metadata: null,
      corrupted: false,
    })

    // Unsplit pipe-delimited show falls back author cleanly to station author
    const pipeOnly = splitAuthorAndTitle("الشمائل المحمدية | الحلقة (15)", "الشمائل المحمدية")
    expect(pipeOnly).toEqual({
      author: "الشمائل المحمدية",
      trackTitle: "الشمائل المحمدية | الحلقة (15)",
    })
  })
})

describe("Arabic Presentation Forms-B shaping & visual BiDi (ar-fixed)", () => {
  test("shapes contextual Arabic forms and Lam-Alef ligatures", () => {
    // مشاري -> initial Meem, medial Sheen, final Alef, isolated Reh, isolated Yeh
    expect(shapeArabicText("مشاري")).toBe("\uFEE3\uFEB8\uFE8E\uFEAD\uFEF1")
    // الأخضر includes Alif-Lam + Alef Hamza Above ligature
    expect(shapeArabicText("الأخضر")).toContain("\uFEF7")
    expect(shapeArabicText("تلاوات")).toContain("\uFEFC")
  })

  test("reorders RTL runs visually, preserves digits, and mirrors brackets identically to FriBidi", () => {
    expect(formatArabicFixed("مشاري العفاسي")).toBe("ﻲﺳﺎﻔﻌﻟﺍ ﻱﺭﺎﺸﻣ")
    expect(formatArabicFixed("عبدالباسط عبدالصمد - سورة البقرة (02)")).toBe(
      "(02) ﺓﺮﻘﺒﻟﺍ ﺓﺭﻮﺳ - ﺪﻤﺼﻟﺍﺪﺒﻋ ﻂﺳﺎﺒﻟﺍﺪﺒﻋ",
    )
    expect(formatArabicFixed("Al-Quraa مشاري العفاسي 123")).toBe(
      "Al-Quraa 123 ﻲﺳﺎﻔﻌﻟﺍ ﻱﺭﺎﺸﻣ",
    )
    expect(bidiVisualOrder("Radio Quraa")).toBe("Radio Quraa")
    expect(formatDisplayText("مشاري العفاسي", "ar")).toBe("مشاري العفاسي")
    expect(formatDisplayText("مشاري العفاسي", "ar-fixed")).toBe("ﻲﺳﺎﻔﻌﻟﺍ ﻱﺭﺎﺸﻣ")
  })
})

describe("pre-configured artwork resolution", () => {
  test("prioritizes user author, user station ID, custom image, bundled category, and default PNG", () => {
    const paths = makeTempPaths()
    mkdirSync(paths.configDir, { recursive: true })
    const authorPng = join(paths.configDir, "alafasi.png")
    const stationPng = join(paths.configDir, "mix.png")
    const customPng = join(paths.configDir, "custom.png")
    const defaultUserPng = join(paths.configDir, "default.png")
    writeFileSync(authorPng, "png")
    writeFileSync(stationPng, "png")
    writeFileSync(customPng, "png")
    writeFileSync(defaultUserPng, "png")

    writeFileSync(
      join(paths.configDir, "images.json"),
      JSON.stringify({
        default: defaultUserPng,
        authors: {
          "mishary alafasi": authorPng,
          "bad script": "javascript:alert(1)",
        },
        stations: {
          "108": stationPng,
        },
      }),
    )

    const config = loadImageConfig(paths)
    expect(normalizeImageUri("javascript:alert(1)")).toBeNull()
    expect(normalizeImageUri("https://cdn.example.com/art.jpg")).toBe(
      "https://cdn.example.com/art.jpg",
    )

    const alafasiStation: Station = {
      id: "79",
      nameEn: "Mishary Alafasi",
      rawNameEn: "Radio Mishary Alafasi",
      url: "https://backup.qurango.net/radio/mishary_alafasi",
      category: "reciter",
    }
    expect(
      resolveStationArtUrl({ station: alafasiStation, author: "Mishary Alafasi", config }),
    ).toBe(`file://${authorPng}`)

    // Multi-reciter station switches dynamically to author override when live reciter matches
    const mixStation: Station = {
      id: "108",
      nameEn: "Main Radio",
      rawNameEn: "-Main Radio-",
      url: "https://backup.qurango.net/radio/mix",
      category: "thematic",
    }
    expect(
      resolveStationArtUrl({ station: mixStation, author: "Mishary Alafasi", config }),
    ).toBe(`file://${authorPng}`)
    expect(
      resolveStationArtUrl({ station: mixStation, author: "Unknown Reciter", config }),
    ).toBe(`file://${stationPng}`)

    const customStation: Station = {
      id: "custom-1",
      nameEn: "Masjid",
      rawNameEn: "Masjid",
      url: "https://stream.example.com/live",
      category: "custom",
      image: customPng,
    }
    expect(resolveStationArtUrl({ station: customStation, config })).toBe(`file://${customPng}`)

    // Missing config falls back to bundled PNG assets cleanly
    const emptyPaths = makeTempPaths()
    const bundledOnly = loadImageConfig(emptyPaths)
    const fallbackArt = resolveStationArtUrl({ station: mixStation, config: bundledOnly })
    expect(fallbackArt.startsWith("file://")).toBe(true)
    expect(DEFAULT_ARTWORK_URI.startsWith("file://")).toBe(true)

    // Reattached clients preserve explicit daemon station-art when local station object is absent
    expect(
      resolveStationArtUrl({
        station: null,
        author: "Mishary Alafasi",
        fallbackUri: `file://${customPng}`,
        config: bundledOnly,
      }),
    ).toBe(`file://${customPng}`)
  })
})
