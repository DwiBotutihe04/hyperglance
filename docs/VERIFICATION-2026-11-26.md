# HyperGlance — Night 4 verification (Thu 26 Nov 2026, ~11:55–12:10 WITA)

Tonight's target: restart the toolchain after the VM restart, implement the
one missing must-have (price/liquidation alert), polish, update the README,
record the demo video, re-pack.
**Result: DONE. All three must-haves are now built and verified in the
simulator. The live order is still blocked by funding (see below) — nothing
faked, the video shows the real blocked outcome.**

## 1. Toolchain restart (after VM restart)

- All processes were dead (ports 8899/5173/9898 empty) and
  `libwebkit2gtk-4.1.so.0` was gone again (VM image reset, same as 24 Nov).
- Fix: `sudo apt-get update` FIRST (apt lists were stale — the package was
  "unable to locate" without it), then `sudo apt-get install -y
  libwebkit2gtk-4.1-0`. Simulator starts cleanly after that (DRI3 warnings
  harmless, as before).
- Started: proxy `node server.mjs` (8899, `/health` ok, apiWallet
  `0xbc7d…`), Vite dev server (5173, HTTP 200), Xvfb `:99` + simulator
  (automation 9898, `pong`).
- `evenhub`/`evenhub-simulator` live in `~/.npm-global/bin` — not on the
  default PATH; export it before `npm run pack` (pack fails with
  `evenhub: not found` otherwise).
- Trap re-hit and avoided: `pkill -f 'evenhub-simulator'` matches its own
  shell — use a bracketed pattern or kill by PID.

## 2. Read path re-verified (live)

- Glance in the simulator at 11:55 WITA: **BTC $62,056.00 / ETH $1,723.20,
  ACCT $0.00, NO POSITIONS** (`docs/screenshots/13-glance-2026-11-26-black.png`).
  Console: `HL live: BTC 62056.0 ETH 1723.2 acct 0 pos 0`. A later refresh
  showed BTC $62,102.00 — the re-fetch is real.
- No positions, no PnL — shown honestly, as before.

## 3. Alerts — implemented and verified

`src/main.ts` (new code, ~150 lines):

- **Price move:** a coin's mark moves ≥ 1% vs the price at app start
  (baseline = first successful live fetch). Latched per coin + direction
  until the move falls back under 0.5%, so it fires once per move.
- **Liquidation proximity:** a position's mark comes within 5% of its
  liquidation price (`liquidationPx` from `clearinghouseState`, now parsed
  into `Position.liqPx`). No open positions ⇒ never fires.
- **Behaviour:** fires only in glance mode (never interrupts a voice/draft
  flow — it latches and waits); alert screen + best-effort beep; tap
  acknowledges → back to glance, where the alert stays as a one-line
  `ALERT …` footer banner until the condition clears. Glance
  auto-refreshes every 30 s so alerts can fire without a tap.
- **Sound — honest limitation:** the Even SDK (0.0.16) exposes no speaker
  API, so the beep is a best-effort WebAudio tone in the page (may only
  sound on the phone companion). The on-glasses visual alert is the
  reliable channel. Documented in README §Alerts.
- **Test alert:** menu → "Test alert" (item 4) shows the alert screen
  labelled `TEST ALERT` ("This is a self-test / No market event") so the
  display + sound can be checked without faking a market event.
- **Verification:** menu navigation `context_menu` → down ×3 → click →
  console `VOICE menu item: 4` + `ALERT test shown`; screen renders
  (`docs/screenshots/14-alert-test-black.png`); tap acknowledges → glance
  returns (`15-glance-after-alert-black.png`, caught mid-refresh).
- A real price alert did NOT fire during the session (BTC/ETH moved < 0.1%
  vs baseline) — correct behaviour, not a failure. The liq alert could not
  fire either (no positions). Both paths are code-reviewed + the test-alert
  path exercises the same screen/beep code.

## 4. Write path — exercised end-to-end, blocked by funding (honest)

- Menu → Demo voice → STT `Saya mau beli 0,01 Ethereum` → draft
  `BUY 0.01 ETH-PERP / Market ~$1,724.25 / Est. value ~$17.24`
  (`17-draft-2026-11-26-black.png`) → tap CONFIRM → proxy funding check
  refused with HTTP 402 (`account not funded: deposit test USDC first`).
- Result screen now shows the real reason instead of a bare HTTP code
  (small fix tonight: `postJson` surfaces the proxy's error body;
  `confirmOrder` maps it to `NOT FUNDED / deposit test USDC first`):
  `docs/screenshots/18-order-result-2026-11-26-black.png`.
- **No order was placed.** The funding block is real and unchanged: two
  20 USDC testnet deposits (24 Nov tx `0xa598…`, 26 Nov tx `0xd064…`)
  confirmed on-chain but NEVER credited — Perps/Spot still $0.00. A Discord
  #testnet-support post is being prepared separately. No re-deposit,
  re-claim, or email-wallet touch tonight. The proxy's `/order` validates
  funding before signing, so a live order cannot run until a deposit
  credits. Signing itself remains verified byte-identical to the official
  Python SDK (24 Nov).

## 5. Demo video — recorded from the simulator

- `docs/demo-video.mp4` (~60 s, 1152×576, ≤ 3 min limit): framebuffer
  frames captured at 2 fps via the simulator's own `/api/screenshot/glasses`
  while the real flow was driven through the automation API — live glance →
  test alert → acknowledge → demo voice → draft → confirm → honest
  `ORDER FAILED / NOT FUNDED` result → glance. Captions per segment + a
  closing card stating the funding block and that signing is verified
  byte-identical to the official SDK. No filled order is shown or implied.
- Frames: `/tmp/hg-video/frames/` (109 frames); driver:
  `/tmp/hg-video/drive.sh`; captions filter: `/tmp/hg-video/filter.txt`.

## 6. Build + pack

- `tsc --noEmit && vite build` clean; single bundle 97.07 kB
  (`dist/assets/index-BUgGJxEG.js`).
- `npm run pack` → **`out.ehpk` 41,200 bytes** (was 40,046), min_app_version
  2.2.10, stamped 26 Nov 12:07 UTC.

## Still pending (for Fri 27 Nov)

1. **Funding** — the only blocker for a live order: needs a deposit to
   credit (Discord #testnet-support post) or a fresh claim + deposit
   attempt. If it lands, the live test is one tap: menu → Demo voice →
   tap CONFIRM (BUY 0.01 ETH, ~$17) → expect ORDER FILLED + position on
   the glance screen.
2. **Even Hub account** — Bozz still has to create it from his phone
   (Even Realities app, joyceadiswara@gmail.com) before `evenhub create /
   upload` can run.
3. **GitHub repo** — not created yet (public repo + README needed for the
   DoraHacks submission). Needs auth from Bozz's side.
4. **Submit (Fri 27 Nov night)** — DoraHacks form: public repo link +
   demo video + description (problem, who it's for, how it works, Track 02)
   + optional `.ehpk`. Hard deadline Mon 30 Nov 03:59 WITA.

## Currently running (left alive)

- Vite dev server (5173), simulator under Xvfb :99 (automation 9898),
  proxy (`node server.mjs`, 127.0.0.1:8899). Logs: `/tmp/hg-proxy.log`,
  `/tmp/hg-vite.log`, `/tmp/hg-sim2.log`.
