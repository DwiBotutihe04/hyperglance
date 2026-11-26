# HyperGlance — Night 2 verification (Tue 24 Nov 2026, ~07:35 WITA)

Today's target: read path — live Hyperliquid testnet data on the G2 display.
**Result: DONE and verified.**

## What renders

One startup page, one full-canvas text container (576×288) on the G2 display,
fetched live from `https://api.hyperliquid-testnet.xyz/info`:

```
HYPERGLANCE · HL TESTNET
--------------------------
BTC-PERP $61,383.50
ETH-PERP $1,713.55
--------------------------
ACCT $0.00 · uPnL +$0.00
NO POSITIONS
LIVE 23:34 · tap=refresh
Taps: 0 · 2x tap = exit
```

- Mark prices are LIVE from `allMids` (BTC $61,383.50 / ETH $1,713.55 at first
  fetch; ETH moved to $1,713.35 after one tap-refresh — the re-fetch is real).
- Account value + unrealized PnL are Bozz's own, from `clearinghouseState`
  for `0xa24e39f1…200f7f`: accountValue `0.0`, `assetPositions: []` — rendered
  honestly as `$0.00 / NO POSITIONS`. Nothing is faked.
- Tap = refresh (re-fetches all three endpoints); double-tap exits (template
  logic, unchanged from night 1).
- Mock snapshot is a fallback ONLY when the API is unreachable, always
  labelled `MOCK DATA` (night-1 content, unchanged). It was not needed today.
- Layout caps at 9 lines (7 lines measured 183px of 288px on night 1); with
  1–2 open positions the footer compresses to `LIVE HH:MM · Taps: N`, with 3+
  only the first position shows plus `+N more positions`. Position lines
  shrink the size decimals (4→2→0) to stay ≤ 26 chars/line.

## Evidence

- `docs/screenshots/04-live-initial-black.png` (+ raw `04-live-initial-framebuffer.png`) —
  live screen at first fetch (Taps: 0).
- `docs/screenshots/05-live-after-tap-black.png` (+ raw `05-live-after-tap-framebuffer.png`) —
  after one simulated tap: ETH $1,713.35, `Taps: 1`.
- Simulator console: `Page created: success` →
  `HL meta: BTC index 3 szDecimals 5` → `HL meta: ETH index 4 szDecimals 4` →
  `HL live: BTC 61383.5 ETH 1713.55 acct 0 pos 0` (then a second `HL live: …`
  line after the tap, ETH 1713.35).
- Build: `tsc --noEmit && vite build` clean; single JS bundle
  `dist/assets/index-DWrfrXPZ.js` (87.35 kB, `inlineDynamicImports: true`).
- Pack: `npm run pack` → `out.ehpk` (37,754 bytes), `min_app_version 2.2.10`.

## How the read path works

`src/main.ts` POSTs three requests in parallel to the testnet info API
(`{"type":"meta"}`, `{"type":"allMids"}`, `{"type":"clearinghouseState",
"user": "<Bozz testnet wallet>"}`), 8 s timeout each, direct `fetch` from the
app (the API sends `access-control-allow-origin: *`, so no proxy is needed).
Coin names are resolved from `meta.universe` — perp asset IDs differ between
testnet (BTC = 3) and mainnet (BTC = 0), so no index is ever hardcoded.
`clearinghouseState` gives `marginSummary.accountValue` and
`assetPositions[]` (`position.coin/szi/unrealizedPnl`); uPnL is the sum of
unrealized PnL. Any fetch failure → mock fallback (labelled); a newer tap
supersedes an in-flight fetch (sequence guard).

## Blocker hit + fix (attempt 1 of 3)

- **Simulator would not start after the overnight VM restart:**
  `evenhub-simulator: error while loading shared libraries:
  libwebkit2gtk-4.1.so.0: cannot open shared object file`. The library was
  gone from the system (VM image reset; home dir + npm toolchain survived,
  system packages did not). Fix: `apt-get install -y libwebkit2gtk-4.1-0`
  (as root, passwordless sudo) — simulator started cleanly after that.
  Lesson: after any VM restart, re-check system libs, not just node processes.
- Dev server (5173) was also dead; restarted with `npm run dev`.
- Currently running (left alive 24 Nov ~07:35 WITA): Vite dev server (port
  5173), simulator under Xvfb (automation API port 9898, `pong`).

## Not done (by design — Wed/Thu)

- Write path (voice → STT → draft → tap confirm → testnet order) — Wed 25 Nov.
  Needs funded testnet USDC first: Bozz claimed 20 USDC from the Circle faucet
  (faucet.circle.com, HyperEVM Testnet) on 24 Nov morning — it lands on
  HyperEVM (chain 998) and must still be deposited into the testnet trading
  account via the testnet app before any order test can run.
- Backend proxy (holds testnet credentials + Groq Whisper server-side).
- Even Hub portal account still pending (Bozz must create it in the phone app).
- `evenhub create/upload` not attempted — needs the Even account + DoraHacks
  submission flow (Fri 27 Nov).
