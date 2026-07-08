# Max ↔ Telegram Bridge

A **two-way messaging bridge** between [Max Messenger](https://web.max.ru) and Telegram, built on **Playwright**. Max exposes no public API, so the bridge drives the Max web client through a headless, persistent browser context — scraping the chat list and message DOM, relaying media, and typing replies back — while Telegram's Bot API handles the other side of the link.

The headline mode maps **each Max chat to its own Telegram forum topic**, turning a Telegram supergroup into a unified inbox you can read *and* reply from.

---

## Why it's interesting

Max is a young Russian messenger with **no bot API and no official integrations**. Bridging it therefore means treating the web app as the integration surface: reverse-engineering its Svelte DOM, surviving QR-based auth, and reconciling a scraped, ID-less message stream against Telegram's structured API. This repo is a compact (~2k LOC) but complete take on that problem — session persistence, rate-limit handling, media relay, and a self-healing main loop included.

## Architecture

```
        ┌──────────────────────┐         ┌───────────────────────┐
        │   Max Messenger       │         │      Telegram          │
        │   (web.max.ru SPA)    │         │      (Bot API)         │
        └──────────┬───────────┘         └───────────┬───────────┘
                   │  Playwright                       │  HTTPS
                   │  (persistent Chromium context)    │  (Bot API)
        ┌──────────▼───────────────────────────────────▼──────────┐
        │                    max_bridge.js                          │
        │                                                           │
        │  Max → TG   sidebar scan → open chat → scrape messages →  │
        │             download media → post to the chat's topic     │
        │                                                           │
        │  TG → Max   getUpdates → match topic → find Max chat →    │
        │             type reply into Max composer                  │
        │                                                           │
        │  topicMap : { "Max chat name" ↔ Telegram topic id }       │
        └───────────────────────────────────────────────────────────┘
```

### Two entry points

| File | Mode | Direction | Chat mapping |
|------|------|-----------|--------------|
| **`max_bridge.js`** | Full bridge | **Two-way** | Every Max chat → its own Telegram **forum topic**; replies in a topic are typed back into the matching Max chat |
| **`max_forwarder.js`** | Forwarder | One-way | A configured list of Max groups → a single Telegram chat (richer media coverage: voice, video, stickers) |

`max_bridge.js` is the primary, most capable component; `max_forwarder.js` is the earlier one-way forwarder kept as a lighter-weight alternative.

## Key techniques

- **Playwright persistent context** — `chromium.launchPersistentContext(session_dir, …)` keeps the Max login (cookies + local storage) on disk, so the bridge survives restarts without re-scanning a QR code. Fonts are route-aborted to cut bandwidth.
- **QR-login flow over Telegram** — on first run (or session expiry) the bridge screenshots the QR panel and delivers it to the admin chat, retrying and refreshing the code every ~30s until the scan lands, then confirms success.
- **Forum-topic-per-chat mapping** — `getOrCreateTopic()` lazily creates a Telegram forum topic per Max chat and persists the `chatName ↔ topicId` map, so conversations stay cleanly separated and addressable in both directions.
- **DOM scraping resilient to a minified SPA** — chat list and message extraction rely on layered `[class*="…"]` selectors plus geometric heuristics (element height/width) and fallbacks, because Max ships hashed Svelte class names.
- **Content-hash de-duplication** — with no stable message IDs exposed, each message is keyed by `sender|text|time`; the last ~200 keys per chat are stored to detect genuinely new messages and to suppress echo of the bridge's own outgoing replies.
- **Media relay** — images, files, voice, video and stickers are fetched *inside the page context* (`fetch` → blob → base64) so authenticated Max CDN URLs resolve with the live session cookies, then re-uploaded to Telegram via multipart `sendPhoto`/`sendDocument`/`sendVoice`/`sendVideo`.
- **Rate-limit aware Telegram client** — a hand-rolled Bot API wrapper (no SDK) adds inter-call spacing plus `429` / `retry_after` backoff and bounded retries.
- **Phantom-unread cooldown** — chats whose unread badge persists without new messages get an exponential backoff (30s → 5min) to avoid pointlessly re-opening them every cycle.
- **Self-healing loop** — detects session expiry and dead/disposed browser targets, then re-navigates or relaunches Chromium and re-authenticates automatically; crashes are reported to the admin chat.
- **Local health server** — `http://127.0.0.1:3217` exposes `/health`, `/topics`, `/screenshot` (live page capture) and `/qr-reauth` for observability and manual re-login.

## Getting started

### Prerequisites
- Node.js 18+
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- For two-way mode: a Telegram **supergroup with Topics enabled**, and the bot added as an admin with "Manage Topics" permission
- A Max account (scanned once via QR)

### Install
```bash
npm install          # also runs `playwright install chromium`
```

### Configure
Provide configuration via **environment variables** (recommended) or a `config.json` file. Environment variables take precedence.

```bash
cp .env.example .env
# edit .env with your bot token and chat IDs
```

or

```bash
cp config.example.json config.json
# edit config.json
```

To find your chat IDs: forward a message from the group to [@userinfobot](https://t.me/userinfobot), or read `getUpdates` output while messaging the bot.

### Run
```bash
# Two-way bridge (forum-topic-per-chat)
npm run bridge      # node max_bridge.js

# One-way forwarder (groups -> single chat)
npm run forwarder   # node max_forwarder.js
```

On first launch the QR code is sent to your admin chat — open **Max → Settings → Devices → Scan QR** on your phone. Once linked, the session is cached in `session/` and reused on subsequent runs.

### Run as a service (optional)
An example `max-forwarder.service` unit is included. Edit the paths, then:
```bash
sudo cp max-forwarder.service /etc/systemd/system/
sudo systemctl enable --now max-forwarder
```

## Configuration reference

| config.json key | Env var | Used by | Description |
|-----------------|---------|---------|-------------|
| `telegram_bot_token` | `TELEGRAM_BOT_TOKEN` | both | Bot token from @BotFather |
| `telegram_forum_chat_id` | `TELEGRAM_FORUM_CHAT_ID` | bridge | Supergroup (Topics enabled) that hosts one topic per Max chat |
| `telegram_admin_chat_id` | `TELEGRAM_ADMIN_CHAT_ID` | both | Receives QR screenshots + admin alerts |
| `telegram_chat_id` | `TELEGRAM_CHAT_ID` | forwarder | Destination chat for one-way forwarding |
| `max_groups` | `MAX_GROUPS` (comma-sep) | forwarder | Max group/chat names to monitor |
| `check_interval_ms` | `CHECK_INTERVAL_MS` | both | Poll interval (default 5000) |
| `session_dir` | `SESSION_DIR` | both | Persistent browser profile directory |
| `downloads_dir` | `DOWNLOADS_DIR` | both | Scratch dir for media relay |
| `screenshots_dir` | `SCREENSHOTS_DIR` | both | QR / debug screenshots |
| `state_file` | `STATE_FILE` | both | JSON state (topic map, seen keys, TG offset) |
| `headless` | `HEADLESS` | both | Run Chromium headless (default true) |
| `ignored_chats` | — | bridge | Max chat names to skip |

## Health endpoints

With the bridge running, on `127.0.0.1:3217`:

| Endpoint | Purpose |
|----------|---------|
| `/health` | Status, uptime, topic count |
| `/topics` | Current `chatName → topicId` map |
| `/screenshot` | Live PNG of the Max page |
| `/qr-reauth` | Trigger a fresh QR-login flow |

## Notes & limitations

- The bridge depends on Max's web DOM; a significant redesign of `web.max.ru` may require selector updates in `listSidebarChats()` / `extractMessages()`.
- Max exposes no stable message IDs, so de-duplication is content-based and best-effort.
- `session/`, `screenshots/`, `downloads/`, state files and `.env` / `config.json` are git-ignored — they contain live login data or secrets.

## License

MIT
