import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  MenuContainerProperty,
  MenuItemProperty,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'

// HyperGlance — read path (Tue 24 Nov) + write path (Tue 24 Nov, pulled
// forward from Wed 25 Nov at Bozz's "gas") + alerts (Thu 26 Nov).
//
// Read path: live mark prices + account value/unrealized PnL + open positions
// from the Hyperliquid TESTNET info API (https://api.hyperliquid-testnet.xyz/info).
// Write path: voice order -> STT -> draft -> one-tap confirm -> market order
// on Hyperliquid TESTNET, via the localhost backend proxy
// (http://127.0.0.1:8899) which holds the testnet API wallet key + Groq
// Whisper server-side. The app NEVER sees a key. Drafts are always shown
// and explicitly confirmed by a tap — never auto-submitted.
// Alerts: price move >= 1% vs app-start baseline, or a position's mark
// within 5% of its liquidation price — alert screen + best-effort beep
// (the SDK exposes no speaker API). Menu "Test alert" is a labelled
// self-test, never a faked market event. Auto-refresh every 30 s in
// glance mode so alerts can fire without a tap.
// Testnet only, no mainnet URLs anywhere, no real money.
// The mock snapshot is a fallback ONLY when the API is unreachable, and it
// is always labelled MOCK DATA.

const API_URL = 'https://api.hyperliquid-testnet.xyz/info'
const PROXY_URL = 'http://127.0.0.1:8899'
const USER = '0xa24e39f1f1a8f18a6c2a34cff987c0591f200f7f'
const COINS = ['BTC', 'ETH'] as const
const FETCH_TIMEOUT_MS = 8000
const PROXY_TIMEOUT_MS = 30000
const RECORD_MS = 5000
const DIVIDER = '--------------------------'

const bridge = await waitForEvenAppBridge()

// ---- types (narrowed from the API's JSON) ----

interface MetaAsset {
  name: string
  szDecimals: number
}

interface Position {
  coin: string
  sizeNum: number
  szDecimals: number
  side: 'LONG' | 'SHORT'
  pnl: number
  liqPx?: number
}

interface LiveData {
  marks: Partial<Record<string, string>>
  accountValue: number
  positions: Position[]
  totalPnl: number
  fetchedAt: Date
}

interface Draft {
  coin: string
  side: 'buy' | 'sell'
  size: number
  sizeDefaulted: boolean
  transcript: string
}

type VoiceState =
  | 'glance'
  | 'voice'
  | 'recording'
  | 'transcribing'
  | 'draft'
  | 'ordering'
  | 'result'
  | 'notice'
  | 'alert'

// ---- fetch helpers ----

