# CLAUDE.md — FB → Telegram Bot

## Project Overview

This is a Node.js bot that mirrors posts from two Facebook Pages (IML and IMBB) to a single Telegram channel in real-time. It uses Facebook Webhooks to receive events, fetches full post data via the Graph API, and forwards content to Telegram via the grammy library.

## Architecture

```
Facebook Webhook (POST /webhook)
        │
        ▼
   src/index.js        — Express server, webhook handler, page routing
        │
        ├─ src/facebook.js   — Graph API fetching & post normalization
        ├─ src/telegram.js   — Telegram sending logic (all content types)
        └─ src/store.js      — Three-layer deduplication, persisted to posted.json
```

## Key Behaviours

### Two-Page Deduplication

- **IML** is the preferred source of truth — processed immediately
- **IMBB** posts are delayed 8 seconds to let IML win dedup races on simultaneous posts
- Three dedup layers: post ID, content hash (SHA-1 of text + first image), source URL

### Content Type Handling

| Facebook Type    | Telegram Output                                                    |
| ---------------- | ------------------------------------------------------------------ |
| `status`         | Text message                                                       |
| `photo`          | Photo with caption (or no caption + follow-up text if >1024 chars) |
| `album`          | Media group, caption on first image                                |
| `video`          | Video upload if ≤50MB, else thumbnail + fallback text              |
| `link` / `share` | Photo preview + text + URL                                         |

### Text Overflow

- Telegram caption limit: 1024 chars
- Telegram message limit: 4096 chars
- If text exceeds caption limit: media sent with NO caption, full text sent as follow-up message

### Known Issues / In Progress

- **Shared videos from IMBB** — when IML shares an IMBB video, attachment `media_type` may not come back as `"video"`, causing fallback to thumbnail. Debug logging is in place in `facebook.js` — awaiting a real shared video post to capture the raw attachment payload and fix type detection.

## Environment Variables

| Variable                        | Description                             |
| ------------------------------- | --------------------------------------- |
| `TELEGRAM_BOT_TOKEN`            | From @BotFather                         |
| `TELEGRAM_CHANNEL_ID`           | `@username` or numeric ID               |
| `FACEBOOK_PAGE_ACCESS_TOKEN`    | Long-lived token, expires every 60 days |
| `FACEBOOK_IML_PAGE_ID`          | IML Facebook Page ID                    |
| `FACEBOOK_IMBB_PAGE_ID`         | IMBB Facebook Page ID                   |
| `FACEBOOK_WEBHOOK_VERIFY_TOKEN` | Secret string for webhook verification  |
| `FACEBOOK_APP_SECRET`           | App secret for HMAC-SHA256 webhook signature verification |
| `PORT`                          | Server port (default 3000)              |

## Dependencies

| Package     | Purpose                             |
| ----------- | ----------------------------------- |
| `express`   | HTTP server for webhook endpoint    |
| `grammy`    | Telegram Bot API client             |
| `axios`     | HTTP requests to Facebook Graph API |
| `dotenv`    | Environment variable loading        |

## Facebook API Notes

- Graph API version: `v21.0`
- Required permissions: `pages_read_engagement`, `pages_read_user_content`, `pages_manage_metadata`
- Page Access Token must be long-lived (exchange via oauth endpoint, valid 60 days)
- Both pages must be subscribed via POST `/me/subscribed_apps` with `subscribed_fields=feed`
- Webhook must be registered in Facebook Developer dashboard under Webhooks → Page → feed

## Hosting

- Deployed on Railway (always-on, auto-deploys from GitHub main branch)
- Public URL required for Facebook webhook delivery
- `posted.json` is written to the project root for dedup persistence — ensure Railway doesn't wipe it on redeploy (it shouldn't by default)

## Development Notes

- Run locally with `npm start` (requires `.env` file)
- Use `npm run dev` for nodemon auto-reload
- Facebook webhooks require a public HTTPS URL — use ngrok for local testing
- Test webhook delivery via Facebook Developer dashboard → Webhooks → Test button
- The `[DEBUG]` log in `facebook.js` `normalizePost()` is temporary and should be removed once the shared video issue is resolved
