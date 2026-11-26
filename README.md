# PolyGlance

A smart-glasses app for the Even Realities G2 that lets crypto holders check
prices, prediction-market odds, a virtual portfolio, and price alerts at a
glance — with **voice commands** and **Telegram alerts** that keep working
when the glasses app is closed — built for the **Heads Up: Even Realities
Hackathon** (track: **Crypto & DeFi**), solo by
[@ilham270207](https://github.com/ilham270207).

> **Data only — not financial advice. Virtual money, no real funds.**

## What it does

One page, one full-screen text container (576×288, green monochrome).
**Tap** switches views, **double-tap** exits, **swipe up/down** acts per view.

| View | Content | Swipe up / down |
| --- | --- | --- |
| **TICKER** | BTC, ETH, SOL, DOGE, XRP prices (CoinGecko) and 24h change, auto-refresh every 60s | Manual refresh |
| **ODDS** | Top 3 crypto markets on Polymarket (YES % by 24h volume), each shown as a short distinct label like `BTC dip $55,000? YES 38%` | Previous / next page of markets |
| **PAPER-BTC** | Virtual $10,000 portfolio: cash, BTC holding, total, P/L | Buy $100 BTC / sell $100 BTC |
| **PAPER-ETH** | Same shared cash, ETH holding, total, P/L | Buy $100 ETH / sell $100 ETH |
| **ALERTS** | Price alerts for BTC, ETH and SOL (v6): per-asset target + status (WAITING / `BTC HIT $X!`); Telegram bot row `@polyglance_alerts_bot`; **double-tap switches asset** | Target step per asset (BTC $1,000 / ETH $100 / SOL $10) |
| **ODDS-ALERT** | Odds alert (v7): alarm when a Polymarket market's YES % crosses a threshold; status WAITING / TRIGGERED! / OFF; **double-tap switches market** | Threshold step 5% (swipe down to 0 cancels) |
| **VOICE** | Push-to-talk voice commands via Groq Whisper (v6: `sell all bitcoin`, `show portfolio`, `cancel alert`, `buy 100 bitcoin`, `set alert 58000`; v7: `set odds alert 60`); live mic level meter | Start/stop listening / cancel |

- Paper trades are stored in `localStorage` (`polyglance.paper.v2`, migrated
  from v1 `{cash, btc}` with ETH starting at 0), so the portfolio survives
  restarts. Cash is shared between the BTC and ETH views; total = cash + BTC
  value + ETH value. Selling requires a holding worth at least $100,
  otherwise the glasses show `NOT ENOUGH BTC` / `NOT ENOUGH ETH` for
  3 seconds.
- The price alert arms automatically once a target is set (default: the next
  step above the current price per asset). When an asset reaches its target
  the glasses show e.g. `BTC HIT $X!` and jump to the ALERTS view. Targets
  and status are stored per asset in `localStorage`
  (`polyglance.alert.v2`, migrated from v1 BTC-only); a cancelled alert is
  never silently re-armed on refresh.
- **Odds alerts (v7):** one active odds alert at a time, stored in
  `localStorage` (`polyglance.odds-alert.v1`, no default, no seeded flag).
  Set it from the ODDS-ALERT view (swipe up = above, swipe down = below,
  step 5%; swipe down to 0 cancels), by voice (`set odds alert above 60`,
  `odds alert below 40`, `cancel odds alert`), or via Telegram
  (`/alertodds btc dip above 60`). Every ODDS refresh checks the alert;
  on crossing, the glasses show `TRIGGERED!` and jump to the ODDS-ALERT
  view. A cancelled alert is never re-armed.
- If a fetch fails, the app keeps showing the last data with an
  `OFFLINE - last data` line instead of going blank.
- All on-glasses text is plain ASCII (max 8 lines, 34 chars per line).

## Voice + Telegram (v6)

- **Voice commands (VOICE view):** push-to-talk on the glasses mic
  (`g2-microphone` permission). Audio is transcribed with Groq Whisper
  (`whisper-large-v3-turbo`) and run through a local command parser
  (`src/voice.ts`, 70/70 unit tests) — the same parser the settings-page
  command chips use, so commands are testable without speaking. New in v6:
  `sell all bitcoin` / `sell all`, `show portfolio`, and `cancel alert`.
  New in v7: `set odds alert above 60` / `odds alert below 40` /
  `cancel odds alert` (threshold validated 5–95).
  Without a Groq key the view explains how to set one.
- **Your key stays on your phone:** the Groq API key is entered in the
  companion settings page and stored in `localStorage` only — it is never
  sent anywhere except `api.groq.com` for transcription. If the direct
  Groq call fails or times out, the app falls back to your own Cloudflare
  Worker STT proxy (`POST /stt`, URL also set in settings); the proxy holds
  its own key as a Worker secret, so the glasses never need a direct
  connection to Groq.
- **Telegram alerts:** a Cloudflare Worker watcher (`watcher/`, cron every
  minute) polls prices and runs the bot **@polyglance_alerts_bot**:
  `/alert btc above 58000`, `/price`, `/odds`, `/list`, `/remove 1`,
  `/health`, `/help`. New in v7: `/alertodds <keyword> above|below <pct>`
  (e.g. `/alertodds btc dip above 60`) — the Worker checks odds alerts
  each tick and fires once per crossing. Alerts fire once per crossing and keep working even
  when the glasses app is closed. The bot token is a Worker secret only —
  never in this repo. Price source is CoinGecko with a Coinbase spot
  fallback (CoinGecko returns 403 to Workers); see
  `watcher/README.md` for deploy steps.

## Screenshots

Glasses display (576×288), captured in the Even Hub simulator.

![TICKER — live prices for 5 coins](images/frame-ticker-v6.png)

*TICKER (v6) — live BTC, ETH, SOL, DOGE, XRP prices from CoinGecko, auto-refresh every 60 seconds.*

![ODDS — Polymarket crypto markets](images/frame-odds-v5.png)

*ODDS — top crypto markets on Polymarket with live YES %, each with a short distinct label (v5).*

![PAPER — virtual $10,000 portfolio](images/frame-paper.png)

*PAPER — virtual $10,000 portfolio, buy/sell $100 per swipe.*

![VOICE — push-to-talk voice commands](images/frame-voice-v5.png)

*VOICE — push-to-talk voice commands via Groq Whisper (v5 capture; v6 adds `sell all bitcoin`, `show portfolio`, `cancel alert`).*

![ALERTS — multi-asset price alerts + Telegram bot](images/frame-alerts-v6.png)

*ALERTS (v6) — price alert for ETH (target $1,800, WAITING) with the Telegram bot row (`@polyglance_alerts_bot`); double-tap switches asset (BTC → ETH → SOL).*

## Demo

▶️ [Watch the 86-second demo on YouTube](https://www.youtube.com/watch?v=7jwChwKZxKQ) — "PolyGlance — Crypto at a Glance on Even Realities G2 (Voice + Telegram)": TICKER, ODDS, paper trading, ALERTS, a live voice command, and the Telegram bot in action.

## Tech stack

- **Vite + TypeScript** (template `even-realities/evenhub-templates/minimal`)
- **Even Hub SDK** `@evenrealities/even_hub_sdk` 0.0.10
- **Node.js** 20 LTS or newer (developed on Node v24 in Termux)
- **Core app: no backend, no API keys.** Data comes straight from public APIs:
  - [CoinGecko](https://api.coingecko.com/api/v3/simple/price) — BTC/ETH/SOL/DOGE/XRP prices
  - [Polymarket Gamma API](https://gamma-api.polymarket.com/markets) — market odds
- **Voice (optional):** your own Groq API key, stored on-phone only (see
  above). **Telegram alerts (optional):** Cloudflare Worker in `watcher/`
  (free tier, cron every minute; secrets via `wrangler secret put`).
- The app runs as a web app in the phone's WebView; the G2 glasses are only
  the display + input (no code runs on the glasses).

## Getting started

```bash
# 1. Tooling (Node 20 LTS or newer)
npm install -g @evenrealities/evenhub-cli @evenrealities/evenhub-simulator

# 2. Scaffold from the official template (already done in this repo)
npx degit even-realities/evenhub-templates/minimal polyglance
cd polyglance
npm install

# 3. Dev server (Vite on http://localhost:5173)
npm run dev

# 4. Simulator (separate terminal, desktop only)
evenhub-simulator http://localhost:5173

# 5. Production build + .ehpk package (optional for submission)
npm run build
npm run pack
```

Notes:

- The simulator is a native desktop window and does not run in Termux —
  coding + `npm run dev` + `npm run build` work from Termux on Android,
  simulator testing needs a PC.
- `app.json` whitelists the two API domains under the `network` permission.

## Install (.ehpk)

`polyglance.ehpk` (in this repo) is the packaged v7 app — load it in the
Even Hub simulator or the Even App to try it without building.

## Project structure

```
app.json          # Even Hub manifest (package id, SDK version, network whitelist, g2-microphone)
src/main.ts       # Whole app: bridge setup, 7 views, paper trade BTC+ETH, price alerts, odds alerts, voice
src/voice.ts      # Voice command parser + PCM-to-WAV + mic level (unit-tested)
src/stt.ts        # Groq Whisper STT + Worker proxy fallback (unit-tested)
index.html        # Vite entry + companion settings page (Groq key, STT proxy URL, test chips)
vite.config.ts    # Vite config (template)
images/           # Simulator screenshots (TICKER / ODDS / PAPER / VOICE / ALERTS)
watcher/          # Telegram bot + price watcher (Cloudflare Worker, Node fallback, tests)
tests/            # Unit tests: voice parser (70), STT fallback (18), watcher core (53)
polyglance.ehpk   # Packaged v7 app for the simulator / Even App
```

## Submission

- Hackathon: Heads Up: Even Realities Hackathon (DoraHacks)
- Track: Crypto & DeFi
- Demo video: ≤ 3 minutes, recorded in the simulator
- Deadline: 30 Nov 2026 02:59 WIB (29 Nov 2026 19:59 UTC)

## License

MIT — see the template repository
[even-realities/evenhub-templates](https://github.com/even-realities/evenhub-templates).