async function postJson(url: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) {
      // Surface the proxy's own error message (e.g. "account not funded:
      // deposit test USDC first") instead of a bare HTTP code.
      let detail = ''
      try {
        const errBody = asRecord(await res.json())
        if (typeof errBody.error === 'string') detail = errBody.error
      } catch {
        // Non-JSON error body — fall through to the bare status.
      }
      throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`)
    }
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

async function postInfo(body: unknown): Promise<unknown> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`HL info HTTP ${res.status}`)
    return (await res.json()) as unknown
  } finally {
    clearTimeout(timer)
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new Error('HL: expected JSON object')
  }
  return v as Record<string, unknown>
}

async function fetchLive(): Promise<LiveData> {
  const [metaRaw, midsRaw, stateRaw] = await Promise.all([
    postInfo({ type: 'meta' }),
    postInfo({ type: 'allMids' }),
    postInfo({ type: 'clearinghouseState', user: USER }),
  ])

  // Resolve coin names from `meta` — perp asset IDs differ between testnet
  // (BTC = 3) and mainnet (BTC = 0), so never hardcode an index.
  const universe = asRecord(metaRaw).universe
  if (!Array.isArray(universe)) throw new Error('HL: meta.universe missing')
  const metaByName = new Map<string, MetaAsset>()
  universe.forEach((u, i) => {
    const r = asRecord(u)
    if (typeof r.name === 'string' && typeof r.szDecimals === 'number') {
      metaByName.set(r.name, { name: r.name, szDecimals: r.szDecimals })
      if ((COINS as readonly string[]).includes(r.name)) {
        console.log(`HL meta: ${r.name} index ${i} szDecimals ${r.szDecimals}`)
      }
    }
  })
  const mids = asRecord(midsRaw)
  for (const coin of COINS) {
    if (!metaByName.has(coin) || typeof mids[coin] !== 'string') {
      throw new Error(`HL: ${coin} missing from meta/mids`)
    }
  }

  const state = asRecord(stateRaw)
  const margin = asRecord(state.marginSummary)
  const accountValue = Number(margin.accountValue ?? '0')
  if (!Number.isFinite(accountValue)) throw new Error('HL: bad accountValue')

  const positions: Position[] = []
  let totalPnl = 0
  const assetPositions = state.assetPositions
  if (Array.isArray(assetPositions)) {
    for (const ap of assetPositions) {
      const pos = asRecord(asRecord(ap).position)
      const coin = pos.coin
      const szi = pos.szi
      const pnl = pos.unrealizedPnl
      if (typeof coin !== 'string' || typeof szi !== 'string' || typeof pnl !== 'string') continue
      const size = Number(szi)
      const pnlNum = Number(pnl)
      if (!Number.isFinite(size) || !Number.isFinite(pnlNum) || size === 0) continue
      totalPnl += pnlNum
      // liquidationPx is present in clearinghouseState positions; parsed
      // for the liquidation-proximity alert (absent = no liq alert).
      const liqRaw = pos.liquidationPx
      const liqNum = typeof liqRaw === 'string' ? Number(liqRaw) : NaN
      positions.push({
        coin,
        sizeNum: Math.abs(size),
        szDecimals: metaByName.get(coin)?.szDecimals ?? 4,
        side: size > 0 ? 'LONG' : 'SHORT',
        pnl: pnlNum,
        ...(Number.isFinite(liqNum) && liqNum > 0 ? { liqPx: liqNum } : {}),
      })
    }
  }

  const marks: Partial<Record<string, string>> = {}
  for (const coin of COINS) marks[coin] = mids[coin] as string

  console.log(
    `HL live: BTC ${marks.BTC} ETH ${marks.ETH} acct ${accountValue} pos ${positions.length}`,
  )
  return { marks, accountValue, positions, totalPnl, fetchedAt: new Date() }
}

// ---- formatting ----

function fmtUsd(n: number): string {
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtSignedUsd(n: number): string {
  return (n < 0 ? '-' : '+') + fmtUsd(Math.abs(n))
}

function fmtSize(absSize: number, decimals: number): string {
  const s = absSize.toFixed(Math.min(Math.max(decimals, 0), 4))
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s
}

function hhmm(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

function trunc(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 3) + '...'
}

// ---- screen content (max 9 lines) ----

function loadingContent(): string {
  return ['HYPERGLANCE · HL TESTNET', DIVIDER, 'Loading live data...'].join('\n')
}

function positionLine(p: Position): string {
  for (const dec of [4, 2, 0]) {
    const line = `${p.coin} ${fmtSize(p.sizeNum, dec)} ${p.side} ${fmtSignedUsd(p.pnl)}`
    if (line.length <= 26) return line
  }
  return `${p.coin} ${p.side} ${fmtSignedUsd(p.pnl)}`
}

function liveContent(data: LiveData, taps: number): string {
  const lines = [
    'HYPERGLANCE · HL TESTNET',
    DIVIDER,
    `BTC-PERP ${fmtUsd(Number(data.marks.BTC ?? '0'))}`,
    `ETH-PERP ${fmtUsd(Number(data.marks.ETH ?? '0'))}`,
    DIVIDER,
    `ACCT ${fmtUsd(data.accountValue)} · uPnL ${fmtSignedUsd(data.totalPnl)}`,
  ]
  // Positions area: max 2 lines, then the footer — 9 lines total, always.
  const pos = data.positions
  const liveTag = `LIVE ${hhmm(data.fetchedAt)}`
  if (pos.length === 0) {
    lines.push('NO POSITIONS')
    lines.push(`${liveTag} · tap=refresh`)
    lines.push(`Taps: ${taps} · 2x tap = exit`)
  } else if (pos.length === 1) {
    lines.push(positionLine(pos[0]))
    lines.push(`${liveTag} · tap=refresh`)
    lines.push(`Taps: ${taps} · 2x tap = exit`)
  } else if (pos.length === 2) {
    lines.push(positionLine(pos[0]))
    lines.push(positionLine(pos[1]))
    lines.push(`${liveTag} · Taps: ${taps}`)
  } else {
    lines.push(positionLine(pos[0]))
    lines.push(`+${pos.length - 1} more positions`)
    lines.push(`${liveTag} · Taps: ${taps}`)
  }
  // An acknowledged alert stays visible as a one-line banner until its
  // condition clears (footer line is replaced, total stays 9 lines).
  if (activeAlert) {
    lines[lines.length - 1] = `ALERT ${trunc(activeAlert.summary, 19)}`
  }
  return lines.join('\n')
}

// Mock snapshot — fallback ONLY when the API is unreachable, always labelled.
const MOCK_SNAPSHOTS = [
  { eth: '+$12.40', btc: '-$3.10' },
  { eth: '+$12.95', btc: '-$2.75' },
]

function mockContent(snapshot: number, taps: number): string {
  const m = MOCK_SNAPSHOTS[snapshot % MOCK_SNAPSHOTS.length]
  return [
    'HYPERGLANCE · HL TESTNET',
    DIVIDER,
    `ETH-PERP   ${m.eth}`,
    `BTC-PERP   ${m.btc}`,
    DIVIDER,
    'MOCK DATA · tap = refresh',
    `Taps: ${taps} · 2x tap = exit`,
  ].join('\n')
}

function voiceIdleContent(): string {
  return [
    'VOICE ORDER · HL TESTNET',
    DIVIDER,
    'Tap to record (5s)',
    'Say: "beli 0,01 ETH"',
    'or menu > Demo voice',
    DIVIDER,
    'tap=record',
    'menu=demo · back',
  ].join('\n')
}

function recordingContent(elapsedMs: number): string {
  return [
    'VOICE ORDER · HL TESTNET',
    DIVIDER,
    `RECORDING... ${Math.floor(elapsedMs / 1000)}s`,
    'Speak now',
    DIVIDER,
    'auto-stops at 5s',
  ].join('\n')
}

function transcribingContent(): string {
  return ['VOICE ORDER · HL TESTNET', DIVIDER, 'Transcribing...'].join('\n')
}

function draftContent(d: Draft): string {
  const mid = live?.marks[d.coin] ? Number(live.marks[d.coin]) : NaN
  const midLine = Number.isFinite(mid) ? `Market ~${fmtUsd(mid)}` : 'Market order'
  const estLine = Number.isFinite(mid)
    ? `Est. value ~${fmtUsd(mid * d.size)}${d.sizeDefaulted ? ' *' : ''}`
    : 'Est. value n/a'
  return [
    'DRAFT ORDER',
    DIVIDER,
    `${d.side === 'buy' ? 'BUY' : 'SELL'} ${fmtSize(d.size, 4)} ${d.coin}-PERP`,
    midLine,
    estLine,
    `"${trunc(d.transcript, 22)}"`,
    DIVIDER,
    'tap=CONFIRM',
    'menu > Back = cancel',
  ].join('\n')
}

function orderingContent(d: Draft): string {
  return [
    'DRAFT ORDER',
    DIVIDER,
    'Submitting...',
    `${d.side === 'buy' ? 'BUY' : 'SELL'} ${fmtSize(d.size, 4)} ${d.coin}-PERP`,
  ].join('\n')
}

function resultContent(ok: boolean, lines: string[]): string {
  return [ok ? 'ORDER FILLED' : 'ORDER FAILED', DIVIDER, ...lines, DIVIDER, 'tap=glance'].join('\n')
}

function noticeContent(title: string, lines: string[], footer: string): string {
  return [title, DIVIDER, ...lines, DIVIDER, footer].join('\n')
}

// ---- alerts (Thu 26 Nov) ----
// Two honest alert sources, both computed from live data only:
//   1. Price move: a coin's mark moves >= 1% vs the price at app start
//      (baseline = first successful live fetch). Latched per coin+direction
//      until the move falls back under 0.5%, so it fires once per move.
//   2. Liquidation proximity: a position's mark comes within 5% of its
//      liquidation price (liquidationPx from clearinghouseState).
// No alert ever fires from mock data. A menu "Test alert" shows the alert
// screen labelled TEST so the display + sound can be checked without
// faking a market event.
// Sound: the Even SDK exposes no speaker API, so the beep is a best-effort
// WebAudio tone in the page (may only sound on the phone companion); the
// on-glasses alert is the visual screen, which always works.

const ALERT_PRICE_PCT = 1.0
const ALERT_PRICE_CLEAR_PCT = 0.5
const ALERT_LIQ_PCT = 5.0
const ALERT_LIQ_CLEAR_PCT = 10.0

interface AlertInfo {
  kind: 'price' | 'liq' | 'test'
  coin: string
  summary: string
  lines: string[]
}

let baseline: Partial<Record<string, number>> | null = null
let alertLatched = new Set<string>()
let activeAlert: AlertInfo | null = null
let alertScreen: AlertInfo | null = null

function beep(): void {
  try {
    const Ctx =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const now = ctx.currentTime
    for (const t of [0, 0.22]) {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'square'
      osc.frequency.value = 880
      gain.gain.setValueAtTime(0.12, now + t)
      gain.gain.exponentialRampToValueAtTime(0.001, now + t + 0.15)
      osc.connect(gain)
      gain.connect(ctx.destination)
      osc.start(now + t)
      osc.stop(now + t + 0.16)
    }
    setTimeout(() => void ctx.close().catch(() => undefined), 800)
  } catch {
    // No audio output available in this WebView — the visual alert still shows.
  }
}

function alertContent(a: AlertInfo): string {
  const title =
    a.kind === 'test' ? 'TEST ALERT' : a.kind === 'liq' ? '!!! LIQ RISK !!!' : '!!! PRICE ALERT !!!'
  return [title, DIVIDER, ...a.lines, DIVIDER, 'tap=acknowledge'].join('\n')
}

function evaluateAlerts(data: LiveData): void {
  if (baseline === null) {
    baseline = {}
    for (const coin of COINS) {
      const m = Number(data.marks[coin] ?? 'NaN')
      if (Number.isFinite(m) && m > 0) baseline[coin] = m
    }
    return
  }
  let fired: AlertInfo | null = null
  // 1. Price move vs baseline.
  for (const coin of COINS) {
    const base = baseline[coin]
    const now = Number(data.marks[coin] ?? 'NaN')
    if (!base || !Number.isFinite(now) || now <= 0) continue
    const pct = ((now - base) / base) * 100
    const dir = pct >= 0 ? 'up' : 'down'
    const key = `${coin}:${dir}`
    if (Math.abs(pct) >= ALERT_PRICE_PCT) {
      if (!alertLatched.has(key)) {
        alertLatched.add(key)
        fired = {
          kind: 'price',
          coin,
          summary: `${coin} ${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`,
          lines: [
            `${coin} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs start`,
            `now ${fmtUsd(now)}`,
            `was ${fmtUsd(base)}`,
          ],
        }
      }
    } else if (Math.abs(pct) < ALERT_PRICE_CLEAR_PCT) {
      alertLatched.delete(key)
    }
  }
  // 2. Liquidation proximity (only when a position exists).
  for (const p of data.positions) {
    if (!p.liqPx) continue
    const mark = Number(data.marks[p.coin] ?? 'NaN')
    if (!Number.isFinite(mark) || mark <= 0) continue
    const distPct = (Math.abs(mark - p.liqPx) / p.liqPx) * 100
    const key = `${p.coin}:liq`
    if (distPct <= ALERT_LIQ_PCT) {
      if (!alertLatched.has(key)) {
        alertLatched.add(key)
        fired = {
          kind: 'liq',
          coin: p.coin,
          summary: `${p.coin} LIQ ${distPct.toFixed(1)}%`,
          lines: [
            `${p.coin} ${p.side} ${fmtSize(p.sizeNum, 4)}`,
            `mark ${fmtUsd(mark)}`,
            `liq ${fmtUsd(p.liqPx)} (${distPct.toFixed(1)}% away)`,
          ],
        }
      }
    } else if (distPct > ALERT_LIQ_CLEAR_PCT) {
      alertLatched.delete(key)
    }
  }
  if (fired) {
    activeAlert = fired
    // Interrupt only the glance screen — never a voice/draft flow.
    if (voice === 'glance') {
      alertScreen = fired
      voice = 'alert'
      beep()
      console.log(`ALERT fired: ${fired.summary}`)
      upgrade()
    } else {
      console.log(`ALERT latched (not interrupting ${voice}): ${fired.summary}`)
    }
  } else if (activeAlert && alertLatched.size === 0) {
    activeAlert = null
  }
}

function showTestAlert(): void {
  alertScreen = {
    kind: 'test',
    coin: '—',
    summary: 'TEST',
    lines: ['Alert display + sound', 'This is a self-test', 'No market event'],
  }
  voice = 'alert'
  beep()
  console.log('ALERT test shown')
  upgrade()
}

// ---- state + render ----

let mode: 'loading' | 'live' | 'mock' = 'loading'
let live: LiveData | null = null
let snapshot = 0
let taps = 0
let refreshSeq = 0

let voice: VoiceState = 'glance'
let draft: Draft | null = null
let notice: { title: string; lines: string[]; footer: string } | null = null
let resultLines: string[] = []
let resultOk = false
let recordStartMs = 0
let recordTimer: ReturnType<typeof setTimeout> | null = null
let audioChunks: Uint8Array[] = []
let lastMenuClickAt = 0

function currentContent(): string {
  if (voice === 'glance') {
    if (mode === 'live' && live) return liveContent(live, taps)
    if (mode === 'mock') return mockContent(snapshot, taps)
    return loadingContent()
  }
  if (voice === 'alert' && alertScreen) return alertContent(alertScreen)
  if (voice === 'voice') return voiceIdleContent()
  if (voice === 'recording') return recordingContent(Date.now() - recordStartMs)
  if (voice === 'transcribing') return transcribingContent()
  if (voice === 'draft' && draft) return draftContent(draft)
  if (voice === 'ordering' && draft) return orderingContent(draft)
  if (voice === 'result') return resultContent(resultOk, resultLines)
  if (voice === 'notice' && notice) return noticeContent(notice.title, notice.lines, notice.footer)
  return voiceIdleContent()
}

function upgrade(): void {
  void bridge.textContainerUpgrade(
    new TextContainerUpgrade({
      containerID: 1,
      containerName: 'main',
      content: currentContent(),
    }),
  )
}

async function refresh(): Promise<void> {
  const mySeq = ++refreshSeq
  mode = 'loading'
  if (voice === 'glance') upgrade()
  try {
    const data = await fetchLive()
    if (mySeq !== refreshSeq) return // a newer tap superseded this fetch
    live = data
    mode = 'live'
    evaluateAlerts(data)
  } catch (err) {
    if (mySeq !== refreshSeq) return
    console.log('HL fetch failed, mock fallback:', err instanceof Error ? err.message : String(err))
    mode = 'mock'
    snapshot += 1
  }
  if (voice === 'glance') upgrade()
}

// ---- voice flow ----

function showNotice(title: string, lines: string[], footer: string): void {
  notice = { title, lines, footer }
  voice = 'notice'
  upgrade()
}

function stopRecordingTimer(): void {
  if (recordTimer !== null) {
    clearTimeout(recordTimer)
    recordTimer = null
  }
}

async function stopRecording(): Promise<void> {
  if (voice !== 'recording') return
  stopRecordingTimer()
  voice = 'transcribing'
  upgrade()
  await bridge.audioControl(false).catch(() => undefined)
  // Concatenate PCM frames (signed 16-bit LE, 16 kHz mono).
  let total = 0
  for (const c of audioChunks) total += c.length
  const pcm = new Uint8Array(total)
  let off = 0
  for (const c of audioChunks) {
    pcm.set(c, off)
    off += c.length
  }
  console.log(`VOICE frames=${audioChunks.length} pcmBytes=${total}`)
  // Silence check: simulator emits silence (no host mic); real speech has
  // samples in the thousands. Skip the STT call on pure silence.
  let maxAbs = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.abs(new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength).getInt16(i, true))
    if (v > maxAbs) maxAbs = v
  }
  if (total === 0 || maxAbs < 50) {
    showNotice('VOICE ORDER · HL TESTNET', ['No speech heard', 'Tap to try again', 'or menu > Demo voice'], 'tap=retry')
    return
  }
  await transcribePcm(pcm)
}

async function startRecording(): Promise<void> {
  audioChunks = []
  voice = 'recording'
  recordStartMs = Date.now()
  upgrade()
  const okGlasses = await bridge.audioControl(true, AudioInputSource.Glasses).catch(() => false)
  console.log('VOICE audioControl glasses:', okGlasses)
  let ok = okGlasses
  if (!ok) {
    // Fallback: phone mic (the companion phone is the other input source).
    ok = await bridge.audioControl(true, AudioInputSource.Phone).catch(() => false)
    console.log('VOICE audioControl phone:', ok)
  }
  if (!ok) {
    showNotice('VOICE ORDER · HL TESTNET', ['Mic unavailable', 'Try menu > Demo voice'], 'tap=retry')
    return
  }
  recordTimer = setTimeout(() => void stopRecording(), RECORD_MS)
  // Live elapsed-time ticker (1s) while recording.
  const tick = setInterval(() => {
    if (voice !== 'recording') {
      clearInterval(tick)
      return
    }
    upgrade()
  }, 1000)
}

async function transcribePcm(pcm: Uint8Array): Promise<void> {
  voice = 'transcribing'
  upgrade()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${PROXY_URL}/stt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: pcm as unknown as BodyInit,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`proxy /stt HTTP ${res.status}`)
    const data = asRecord(await res.json())
    const transcript = typeof data.transcript === 'string' ? data.transcript : ''
    console.log(`VOICE transcript: ${transcript}`)
    if (!transcript.trim()) {
      showNotice('VOICE ORDER · HL TESTNET', ['Empty transcript', 'Tap to try again'], 'tap=retry')
      return
    }
    await draftFromTranscript(transcript)
  } catch (err) {
    console.log('VOICE stt failed:', err instanceof Error ? err.message : String(err))
    showNotice('VOICE ORDER · HL TESTNET', ['STT failed', trunc(err instanceof Error ? err.message : String(err), 26)], 'tap=retry')
  }
}

async function transcribeWav(wav: ArrayBuffer): Promise<void> {
  voice = 'transcribing'
  upgrade()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${PROXY_URL}/stt`, {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav as unknown as BodyInit,
        signal: ctrl.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`proxy /stt HTTP ${res.status}`)
    const data = asRecord(await res.json())
    const transcript = typeof data.transcript === 'string' ? data.transcript : ''
    console.log(`VOICE demo transcript: ${transcript}`)
    if (!transcript.trim()) {
      showNotice('VOICE ORDER · HL TESTNET', ['Empty transcript', 'Tap to try again'], 'tap=retry')
      return
    }
    await draftFromTranscript(transcript)
  } catch (err) {
    console.log('VOICE demo stt failed:', err instanceof Error ? err.message : String(err))
    showNotice('VOICE ORDER · HL TESTNET', ['STT failed', trunc(err instanceof Error ? err.message : String(err), 26)], 'tap=retry')
  }
}

