import type { AppLanguage } from "./types.ts"

// Contextual glyph forms: [isolated, final, initial?, medial?]
type ShapingForms =
  | readonly [string, string]
  | readonly [string, string, string, string]

const ARABIC_SHAPING_MAP: ReadonlyMap<number, ShapingForms> = new Map([
  [0x0621, ["\uFE80", "\uFE80"]], // Hamza
  [0x0622, ["\uFE81", "\uFE82"]], // Alef Madda
  [0x0623, ["\uFE83", "\uFE84"]], // Alef Hamza Above
  [0x0624, ["\uFE85", "\uFE86"]], // Waw Hamza
  [0x0625, ["\uFE87", "\uFE88"]], // Alef Hamza Below
  [0x0626, ["\uFE89", "\uFE8A", "\uFE8B", "\uFE8C"]], // Yeh Hamza
  [0x0627, ["\uFE8D", "\uFE8E"]], // Alef
  [0x0628, ["\uFE8F", "\uFE90", "\uFE91", "\uFE92"]], // Beh
  [0x0629, ["\uFE93", "\uFE94"]], // Teh Marbuta
  [0x062a, ["\uFE95", "\uFE96", "\uFE97", "\uFE98"]], // Teh
  [0x062b, ["\uFE99", "\uFE9A", "\uFE9B", "\uFE9C"]], // Theh
  [0x062c, ["\uFE9D", "\uFE9E", "\uFE9F", "\uFEA0"]], // Jeem
  [0x062d, ["\uFEA1", "\uFEA2", "\uFEA3", "\uFEA4"]], // Hah
  [0x062e, ["\uFEA5", "\uFEA6", "\uFEA7", "\uFEA8"]], // Khah
  [0x062f, ["\uFEA9", "\uFEAA"]], // Dal
  [0x0630, ["\uFEAB", "\uFEAC"]], // Thal
  [0x0631, ["\uFEAD", "\uFEAE"]], // Reh
  [0x0632, ["\uFEAF", "\uFEB0"]], // Zain
  [0x0633, ["\uFEB1", "\uFEB2", "\uFEB3", "\uFEB4"]], // Seen
  [0x0634, ["\uFEB5", "\uFEB6", "\uFEB7", "\uFEB8"]], // Sheen
  [0x0635, ["\uFEB9", "\uFEBA", "\uFEBB", "\uFEBC"]], // Sad
  [0x0636, ["\uFEBD", "\uFEBE", "\uFEBF", "\uFEC0"]], // Dad
  [0x0637, ["\uFEC1", "\uFEC2", "\uFEC3", "\uFEC4"]], // Tah
  [0x0638, ["\uFEC5", "\uFEC6", "\uFEC7", "\uFEC8"]], // Zah
  [0x0639, ["\uFEC9", "\uFECA", "\uFECB", "\uFECC"]], // Ain
  [0x063a, ["\uFECD", "\uFECE", "\uFECF", "\uFED0"]], // Ghain
  [0x0640, ["\u0640", "\u0640", "\u0640", "\u0640"]], // Tatweel
  [0x0641, ["\uFED1", "\uFED2", "\uFED3", "\uFED4"]], // Feh
  [0x0642, ["\uFED5", "\uFED6", "\uFED7", "\uFED8"]], // Qaf
  [0x0643, ["\uFED9", "\uFEDA", "\uFEDB", "\uFEDC"]], // Kaf
  [0x0644, ["\uFEDD", "\uFEDE", "\uFEDF", "\uFEE0"]], // Lam
  [0x0645, ["\uFEE1", "\uFEE2", "\uFEE3", "\uFEE4"]], // Meem
  [0x0646, ["\uFEE5", "\uFEE6", "\uFEE7", "\uFEE8"]], // Noon
  [0x0647, ["\uFEE9", "\uFEEA", "\uFEEB", "\uFEEC"]], // Heh
  [0x0648, ["\uFEED", "\uFEEE"]], // Waw
  [0x0649, ["\uFEEF", "\uFEF0"]], // Alef Maksura
  [0x064a, ["\uFEF1", "\uFEF2", "\uFEF3", "\uFEF4"]], // Yeh
  [0x0671, ["\uFB50", "\uFB51"]], // Alef Wasla
  [0x067e, ["\uFB56", "\uFB57", "\uFB58", "\uFB59"]], // Peh
  [0x0686, ["\uFB7A", "\uFB7B", "\uFB7C", "\uFB7D"]], // Tcheh
  [0x0698, ["\uFB8A", "\uFB8B"]], // Jeh
  [0x06a9, ["\uFB8E", "\uFB8F", "\uFB90", "\uFB91"]], // Keheh
  [0x06af, ["\uFB92", "\uFB93", "\uFB94", "\uFB95"]], // Gaf
  [0x06cc, ["\uFBFC", "\uFBFD", "\uFBFE", "\uFBFF"]], // Farsi Yeh
])

