# IMLBB Telegram Bot

A production Node.js service that mirrors Facebook page posts from the **International Mr. Leather (IML)** and **International Mr. Bootblack (IMBB)** pages to a Telegram announcement channel in real time — including text, images, video, and attachments.

Built to solve a real operational gap: no official Telegram announcement channel existed for IML/IMBB event updates, and manually copy-pasting social media posts was slow and error-prone.

**Status: Live in production on Railway.**

---

## The Problem

IML and IMBB maintain active Facebook pages for event announcements, but their Telegram audience had no reliable way to receive those updates without manually checking Facebook. Copy-pasting posts was tedious and inconsistent — especially when both pages sometimes post the same content independently.

This bot eliminates that manual work entirely.

---

## How It Works

```
IML Page Post          IMBB Page Post
      │                      │
      ▼                      ▼
      └──── Facebook Webhooks (real-time) ────┘
                       │
                       ▼
            Bot Server (/webhook endpoint)
                       │
                  ┌────┴──────────────────────────┐
                  │  3-Layer Deduplication         │
                  │  1. Post ID match              │
                  │  2. Source URL (shared posts)  │
                  │  3. Content hash (copies)      │
                  └────┬──────────────────────────┘
                       │
                       ▼
            Fetches full post via Facebook Graph API
            (text, images, video, attachments)
                       │
                       ▼
                 Telegram Bot API
                       │
                       ▼
            IMLBB Telegram Channel (posted once)
```

---

## Deduplication Logic

A core challenge: IML and IMBB sometimes post the same content independently. The bot handles this with three layers of deduplication:

| Scenario                           | Result                                               |
| ---------------------------------- | ---------------------------------------------------- |
| IML makes an original post         | ✅ Posted once                                       |
| IMBB copies that IML post verbatim | ❌ Skipped — content hash match within 15 min window |
| IMBB makes its own original post   | ✅ Posted once                                       |
| IML shares an IMBB post            | ❌ Skipped — source URL already forwarded            |

**IML is treated as the canonical source of truth.** When both pages fire simultaneously, IML's version is always kept and IMBB's is silently dropped. To manage race conditions, IMBB posts are delayed 8 seconds before processing to allow IML to win the race.

---

## Tech Stack

| Layer             | Technology            |
| ----------------- | --------------------- |
| Runtime           | Node.js               |
| Webhook Ingestion | Facebook Webhooks API |
| Content Fetching  | Facebook Graph API    |
| Messaging         | Telegram Bot API      |
| Deployment        | Railway               |

---

## Features

- ✅ Real-time Facebook → Telegram mirroring via webhooks
- ✅ Full content support: text, images, video, and attachments
- ✅ Three-layer deduplication across two source pages
- ✅ Race condition handling with source-of-truth prioritization
- ✅ Live in production, actively serving the IML/IMBB community

---

## Roadmap

- [ ] Handle Telegram caption character limits — when post text exceeds the caption limit for photo/video messages, send the overflow as a follow-up text-only message
- [ ] Logging and alerting for failed webhook deliveries
- [ ] Admin dashboard for monitoring post delivery status

---

## Background

This project was built as part of my role as Social Media Coordinator for International Mr. Leather & International Mr. Bootblack. It's one piece of a larger effort to modernize how the organization communicates with its community across platforms.