async function draftFromTranscript(transcript: string): Promise<void> {
  try {
    const data = asRecord(await postJson(`${PROXY_URL}/draft`, { transcript }, PROXY_TIMEOUT_MS))
    if (data.ok !== true) {
      const errMsg = typeof data.error === 'string' ? data.error : 'parse failed'
      showNotice('VOICE ORDER · HL TESTNET', ['Could not parse:', `"${trunc(transcript, 20)}"`, trunc(errMsg, 26)], 'tap=retry')
      return
    }
    draft = {
      coin: String(data.coin),
      side: data.side === 'sell' ? 'sell' : 'buy',
      size: Number(data.size),
      sizeDefaulted: data.sizeDefaulted === true,
      transcript,
    }
    console.log(`VOICE draft: ${draft.side} ${draft.size} ${draft.coin}`)
    voice = 'draft'
    upgrade()
  } catch (err) {
    console.log('VOICE draft failed:', err instanceof Error ? err.message : String(err))
    showNotice('VOICE ORDER · HL TESTNET', ['Draft failed', trunc(err instanceof Error ? err.message : String(err), 26)], 'tap=retry')
  }
}

async function runDemoVoice(): Promise<void> {
  voice = 'transcribing'
  upgrade()
  try {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), PROXY_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(`${PROXY_URL}/demo-phrase`, { signal: ctrl.signal })
    } finally {
      clearTimeout(timer)
    }
    if (!res.ok) throw new Error(`proxy /demo-phrase HTTP ${res.status}`)
    await transcribeWav(await res.arrayBuffer())
  } catch (err) {
    console.log('VOICE demo fetch failed:', err instanceof Error ? err.message : String(err))
    showNotice('VOICE ORDER · HL TESTNET', ['Demo failed', trunc(err instanceof Error ? err.message : String(err), 26)], 'tap=retry')
  }
}

