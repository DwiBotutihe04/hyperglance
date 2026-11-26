// HyperGlance backend proxy (localhost only, demo use).
// Holds the Hyperliquid TESTNET API wallet key + Groq Whisper server-side.
// The glasses app NEVER sees any key. Keys are never logged.
//
// Endpoints:
//   GET  /health       -> {ok, apiWallet}
//   GET  /demo-phrase  -> demo WAV ("beli 0,01 ETH", espeak-ng id voice)
//   POST /stt          -> raw PCM16 16kHz body (application/octet-stream) or
//                          WAV body (audio/wav) -> {transcript, language}
//   POST /draft        -> {transcript} -> {ok, coin, side, size} | {ok:false, error}
//   POST /order        -> {coin, side, size} -> Hyperliquid testnet order result
//
// STT shells out to groq.py run (bridges GROQ_API_KEY as a surrogate; the
// real key never touches this process's files or logs).

import http from 'node:http'
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { parseDraft } from './parse.mjs'
import { makeWallet, submitMarketOrder, MAIN_ACCOUNT } from './hl.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PORT = 8899
const GROQ_HELPER = '/home/hatch/workspace/custom-connectors/custom.groq/bin/groq.py'
const STT_PY = join(HERE, 'stt.py')
const DEMO_WAV = join(HERE, 'demo-phrase.wav')

// ---- env (testnet API wallet; never log values) ----
const env = {}
for (const line of readFileSync(join(HERE, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) env[m[1].trim()] = m[2].trim()
}
if (!env.HL_API_WALLET_PRIVATE_KEY) throw new Error('HL_API_WALLET_PRIVATE_KEY missing from proxy/.env')
const wallet = makeWallet(env.HL_API_WALLET_PRIVATE_KEY)
const API_WALLET = await wallet.getAddress()
console.log(`[proxy] api wallet ${API_WALLET} for main account ${MAIN_ACCOUNT} (testnet only)`)

// ---- helpers ----
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req, maxBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (c) => {
      total += c.length
      if (total > maxBytes) return reject(new Error('body too large'))
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// Wrap raw PCM16 16kHz mono in a 44-byte WAV header for Whisper.
function pcmToWav(pcm) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28) // byte rate
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

function runStt(wavPath) {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      [GROQ_HELPER, 'run', 'python3', STT_PY, wavPath],
      { timeout: 90000 },
    )
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => resolve({ error: `stt spawn failed: ${e.message}` }))
    child.on('close', (code) => {
      if (code !== 0) return resolve({ error: `stt exit ${code}: ${err.slice(0, 200) || out.slice(0, 200)}` })
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()))
      } catch {
        resolve({ error: `stt bad output: ${out.slice(0, 200)}` })
      }
    })
  })
}

// ---- server ----
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = new URL(req.url, 'http://localhost')
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return sendJson(res, 200, { ok: true, apiWallet: API_WALLET, mainAccount: MAIN_ACCOUNT })
    }
    if (req.method === 'GET' && url.pathname === '/demo-phrase') {
      if (!existsSync(DEMO_WAV)) return sendJson(res, 404, { error: 'demo phrase not generated yet' })
      const wav = readFileSync(DEMO_WAV)
      res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': wav.length })
      return res.end(wav)
    }
    if (req.method === 'POST' && url.pathname === '/stt') {
      const body = await readBody(req)
      if (body.length === 0) return sendJson(res, 400, { error: 'empty audio body' })
      const isWav = body.slice(0, 4).toString() === 'RIFF'
      const wav = isWav ? body : pcmToWav(body)
      const dir = mkdtempSync(join(tmpdir(), 'hg-stt-'))
      const wavPath = join(dir, 'audio.wav')
      try {
        writeFileSync(wavPath, wav)
        const t0 = Date.now()
        const result = await runStt(wavPath)
        if (result.error) return sendJson(res, 502, { error: result.error })
        const transcript = String(result.text || '').trim()
        console.log(`[stt] ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${JSON.stringify(transcript.slice(0, 80))}`)
        return sendJson(res, 200, { transcript, language: result.language || '' })
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
    if (req.method === 'POST' && url.pathname === '/draft') {
      const body = await readBody(req, 64 * 1024)
      const { transcript } = JSON.parse(body.toString('utf8'))
      return sendJson(res, 200, parseDraft(transcript))
    }
    if (req.method === 'POST' && url.pathname === '/order') {
      const body = await readBody(req, 64 * 1024)
      const { coin, side, size } = JSON.parse(body.toString('utf8'))
      if (!['BTC', 'ETH'].includes(coin) || !['buy', 'sell'].includes(side) || !(size > 0)) {
        return sendJson(res, 400, { error: 'bad order: need {coin: BTC|ETH, side: buy|sell, size: number}' })
      }
      console.log(`[order] ${side} ${size} ${coin} (testnet)`)
      try {
        const result = await submitMarketOrder(wallet, { coin, side, size })
        console.log(`[order] done: ${JSON.stringify(result).slice(0, 300)}`)
        return sendJson(res, 200, result)
      } catch (e) {
        console.log(`[order] failed: ${e.message}`)
        const code = e.code === 'NOT_FUNDED' ? 402 : e.code === 'TOO_SMALL' ? 400 : 502
        return sendJson(res, code, { error: e.message })
      }
    }
    return sendJson(res, 404, { error: 'not found' })
  } catch (e) {
    console.log(`[proxy] ${req.method} ${url.pathname} error: ${e.message}`)
    return sendJson(res, 500, { error: e.message })
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[proxy] listening on http://127.0.0.1:${PORT} (localhost only)`)
})
