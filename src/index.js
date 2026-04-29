/**
 * index.js
 * Entry point. Spins up an Express server that:
 *   GET  /webhook  → Facebook verification handshake
 *   POST /webhook  → Receives real-time Facebook page post events
 *   GET  /health   → Simple health check for hosting platforms
 *
 * Supports two pages (IML + IMBB) with three-layer deduplication:
 *   1. Post ID exact match
 *   2. Source URL (catches IML sharing an IMBB post already forwarded)
 *   3. Content hash within 15-minute window (catches IMBB copying an IML post verbatim)
 *
 * IML is treated as the preferred source — if both pages fire within the
 * dedup window, IML's version is kept and IMBB's is silently dropped.
 * To achieve this, IML posts are processed immediately while IMBB posts
 * wait a short delay, giving IML's webhook time to register first.
 */

require('dotenv').config();

const crypto = require('crypto');

// ── Startup validation ────────────────────────────────────────────────────────
const REQUIRED_ENV_VARS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHANNEL_ID',
  'FACEBOOK_IML_PAGE_ACCESS_TOKEN',
  'FACEBOOK_IMBB_PAGE_ACCESS_TOKEN',
  'FACEBOOK_IML_PAGE_ID',
  'FACEBOOK_IMBB_PAGE_ID',
  'FACEBOOK_WEBHOOK_VERIFY_TOKEN',
  'FACEBOOK_APP_SECRET',
  'FACEBOOK_APP_ID',
];

const missing = REQUIRED_ENV_VARS.filter((v) => !process.env[v]);
if (missing.length > 0) {
  console.error('[Startup] Missing required environment variables:');
  missing.forEach((v) => console.error(`  - ${v}`));
  process.exit(1);
}

const express = require('express');
const { fetchPost } = require('./facebook');
const { sendPost } = require('./telegram');
const { checkDuplicate, markPosted } = require('./store');
const { startScheduler } = require('./tokenManager');

const app = express();

// ── HMAC signature verification ───────────────────────────────────────────────
const APP_SECRET = process.env.FACEBOOK_APP_SECRET;

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

function verifyWebhookSignature(req) {
  const signature = req.headers['x-hub-signature-256'];
  if (!signature) return false;
  const expected =
    'sha256=' +
    crypto.createHmac('sha256', APP_SECRET).update(req.rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  } catch {
    return false;
  }
}

const VERIFY_TOKEN = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN;
const IML_PAGE_ID = process.env.FACEBOOK_IML_PAGE_ID;
const IMBB_PAGE_ID = process.env.FACEBOOK_IMBB_PAGE_ID;
const PORT = process.env.PORT || 3000;

// How long to delay processing IMBB posts (ms).
const IMBB_DELAY_MS = 8000;

// ── Health check ─────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// ── Facebook webhook verification ────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('[Webhook] Facebook verification successful');
    return res.status(200).send(challenge);
  }
  console.warn('[Webhook] Verification failed — token mismatch');
  return res.sendStatus(403);
});

// ── Incoming Facebook events ──────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Verify HMAC signature before processing anything
  if (!verifyWebhookSignature(req)) {
    console.warn('[Webhook] Rejected request — invalid signature');
    return res.sendStatus(403);
  }

  // Always respond 200 quickly so Facebook doesn't retry
  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;

    // Only handle events from our two known pages
    if (pageId !== IML_PAGE_ID && pageId !== IMBB_PAGE_ID) continue;

    const isIML = pageId === IML_PAGE_ID;
    const isIMBB = pageId === IMBB_PAGE_ID;

    for (const change of entry.changes || []) {
      if (change.field !== 'feed') continue;

      const value = change.value;

      // Only new posts — ignore edits, deletes, comments, likes, etc.
      if (value.verb !== 'add') continue;

      // Accept all post item types Facebook may send
      const POST_ITEMS = new Set(['post', 'status', 'photo', 'video', 'share']);
      if (!POST_ITEMS.has(value.item)) continue;

      // The post_id prefix always matches the page that owns it.
      // This filters out fan/visitor wall posts on either page.
      const postId = value.post_id;
      if (!postId?.startsWith(pageId)) continue;

      if (isIML) {
        await processPost(postId, 'IML');
      } else if (isIMBB) {
        setTimeout(() => processPost(postId, 'IMBB'), IMBB_DELAY_MS);
      }
    }
  }
});

// ── Core processing ───────────────────────────────────────────────────────────

async function processPost(postId, pageLabel) {
  console.log(`[${pageLabel}] New post detected: ${postId}`);

  try {
    const post = await fetchPost(postId);
    const { isDuplicate, reason } = checkDuplicate(postId, post);

    if (isDuplicate) {
      console.log(
        `[${pageLabel}] Skipping duplicate post ${postId} — ${reason}`,
      );
      return;
    }

    await sendPost(post);
    markPosted(postId, post);
    console.log(`[${pageLabel}] ✓ Successfully forwarded post ${postId}`);
  } catch (err) {
    console.error(
      `[${pageLabel}] ✗ Failed to forward post ${postId}:`,
      err.message,
    );
  }
}

// ── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════╗
║   FB → Telegram Bot is running!          ║
║   IML Page  : ${String(IML_PAGE_ID || 'NOT SET').padEnd(26)}║
║   IMBB Page : ${String(IMBB_PAGE_ID || 'NOT SET').padEnd(26)}║
║   Port      : ${String(PORT).padEnd(26)}║
╚══════════════════════════════════════════╝
  `);

  // Start the token auto-refresh scheduler
  startScheduler();
});