async function confirmOrder(): Promise<void> {
  if (!draft) return
  const d = draft
  voice = 'ordering'
  upgrade()
  try {
    const data = asRecord(await postJson(`${PROXY_URL}/order`, { coin: d.coin, side: d.side, size: d.size }, PROXY_TIMEOUT_MS))
    // Hyperliquid /exchange order response:
    // {status: "ok", response: {type: "order", data: {statuses: [...]}}}
    // or {status: "err", response: "<message>"}.
    console.log(`VOICE order result: ${JSON.stringify(data).slice(0, 300)}`)
    if (data.status === 'err') {
      resultOk = false
      resultLines = [trunc(String(data.response ?? 'exchange error'), 26)]
    } else {
      const resp = asRecord(data.response ?? {})
      const respData = asRecord(resp.data ?? {})
      const statusList = Array.isArray(respData.statuses) ? (respData.statuses as unknown[]) : []
      const first = statusList.length > 0 ? asRecord(statusList[0]) : {}
      if (typeof first.filled === 'object' && first.filled !== null) {
        const f = asRecord(first.filled)
        resultOk = true
        resultLines = [
          `${d.side === 'buy' ? 'BUY' : 'SELL'} ${fmtSize(d.size, 4)} ${d.coin}`,
          `@ ${fmtUsd(Number(f.avgPx ?? '0'))}`,
          `oid ${String(f.oid ?? '')}`,
        ]
      } else if (typeof first.resting === 'object' && first.resting !== null) {
        const r = asRecord(first.resting)
        resultOk = true
        resultLines = [
          `${d.side === 'buy' ? 'BUY' : 'SELL'} ${fmtSize(d.size, 4)} ${d.coin}`,
          'RESTING (not filled)',
          `oid ${String(r.oid ?? '')}`,
        ]
      } else if (typeof first.error === 'string') {
        resultOk = false
        resultLines = [trunc(first.error, 26)]
      } else {
        resultOk = false
        resultLines = ['Unknown result', 'Check console']
      }
    }
  } catch (err) {
    console.log('VOICE order failed:', err instanceof Error ? err.message : String(err))
    resultOk = false
    // Show the proxy's real reason in readable form (funding check etc.)
    // instead of a bare HTTP code.
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('account not funded')) {
      resultLines = ['NOT FUNDED', 'deposit test USDC first']
    } else if (msg.includes('TOO_SMALL') || msg.includes('below $10') || msg.includes('notional')) {
      resultLines = ['TOO SMALL', 'min notional $10']
    } else {
      resultLines = [trunc(msg, 26)]
    }
  }
  voice = 'result'
  upgrade()
  // Refresh the glance data in the background so positions show up.
  void refresh()
}

