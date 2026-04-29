# Roadmap & Known Issues

Tracked improvements and known issues for the FB → Telegram Bot.
Items are roughly ordered by priority.

---

## 🔴 High Priority

### 1. Railway filesystem is ephemeral — token persistence will fail after redeploy

**Status:** Open  
**Area:** `src/tokenManager.js`

`token-store.json` is written to the local container filesystem, which Railway wipes on every redeploy and restart. This means:

- First startup: loads from env vars, refreshes after 1 min, writes to file ✓
- 7 days later: scheduler refreshes, writes new token to file ✓
- Code push triggers redeploy: file is gone, env still has the original (now stale) token ✗

Over time, after enough refresh cycles without a persistent file, the env var token will be too stale to exchange and auto-refresh will start failing silently.

**Fix:**

1. Attach a Railway Volume to the service:
   - Railway dashboard → service → **Volumes** → create volume → mount path e.g. `/app/data`
2. Add a `TOKEN_STORE_PATH` env var (default: current path for local dev):
   ```
   TOKEN_STORE_PATH=/app/data/token-store.json
   ```
3. Update `STORE_FILE` in `tokenManager.js`:
   ```js
   const STORE_FILE =
     process.env.TOKEN_STORE_PATH ||
     path.join(__dirname, '..', 'token-store.json');
   ```
4. Verify by deploying and confirming `token-store.json` survives a forced redeploy

**Also add to `.env.example`:**

```
TOKEN_STORE_PATH=/app/data/token-store.json
```

---

## 🟡 Medium Priority

### 2. Initial token refresh on every startup wastes Facebook refresh cycles

**Status:** Open  
**Area:** `src/tokenManager.js`

The scheduler currently calls `refreshAllTokens()` 60 seconds after every startup. This is fine for validating tokens on first boot, but burns a fresh 60-day Facebook refresh cycle on every Railway restart (deploys, OOM kills, code pushes).

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

**Note:** This is only useful once item #1 (Railway Volume) is implemented — without persistent storage, `lastRefreshed` is always null on startup anyway.

---

## 🟢 Low Priority / Pending Data

### 3. Shared IMBB video posts show thumbnail instead of video

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

---

## ✅ Completed

- Three-layer deduplication (post ID, content hash, source URL)
- Two-page support (IML + IMBB) with IML as preferred source
- Per-page dedicated access tokens
- Auto-refresh token scheduler (weekly)
- HMAC webhook signature verification
- Startup env var validation
- Text overflow handling (image + follow-up message)
- All content types: text, photo, album, video, link/share
- Shared post text extraction from `attachment.description`
- Deployed to Railway with GitHub auto-deploy
- Privacy policy hosted on GitHub Pages
- grammy replacing node-telegram-bot-api (no vulnerabilities)
