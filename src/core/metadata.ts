export interface RepairedTextResult {
  text: string
  corrupted: boolean
}

export interface ParsedLiveMetadata {
  trackTitle: string | null
  author: string | null
  metadata: string | null
  corrupted: boolean
}

// Reverse mapping from Windows-1252 printable U+0152..U+2122 characters back to raw C1 bytes (0x80-0x9F).
const CP1252_REVERSE: ReadonlyMap<number, number> = new Map([
  [0x20ac, 0x80],
  [0x201a, 0x82],
  [0x0192, 0x83],
  [0x201e, 0x84],
  [0x2026, 0x85],
  [0x2020, 0x86],
  [0x2021, 0x87],
  [0x02c6, 0x88],
  [0x2030, 0x89],
  [0x0160, 0x8a],
  [0x2039, 0x8b],
  [0x0152, 0x8c],
  [0x017d, 0x8e],
  [0x2018, 0x91],
  [0x2019, 0x92],
  [0x201c, 0x93],
  [0x201d, 0x94],
  [0x2022, 0x95],
  [0x2013, 0x96],
  [0x2014, 0x97],
  [0x02dc, 0x98],
  [0x2122, 0x99],
  [0x0161, 0x9a],
  [0x203a, 0x9b],
  [0x0153, 0x9c],
  [0x017e, 0x9e],
  [0x0178, 0x9f],
])

const win1256Decoder = new TextDecoder("windows-1256")
const strictUtf8Decoder = new TextDecoder("utf-8", { fatal: true })

const LOST_DOUBLE_UTF8_PAIR = /[\u00D8-\u00DB]\?/
const DOUBLE_UTF8_CLUSTER = /[\u00D8-\u00DB][\u0080-\u00BF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/
const ARABIC_LETTER_RE = /[\u0621-\u064A\u0671]/g
const CP1256_INDICATOR_RE = /[\u00C1-\u00DA\u00DC-\u00FA]{2,}/

function stripControlChars(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F]/g, " ")
}

function finalizeCleanText(text: string): string {
  // Replace remaining typographic soft hyphens (e.g. "Ta\u00ADHa", "Al\u00ADAhzab") with ASCII hyphen.
  return stripControlChars(text)
    .replace(/\u00AD/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

function stringToByteArray(input: string): Uint8Array | null {
  const bytes = new Uint8Array(input.length)
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i)
    if (code <= 0xff) {
      bytes[i] = code
      continue
    }
    const mapped = CP1252_REVERSE.get(code)
    if (mapped !== undefined) {
      bytes[i] = mapped
      continue
    }
    return null
  }
  return bytes
}

function tryDecodeDoubleUtf8Segment(segment: string): string | null {
  const bytes = stringToByteArray(segment)
  if (!bytes) return null
  try {
    const decoded = strictUtf8Decoder.decode(bytes)
    if (decoded !== segment && /[\u0600-\u06FF]/.test(decoded)) {
      return decoded
    }
  } catch {
    return null
  }
  return null
}

function repairDoubleUtf8(input: string): string {
  // Decode mixed segments whose chars all map back to Latin-1/Windows-1252 single bytes.
  return input.replace(/[\x20-\xFF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]+/g, (chunk) => {
    if (!DOUBLE_UTF8_CLUSTER.test(chunk)) return chunk
    return tryDecodeDoubleUtf8Segment(chunk) ?? chunk
  })
}

function repairCp1256Mojibake(input: string): string {
  // Repair Windows-1256 words that were decoded byte-for-byte as ISO-8859-1.
  return input.replace(/[^\s]+/g, (token) => {
    if (!CP1256_INDICATOR_RE.test(token)) return token
    const bytes = new Uint8Array(token.length)
    let extendedCount = 0
    for (let i = 0; i < token.length; i++) {
      const code = token.charCodeAt(i)
      if (code <= 0xff) {
        bytes[i] = code
        if (code >= 0x80) extendedCount++
      } else {
        const mapped = CP1252_REVERSE.get(code)
        if (mapped === undefined) return token
        bytes[i] = mapped
        extendedCount++
      }
    }
    const decoded = win1256Decoder.decode(bytes)
    if (decoded.includes("\uFFFD")) return token
    const arabicMatches = decoded.match(ARABIC_LETTER_RE)
    if (!arabicMatches || arabicMatches.length < 2) return token
    if (arabicMatches.length < Math.ceil(extendedCount * 0.6)) return token
    return decoded
  })
}

/**
 * Repair Shoutcast/Icecast mojibake (CP1256-as-Latin-1 and double-UTF-8) while detecting
 * irrecoverably damaged streams where the upstream server dropped UTF-8 trail bytes to `?`.
 */
