# CSAFI Outreach Dashboard

A simple, CEO-friendly view of outreach performance across both channels, with a
**date-range filter**:

- **LinkedIn** (Connectora) — requests sent · accepted · replied
- **Email** (Instantly) — emails sent · opened · replied

Two big headline sections up top, a slim per-campaign breakdown below, and API
keys that never leave the server.

---

## The date filter (important to understand)

- **Email** filters by date natively — Instantly's API accepts a date range, so
  the email numbers reflect exactly the period you pick.
- **LinkedIn** has no date history in its API (Connectora only returns *current*
  totals). So this app keeps a **daily snapshot** of each LinkedIn campaign in
  Postgres, and computes "activity in a range" as the difference between the
  snapshot at the end of the range and the one just before the start.
  - **History builds forward from the day you switch it on.** It cannot recover
    weeks that already passed.
  - Without a database, LinkedIn just shows **lifetime** totals (and says so);
    the email date filter still works.

---

## Guardrail

Only campaigns whose title contains **`CSAFI`** (case-insensitive) are shown, on
both channels — so test/finished campaigns without that in the name are ignored.
Change the keyword any time with the `CAMPAIGN_FILTER` variable.

---

## Webinar bookings (HubSpot, read directly)

The **Webinar Bookings** section (top of the page) reads your HubSpot webinar-form
submissions **directly from HubSpot** on every refresh — the same way the dashboard
reads Connectora and Instantly. No n8n or database step is needed for bookings; each
submission carries its own `submittedAt`, so bookings filter by date natively, and the
form values give the registrant's **name + email**.

**Railway variables:**
- `HUBSPOT_TOKEN` — a HubSpot **private-app token** with the **`forms`** scope
  (HubSpot → Settings → Integrations → Private Apps → Create → add the `forms` scope →
  copy the token, starts with `pat-`).
- `HUBSPOT_FORMS` — the webinar forms to read, as JSON mapping each **form GUID** to a
  display name, e.g. `{"f0fe96d8-449a-4768-975b-6fa539b56466":"IT Webinar","<guid2>":"Executive Webinar"}`.
  (The GUID is the `sourceId` you saw in the webhook, or the form's ID in HubSpot →
  Marketing → Forms.)
- `BOOKING_LINK` — the webinar URL to display on the card.

Endpoint used (read-only): `GET /form-integrations/v1/submissions/forms/{guid}` — paged
50 at a time, newest first; for a date range it stops paging once it passes the start.

> Note: this counts every **form submission**, so it captures both new and existing
> HubSpot contacts. (An optional n8n → `POST /api/booking` push path is still built in
> as a fallback — set `BOOKING_TOKEN` + `DATABASE_URL` instead of the HubSpot vars.)

---

## Deploy on Railway

### 1. Deploy the app
Push this folder to your repo and deploy it as a service (Railway auto-runs
`npm start`). Set these **Variables**:

- `CONNECTORA_API_KEY` — your Connectora key (`mcp_…`)
- `INSTANTLY_API_KEY` — your Instantly v2 key
- `CAMPAIGN_FILTER` — `CSAFI` (already the default)

At this point everything works, with LinkedIn showing **lifetime** totals.

### 2. Add the database (enables LinkedIn date filtering)
1. In your Railway project: **+ New → Database → Add PostgreSQL** (one click).
2. Open your **app** service → **Variables** → add:
   `DATABASE_URL = ${{Postgres.DATABASE_URL}}`
   (Type it exactly — Railway links it to the Postgres service.)
3. Redeploy. On boot the app creates its table and starts snapshotting.
   From now on, the date filter works for LinkedIn too.

That's it. (Prefer your existing Supabase instead? Use its connection string as
`DATABASE_URL` — same thing. Just note the Supabase free tier auto-pauses when
idle, which Railway Postgres doesn't.)

### Keeping snapshots fresh
The app snapshots on every page load **and** every 6 hours on its own, so history
accrues even if nobody opens the page. You can also trigger one manually:
`POST /api/snapshot` (protect it by setting `SNAPSHOT_TOKEN` and sending it as the
`x-snapshot-token` header) — handy if you'd rather drive it from n8n on a schedule.

---

## Run locally

```bash
npm install
cp .env.example .env      # paste your keys; DATABASE_URL optional
npm start                 # http://localhost:3000
```

No keys? It renders bundled sample data. `DEMO_MODE=true` forces that.

---

## How it stays live

Every `/api/data` call fetches current values straight from the APIs — no caching
(`Cache-Control: no-store`, ETag disabled). Clicking **Refresh**, changing the
date range, or the 60-second auto-refresh all pull fresh numbers. The small status
line under the header shows each API's HTTP status, response time, and campaign
count on every refresh; the server logs every call (visible in Railway logs).

## Endpoints used (read-only on the outreach tools)

- Connectora: `GET /api/mcp/analytics/overview`
- Instantly:  `GET /api/v2/campaigns/analytics?start_date=&end_date=`

This dashboard never sends a message, launches, or changes anything in either tool.
