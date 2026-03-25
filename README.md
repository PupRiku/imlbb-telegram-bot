# 📲 Facebook → Telegram Bot

Automatically mirrors posts from two Facebook Pages (IML and IMBB) to a single Telegram channel — including text, photos, videos, albums, and link previews — without duplicates.

---

## How It Works

```
IML Page Post          IMBB Page Post
      │                      │
      ▼                      ▼
      └──── Facebook Webhooks (real-time) ────┘
                       │
                       ▼
            Your Bot Server (/webhook)
                       │
                  ┌────┴─────────────────────────┐
                  │  3-layer deduplication:       │
                  │  1. Post ID match             │
                  │  2. Source URL (shares)       │
                  │  3. Content hash (copies)     │
                  └────┬─────────────────────────┘
                       │
                       ▼
            Fetches full post via Graph API
            (text, images, video, attachments)
                       │
                       ▼
              Telegram Bot API
                       │
                       ▼
            Your Telegram Channel (posted once)
```

### Deduplication Behaviour

The bot watches both pages on a single webhook endpoint and handles four scenarios automatically:

| Scenario | What happens |
|---|---|
| IML makes an original post | ✅ Posted once |
| IMBB copies that IML post verbatim | ❌ Skipped — content hash match within 15 min |
| IMBB makes its own original post | ✅ Posted once |
| IML shares that IMBB post | ❌ Skipped — source URL already forwarded |

IML is treated as the **preferred source of truth**. When both pages fire simultaneously, IML's version is always kept and IMBB's is silently dropped (IMBB posts are delayed 8 seconds before processing to allow IML to win the race).

---

## Prerequisites

- Node.js 18+
- Admin access to both the IML and IMBB Facebook Pages
- A Telegram channel you own
- A hosting platform with a public HTTPS URL (see Hosting section)

---

## Step 1 — Create Your Telegram Bot

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` and follow the prompts
3. Copy the **Bot Token** (looks like `123456789:ABCdef...`)
4. Open your Telegram channel → **Manage Channel → Administrators**
5. Add your bot as an admin with **"Post Messages"** permission

**Get your Channel ID:**
- If your channel is public: use `@YourChannelUsername`
- If private: forward any message from the channel to **@userinfobot** to get the numeric ID (e.g. `-1001234567890`)

---

## Step 2 — Facebook Developer Setup

### 2a. Create a Facebook App

1. Go to [developers.facebook.com](https://developers.facebook.com) → **My Apps → Create App**
2. Choose **"Other"** → **"Business"** type
3. Name it (e.g. "IML Telegram Sync") and click **Create**

### 2b. Add Required Products

In your app dashboard, add these two products:
- **Webhooks**
- **Pages** (under "Add Products")

### 2c. Generate a Page Access Token

You only need **one token**, but it must have access to both pages.

1. Go to **Tools → Graph API Explorer**
2. Select your app in the top-right dropdown
3. Click **"Generate Access Token"** → select the **IML page**
4. Grant these permissions:
   - `pages_read_engagement`
   - `pages_read_user_content`
5. Copy the token

> ⚠️ **Make it long-lived!** Short-lived tokens expire in 1 hour.
> Exchange it using this URL (paste in your browser):
> ```
> https://graph.facebook.com/oauth/access_token
>   ?grant_type=fb_exchange_token
>   &client_id=YOUR_APP_ID
>   &client_secret=YOUR_APP_SECRET
>   &fb_exchange_token=YOUR_SHORT_TOKEN
> ```
> Long-lived tokens last 60 days. Set a calendar reminder to refresh it.

> ℹ️ **Why only one token?** Since you admin both pages, a single long-lived token authorized against your Facebook account covers both. The Graph API will accept requests for any page you manage.

### 2d. Find Both Page IDs

For each page (IML and IMBB):

Go to the Facebook Page → **About** → scroll down to find **Page ID** (a long number). Keep both handy — you'll need them in Step 3.

---

## Step 3 — Configure Environment Variables

```bash
cp .env.example .env
```

Edit `.env` and fill in all values:

```env
TELEGRAM_BOT_TOKEN=123456789:ABCdef...
TELEGRAM_CHANNEL_ID=@YourChannelUsername

FACEBOOK_PAGE_ACCESS_TOKEN=EAABsbCS...
FACEBOOK_IML_PAGE_ID=123456789012345
FACEBOOK_IMBB_PAGE_ID=987654321098765
FACEBOOK_WEBHOOK_VERIFY_TOKEN=any_secret_string_you_choose