function enterVoice(): void {
  stopRecordingTimer()
  void bridge.audioControl(false).catch(() => undefined)
  draft = null
  voice = 'voice'
  upgrade()
}

function enterGlance(): void {
  stopRecordingTimer()
  void bridge.audioControl(false).catch(() => undefined)
  draft = null
  voice = 'glance'
  upgrade()
  void refresh()
}

// ---- page creation ----

const mainText = new TextContainerProperty({
  xPosition: 0,
  yPosition: 0,
  width: 576,
  height: 288,
  borderWidth: 0,
  borderColor: 5,
  paddingLength: 4,
  containerID: 1,
  containerName: 'main',
  content: loadingContent(),
  isEventCapture: 1,
})

const menuObject = new MenuContainerProperty({
  menuItems: [
    new MenuItemProperty({ itemName: 'Voice order', itemID: 1 }),
    new MenuItemProperty({ itemName: 'Demo voice', itemID: 2 }),
    new MenuItemProperty({ itemName: 'Back to glance', itemID: 3 }),
    new MenuItemProperty({ itemName: 'Test alert', itemID: 4 }),
  ],
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 1,
    textObject: [mainText],
    menuObject,
  }),
)

console.log('Page created:', result === 0 ? 'success' : `failed (${result})`)

// Fetch live data on startup; tap = refresh (in glance mode).
void refresh()

