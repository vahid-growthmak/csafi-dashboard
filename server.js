/**
 * CSAFI Outreach Dashboard — backend
 * -----------------------------------
 * Serves a simple, CEO-friendly view of outreach performance:
 *   - LinkedIn (Connectora)  -> analytics/overview   (current totals)
 *   - Email    (Instantly)   -> campaigns/analytics  (supports date ranges)
 *
 * Date filtering:
 *   - EMAIL: Instantly's API filters by date natively (start_date / end_date).
 *   - LINKEDIN: Connectora only returns *current* totals, so we keep a daily
 *     snapshot in Postgres and compute "activity in a date range" as the
 *     difference between the snapshot at the end of the range and the one just
 *     before it. History builds forward from the first snapshot.
 *
 * Guardrail:
 *   - Only campaigns whose title contains CAMPAIGN_FILTER (default "CSAFI",
 *     case-insensitive) are shown, on both channels.
 *
 * Everything runs on the server; API keys never reach the browser.
 *
 * Env vars (set in Railway):
 *   CONNECTORA_API_KEY   Connectora MCP key (mcp_...)
 *   INSTANTLY_API_KEY    Instantly v2 API key
 *   DATABASE_URL         Postgres connection string (add Railway Postgres).
 *                        Without it, LinkedIn simply shows lifetime totals.
 *   CAMPAIGN_FILTER      default "CSAFI"
 *   SNAPSHOT_TOKEN       optional; protects POST /api/snapshot
 *   CONNECTORA_BASE / INSTANTLY_BASE   optional overrides
 *   DEMO_MODE            "true" to render bundled sample data
 *   PGSSL                "disable" to turn off SSL (Railway internal networking)
 */

import express from "express";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set("etag", false);
app.use(express.json());
const PORT = process.env.PORT || 3000;

const CONNECTORA_API_KEY = process.env.CONNECTORA_API_KEY || "";
const INSTANTLY_API_KEY = process.env.INSTANTLY_API_KEY || "";
const CONNECTORA_BASE = process.env.CONNECTORA_BASE || "https://mcp.connectora.growthmak.com/api/mcp";
const INSTANTLY_BASE = process.env.INSTANTLY_BASE || "https://api.instantly.ai/api/v2";
const CAMPAIGN_FILTER = (process.env.CAMPAIGN_FILTER || "CSAFI").trim().toLowerCase();
const SNAPSHOT_TOKEN = process.env.SNAPSHOT_TOKEN || "";
const DATABASE_URL = process.env.DATABASE_URL || "";

const DEMO_MODE =
  String(process.env.DEMO_MODE).toLowerCase() === "true" ||
  (!CONNECTORA_API_KEY && !INSTANTLY_API_KEY);