const LAM_ALEF_LIGATURES: ReadonlyMap<number, readonly [string, string]> = new Map([
  [0x0622, ["\uFEF5", "\uFEF6"]], // Lam + Alef Madda
  [0x0623, ["\uFEF7", "\uFEF8"]], // Lam + Alef Hamza Above
  [0x0625, ["\uFEF9", "\uFEFA"]], // Lam + Alef Hamza Below
  [0x0627, ["\uFEFB", "\uFEFC"]], // Lam + Alef
])

function isArabicDiacritic(code: number): boolean {
  return (code >= 0x064b && code <= 0x065f) || code === 0x0670 || (code >= 0x06d6 && code <= 0x06ed)
}

function connectsToNext(code: number): boolean {
  const forms = ARABIC_SHAPING_MAP.get(code)
  return Boolean(forms && forms.length === 4)
}

function connectsToPrev(code: number): boolean {
  return ARABIC_SHAPING_MAP.has(code)
}

/** Shape Arabic letters to contextual Presentation Forms-B & Lam-Alef ligatures. */
export function shapeArabicText(input: string): string {
  // Strip combining Arabic diacritics first so legacy fixed-grid terminals never shift column widths.
  const chars: string[] = []
  for (const ch of input) {
    if (!isArabicDiacritic(ch.charCodeAt(0))) {
      chars.push(ch)
    }
  }

  let out = ""
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i]!
    const code = ch.charCodeAt(0)
    const forms = ARABIC_SHAPING_MAP.get(code)
    if (!forms) {
      out += ch
      continue
    }

    const prevCode = i > 0 ? chars[i - 1]!.charCodeAt(0) : 0
    const prevConnects = i > 0 && connectsToNext(prevCode)

    // Handle mandatory Lam + Alef ligature as a single right-connecting glyph
    if (code === 0x0644 && i + 1 < chars.length) {
      const nextCode = chars[i + 1]!.charCodeAt(0)
      const lig = LAM_ALEF_LIGATURES.get(nextCode)
      if (lig) {
        out += prevConnects ? lig[1] : lig[0]
        i++
        continue
      }
    }

    const nextConnects =
      i + 1 < chars.length && connectsToPrev(chars[i + 1]!.charCodeAt(0))
    const canJoinNext = forms.length === 4 && nextConnects

    if (prevConnects && canJoinNext) {
      out += (forms as readonly [string, string, string, string])[3]
    } else if (prevConnects) {
      out += forms[1]
    } else if (canJoinNext) {
      out += (forms as readonly [string, string, string, string])[2]
    } else {
      out += forms[0]
    }
  }
  return out
}

type BidiType = "L" | "R" | "AL" | "EN" | "AN" | "ES" | "CS" | "ET" | "WS" | "ON"

const MIRROR_MAP: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  [")", "("],
  ["[", "]"],
  ["]", "["],
  ["{", "}"],
  ["}", "{"],
  ["<", ">"],
  [">", "<"],
  ["«", "»"],
  ["»", "«"],
])

function classifyBidi(ch: string): BidiType {
  const code = ch.charCodeAt(0)
  if ((code >= 0x0600 && code <= 0x06ff) || (code >= 0xfe70 && code <= 0xfefc) || (code >= 0xfb50 && code <= 0xfdff)) {
    if (code >= 0x0660 && code <= 0x0669) return "AN"
    if (code >= 0x06f0 && code <= 0x06f9) return "EN"
    if (code === 0x060c || code === 0x061b || code === 0x061f) return "ON"
    return "AL"
  }
  if (code >= 0x0590 && code <= 0x05ff) return "R"
  if (code >= 0x30 && code <= 0x39) return "EN"
  if (ch === "+" || ch === "-") return "ES"
  if (ch === "." || ch === "," || ch === ":" || ch === "/") return "CS"
  if (ch === "%" || ch === "$") return "ET"
  if (ch === " " || ch === "\t") return "WS"
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x00c0 && code <= 0x02ff)) {
    return "L"
  }
  if (MIRROR_MAP.has(ch) || /[!"#&'()*;<=>?@[\\\]^_`{|}~—–]/.test(ch)) {
    return "ON"
  }
  // Treat other non-punctuation Unicode letters as LTR strong chars
  if (/\p{L}/u.test(ch)) return "L"
  return "ON"
}

/**
 * Reorder Unicode characters from logical order into terminal visual left-to-right order
 * using UAX #9 implicit levels, weak/neutral resolution, run reversal, and bracket mirroring.
 */
