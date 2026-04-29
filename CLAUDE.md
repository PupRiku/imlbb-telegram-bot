# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # Run the server (production)
npm run dev      # Run with nodemon (auto-restart on file changes)
```

There are no tests or linting scripts defined.

## Environment

Copy `.env.example` to `.env` and fill in all six variables before running. The server will start but silently fail to post if tokens are missing.

`posted.json` is auto-created at the project root on first successful post. It is gitignored and persists deduplication state across restarts.

## Architecture

The bot is a single Express webhook server with three source files:

**`src/index.js`** — Entry point and orchestrator. Handles Facebook webhook verification (`GET /webhook`) and incoming post events (`POST /webhook`). On a new post event, it calls `fetchPost` → `checkDuplicate` → `sendPost` → `markPosted`. IML posts are processed immediately; IMBB posts are delayed 8 seconds (`IMBB_DELAY_MS`) so IML wins the deduplication race when both pages fire simultaneously. Always responds `200` to Facebook immediately before async processing to prevent retries.

**`src/facebook.js`** — Fetches a full post from the Facebook Graph API v19.0 and normalizes it into a consistent internal shape: `{ id, text, type, photos, video, link, sourceUrl }`. The `type` field drives which Telegram sender is used. For shared posts, `sourceUrl` captures the original post URL for dedup layer 2.

**`src/telegram.js`** — Sends normalized post objects to the Telegram channel using grammY. Dispatches to a type-specific sender (`sendText`, `sendPhoto`, `sendAlbum`, `sendVideo`, `sendLink`). All senders handle Telegram's 1024-char caption limit by sending media with no caption and following up with a separate text message when overflow occurs. Videos over 50 MB fall back to thumbnail + link. Albums over 10 photos are split into two `sendMediaGroup` calls.

**`src/store.js`** — In-memory deduplication store backed by `posted.json`. Three layers: (1) exact post ID, (2) source URL of shared posts, (3) SHA-1 content hash (text + first image URL) within a 15-minute window. Each collection is capped at 500 entries (FIFO eviction). Loaded from disk at startup, written to disk after every `markPosted` call.

## Deduplication Flow

```
postId seen?        → skip (layer 1)
sourceUrl seen?     → skip (layer 2)
content hash recent? → skip (layer 3, 15-min window)
                    → forward, then markPosted
```

IML is the canonical source. If IMBB fires for the same content within 15 minutes of IML, the content hash check drops it.

## Deployment

Hosted on Railway. The `PORT` env var is set by Railway automatically; the default fallback is `3000`. The `/health` endpoint is used by Railway for health checks.