PORT=3000
```

---

## Step 4 — Install & Run Locally

```bash
npm install
npm start
```

You should see:
```
╔══════════════════════════════════════════╗
║   FB → Telegram Bot is running!          ║
║   IML Page  : 123456789012345            ║
║   IMBB Page : 987654321098765            ║
║   Port      : 3000                       ║
╚══════════════════════════════════════════╝
```

---

## Step 5 — Deploy to the Internet

You need a **public HTTPS URL** for Facebook webhooks. Here are the easiest options:

### Option A: Railway (Recommended — Free tier available)

1. Push this project to a GitHub repo
2. Go to [railway.app](https://railway.app) → **New Project → Deploy from GitHub**
3. Select your repo
4. Go to **Variables** tab and add all your `.env` values
5. Railway auto-assigns a URL like `https://your-app.up.railway.app`

### Option B: Render (Also free tier)

1. Push to GitHub
2. Go to [render.com](https://render.com) → **New → Web Service**
3. Connect your repo, set Start Command to `npm start`
4. Add environment variables in the dashboard
5. You get a URL like `https://your-app.onrender.com`

> ⚠️ Render's free tier spins down after inactivity. Use Railway or a paid plan for production.

### Option C: Test locally with ngrok

```bash
npm install -g ngrok
ngrok http 3000
# Gives you a temporary https URL for testing
```

---

## Step 6 — Register the Webhook on Facebook

Once your server is live, you need to subscribe **both pages** to the same webhook endpoint.

### 6a. Set up the webhook callback

1. Go to [developers.facebook.com](https://developers.facebook.com) → Your App → **Webhooks**
2. Click **"Subscribe to this object"** → choose **Page**
3. Fill in:
   - **Callback URL**: `https://your-app-url.com/webhook`
   - **Verify Token**: the same string you put in `FACEBOOK_WEBHOOK_VERIFY_TOKEN`
4. Click **"Verify and Save"** — Facebook will call your `/webhook` endpoint to confirm
5. Under **Subscription Fields**, enable: `feed`

### 6b. Subscribe the IML page

1. In the Webhooks dashboard, find the **Page** object row
2. Click **"Subscribe"** in the dropdown next to it
3. Select your **IML page** from the list

### 6c. Subscribe the IMBB page

1. Click **"Subscribe"** again in the same dropdown
2. Select your **IMBB page** from the list

Both pages now send events to the same `/webhook` endpoint. The bot identifies which page triggered each event using the page ID in the payload and applies deduplication accordingly.

> ℹ️ You can verify both subscriptions are active by going to your Facebook Page → **Settings → Advanced → Webhooks** and confirming `feed` is listed as an active subscription for each page.

---

## Project Structure

```
fb-telegram-bot/
├── src/
│   ├── index.js       # Express server + webhook handler
│   ├── facebook.js    # Graph API fetching & normalization
│   ├── telegram.js    # Telegram posting logic
│   └── store.js       # Deduplication (prevents double-posting)
├── .env.example       # Environment variable template
├── .gitignore
├── package.json
└── README.md
```

---

## Content Type Handling

| Facebook Post Type | Telegram Output |
|---|---|
| Text only | Text message |
| Single photo | Photo with caption |
| Album (2–10 photos) | Media group |
| Album (11–20 photos) | Two media groups |
| Video (≤50 MB) | Video file with caption |
| Video (>50 MB) | Thumbnail + link to Facebook |
| Link / article share | Photo preview + text + URL |

---

## Troubleshooting

**Bot doesn't post anything**
- Check that the bot is an admin in the channel with "Post Messages" permission
- Verify your `TELEGRAM_CHANNEL_ID` is correct (try the numeric ID if `@username` doesn't work)
- Confirm both pages are subscribed to the webhook (Step 6b & 6c)

**Only one page's posts are coming through**
- Double-check that both `FACEBOOK_IML_PAGE_ID` and `FACEBOOK_IMBB_PAGE_ID` are set correctly in `.env`
- Verify both pages are subscribed under **Page Settings → Advanced → Webhooks**
- Make sure your Page Access Token has permissions for both pages

**Posts appear twice**
- This shouldn't happen — `store.js` uses three-layer deduplication. If it does, check that `posted.json` is persisted between restarts on your hosting platform and that both page IDs are set correctly.

**An IMBB-original post isn't appearing (IML shared it but IMBB's original wasn't posted)**
- This could happen if the IMBB webhook fires but IML's share arrives first and marks the source URL as seen. Check your server logs for `[IMBB]` entries. If IMBB posts are consistently being skipped when they shouldn't be, the source URL from the IML share may not be matching exactly — open a GitHub issue with your log output.

**Facebook webhook verification fails**
- Make sure your server is running and publicly accessible
- Double-check `FACEBOOK_WEBHOOK_VERIFY_TOKEN` matches in both `.env` and the Facebook dashboard

**Videos not posting**
- Facebook often restricts direct video URL access. The bot will fall back to thumbnail + link automatically.

**Page Access Token expired**
- Long-lived tokens last 60 days. Re-run the exchange flow in Step 2c and update your environment variable.

---

## License

MIT
