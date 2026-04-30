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
 * IML is always the preferred source of truth. IMBB posts are held in a
 * pending queue for 90 seconds. If an IML post with matching content arrives
 * within that window, IML wins and IMBB is discarded. If no IML match arrives,
 * IMBB's post is forwarded as an original.
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
const { checkDuplicate, markPosted, buildTextHash } = require('./store');
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

// How long to hold an IMBB post before forwarding if no IML match arrives (ms)
const IMBB_HOLD_MS = 90 * 1000;

// ── IMBB pending queue ────────────────────────────────────────────────────────
// Maps contentHash → { postId, post, timer }
const imbbPending = new Map();

function holdIMBBPost(postId, post) {
  const hash = buildTextHash(post);

  // If no hash (no text), nothing to match on — forward immediately
  if (!hash) {
    processPost(postId, 'IMBB', post);
    return;
  }

  console.log(
    `[IMBB] Holding post ${postId} for ${IMBB_HOLD_MS / 1000}s — waiting for IML match...`,
  );

  const timer = setTimeout(async () => {
    if (imbbPending.has(hash)) {
      imbbPending.delete(hash);
      console.log(
        `[IMBB] No IML match arrived — forwarding IMBB post ${postId}`,
      );
      await processPost(postId, 'IMBB', post);
    }
  }, IMBB_HOLD_MS);

  imbbPending.set(hash, { postId, post, timer });
}

function cancelIMBBIfDuplicate(imlPost) {
  const hash = buildTextHash(imlPost);
  if (!hash) return;

  if (imbbPending.has(hash)) {
    const { postId, timer } = imbbPending.get(hash);
    clearTimeout(timer);
    imbbPending.delete(hash);
    console.log(`[IMBB] IML match found — discarding held IMBB post ${postId}`);
  }
}

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
  if (!verifyWebhookSignature(req)) {
    console.warn('[Webhook] Rejected request — invalid signature');
    return res.sendStatus(403);
  }

  res.sendStatus(200);

  const body = req.body;
  if (body.object !== 'page') return;

  for (const entry of body.entry || []) {
    const pageId = entry.id;
    if (pageId !== IML_PAGE_ID && pageId !== IMBB_PAGE_ID) continue;

    const isIML = pageId === IML_PAGE_ID;
    const isIMBB = pageId === IMBB_PAGE_ID;

    for (const change of entry.changes || []) {
      if (change.field !== 'feed') continue;

      const value = change.value;
      if (value.verb !== 'add') continue;

      const POST_ITEMS = new Set(['post', 'status', 'photo', 'video', 'share']);
      if (!POST_ITEMS.has(value.item)) continue;

      const postId = value.post_id;
      if (!postId?.startsWith(pageId)) continue;

      if (isIML) {
        await handleIMLPost(postId);
      } else if (isIMBB) {
        await handleIMBBPost(postId);
      }
    }
  }
});

// ── Page handlers ─────────────────────────────────────────────────────────────

async function handleIMLPost(postId) {
  console.log(`[IML] New post detected: ${postId}`);
  try {
    const post = await fetchPost(postId);

    // Cancel any matching held IMBB post before forwarding IML's version
    cancelIMBBIfDuplicate(post);

    const { isDuplicate, reason } = checkDuplicate(postId, post);
    if (isDuplicate) {
      console.log(`[IML] Skipping duplicate post ${postId} — ${reason}`);
      return;
    }

    await sendPost(post);
    markPosted(postId, post);
    console.log(`[IML] ✓ Successfully forwarded post ${postId}`);
  } catch (err) {
    console.error(`[IML] ✗ Failed to forward post ${postId}:`, err.message);
  }
}

async function handleIMBBPost(postId) {
  console.log(`[IMBB] New post detected: ${postId}`);
  try {
    const post = await fetchPost(postId);

    // Check dedup before holding — no point holding if it's already been posted
    const { isDuplicate, reason } = checkDuplicate(postId, post);
    if (isDuplicate) {
      console.log(`[IMBB] Skipping duplicate post ${postId} — ${reason}`);
      return;
    }

    // Hold the post and wait to see if IML posts the same content
    holdIMBBPost(postId, post);
  } catch (err) {
    console.error(`[IMBB] ✗ Failed to fetch post ${postId}:`, err.message);
  }
}

// ── Core processing ───────────────────────────────────────────────────────────

async function processPost(postId, pageLabel, post) {
  try {
    // Re-check dedup at send time in case state changed during the hold window
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

  startScheduler();
});
