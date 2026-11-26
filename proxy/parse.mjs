// Transcript -> draft order parsing (Indonesian + English).
// No network, no secrets. Pure function, unit-testable.

const COINS = {
  btc: 'BTC',
  bitcoin: 'BTC',
  eth: 'ETH',
  ethereum: 'ETH',
}

const WORD_NUM = {
  nol: 0, satu: 1, dua: 2, tiga: 3, empat: 4, lima: 5,
  enam: 6, tujuh: 7, delapan: 8, sembilan: 9, sepuluh: 10,
  sebelas: 11, duabelas: 12,
}

// "nol koma nol satu" -> 0.01 ; "satu koma lima" -> 1.5 ; "dua" -> 2
function wordsToNumber(words) {
  const nums = []
  let i = 0
  while (i < words.length) {
    const w = words[i]
    if (w === 'koma' || w === 'point' || w === 'dot') {
      nums.push('.')
      i += 1
      continue
    }
    if (w in WORD_NUM) {
      nums.push(String(WORD_NUM[w]))
      i += 1
      continue
    }
    if (/^\d+$/.test(w)) {
      nums.push(w)
      i += 1
      continue
    }
    break
  }
  if (nums.length === 0) return null
  // Join: integer part digits then optional '.' then fraction digits.
  let out = ''
  let seenDot = false
  for (const t of nums) {
    if (t === '.') {
      if (seenDot) break
      seenDot = true
      out += '.'
    } else {
      out += t
    }
  }
  const n = Number(out)
  return Number.isFinite(n) ? n : null
}

function findSize(words) {
  // 1) digit forms: "0,01" (Indonesian decimal comma), "0.01", "0,5"
  for (const w of words) {
    const m = w.match(/^(\d+)[.,](\d+)$/)
    if (m) return Number(`${m[1]}.${m[2]}`)
    if (/^\d+$/.test(w)) {
      const n = Number(w)
      if (n > 0 && n < 1000) return n
    }
  }
  // 2) number words, e.g. "nol koma nol satu"
  for (let i = 0; i < words.length; i++) {
    const n = wordsToNumber(words.slice(i))
    if (n !== null && n > 0) return n
  }
  return null
}

// Levenshtein distance (small words only; STT often mishears one letter).
function lev(a, b) {
  const m = a.length
  const n = b.length
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return d[m][n]
}

function fuzzyWord(words, targets, maxDist = 2) {
  for (const w of words) {
    if (targets.includes(w)) return w
  }
  for (const w of words) {
    if (w.length >= 4 && targets.some((t) => lev(w, t) <= maxDist)) return w
  }
  return null
}

export function parseDraft(transcript) {
  const text = String(transcript || '').toLowerCase()
  // Strip punctuation except , . (kept for decimals), split on whitespace.
  const cleaned = text.replace(/[^a-z0-9,.\s]/g, ' ')
  const words = cleaned.split(/\s+/).filter(Boolean)

  let side = null
  if (fuzzyWord(words, ['beli', 'buy', 'long', 'ambil'])) side = 'buy'
  else if (fuzzyWord(words, ['jual', 'sell', 'short'])) side = 'sell'

  let coin = null
  for (const w of words) {
    if (w in COINS) {
      coin = COINS[w]
      break
    }
  }

  const size = findSize(words)
  const defaults = { ETH: 0.01, BTC: 0.001 }

  if (!side) return { ok: false, error: 'side not recognized (say beli/jual)' }
  if (!coin) return { ok: false, error: 'coin not recognized (say BTC/ETH)' }
  return {
    ok: true,
    coin,
    side,
    size: size ?? defaults[coin],
    sizeDefaulted: size === null,
  }
}