export function bidiVisualOrder(input: string): string {
  const chars = Array.from(input)
  const n = chars.length
  if (n === 0) return input

  const types: BidiType[] = chars.map(classifyBidi)
  const hasRtl = types.some((t) => t === "R" || t === "AL")
  if (!hasRtl) return input

  // P2/P3: base paragraph level from first strong character
  let baseLevel = 0
  for (const t of types) {
    if (t === "L") {
      baseLevel = 0
      break
    }
    if (t === "R" || t === "AL") {
      baseLevel = 1
      break
    }
  }
  const sos: BidiType = baseLevel === 1 ? "R" : "L"

  // W2 / W3: resolve AL -> R and EN following AL -> AN
  let lastStrong: BidiType = sos
  for (let i = 0; i < n; i++) {
    if (types[i] === "AL") {
      types[i] = "R"
      lastStrong = "AL"
    } else if (types[i] === "L" || types[i] === "R") {
      lastStrong = types[i]!
    } else if (types[i] === "EN" && lastStrong === "AL") {
      types[i] = "AN"
    }
  }

  // W4: single separator between two identical number types
  for (let i = 1; i < n - 1; i++) {
    const prev = types[i - 1]!
    const next = types[i + 1]!
    if (types[i] === "ES" && prev === "EN" && next === "EN") {
      types[i] = "EN"
    } else if (types[i] === "CS" && prev === next && (prev === "EN" || prev === "AN")) {
      types[i] = prev
    }
  }

  // W5: terminators adjacent to EN
  for (let i = 0; i < n; i++) {
    if (types[i] !== "ET") continue
    if ((i > 0 && types[i - 1] === "EN") || (i + 1 < n && types[i + 1] === "EN")) {
      types[i] = "EN"
    }
  }

  // W6: remaining separators/terminators become ON
  for (let i = 0; i < n; i++) {
    if (types[i] === "ES" || types[i] === "CS" || types[i] === "ET") {
      types[i] = "ON"
    }
  }

  // W7: resolve EN to L when previous strong char was L (or base L)
  let strongSoFar: BidiType = sos
  for (let i = 0; i < n; i++) {
    if (types[i] === "L" || types[i] === "R") {
      strongSoFar = types[i]!
    } else if (types[i] === "EN" && strongSoFar === "L") {
      types[i] = "L"
    }
  }

  // N1 / N2: resolve spans of WS/ON against enclosing strong directions (with numbers treated as R)
  const strongForNeutral = (t: BidiType): "L" | "R" =>
    t === "R" || t === "EN" || t === "AN" ? "R" : "L"

  let i = 0
  while (i < n) {
    if (types[i] !== "WS" && types[i] !== "ON") {
      i++
      continue
    }
    const start = i
    while (i < n && (types[i] === "WS" || types[i] === "ON")) {
      i++
    }
    const prevDir = start > 0 ? strongForNeutral(types[start - 1]!) : sos
    const nextDir = i < n ? strongForNeutral(types[i]!) : sos
    const resolved: "L" | "R" = prevDir === nextDir ? prevDir : (sos as "L" | "R")
    for (let k = start; k < i; k++) {
      types[k] = resolved
    }
  }

  // I1 / I2: compute embedding levels
  const levels = new Array<number>(n)
  for (let k = 0; k < n; k++) {
    const t = types[k]!
    if (baseLevel === 0) {
      levels[k] = t === "R" ? 1 : t === "AN" || t === "EN" ? 2 : 0
    } else {
      levels[k] = t === "R" ? 1 : 2
    }
  }

  // L4: mirror glyphs when positioned on odd (RTL) level
  for (let k = 0; k < n; k++) {
    if ((levels[k]! & 1) === 1) {
      const mirrored = MIRROR_MAP.get(chars[k]!)
      if (mirrored) chars[k] = mirrored
    }
  }

  // L2: reverse contiguous runs from max level down to 1
  let maxLevel = 0
  for (const lvl of levels) {
    if (lvl > maxLevel) maxLevel = lvl
  }
  const indices = chars.map((_, idx) => idx)
  for (let lvl = maxLevel; lvl >= 1; lvl--) {
    let idx = 0
    while (idx < n) {
      if (levels[indices[idx]!]! < lvl) {
        idx++
        continue
      }
      const runStart = idx
      while (idx < n && levels[indices[idx]!]! >= lvl) {
        idx++
      }
      let lo = runStart
      let hi = idx - 1
      while (lo < hi) {
        const tmp = indices[lo]!
        indices[lo] = indices[hi]!
        indices[hi] = tmp
        lo++
        hi--
      }
    }
  }

  return indices.map((idx) => chars[idx]!).join("")
}

/** Convert logical UTF-8 Arabic/mixed text into visually ordered reshaped terminal output. */
export function formatArabicFixed(text: string): string {
  if (!text || !/[\u0600-\u06FF]/.test(text)) return text
  return bidiVisualOrder(shapeArabicText(text))
}

/** Format display text for the active language mode (`en`, `ar`, or `ar-fixed`). */
export function formatDisplayText(text: string, language: AppLanguage): string {
  if (language === "ar-fixed") {
    return formatArabicFixed(text)
  }
  return text
}
