# HyperGlance

Trading copilot for Even Realities G2 smart glasses — **Track 02 Crypto & DeFi**,
Even Realities "Heads Up" hackathon (build week 23–29 Nov 2026, DoraHacks).

One glance shows your Hyperliquid **testnet** positions + unrealized PnL.
Voice order ("buy 0.01 ETH") → draft on screen → one tap on G2 to confirm →
real market order on Hyperliquid **testnet** (never mainnet, never real money).

## What existed before 23 Nov 2026 (pre-hackathon)

- The `minimal` starter template from
  [even-realities/evenhub-templates](https://github.com/even-realities/evenhub-templates)
  (`index.html` host page, `src/main.ts` single-container bootstrap,
  `app.json` manifest shape, `tsconfig.json`, `vite.config.ts`) — cloned
  23 Nov 2026 and adapted. No app code existed before the hackathon.
- Toolchain only: Node v24.22.1, `@evenrealities/evenhub-cli@0.2.0`,
  `@evenrealities/evenhub-simulator@0.9.5`, `@evenrealities/even_hub_sdk@0.0.16`.

Everything else in this repo (glance layout, mock data, input handling,
read/write paths, backend proxy) was written during the hackathon, 23–27 Nov 2026.

## Status

- **23 Nov (night 1): skeleton** — app boots, one 576×288 container renders
  a mock glance screen (title + 2 mock positions). Tap cycles mock data,
  double-tap exits. No network calls, no trading logic.
- **24 Nov (night 2): read path — DONE and verified in the simulator**
  (`docs/VERIFICATION-2026-11-24.md`). Live BTC/ETH-PERP mark prices from
  Hyperliquid testnet `allMids`, plus Bozz's account value / unrealized PnL /
  open positions from `clearinghouseState` (currently $0.00, no positions —
  shown honestly). Tap = refresh. Mock data is a labelled fallback only.
- **24 Nov (day 2, pulled forward from 25 Nov): write path — BUILT and
  verified through the draft stage in the simulator**
  (`docs/VERIFICATION-2026-11-24-write.md`). Voice order → Whisper STT →
  draft → one-tap confirm → market order on Hyperliquid testnet, via the
  localhost backend proxy (`proxy/`). End-to-end order test still pending:
  the 20 test USDC must be deposited into the trading account and the API
  wallet approved (both in progress via the testnet app).
- **26 Nov: write path exercised end-to-end — blocked by funding, honestly.**
  Menu → Demo voice → draft (BUY 0.01 ETH, ~$17.24) → tap CONFIRM →
  the proxy's funding check refused with HTTP 402
  (`account not funded: deposit test USDC first`), shown on screen as
  `ORDER FAILED / NOT FUNDED / deposit test USDC first`
  (`docs/screenshots/17-draft-2026-11-26-black.png`,
  `18-order-result-2026-11-26-black.png`). No order was placed, nothing
  faked. The funding block is real: two 20 USDC testnet deposits
  (24 Nov tx `0xa598…`, 26 Nov tx `0xd064…`) were confirmed on-chain but
  NEVER credited — Perps/Spot still $0.00. A Discord #testnet-support post
  is being prepared. The order signing itself is verified byte-identical
  to the official Python SDK, so the flow runs end-to-end the moment a
  deposit credits.
- 25 Nov: end-to-end order test (once funded) + write-path hardening.
  The order test was run on 26 Nov (see below) — blocked by funding.
- **26 Nov: alerts — DONE and verified in the simulator** (this README
  §Alerts, `docs/screenshots/14-alert-test-black.png`). Demo video recorded
  from the simulator (`docs/demo-video.mp4`, ~60 s, captions included):
  live glance → test alert → demo voice → draft → confirm → honest
  `ORDER FAILED / NOT FUNDED` result. Nothing faked.
- 26 Nov: `.ehpk` packed (41,200 bytes), final test, submit.

## Read path (how it works)

`src/main.ts` POSTs three requests in parallel to the Hyperliquid **testnet**
info API (`https://api.hyperliquid-testnet.xyz/info`): `{"type":"meta"}`,
`{"type":"allMids"}`, `{"type":"clearinghouseState","user":"<testnet wallet>"}`.
Direct `fetch` from the app — the API sends `access-control-allow-origin: *`,
so no proxy is needed. Coin names are resolved from `meta.universe` (perp
asset IDs differ testnet vs mainnet: BTC is 3 on testnet, 0 on mainnet — never
hardcode an index). Any fetch failure falls back to the labelled mock snapshot.
No API keys or secrets: the info API is public and keyless.

## Write path (how it works)

Voice order flow (one container, mode state machine in `src/main.ts`):

1. **Enter:** long-press → contextual menu → "Voice order" (or "Demo voice").
   Menu items are attached as `menuObject` at page creation; selections arrive
   as `event.menuItemClickEvent`. A tap within 400 ms of a menu selection is
   ignored, so a menu tap can never confirm an order by accident.
2. **Record:** tap starts the mic (`bridge.audioControl(true, Glasses)`,
   falls back to Phone). PCM 16 kHz frames arrive via `event.audioEvent`
   (100 ms/chunk in the simulator, 10 ms on hardware). Auto-stops after 5 s.
   Pure silence is detected (max |sample| < 50) and reported without calling STT.
3. **Transcribe:** raw PCM is POSTed to the proxy `/stt` (Groq Whisper
   `whisper-large-v3-turbo`, `language: id`). The proxy shells out to the
   Groq connector helper, so the key never touches the proxy's files.
4. **Draft:** proxy `/draft` parses the transcript (Indonesian "beli/jual" +
   coin + size; decimal comma "0,01" and number words "nol koma nol satu"
   supported; fuzzy 2-letter-tolerant side-word match for STT noise). The
   draft screen shows side/size/coin, live mid price, estimated value and the
   transcript — and waits.
5. **Confirm:** a single tap on the draft screen POSTs to proxy `/order`,
   which signs the order with the testnet API wallet key (EIP-712 L1 action,
   verified byte-identical against the official Python SDK) and submits a
   market (IOC, ±3% slippage) order to
   `https://api.hyperliquid-testnet.xyz/exchange`. Result screen shows
   FILLED (avg price + order id), RESTING, or FAILED with the reason.
   "Back to glance" in the menu discards the draft — never auto-submit.
6. **Demo voice (simulator only):** the simulator has no microphone
   (`audioControl` returns false). Menu → "Demo voice" fetches a bundled
   sample phrase (`proxy/demo-phrase.wav`, espeak-ng mbrola-id1 voice saying
   "saya mau beli nol koma nol satu ethereum") from the proxy and runs it
   through the real STT + draft pipeline. On real hardware the mic path is
   used; the demo phrase exists only so the flow is demonstrable on video.

## Alerts (how it works, added 26 Nov)

Two alert sources, both computed from **live** data only — never from the
mock fallback:

1. **Price move:** a coin's mark moves ≥ 1% vs the price at app start
   (baseline = first successful live fetch). Latched per coin + direction
   until the move falls back under 0.5%, so it fires once per move.
2. **Liquidation proximity:** a position's mark comes within 5% of its
   liquidation price (`liquidationPx` from `clearinghouseState`; parsed in
   `fetchLive`). With no open positions this never fires.

When an alert fires in glance mode the screen switches to the alert
(`!!! PRICE ALERT !!!` / `!!! LIQ RISK !!!` with coin, % move, prices) and
a best-effort beep plays. A tap acknowledges it and returns to the glance,
where the alert stays as a one-line `ALERT …` footer banner until the
condition clears. An alert never interrupts a voice/draft flow — it latches
and waits. The glance auto-refreshes every 30 s so alerts can fire without
a tap.

**Sound — honest limitation:** the Even SDK exposes no speaker API, so the
beep is a best-effort WebAudio tone in the page (it may only sound on the
phone companion). The on-glasses alert is the visual screen, which always
works.

**Test alert:** menu → "Test alert" shows the alert screen labelled
`TEST ALERT` ("This is a self-test / No market event") so the display +
sound can be checked without faking a market event. Verified in the
simulator 26 Nov (`docs/screenshots/14-alert-test-black.png`).

## Backend proxy (`proxy/`)

Small Node server (plain `node:http`, no framework), localhost only
(`http://127.0.0.1:8899`). Start it before the simulator:

```bash
cd proxy && npm install && node server.mjs
# proxy/.env (mode 600) holds HL_API_WALLET_ADDRESS + HL_API_WALLET_PRIVATE_KEY
# (testnet-only API wallet; the private key NEVER leaves this VM, is never
# logged, and is never bundled into the app or the .ehpk)
```

Endpoints: `GET /health`, `GET /demo-phrase`, `POST /stt` (raw PCM16 16 kHz
or WAV), `POST /draft` (`{transcript}`), `POST /order`
(`{coin, side, size}` — validates funding ≥ $0 and notional ≥ $10 first).
The Groq key is NOT in `.env`: `/stt` shells out to the Groq connector
helper (`groq.py run`), which bridges the credential as a surrogate.

## Run

```bash
npm install
npm run dev          # Vite dev server on http://localhost:5173
cd proxy && node server.mjs   # backend proxy on http://127.0.0.1:8899
npm run simulate     # Even Hub simulator (needs Xvfb on headless Linux)
```

Simulator automation API (when started with `--automation-port 9898`):

```bash
curl localhost:9898/api/ping                        # health check -> pong
curl localhost:9898/api/screenshot/glasses -o shot.png   # 576x288 framebuffer PNG
curl localhost:9898/api/console                     # webview console output
curl -X POST localhost:9898/api/input -H 'Content-Type: application/json' \
  -d '{"action":"click"}'                          # send a tap
```

Real glasses: `npx evenhub qr --url http://<your-ip>:5173`, scan with the
Even Hub companion app.

## Pack for distribution

```bash
npm run pack
```

Produces a single-bundle `.ehpk` (one JS bundle, `inlineDynamicImports: true`).

## Security

- **Never bundle API keys or secrets into the `.ehpk` or this repo.**
  Hyperliquid testnet credentials and the STT key live server-side in the
  backend proxy only (added 24–25 Nov), never in app code.
- Testnet only. No mainnet, no real funds, no financial advice.

## Manifest rules (learned the hard way)

- `app.json` `permissions` must be an **array of objects**
  (`[{"name": "network"}]`), not a map. **Every permission also needs a
  `desc`** — the pack validator rejects bare `{"name": ...}`.
- `min_app_version` floor for SDK 0.0.16 is **2.2.10**, not 2.0.0.
- The simulator framebuffer PNG is mostly transparent (text is opaque green
  on a transparent background) — composite over black to read it.
- The simulator emits `audioEvents` (16 kHz PCM, 100 ms/chunk) but has **no
  microphone**: `audioControl(true, Glasses)` returns `false` in the sim.
  Use the "Demo voice" menu item to exercise STT in the simulator.
- The contextual menu opens on long-press; in the simulator use
  `POST /api/input {"action": "context_menu"}` then `up`/`down` + `click`
  to pick an item. The menu overlay does not appear in screenshots — watch
  the console for `menuItemClickEvent` instead.
- `package_id` lowercase reverse-domain, min 2 segments, no hyphens
  (`com.soeltan.hyperglance`). App `name` ≤ 20 chars. `edition: "202601"`.
- Pack with `--sdk-ver` matching the installed SDK (0.0.16).
- Simulator ≠ hardware: `CLICK_EVENT` is 0 and protobuf omits zero-value
  fields, so a tap arrives with `eventType === undefined` — resolve the
  default inside the envelope check (see `src/main.ts`).
- Restart the simulator after edits; HMR alone leaves a stale page container.
- After a VM restart, system packages outside the home dir may be gone
  (e.g. `libwebkit2gtk-4.1` for the simulator) — reinstall with apt before
  assuming the toolchain is intact. **26 Nov: apt lists were stale after
  the restart — `apt-get update` first, or the package is "unable to
  locate".**
- The Even SDK (0.0.16) exposes **no speaker/audio-output API** — an alert
  beep can only be a best-effort WebAudio tone in the page; the visual
  alert screen is the reliable channel.