// Auto-refresh the glance every 30 s so price/liquidation alerts can fire
// without a tap. Glance mode only — never interrupts a voice/draft flow.
setInterval(() => {
  if (voice === 'glance') void refresh()
}, 30000)

// Reads the event type out of one envelope.
//
// CLICK_EVENT is 0, and protobuf omits zero-value fields on the wire, so a
// single tap arrives as an envelope whose `eventType` is `undefined`. The
// default has to be resolved INSIDE the envelope check. Writing
// `event.sysEvent?.eventType ?? OsEventTypeList.CLICK_EVENT` instead would
// read CLICK on events that carry no `sysEvent` at all, so every scroll,
// exit and audio frame would fire the tap handler.
function eventTypeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

// Event routing, critical details:
//   • Taps/double-taps/lifecycle come through `event.sysEvent`.
//     Scroll gestures come through `event.textEvent`. Never mix them.
//   • Audio frames come through `event.audioEvent` (only while recording).
//   • Menu selections come through `event.menuItemClickEvent` — check FIRST:
//     a menu-click envelope may also carry a sysEvent with an omitted
//     zero-value eventType, which eventTypeOf would misread as CLICK.
//     A stray CLICK right after a menu selection is ignored for 400 ms so a
//     menu tap can never confirm an order by accident.
//   • Double-tap → `shutDownPageContainer(1)` is a root-level check: it
//     must fire no matter which envelope the event arrives in, so users
//     can always exit the app.
//   • Check DOUBLE_CLICK_EVENT before CLICK_EVENT.
const unsubscribe = bridge.onEvenHubEvent((event) => {
  // Menu selections.
  const menuClick = event.menuItemClickEvent
  if (menuClick && typeof menuClick.itemID === 'number') {
    lastMenuClickAt = Date.now()
    console.log(`VOICE menu item: ${menuClick.itemID}`)
    if (menuClick.itemID === 1) enterVoice()
    else if (menuClick.itemID === 2) void runDemoVoice()
    else if (menuClick.itemID === 3) enterGlance()
    else if (menuClick.itemID === 4) showTestAlert()
    return
  }

  // Audio frames (only collected while recording).
  const audio = event.audioEvent
  if (audio && voice === 'recording') {
    if (audio.audioPcm && audio.audioPcm.length > 0) {
      audioChunks.push(audio.audioPcm as Uint8Array)
    }
    return
  }

  const sysType = eventTypeOf(event.sysEvent)
  const textType = eventTypeOf(event.textEvent)

  if (sysType === OsEventTypeList.DOUBLE_CLICK_EVENT || textType === OsEventTypeList.DOUBLE_CLICK_EVENT) {
    bridge.shutDownPageContainer(1)
    return
  }

  if (sysType === OsEventTypeList.CLICK_EVENT || textType === OsEventTypeList.CLICK_EVENT) {
    // Ignore a click that arrives right after a menu selection.
    if (Date.now() - lastMenuClickAt < 400) return
    taps += 1
    if (voice === 'glance') {
      void refresh()
    } else if (voice === 'voice') {
      void startRecording()
    } else if (voice === 'draft') {
      void confirmOrder()
    } else if (voice === 'result') {
      enterGlance()
    } else if (voice === 'alert') {
      // Acknowledge the alert — back to glance (banner stays while active).
      enterGlance()
    } else if (voice === 'notice') {
      enterVoice()
    }
    return
  }

  if (sysType === OsEventTypeList.SYSTEM_EXIT_EVENT || sysType === OsEventTypeList.ABNORMAL_EXIT_EVENT) {
    unsubscribe()
  }
})
