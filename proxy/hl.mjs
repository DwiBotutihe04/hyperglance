// Hyperliquid TESTNET order signing + submission.
// Mirrors hyperliquid-python-sdk (utils/signing.py + exchange.py) exactly:
//   action_hash = keccak(msgpack(action) + nonce(8B BE) + 0x00 [no vault])
//   phantom agent = {source: "b" (testnet), connectionId: hash}
//   EIP-712 domain {name: "Exchange", version: "1", chainId: 1337,
//                   verifyingContract: 0x0000...}
//   types Agent[{source, string}, {connectionId, bytes32}]
//   order wire = {a: asset, b: isBuy, p: float_to_wire(limitPx),
//                 s: float_to_wire(sz), r: reduceOnly,
//                 t: {limit: {tif: "Ioc"}}}
//   POST /exchange {action, nonce, signature: {r, s, v}, vaultAddress: null,
//                   expiresAfter: null}
// Testnet only. The API wallet key is passed in at startup, never logged.

import { ethers } from 'ethers'
import { encode } from '@msgpack/msgpack'

export const TESTNET_INFO_URL = 'https://api.hyperliquid-testnet.xyz/info'
export const TESTNET_EXCHANGE_URL = 'https://api.hyperliquid-testnet.xyz/exchange'
export const MAIN_ACCOUNT = '0xa24e39f1f1a8f18a6c2a34cff987c0591f200f7f'
const MIN_NOTIONAL_USD = 10

const DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000',
}
const AGENT_TYPES = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' },
  ],
}

// Python float_to_wire: f"{x:.8f}", reject if it moves the value >= 1e-12,
// then Decimal normalize (strip trailing zeros).
export function floatToWire(x) {
  const rounded = Number(x).toFixed(8)
  if (Math.abs(parseFloat(rounded) - Number(x)) >= 1e-12) {
    throw new Error(`float_to_wire causes rounding: ${x}`)
  }
  let s = rounded
  if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '')
  if (s === '-0' || s === '') s = '0'
  return s
}

// Python Exchange._slippage_price: 5 significant figures, then round to
// (6 - szDecimals) decimals for perps.
export function slippagePrice(mid, isBuy, szDecimals) {
  let px = mid * (isBuy ? 1.03 : 0.97)
  px = parseFloat(px.toPrecision(5))
  const decimals = 6 - szDecimals
  px = Math.round(px * 10 ** decimals) / 10 ** decimals
  return px
}

function floorToDecimals(x, decimals) {
  const f = 10 ** decimals
  return Math.floor(x * f) / f
}

async function postInfo(body) {
  const res = await fetch(TESTNET_INFO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HL info HTTP ${res.status}`)
  return res.json()
}

// Build the signed action for one market (IOC) order. Pure except for the
// signing key. Exported for the oracle test.
export async function buildSignedOrder(wallet, { coin, side, size, mid, asset, szDecimals, nonce }) {
  const isBuy = side === 'buy'
  const limitPx = slippagePrice(mid, isBuy, szDecimals)
  const sz = floorToDecimals(size, szDecimals)
  if (sz <= 0) throw new Error('size rounds to zero at szDecimals')
  const wire = {
    a: asset,
    b: isBuy,
    p: floatToWire(limitPx),
    s: floatToWire(sz),
    r: false,
    t: { limit: { tif: 'Ioc' } },
  }
  const action = { type: 'order', orders: [wire], grouping: 'na' }
  // action_hash(action, vault=None, nonce, expires_after=None)
  const packed = encode(action)
  const hashInput = new Uint8Array(packed.length + 8 + 1)
  hashInput.set(packed, 0)
  const nonceView = new DataView(hashInput.buffer, packed.length, 8)
  nonceView.setBigUint64(0, BigInt(nonce), false)
  hashInput[packed.length + 8] = 0x00 // no vault
  const actionHash = ethers.keccak256(hashInput)
  const sig = await wallet.signTypedData(DOMAIN, AGENT_TYPES, {
    source: 'b', // testnet phantom agent
    connectionId: actionHash,
  })
  const r = `0x${sig.slice(2, 66)}`
  const s = `0x${sig.slice(66, 130)}`
  const v = parseInt(sig.slice(130), 16)
  return { action, nonce, signature: { r, s, v }, limitPx, sz }
}

export async function submitMarketOrder(wallet, { coin, side, size }) {
  const [meta, mids, state] = await Promise.all([
    postInfo({ type: 'meta' }),
    postInfo({ type: 'allMids' }),
    postInfo({ type: 'clearinghouseState', user: MAIN_ACCOUNT }),
  ])
  const universe = meta.universe
  const idx = universe.findIndex((u) => u.name === coin)
  if (idx < 0) throw new Error(`coin ${coin} not in meta`)
  const szDecimals = universe[idx].szDecimals
  const mid = Number(mids[coin])
  if (!Number.isFinite(mid) || mid <= 0) throw new Error(`no mid price for ${coin}`)

  const accountValue = Number(state.marginSummary?.accountValue ?? '0')
  if (!(accountValue > 0)) {
    const e = new Error('account not funded: deposit test USDC first')
    e.code = 'NOT_FUNDED'
    throw e
  }
  const notional = mid * size
  if (notional < MIN_NOTIONAL_USD) {
    const e = new Error(`order $${notional.toFixed(2)} below $10 minimum`)
    e.code = 'TOO_SMALL'
    throw e
  }

  const nonce = Date.now()
  const { action, signature, limitPx, sz } = await buildSignedOrder(wallet, {
    coin,
    side,
    size,
    mid,
    asset: idx,
    szDecimals,
    nonce,
  })
  const res = await fetch(TESTNET_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action,
      nonce,
      signature,
      vaultAddress: null,
      expiresAfter: null,
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HL exchange HTTP ${res.status}: ${text.slice(0, 300)}`)
  }
  const body = await res.json()
  return { ...body, _debug: { coin, side, size: sz, limitPx, mid, nonce } }
}

export function makeWallet(privateKey) {
  return new ethers.Wallet(privateKey)
}
