# Roadmap & Known Issues

Tracked improvements and known issues for the FB → Telegram Bot.
Items are roughly ordered by priority.

---

## 🟡 Medium Priority

### 1. Smart startup refresh — skip if tokens are fresh

**Status:** Open  
**Area:** `src/tokenManager.js`

The scheduler currently calls `refreshAllTokens()` 60 seconds after every startup. Now that the Railway Volume persists `lastRefreshed`, this burns an unnecessary Facebook refresh cycle on every redeploy.

**Fix:** Before refreshing on startup, check if the token actually needs it:

```js
function tokenNeedsRefresh(tokenState) {
  if (!tokenState.lastRefreshed) return true; // never refreshed
  const daysSinceRefresh =
    (Date.now() - tokenState.lastRefreshed) / (1000 * 60 * 60 * 24);
  return daysSinceRefresh >= 5; // only refresh if 5+ days old
}
```

Then in the startup refresh:

```js
setTimeout(async () => {
  const imlNeeds = tokenNeedsRefresh(tokens.iml);
  const imbbNeeds = tokenNeedsRefresh(tokens.imbb);

  if (!imlNeeds && !imbbNeeds) {
    console.log('[TokenManager] Tokens are fresh, skipping startup refresh');
    return;
  }
  await refreshAllTokens();
}, 60 * 1000);
```

---

## 🟢 Low Priority / Pending Data

### 2. Shared IMBB video posts show thumbnail instead of video

**Status:** Waiting on debug logs  
**Area:** `src/facebook.js`

When IML shares a video post originally from IMBB, the post comes through as `type: photo` instead of `type: video`, causing the thumbnail fallback to fire.

Debug logging is currently active in `normalizePost()` to capture the raw attachment payload from a real shared video post.

**Suspected fix** (apply once debug logs confirm):

```js
// Change this condition:
} else if (mediaType === "video" || mediaType === "live_video" || attachment.media?.source) {
```

The `attachment.media?.source` check should catch shared videos where `media_type` comes back as `"share"` but the video URL is still present in `attachment.media.source`.

**Also:** Once this is confirmed and fixed, remove all `[DEBUG]` and `[Facebook] mediaType/attachment` console.log statements from `normalizePost()`.

### 3. Live video / Reel handling

**Status:** Open  
**Area:** `src/telegram.js`, `src/facebook.js`

Facebook Reels and live videos use DASH adaptive streaming URLs (`tag=dash`, `bitrate=0`) which Telegram cannot upload as proper video — they come through as silent GIFs instead.

**Planned behavior:**

- **Reels** — detect DASH URL, send thumbnail + post text + link to reel URL
- **Live videos** — send IML profile picture + "🔴 We are live! Watch here: [link]"
  **Blocked on:** IML profile picture URL (get via `/me?fields=picture.width(720)` in Graph API Explorer with IML page token)

---

## ✅ Completed

- Railway Volume for persistent token storage (`/app/data/token-store.json`)
- True Page Tokens via `/me/accounts` (not User Tokens)
- Per-page dedicated access tokens (IML + IMBB separate)
- Auto-refresh token scheduler (weekly, 7-day interval)
- IMBB pending queue — IML always wins regardless of post timing
- Content hash dedup uses text only (CDN URLs differ across pages)
- Three-layer deduplication (post ID, content hash, source URL)
- Two-page support (IML + IMBB) with IML as preferred source
- HMAC webhook signature verification
- Startup env var validation
- Text overflow handling (image with no caption + full text follow-up)
- All content types: text, photo, album, video, link/share
- Shared post text extraction from `attachment.description`
- grammy replacing node-telegram-bot-api (no vulnerabilities)
- Deployed to Railway with GitHub auto-deploy
- Privacy policy hosted on GitHub Pages
