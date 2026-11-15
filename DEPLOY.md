# Put Gemini Friend in the cloud ($0)

You end up with a private web address that works on any phone or laptop. It asks for your passcode, then it's your app.

Three free accounts: **Upstash** (stores your history), **GitHub** (holds the code), **Render** (runs the app).

## 1. Upstash: your history (3 min)
1. Go to console.upstash.com and sign in with Google.
2. **Create Database** → name `gemini-friend` → pick the closest region → **Free** plan → Create.
3. On the database page, find the **REST API** section. Copy two values:
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN` (the main token, not the read-only one)

Keep that tab open. You'll paste them into Render in step 3.

## 2. GitHub: the code (3 min)
1. github.com → **New repository** → name `gemini-friend` → **Private** → Create.
2. Click **uploading an existing file**.
3. Open the unzipped `gemini-friend` folder. Drag in everything **except** `node_modules`, `data`, `transcripts` and `.env` (you won't have most of these in the zip).
   Dotfiles are hidden on Mac. Press `Cmd + Shift + .` in Finder to show them, and include `.node-version` and `.gitignore`.
4. **Commit changes**.

## 3. Render: the server (5 min)
1. render.com → sign up with GitHub. Render may ask for a card to verify you. That is a $1 hold that is reversed, and the Free plan stays free.
2. **New +** → **Web Service** → pick your `gemini-friend` repo.
3. Fill in:
   - Region: **Singapore** (closest to India)
   - Runtime: **Node**
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Instance Type: **Free**
4. Under **Environment Variables**, add these five:

   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | your Gemini key |
   | `APP_PASSCODE` | a passcode you'll remember, 8+ characters. Don't reuse a real password. |
   | `UPSTASH_REDIS_REST_URL` | from step 1 |
   | `UPSTASH_REDIS_REST_TOKEN` | from step 1 |
   | `NODE_VERSION` | `22` |

5. **Create Web Service**. After about 3 minutes the log says "Gemini Friend v3 running" and you get an address like `https://gemini-friend-xxxx.onrender.com`.

Open it, enter your passcode, and make a 2-minute test call.

## 4. On your phone
Open the same address. Use **Add to Home Screen** (Safari: Share → Add to Home Screen; Chrome: ⋮ → Install app). Then it opens like an app.

## Good to know
- **Waking up:** after 15 minutes with no activity the free server sleeps. The next visit shows a loading page for about a minute. A live call keeps it awake.
- **Keep the call screen open.** The phone locks the mic if you switch apps. The app asks the screen to stay on during a call.
- **Your history is safe across sleeps and redeploys** because it lives in Upstash, not on Render's disk.
- **Changing the passcode** signs you out everywhere. Change it in Render → Environment.
- **Updating the app later:** edit the files in GitHub (or re-upload). Render redeploys by itself.
- **Bring over calls from your Mac (optional):** add the two Upstash values to your local `.env`, then run `node --env-file=.env scripts/import-local-history.js`.
- **Never put `.env` on GitHub.** The key belongs only in Render's Environment tab.