export function repairStreamText(raw: string): RepairedTextResult {
  if (!raw || typeof raw !== "string") {
    return { text: "", corrupted: false }
  }
  if (raw.includes("\uFFFD")) {
    return { text: "", corrupted: true }
  }

  let candidate = raw
  if (DOUBLE_UTF8_CLUSTER.test(candidate)) {
    candidate = repairDoubleUtf8(candidate)
  }

  // Catch unrecoverable server-damaged UTF-8 like Salma ("Ù?Ø­Ù?Ø¯") or remaining Ø?/Ù? pairs.
  if (
    LOST_DOUBLE_UTF8_PAIR.test(raw) ||
    LOST_DOUBLE_UTF8_PAIR.test(candidate) ||
    DOUBLE_UTF8_CLUSTER.test(candidate)
  ) {
    return { text: "", corrupted: true }
  }

  if (CP1256_INDICATOR_RE.test(candidate)) {
    candidate = repairCp1256Mojibake(candidate)
  }

  if (candidate.includes("\uFFFD") || CP1256_INDICATOR_RE.test(candidate)) {
    return { text: "", corrupted: true }
  }

  const cleaned = finalizeCleanText(candidate)
  return { text: cleaned, corrupted: false }
}

function urlBasenameSlug(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const pathname = new URL(url).pathname
    const seg = pathname.split("/").filter(Boolean).pop()
    return seg ? seg.toLowerCase() : null
  } catch {
    return null
  }
}

function isUrlSlugPlaceholder(
  value: string,
  stationUrl: string | null | undefined,
): boolean {
  const slug = urlBasenameSlug(stationUrl)
  if (!slug) return false
  const clean = value.trim().toLowerCase()
  return clean === slug || clean === decodeURIComponent(slug)
}

/** Split `<Reciter/Author> - <Chapter/Verse/Details>` on the first delimiter when informative. */
export function splitAuthorAndTitle(
  cleanTag: string,
  fallbackAuthor: string | null = null,
): { author: string | null; trackTitle: string } {
  const match = cleanTag.match(/^(.+?)\s+-\s+(.+)$/)
  if (match) {
    const left = match[1]?.trim() ?? ""
    const right = match[2]?.trim() ?? ""
    if (left && right) {
      return { author: left, trackTitle: right }
    }
  }
  return { author: fallbackAuthor, trackTitle: cleanTag }
}

/** Parse live ICY/demuxer metadata into clean chapter title, author, and TUI metadata line. */
export function parseLiveStreamMetadata(input: {
  metadataRaw: Record<string, unknown> | null
  mediaTitle: string | null
  forcedTitle?: string | null
  stationName?: string | null
  stationAuthor?: string | null
  stationUrl?: string | null
}): ParsedLiveMetadata {
  let rawIcyTitle = ""
  let rawTitle = ""
  let rawArtist = ""

  if (input.metadataRaw) {
    for (const [k, v] of Object.entries(input.metadataRaw)) {
      if (typeof v !== "string") continue
      const val = v.trim()
      if (!val) continue
      const key = k.toLowerCase()
      if (key === "icy-title") rawIcyTitle = val
      else if (key === "title") rawTitle = val
      else if (key === "artist") rawArtist = val
    }
  }

  let candidate = rawIcyTitle || rawTitle
  if (!candidate && input.mediaTitle) {
    const mt = input.mediaTitle.trim()
    if (
      mt &&
      mt !== input.forcedTitle &&
      !mt.endsWith(" — Quraa") &&
      !isUrlSlugPlaceholder(mt, input.stationUrl)
    ) {
      candidate = mt
    }
  }

  if (!candidate || candidate === input.forcedTitle) {
    return {
      trackTitle: null,
      author: input.stationAuthor ?? null,
      metadata: null,
      corrupted: false,
    }
  }

  const repairedCandidate = repairStreamText(candidate)
  if (repairedCandidate.corrupted || !repairedCandidate.text) {
    return {
      trackTitle: null,
      author: input.stationAuthor ?? null,
      metadata: null,
      corrupted: repairedCandidate.corrupted,
    }
  }

  const repairedArtist = rawArtist ? repairStreamText(rawArtist) : null
  const explicitArtist =
    repairedArtist && !repairedArtist.corrupted && repairedArtist.text
      ? repairedArtist.text
      : null

  if (explicitArtist) {
    const trackTitle = repairedCandidate.text
    const metadata = trackTitle.includes(explicitArtist)
      ? trackTitle
      : `${explicitArtist} — ${trackTitle}`
    return {
      trackTitle,
      author: explicitArtist,
      metadata,
      corrupted: false,
    }
  }

  const split = splitAuthorAndTitle(repairedCandidate.text, input.stationAuthor ?? null)
  return {
    trackTitle: split.trackTitle,
    author: split.author,
    metadata: repairedCandidate.text,
    corrupted: false,
  }
}

/** Extract concise clean metadata display string (retaining backwards-compatible helper signature). */
export function extractMetadataText(
  metadata: Record<string, unknown> | null,
  mediaTitle: string | null,
  forcedTitle: string | null,
): string | null {
  return parseLiveStreamMetadata({
    metadataRaw: metadata,
    mediaTitle,
    forcedTitle,
  }).metadata
}
