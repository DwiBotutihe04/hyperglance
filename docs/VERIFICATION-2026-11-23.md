# HyperGlance — Night 1 verification (Mon 23 Nov 2026, ~20:19 WITA)

Tonight's target: skeleton app + 1 container rendering in the Even Hub simulator.
**Result: DONE and verified.**

## What renders

One startup page, one full-canvas text container (576×288) on the G2 display:

```
HYPERGLANCE · HL TESTNET
--------------------------
ETH-PERP   +$12.40
BTC-PERP   -$3.10
--------------------------
MOCK DATA · tap = refresh
Taps: 0 · 2x tap = exit
```

Tap cycles two mock snapshots (ETH +$12.40→+$12.95, BTC -$3.10→-$2.75) and
increments the tap counter — input path + `textContainerUpgrade` verified live
via `POST /api/input {"action":"click"}`. Double-tap exits (template logic,
not re-tested tonight). No network calls, no trading logic — mock data only.

## Evidence

- `docs/screenshots/01-initial-glasses-framebuffer.png` — raw 576×288 RGBA
  framebuffer, initial state (snapshot 0).
- `docs/screenshots/02-after-tap-glasses-framebuffer.png` — raw framebuffer
  after one simulated tap (snapshot 1, "Taps: 1").
- `docs/screenshots/01/02-*-black.png` — same frames composited on black,
  readable in any image viewer.
- `docs/screenshots/03-companion-webview.png` — companion WebView page.
- Simulator console: `[EvenAppBridge] Bridge initialized` →
  `Page created: success`; tap arrived as
  `EvenHub event: {"jsonData":{"eventSource":1},"sysEvent":{"eventSource":1}}`
  (note: `sysEvent.eventType` absent = CLICK_EVENT 0, as expected).
- Build: `tsc --noEmit && vite build` clean; single JS bundle
  `dist/assets/index-*.js` (83.91 kB, `inlineDynamicImports: true`).
- Pack: `npm run pack` → `out.ehpk` (36,135 bytes), `min_app_version 2.2.10`.

## How to (re)start

```bash
cd ~/workspace/even-realities/hyperglance
export PATH="$HOME/.npm-global/bin:$PATH"   # evenhub + evenhub-simulator live here
npm run dev                                 # Vite on http://localhost:5173
npm run simulate                            # xvfb-run -a evenhub-simulator --automation-port 9898 http://localhost:5173
```

Currently running (left alive 23 Nov ~20:19 WITA): Vite dev server (PID 7396,
port 5173), simulator under Xvfb :99 (automation API port 9898).
Simulator automation: `curl localhost:9898/api/ping` → `pong`;
`/api/screenshot/glasses` → 576×288 RGBA PNG; `/api/console`;
`POST /api/input {"action":"click"|"double_click"|...}`.

## Quirks found tonight (sim-only, record for Tue/Wed)

1. **Framebuffer PNG is mostly transparent.** The glasses screenshot's text
   pixels are opaque green `(0,255,0,255)` on a TRANSPARENT background
   `(0,255,0,0)` — only ~2,837 of 165,888 px are opaque. Viewed raw it looks
   like a solid green rectangle; composite over black to read it. This is a
   simulator rendering artifact, not an app bug.
2. **Pack validator needs `desc` on every permission.** `app.json`
   permissions must be `[{"name": "network", "desc": "...≤300 chars"}]` —
   a bare `{"name": "network"}` fails `evenhub pack` with
   `Invalid app.json: permissions.0.desc`. Fixed in app.json.
3. **SDK 0.0.16 floor is min_app_version 2.2.10**, not 2.0.0. The pack CLI
   auto-stamps the higher value with a warning; `app.json` now sets 2.2.10
   directly so pack output is clean.
4. **Tap event quirk confirmed live:** a click arrives with `sysEvent`
   carrying NO `eventType` (protobuf omits the 0 value) — the template's
   `eventTypeOf()` helper (resolve default INSIDE the envelope check) works.
5. **Simulator needs Xvfb headless** (`xvfb-run -a`); bare
   `evenhub-simulator` panics on GTK init without a display. DRI3/AT-SPI
   warnings in the sim log are harmless headless noise.
6. Restart the simulator after `src/` edits — HMR alone leaves a stale page
   container (per plan; not re-tested tonight).

## Not done (by design — Tue/Wed)

- Read path (live Hyperliquid testnet positions/PnL/mark price) — Tue 24 Nov.
- Write path (voice → STT → draft → tap confirm → testnet order) — Wed 25 Nov.
- Backend proxy (holds testnet credentials + Groq Whisper server-side).
- Hyperliquid testnet USDC still 0 — faucet blocked (no mainnet history);
  needs Discord request or another funded testnet wallet before the write
  path can be tested end-to-end.
- Even Hub portal account still pending (Bozz must create it in the phone app).
- `evenhub create/upload` not attempted — needs the Even account + DoraHacks
  submission flow (Fri 27 Nov).