// ---------- Postgres (optional) ----------
let pool = null;
if (DATABASE_URL) {
  // No SSL for local dev or Railway's private network; SSL for external hosts (Supabase, public proxies).
  const noSsl = /localhost|127\.0\.0\.1|\.railway\.internal/.test(DATABASE_URL);
  const ssl = process.env.PGSSL === "disable" || noSsl ? false : { rejectUnauthorized: false };
  pool = new pg.Pool({ connectionString: DATABASE_URL, ssl, max: 4 });
  pool.on("error", (e) => console.log("  ! pg pool error:", e.message));
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS linkedin_snapshots (
      snapshot_date DATE NOT NULL,
      campaign_id   TEXT NOT NULL,
      campaign_name TEXT,
      status        TEXT,
      leads         INTEGER DEFAULT 0,
      sent          INTEGER DEFAULT 0,
      accepted      INTEGER DEFAULT 0,
      replied       INTEGER DEFAULT 0,
      captured_at   TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (snapshot_date, campaign_id)
    );
  `);
  console.log("  db: linkedin_snapshots ready");
}

// ---------- helpers ----------
function pct(n, d) {
  if (!d || d <= 0) return 0;
  return Math.round((n / d) * 1000) / 10;
}
function includeCampaign(name) {
  if (!CAMPAIGN_FILTER) return true;
  return String(name || "").toLowerCase().includes(CAMPAIGN_FILTER);
}
// today's date (YYYY-MM-DD) in the CEO's timezone
function istToday() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}
function addDays(dateStr, n) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function firstOfMonth(dateStr) { return dateStr.slice(0, 8) + "01"; }

// Resolve a date range from query params. Returns {start, end, label, all}.
function resolveRange(q) {
  const today = istToday();
  const preset = String(q.preset || "").toLowerCase();
  if (preset === "7d") return { start: addDays(today, -6), end: today, label: "Last 7 days", all: false };
  if (preset === "30d") return { start: addDays(today, -29), end: today, label: "Last 30 days", all: false };
  if (preset === "month") return { start: firstOfMonth(today), end: today, label: "This month", all: false };
  if (preset === "all" || (!q.start && !q.end && !preset)) return { start: null, end: null, label: "All time", all: true };
  // custom
  const start = /^\d{4}-\d{2}-\d{2}$/.test(q.start || "") ? q.start : addDays(today, -6);
  const end = /^\d{4}-\d{2}-\d{2}$/.test(q.end || "") ? q.end : today;
  return { start, end, label: `${start} → ${end}`, all: false };
}

async function callUpstream(label, url, headers, timeoutMs = 15000) {
  const started = Date.now();
  console.log(`  -> ${label}  GET ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    const text = await res.text();
    const ms = Date.now() - started;
    let body;
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
    if (!res.ok) {
      const msg = body?.error || body?.message || `HTTP ${res.status}`;
      console.log(`  <- ${label}  ${res.status} FAILED in ${ms}ms  ·  ${msg}`);
      return { ok: false, status: res.status, durationMs: ms, error: msg };
    }
    console.log(`  <- ${label}  ${res.status} OK in ${ms}ms`);
    return { ok: true, status: res.status, durationMs: ms, body };
  } catch (err) {
    const ms = Date.now() - started;
    const msg = err.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(err.message || err);
    console.log(`  <- ${label}  ERROR in ${ms}ms  ·  ${msg}`);
    return { ok: false, status: 0, durationMs: ms, error: msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------- LinkedIn (Connectora) ----------
function normalizeConnectoraLive(overview) {
  const list = Array.isArray(overview?.perCampaign) ? overview.perCampaign : [];
  return list
    .filter((c) => includeCampaign(c.name))
    .map((c) => {
      const f = c.funnel || {};
      return {
        channel: "linkedin",
        id: c.id,
        name: c.name || "(unnamed campaign)",
        status: String(c.status || "unknown").toLowerCase(),
        leads: Number(f.total || 0),
        sent: Number(f.inviteSent || 0),
        accepted: Number(f.connected || 0),
        replied: Number(f.replied || 0),
      };
    });
}

// current lifetime totals from Connectora (also used to write the daily snapshot)
async function getConnectoraLive() {
  if (!CONNECTORA_API_KEY) return { ok: false, configured: false, error: "CONNECTORA_API_KEY is not set.", rows: [] };
  const url = `${CONNECTORA_BASE}/analytics/overview`;
  const r = await callUpstream("Connectora", url, { Authorization: `Bearer ${CONNECTORA_API_KEY}`, Accept: "application/json" });
  if (!r.ok) return { ok: false, configured: true, error: r.error, status: r.status, durationMs: r.durationMs, rows: [] };
  const rows = normalizeConnectoraLive(r.body);
  console.log(`     Connectora: ${rows.length} CSAFI campaign(s) after filter`);
  return { ok: true, configured: true, status: r.status, durationMs: r.durationMs, rows };
}

async function writeSnapshot(rows) {
  if (!pool || !rows.length) return;
  const day = istToday();
  const text = `
    INSERT INTO linkedin_snapshots (snapshot_date, campaign_id, campaign_name, status, leads, sent, accepted, replied, captured_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
    ON CONFLICT (snapshot_date, campaign_id) DO UPDATE SET
      campaign_name = EXCLUDED.campaign_name, status = EXCLUDED.status, leads = EXCLUDED.leads,
      sent = EXCLUDED.sent, accepted = EXCLUDED.accepted, replied = EXCLUDED.replied, captured_at = now();`;
  for (const c of rows) {
    await pool.query(text, [day, c.id, c.name, c.status, c.leads, c.sent, c.accepted, c.replied]);
  }
  console.log(`     snapshot saved for ${day} (${rows.length} campaign(s))`);
}

// scheduled/standalone snapshot (does its own Connectora fetch)
async function snapshotJob() {
  if (!pool) return;
  const live = await getConnectoraLive();
  if (live.ok) await writeSnapshot(live.rows);
}

// LinkedIn numbers for a date range, computed from snapshots (delta end - before-start)
async function getLinkedInRange(range, liveRows) {
  // All-time (or no DB): just use the live lifetime totals.
  if (range.all || !pool) {
    const campaigns = (liveRows || []).map((c) => finishLinkedIn(c.name, c.status, c.leads, c.sent, c.accepted, c.replied, c.id));
    return { mode: "lifetime", campaigns, historySince: null };
  }
  const { rows } = await pool.query(
    `
    WITH end_snap AS (
      SELECT DISTINCT ON (campaign_id) campaign_id, campaign_name, status, leads, sent, accepted, replied
      FROM linkedin_snapshots WHERE snapshot_date <= $2
      ORDER BY campaign_id, snapshot_date DESC
    ),
    base_snap AS (
      SELECT DISTINCT ON (campaign_id) campaign_id, sent, accepted, replied
      FROM linkedin_snapshots WHERE snapshot_date < $1
      ORDER BY campaign_id, snapshot_date DESC
    )
    SELECT e.campaign_id, e.campaign_name, e.status, e.leads,
      GREATEST(e.sent     - COALESCE(b.sent,0),     0) AS sent,
      GREATEST(e.accepted - COALESCE(b.accepted,0), 0) AS accepted,
      GREATEST(e.replied  - COALESCE(b.replied,0),  0) AS replied
    FROM end_snap e LEFT JOIN base_snap b USING (campaign_id)
    ORDER BY e.campaign_name;`,
    [range.start, range.end]
  );
  const campaigns = rows
    .filter((r) => includeCampaign(r.campaign_name))
    .map((r) => finishLinkedIn(r.campaign_name, r.status, r.leads, Number(r.sent), Number(r.accepted), Number(r.replied), r.campaign_id));
  const min = await pool.query(`SELECT MIN(snapshot_date) AS d FROM linkedin_snapshots`);
  const historySince = min.rows[0]?.d ? new Date(min.rows[0].d).toISOString().slice(0, 10) : null;
  return { mode: "range", campaigns, historySince };
}

function finishLinkedIn(name, status, leads, sent, accepted, replied, id) {
  return {
    channel: "linkedin", id, name, status: String(status || "unknown").toLowerCase(),
    running: String(status || "").toLowerCase() === "running",
    leads: Number(leads || 0), sent, accepted, replied,
    noReply: Math.max(sent - replied, 0),
    acceptRatePct: pct(accepted, sent),
    replyRatePct: pct(replied, accepted),
  };
}

// ---------- Email (Instantly) ----------
function instantlyStatus(code) {
  switch (Number(code)) {
    case 1: case 4: return "running";
    case 2: return "paused";
    case 3: return "completed";
    case 0: return "draft";
    case -99: return "suspended";
    case -1: return "unhealthy";
    case -2: return "bounce protect";
    default: return "unknown";
  }
}
function normalizeInstantly(rows) {
  const list = Array.isArray(rows) ? rows : rows?.items || [];
  return list
    .filter((c) => includeCampaign(c.campaign_name))
    .map((c) => {
      const sent = Number(c.contacted_count ?? c.emails_sent_count ?? 0);
      const accepted = Number(c.open_count_unique ?? c.open_count ?? 0);
      const replied = Number(c.reply_count_unique ?? c.reply_count ?? 0);
      const status = instantlyStatus(c.campaign_status);
      return {
        channel: "email", id: c.campaign_id, name: c.campaign_name || "(unnamed campaign)",
        status, running: status === "running",
        leads: Number(c.leads_count || 0),
        sent, accepted, replied, noReply: Math.max(sent - replied, 0),
        acceptRatePct: pct(accepted, sent), replyRatePct: pct(replied, sent),
        bounced: Number(c.bounced_count || 0),
        opportunities: Number(c.total_opportunities || 0),
        opportunityValue: Number(c.total_opportunity_value || 0),
      };
    });
}
async function getEmail(range) {
  if (!INSTANTLY_API_KEY) return { ok: false, configured: false, error: "INSTANTLY_API_KEY is not set.", campaigns: [], meta: { source: "not-configured" } };
  let url = `${INSTANTLY_BASE}/campaigns/analytics`;
  if (!range.all) url += `?start_date=${range.start}&end_date=${range.end}`;
  const r = await callUpstream("Instantly", url, { Authorization: `Bearer ${INSTANTLY_API_KEY}`, Accept: "application/json" });
  const meta = { source: "live", httpStatus: r.status, durationMs: r.durationMs };
  if (!r.ok) return { ok: false, configured: true, error: r.error, campaigns: [], meta };
  const campaigns = normalizeInstantly(r.body);
  console.log(`     Instantly: ${campaigns.length} CSAFI campaign(s) after filter`);
  return { ok: true, configured: true, campaigns, meta };
}

// ---------- totals ----------
function totalsFor(campaigns, channel) {
  const t = campaigns.reduce((a, c) => {
    a.campaigns++; a.running += c.running ? 1 : 0;
    a.sent += c.sent; a.accepted += c.accepted; a.replied += c.replied; a.noReply += c.noReply;
    return a;
  }, { campaigns: 0, running: 0, sent: 0, accepted: 0, replied: 0, noReply: 0 });
  t.acceptRatePct = pct(t.accepted, t.sent);
  t.replyRatePct = channel === "email" ? pct(t.replied, t.sent) : pct(t.replied, t.accepted || t.sent);
  return t;
}

// ---------- routes ----------
app.get("/api/data", async (req, res) => {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  const reqStart = Date.now();
  const range = resolveRange(req.query);
  console.log(`\n[${new Date().toISOString()}] /api/data  <- range="${range.label}"${DEMO_MODE ? "  (DEMO)" : ""}`);

  try {
    if (DEMO_MODE) {
      const sample = JSON.parse(await readFile(path.join(__dirname, "sample-data.json"), "utf8"));
      const meta = { source: "demo" };
      const li = { ok: true, configured: true, campaigns: sample.linkedin, meta: { ...meta, mode: "lifetime" } };
      const em = { ok: true, configured: true, campaigns: sample.email, meta };
      console.log("  (serving sample data)");
      return res.json({
        generatedAt: new Date().toISOString(), demo: true, range,
        linkedin: { ...li, totals: totalsFor(li.campaigns, "linkedin") },
        email: { ...em, totals: totalsFor(em.campaigns, "email") },
      });
    }

    // Fetch LinkedIn live + email (in parallel)
    const [live, email] = await Promise.all([getConnectoraLive(), getEmail(range)]);

    // keep today's snapshot fresh (also seeds history)
    if (pool && live.ok) { try { await writeSnapshot(live.rows); } catch (e) { console.log("  ! snapshot write failed:", e.message); } }

    // LinkedIn for the selected range
    let linkedin;
    if (!live.configured) {
      linkedin = { ok: false, configured: false, error: live.error, campaigns: [], meta: { source: "not-configured" } };
    } else if (!live.ok) {
      linkedin = { ok: false, configured: true, error: live.error, campaigns: [], meta: { source: "live", httpStatus: live.status, durationMs: live.durationMs } };
    } else {
      const ranged = await getLinkedInRange(range, live.rows);
      linkedin = {
        ok: true, configured: true, campaigns: ranged.campaigns,
        meta: { source: "live", httpStatus: live.status, durationMs: live.durationMs, mode: ranged.mode, historySince: ranged.historySince, dbEnabled: !!pool },
      };
    }

    console.log(`  = done in ${Date.now() - reqStart}ms  ·  LinkedIn ${linkedin.ok ? "OK" : "FAIL"} (${linkedin.meta.mode || "-"}) / Email ${email.ok ? "OK" : "FAIL"}`);
    res.json({
      generatedAt: new Date().toISOString(), demo: false, range,
      linkedin: { ...linkedin, totals: totalsFor(linkedin.campaigns, "linkedin") },
      email: { ...email, totals: totalsFor(email.campaigns, "email") },
    });
  } catch (err) {
    console.log("  ! /api/data error:", err.message);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Manual snapshot trigger (for n8n/cron or backfilling). Protect with SNAPSHOT_TOKEN.
app.post("/api/snapshot", async (req, res) => {
  if (SNAPSHOT_TOKEN && req.get("x-snapshot-token") !== SNAPSHOT_TOKEN) {
    return res.status(401).json({ error: "bad token" });
  }
  if (!pool) return res.status(400).json({ error: "no DATABASE_URL — snapshots disabled" });
  try {
    console.log(`\n[${new Date().toISOString()}] /api/snapshot  <- manual`);
    await snapshotJob();
    res.json({ ok: true, date: istToday() });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

app.get("/healthz", (req, res) => res.json({ ok: true, db: !!pool }));
app.use(express.static(path.join(__dirname, "public")));

(async () => {
  try { await ensureSchema(); } catch (e) { console.log("  ! ensureSchema failed:", e.message); }
  app.listen(PORT, () => {
    console.log(`CSAFI dashboard on port ${PORT}`);
    console.log(`  Connectora key: ${CONNECTORA_API_KEY ? "set" : "MISSING"}  ·  Instantly key: ${INSTANTLY_API_KEY ? "set" : "MISSING"}`);
    console.log(`  Postgres: ${pool ? "connected (LinkedIn history ON)" : "none (LinkedIn lifetime only)"}  ·  filter: "${CAMPAIGN_FILTER}"  ·  demo: ${DEMO_MODE ? "ON" : "off"}`);
  });
  // background snapshots so history accrues even if nobody opens the page
  if (pool) {
    snapshotJob().catch((e) => console.log("  ! startup snapshot:", e.message));
    setInterval(() => snapshotJob().catch((e) => console.log("  ! snapshot:", e.message)), 6 * 60 * 60 * 1000);
  }
})();
