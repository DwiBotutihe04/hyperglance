# HyperGlance — Write path verification (Tue 24 Nov 2026, ~07:40–08:00 WITA)

Today's target (pulled forward from Wed 25 Nov at Bozz's "gas"): voice order
→ STT → draft → one-tap confirm → market order on Hyperliquid TESTNET.
**Result: BUILT and verified through the draft stage in the simulator.
End-to-end order test NOT run — the two preconditions are still pending
(see "Pending preconditions"). No order was submitted, nothing faked.**

## What was built

### Backend proxy (`proxy/`, localhost only, `http://127.0.0.1:8899`)
- `server.mjs` (plain `node:http`, no framework) — `GET /health`,
  `GET /demo-phrase`, `POST /stt`, `POST /draft`, `POST /order`. CORS `*`.
  Left running.
- `stt.py` — Groq Whisper `whisper-large-v3-turbo`, `language: id`, via the
  Groq connector helper (`groq.py run`, credential bridged as a surrogate —
  the raw key never touches the proxy's files, env, or logs).
- `parse.mjs` — transcript → draft: Indonesian "beli/jual" + coin + size;
  decimal comma ("0,01"), number words ("nol koma nol satu"), fuzzy
  side-word match (Levenshtein ≤ 2) for STT noise; defaults ETH 0.01 /
  BTC 0.001 when no size is spoken.
- `hl.mjs` — Hyperliquid testnet order signing + submission, mirroring
  hyperliquid-python-sdk exactly (msgpack action + nonce + vault byte →
  keccak → phantom agent `source: "b"` (testnet) → EIP-712 `Agent` type;
  wire `{a, b, p, s, r, t}`, `float_to_wire`, IOC ±3% slippage, `$10`
  minimum notional, funding check first).
- `proxy/.env` (mode 600) holds the testnet API wallet
  (`0xbc7d5d260e94207aab1fc139c1bf66d335930f59`). The private key is read at
  runtime only — never printed, logged, or bundled into the app/`.ehpk`.
- `proxy/demo-phrase.wav` — "saya mau beli nol koma nol satu ethereum"
  (espeak-ng mbrola-id1 Indonesian voice, 22050 Hz WAV) for simulator demos.

### App (`src/main.ts`, one container, mode state machine)
- Contextual menu (`menuObject` at page creation): "Voice order" (1),
  "Demo voice" (2), "Back to glance" (3). Selections via
  `event.menuItemClickEvent`; checked FIRST in the event handler (a
  menu-click envelope can carry a sysEvent with omitted zero-value
  `eventType`, which would otherwise misread as CLICK). Taps within 400 ms
  of a menu selection are ignored, so a menu tap can never confirm an order.
- Voice flow: tap → record (mic `audioControl(true, Glasses)`, falls back to
  Phone; auto-stop 5 s; silence detected and reported without calling STT)
  → `/stt` → `/draft` → draft screen (side/size/coin, live mid, est. value,
  transcript) → tap CONFIRM → `/order` → FILLED/RESTING/FAILED screen.
  "Back to glance" discards the draft. Never auto-submits.
- `app.json`: added `g2-microphone` + `phone-microphone` permissions
  (array-of-objects WITH `desc` — the pack validator rejects bare entries).

## Verification evidence

- **Signing oracle (byte-identical):** the same fixed order (ETH buy 0.01 @
  limit 1765, nonce 1795477000000) signed by the official Python SDK and by
  `proxy/hl.mjs` produced the SAME signature:
  `r 0x9e2ddd36…3071f, s 0x647f7539…0714e, v 28`. Action wire identical.
- **STT:** demo WAV → `{"transcript": "Saya mau beli 0,01 Ethereum"}`
  (1.3 s). First espeak-ng default voice transcribed badly
  ("Pelin 0,0 satu et freum."); the mbrola-id1 voice + full sentence fixed it.
- **Draft parse unit checks:** "Saya mau beli 0,01 Ethereum" → buy 0.01 ETH;
  "Pili 0,01 Ethereum" → buy 0.01 ETH (fuzzy); "beli nol koma nol satu
  ethereum" → buy 0.01 ETH; "jual 0,001 bitcoin" → sell 0.001 BTC;
  "halo apa kabar" → error (no side); "jual dua ethereum" → sell 2 ETH.
- **Simulator, demo flow (twice, incl. after rebuild):** menu → "Demo voice"
  → console `VOICE demo transcript: Saya mau beli 0,01 Ethereum` →
  `VOICE draft: buy 0.01 ETH` → draft screen renders:
  `BUY 0.01 ETH-PERP / Market ~$1,709.50 / Est. value ~$17.10 /
  "Saya mau beli 0,01..." / tap=CONFIRM / menu > Back = cancel`
  (`docs/screenshots/09-after-menu-nav-black.png`,
  `12-draft-v2-black.png`).
- **Simulator, mic path:** tap "Voice order" → tap record →
  `VOICE audioControl glasses: false` → fallback
  `VOICE audioControl phone: false` → "Mic unavailable / Try menu >
  Demo voice" notice (`11-after-record-black.png`). The simulator has no
  microphone; the fallback chain and notice work as designed. On hardware
  the glasses mic is primary.
- **Menu navigation in the simulator:** `POST /api/input
  {"action": "context_menu"}` then `down`/`click` selects items
  (`menuItemClickEvent itemID 2` and `3` observed in console). The menu
  overlay does NOT appear in framebuffer/webview screenshots — watch the
  console, not the picture.
- **Glance still live:** BTC $61,196.50 / ETH $1,709.45, ACCT $0.00,
  NO POSITIONS (`06-glance-live-black.png`).
- **Build:** `tsc --noEmit && vite build` clean, single bundle 94.54 kB.
  **Pack:** `npm run pack` → `out.ehpk` 40,046 bytes, min_app_version 2.2.10.
- **Fixes during the build (attempts used):** (1) `MenuItemProperty` plain
  objects rejected by TS — use `new MenuItemProperty(...)` instances.
  (2) Levenshtein "pili"/"beli" is distance 2, not 1 — fuzzy threshold
  raised to ≤ 2. (3) `pkill -f 'node server.mjs'` killed my own shell —
  use a bracketed regex (`server[.]mjs`) for process matching.

## Pending preconditions (checked 3×, last ~08:00 WITA)

1. **Deposit: 20 test USDC still on HyperEVM, trading account $0.00.**
   `clearinghouseState` accountValue `0.0`; HyperEVM USDC balanceOf still
   20.0. A browser task is depositing it via the testnet app.
   Watch-out: the deposit is an EVM transaction that needs HYPE gas, and
   the wallet holds 0 HYPE. If the app asks for gas, the untested lead is
   the ZalalenA faucet (claims no login/balance) or asking Discord
   #testnet-support for a little test HYPE. All other HYPE faucets
   (Quicknode/Chainstack/Alchemy) need a mainnet balance Bozz doesn't have.
2. **API wallet not approved yet:** `extraAgents` for Bozz's main account
   is `[]` — `0xbc7d…` is not listed. Same browser task is approving it
   (More → API in the testnet app).

Once both land, the end-to-end test is one tap in the simulator: menu →
"Demo voice" → tap CONFIRM (BUY 0.01 ETH, ~$17) → expect ORDER FILLED with
an order id, then the glance screen shows the open position. The proxy's
`/order` already validates funding and the $10 minimum before signing.

## Currently running (left alive)

- Vite dev server (5173), simulator under Xvfb (automation 9898),
  proxy (`node server.mjs`, 127.0.0.1:8899). Start the proxy with
  `cd proxy && node server.mjs` if it dies — the voice flow needs it.
- Not done: end-to-end order test (blocked on the two preconditions above);
  `evenhub create/upload` (needs the Even account + Fri submission flow).
