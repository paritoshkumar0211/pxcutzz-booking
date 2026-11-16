# PXCUTZZ — Online Booking Website

Online booking website for **PXCUTZZ**, a men's salon / barbershop in Surrey, BC, Canada.
Clients pick a service, pick a day, pick a time, enter their details, and book.
The salon sees bookings in the **Manage** view and confirms them.

- Salon: 9385 120 St, Unit 102, Surrey, BC, Canada · +1 672-588-2101 · pxcutzz@gmail.com
- Hours: Wednesday–Monday, 9:00 AM – 9:00 PM · **Closed Tuesday** (America/Vancouver time)
- No Beard Perms service (removed by the owner).

## What this app does

- 9 services with the owner's prices and durations (see `server.js` `SERVICES`).
  Durations the owner did not give (Beard Lineup (Straight Razor), D Tan, Scrub,
  and the two price-on-request beard services) are 30-minute **placeholders** —
  they are marked `placeholderDuration: true` in the code (durations are hidden
  from clients on the site; only the owner sees them in the dashboard).
  The two price-on-request services show "Price on request" and have no price.
- Time slots 9:00 AM – 9:00 PM in 30-minute steps; a slot is offered only if
  the whole service finishes by 9:00 PM. Tuesdays show as closed.
- Double-booking is prevented: a slot that overlaps an existing booking on
  the same day is not offered, and the server re-checks at booking time
  (returns HTTP 409 if it was just taken).
- On booking, if Gmail SMTP is configured, the **client** gets a confirmation
  email and the **salon** (pxcutzz@gmail.com) gets a booking alert. If email
  is **not** configured, the booking still saves and the confirmation screen
  clearly says email was not sent.
- Manage view (`#manage` on the home page): list of all bookings, with a
  **Confirm** button per booking. If `ADMIN_TOKEN` is set on the server, the
  Manage API requires that token (the page will prompt for it once).
- **No SMS gateway is connected.** SMS is a future step — see "SMS (future)" below.

## Run locally

```bash
cd pxcutzz-render-app
npm install
npm start
# open http://localhost:3000
```

Optional, to test email locally, create a `.env` file (never commit it) or
export the variables before starting:

```bash
export GMAIL_USER=pxcutzz@gmail.com
export GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx   # Gmail app password, see below
export ADMIN_TOKEN=some-secret-token            # optional
npm start
```

Node 18+ is required. Bookings are stored in `data/bookings.db` (SQLite).
If the native SQLite module cannot load, the app falls back to
`data/bookings.json` and keeps working.

## Deploy on Render (free tier) — exact steps

Do this once. You need a **Render account** and a **GitHub account** (both free).

### 1. Put this code in a GitHub repo
1. On GitHub, create a new repository, e.g. `pxcutzz-booking`.
2. Push this folder's contents into it (or upload them via the GitHub web UI):
   `package.json`, `server.js`, `render.yaml`, `README.md`, `public/`.
   Do **not** upload `node_modules/`, `data/`, or any `.env` file (they are git-ignored).

### 2. Create the Render web service
1. Go to <https://dashboard.render.com> and sign in / create a free account.
2. Click **New + → Web Service**.
3. Choose **Build and deploy from a Git repository** and connect/pick the
   `pxcutzz-booking` repo.
4. Render reads `render.yaml` from the repo and pre-fills the service:
   - **Name:** `pxcutzz-booking`
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan:** Free
   - *(If Render asks instead of using the blueprint, use exactly these values, then click "Create Web Service".)*
   Alternatively, use the blueprint directly: **New + → Blueprint**, pick the repo, and Render will create the service from `render.yaml`.
5. Wait for the first deploy to finish. Render gives you a URL like
   `https://pxcutzz-booking.onrender.com`. Open it — the booking site is live.

### 3. Set the environment variables on Render
In the Render dashboard, open the service → **Environment**, and add:

| Variable | Value | Notes |
|---|---|---|
| `GMAIL_USER` | `pxcutzz@gmail.com` | Gmail account that sends the emails |
| `GMAIL_APP_PASSWORD` | (16-character app password) | See "Gmail app password" below. **Not** the normal Gmail password |
| `ADMIN_TOKEN` | (a secret phrase you choose) | Optional. If set, only people with this token can open the Manage bookings list. Render's `render.yaml` generates one automatically on blueprint deploy — copy it from the Environment tab if you want to use it |

After saving variables, click **Manual Deploy → Deploy latest commit** (or wait for the automatic redeploy).

### Gmail app password (for confirmation emails)
1. In the `pxcutzz@gmail.com` Google account, turn on **2-Step Verification**
   (Google Account → Security → 2-Step Verification).
2. Then go to Security → **App passwords** → create one for "Mail" / "Other (PXCUTZZ booking)".
3. Google shows a 16-character password (like `abcd efgh ijkl mnop`). Copy it
   into Render as `GMAIL_APP_PASSWORD`. Do not share it in chat and do not
   put it in the repo.
4. Test: make a booking on the live site with your own email — you should get
   a confirmation email, and pxcutzz@gmail.com should get the booking alert.
   If no email arrives, the booking still saves, and the confirmation screen
   will say email was not sent.

### Free-tier notes (Render)
- **Free web services spin down after ~15 minutes of inactivity.** The first
  visit after a quiet period can take 30–60 seconds to wake up. That is
  normal on the free plan and does not lose bookings.
- **Free disk is ephemeral.** Bookings live in `data/bookings.db` on the
  service's disk, which Render wipes on redeploy/restart. For permanent
  storage, set `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` (a free Turso
  hosted-SQLite database — no credit card) on Render: the app then stores
  bookings in Turso and they survive redeploys/restarts. Without those
  variables the app uses the local SQLite file (ephemeral on the free
  tier), with a JSON-file fallback if the native module cannot load.
- **Free tier limits:** 750 instance hours/month, 512 MB RAM, shared CPU.
  This app is well within those limits.
- Custom domain: Render dashboard → service → **Settings → Custom Domain**,
  add `pxcutzz.com`, then at your domain registrar (Namecheap) point the
  domain to Render using the DNS records Render shows you. The site then
  lives at `https://pxcutzz.com`.

### Test the live site
1. Open the Render URL. Pick a service (e.g. Haircut & Beard), pick a day
   that is not a Tuesday, pick a time, enter your name/phone/email, submit.
2. You should see "You're booked!" with the booking details.
3. Try booking the same slot again — it should no longer be offered.
4. Open **Manage** at the bottom of the page — your booking is listed.
   Click **Confirm** — its status becomes "confirmed".

## SMS (future)
No SMS gateway is connected and none is invented here. When the owner is
ready, the usual next step is a Twilio account: add `TWILIO_ACCOUNT_SID`,
`TWILIO_AUTH_TOKEN`, and `TWILIO_PHONE_NUMBER` to Render, then add a
`sendSms()` call next to `sendBookingEmails()` in `server.js` to text the
client a confirmation and the salon an alert. The booking form already
collects the client's phone number.

## Files
- `package.json` — dependencies (express, better-sqlite3, nodemailer) and `npm start`
- `server.js` — Express server, services, slots, bookings API, email
- `public/index.html` — booking page + Manage view
- `public/app.js` — booking wizard + Manage logic (no build step)
- `public/styles.css` — styling
- `render.yaml` — Render blueprint (free web service)
- `README.md` — this file
