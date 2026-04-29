/**
 * tokenManager.js
 * Manages long-lived Facebook Page Access Tokens for IML and IMBB.
 *
 * Facebook long-lived tokens expire after 60 days, but can be refreshed
 * by exchanging them for a new long-lived token before expiry.
 *
 * Strategy:
 * - On startup, load tokens from token-store.json (if it exists),
 *   falling back to env vars
 * - A weekly scheduler refreshes both tokens automatically
 * - Refreshed tokens are persisted to token-store.json
 * - If a refresh fails, the existing token continues to be used and
 *   an alert is logged
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');

const STORE_FILE = path.join(__dirname, '..', 'token-store.json');
const BASE = 'https://graph.facebook.com/v21.0';

const APP_ID = process.env.FACEBOOK_APP_ID;
const APP_SECRET = process.env.FACEBOOK_APP_SECRET;

// In-memory token state
const tokens = {
  iml: {
    token: process.env.FACEBOOK_IML_PAGE_ACCESS_TOKEN || '',
    expiresAt: null, // ms timestamp, null = unknown
    lastRefreshed: null,
  },
  imbb: {
    token: process.env.FACEBOOK_IMBB_PAGE_ACCESS_TOKEN || '',
    expiresAt: null,
    lastRefreshed: null,
  },
};

// ── Persistence ───────────────────────────────────────────────────────────────

function loadTokenStore() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
      if (data.iml?.token) {
        tokens.iml = { ...tokens.iml, ...data.iml };
        console.log('[TokenManager] Loaded IML token from store');
      }
      if (data.imbb?.token) {
        tokens.imbb = { ...tokens.imbb, ...data.imbb };
        console.log('[TokenManager] Loaded IMBB token from store');
      }
    }
  } catch (err) {
    console.warn(
      '[TokenManager] Could not load token-store.json:',
      err.message,
    );
  }
}

function saveTokenStore() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(tokens, null, 2), 'utf8');
  } catch (err) {
    console.warn(
      '[TokenManager] Could not save token-store.json:',
      err.message,
    );
  }
}

// ── Token getters ─────────────────────────────────────────────────────────────

function getIMLToken() {
  return tokens.iml.token;
}

function getIMBBToken() {
  return tokens.imbb.token;
}

// ── Refresh logic ─────────────────────────────────────────────────────────────

/**
 * Exchange a long-lived token for a fresh long-lived token.
 * Facebook allows this at any time — the clock resets to 60 days.
 */
async function refreshToken(pageKey) {
  const current = tokens[pageKey].token;
  if (!current) {
    console.error(
      `[TokenManager] No token available for ${pageKey}, cannot refresh`,
    );
    return false;
  }

  try {
    console.log(`[TokenManager] Refreshing ${pageKey.toUpperCase()} token...`);

    const { data } = await axios.get(`${BASE}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: APP_ID,
        client_secret: APP_SECRET,
        fb_exchange_token: current,
      },
    });

    if (!data.access_token) {
      throw new Error('No access_token in response');
    }

    const expiresIn = data.expires_in || 5184000; // default 60 days in seconds
    tokens[pageKey] = {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
      lastRefreshed: Date.now(),
    };

    saveTokenStore();

    const expiryDate = new Date(tokens[pageKey].expiresAt).toLocaleDateString(
      'en-US',
      {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      },
    );
    console.log(
      `[TokenManager] ✓ ${pageKey.toUpperCase()} token refreshed successfully. Expires: ${expiryDate}`,
    );
    return true;
  } catch (err) {
    const errMsg = err.response?.data?.error?.message || err.message;
    console.error(
      `[TokenManager] ✗ Failed to refresh ${pageKey.toUpperCase()} token: ${errMsg}`,
    );
    console.error(
      `[TokenManager] ⚠ ${pageKey.toUpperCase()} token unchanged — will retry next scheduled refresh`,
    );
    return false;
  }
}

async function refreshAllTokens() {
  console.log('[TokenManager] Running scheduled token refresh...');
  const imlOk = await refreshToken('iml');
  const imbbOk = await refreshToken('imbb');

  if (!imlOk || !imbbOk) {
    console.error(
      '[TokenManager] ⚠ One or more tokens failed to refresh. Check logs above.',
    );
  } else {
    console.log('[TokenManager] ✓ All tokens refreshed successfully.');
  }
}

// ── Scheduler ─────────────────────────────────────────────────────────────────

// Refresh interval: every 7 days (well within the 60-day expiry window)
const REFRESH_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function startScheduler() {
  // Run once 1 minute after startup to validate tokens are working
  setTimeout(async () => {
    console.log('[TokenManager] Running initial token refresh check...');
    await refreshAllTokens();
  }, 60 * 1000);

  // Then refresh every 7 days
  setInterval(refreshAllTokens, REFRESH_INTERVAL_MS);

  const nextRefresh = new Date(Date.now() + REFRESH_INTERVAL_MS);
  console.log(
    `[TokenManager] Scheduler started. Next refresh: ${nextRefresh.toLocaleDateString(
      'en-US',
      {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      },
    )}`,
  );
}

// ── Init ──────────────────────────────────────────────────────────────────────

loadTokenStore();

module.exports = {
  getIMLToken,
  getIMBBToken,
  startScheduler,
  refreshAllTokens,
};
