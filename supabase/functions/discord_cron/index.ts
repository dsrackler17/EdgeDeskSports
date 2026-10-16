// ============================================================
//  FILE:    supabase/functions/discord_cron/index.ts
//  TYPE:    Edge Function (deployed) — every automated EdgeDesk Discord post
//  DEPLOY:  the Deploy Discord posts workflow, or
//           supabase functions deploy discord_cron --no-verify-jwt
//  CRON:    supabase/discord_cron.sql (scorecard Mondays 10:00 CT, slate daily
//           10:00 CT, samples every 15 minutes)
// ============================================================
// WHAT IT POSTS. Three things, each through the one helper, postToDiscord():
//
//   action 'scorecard'  Mondays 10:00 America/Chicago, to #clv-results. One
//       embed per sport (NFL, CFB, NBA, CBB, NHL): graded signals, average
//       CLV, the share that beat the close and the Brier score, for the past
//       seven Central days and the season. CLV comes from the SAME query the
//       public record runs (record.html: public_record with its EDGEQ filter);
//       Brier from the /performance/ ledger's database mirror (perf_grades,
//       the headline tier: VERIFIED, eligible, non-push). Fewer than 10 graded
//       signals prints the numbers AND "Small sample" — nothing is hidden, and
//       a bad week is printed exactly like a good one. A last embed carries
//       the free Discord samples' own record.
//
//   action 'slate'  daily 10:00 CT, to each sport's channel. First
//       yesterday's results: how EdgeDesk's pregame numbers did, every game,
//       from the /performance/ record (misses printed like hits; a day with an
//       unverified final waits for the 10:30 tick). Then today's slate: game,
//       time, the book's line, the opening line and the move since the open,
//       and the forecast for outdoor football games where EdgeDesk has one.
//       Where EdgeDesk owns no consensus or opener (NBA, CBB, NHL: one book's
//       quote via ESPN), the post names the book and shows no move; when the
//       NFL / CFB consensus feed is down it falls back to that one book and
//       says so. Beside each line, EdgeDesk's OWN numbers from
//       engine/projections.json (frozen before any price is read): its side
//       and %, fair price and line, projected score and total, the gap to the
//       book, and the market's validation state. A gap is described, never
//       called a pick; no EV. No games, or a failed / stale sync, is a SKIP,
//       logged with its reason — never a partial post.
//
//   action 'samples'  every 15 minutes, CFB and NFL. (1) records the first
//       time each game is seen classified INVESTIGATE or MONITOR, with the
//       consensus line then (the database clock stamps it); (2) once per slate
//       date, from DISCORD_SAMPLE_SELECT_HOUR, chooses up to two eligible
//       INVESTIGATE games — else the top eligible MONITOR — by a fixed order,
//       and writes every candidate and the reason for each choice before any
//       game is played; (3) posts each sample DISCORD_SAMPLE_DELAY_HOURS after
//       detection and never later than 60 minutes before kickoff (a sample
//       that cannot make that window is recorded as not posted, with why);
//       (4) after the game closes, replies in a thread on the sample with the
//       closing line and the CLV at detection and at post time — the same
//       way whether the market moved toward the flag or away from it.
//       Classification sources: CFB cfb.analyst_flags (the app's "Analyst
//       pass"); NFL public.game_research_state, the NFL board's research
//       status — which has INVESTIGATE but no MONITOR tier and no
//       observability tiers, so an NFL slate with no INVESTIGATE game has no
//       sample, and the post says the tiers are not published for the NFL.
//
// NEVER TWICE. Every post is claimed per type, channel and date
// (supabase/discord.sql: discord_claim_post) before it is sent. A rerun, a
// retry or the :30 tick finds the claim and posts nothing.
//
// NEVER A SECRET IN A LOG. Webhook URLs and the bot token are read from the
// environment by NAME and used only as the request target / header. The log
// stores the secret's name; every error string is scrubbed of webhook URLs,
// and the database refuses a row that carries one.
//
// DRY RUN. DISCORD_DRY_RUN=1 (or "dry_run": true in a manual call) prints
// every payload (`DISCORD_DRY_RUN {...}`) instead of posting, logs it as
// dry_run, claims nothing and writes no sample ledger rows.
//
// AUTH. pg_cron sends the Vault secret discord_cron_secret as x-cron-secret;
// it must equal DISCORD_CRON_SECRET. Deployed with --no-verify-jwt. A GET is a
// read-only health probe that reports which secrets are SET (true/false),
// never their values.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by the platform
//   DISCORD_CRON_SECRET          required; the same value as Vault discord_cron_secret
//   DISCORD_WEBHOOK_CLV_RESULTS  #clv-results webhook URL
//   DISCORD_WEBHOOK_NFL, DISCORD_WEBHOOK_CFB, DISCORD_WEBHOOK_NBA,
//   DISCORD_WEBHOOK_CBB, DISCORD_WEBHOOK_NHL   sport channel webhook URLs
//   DISCORD_BOT_TOKEN            optional; lets the follow-up open a thread on
//                                the sample (webhooks cannot). Without it the
//                                follow-up is posted in the channel with a
//                                link to the sample.
//   DISCORD_DRY_RUN              1 = print, never post
//   DISCORD_SAMPLE_DELAY_HOURS   default 3
//   DISCORD_SAMPLE_SELECT_HOUR   default 8 (CT hour a slate's samples are chosen)
//   DISCORD_SLATE_HOUR, DISCORD_SCORECARD_HOUR   default 10 (CT)
//   DISCORD_LINE_MAX_AGE_MIN     default 180: an older line source is a failed sync
//   DISCORD_SCHEDULE_MAX_AGE_MIN default 180: an older today/slate.json is a failed sync
//   DISCORD_FOLLOWUP_AFTER_HOURS default 4 (hours after kickoff to look for the close)
//   DISCORD_SIGNUP_URL           default https://edgedesksports.com/#pricing (no affiliate code)
//   DISCORD_RECORD_URL           default https://edgedesksports.com/record.html
//   DISCORD_PERFORMANCE_URL      default https://edgedesksports.com/performance/
//   EDGEDESK_SITE_BASE           default https://edgedesksports.com
// ============================================================

/* WHICH CODE IS ANSWERING. Returned by the GET probe. Bump on every change. */
export const BUILD = "discord_cron-2026-10-16-r2";

// ------------------------------------------------------------------ config

/* read per call, so a rotated secret takes effect on the next tick and the
   tests exercise this file rather than a copy of it */
export function config() {
  const env = (k: string) => Deno.env.get(k) ?? '';
  const num = (k: string, fb: number, lo: number, hi: number) => {
    const raw = env(k);
    const v = raw === '' ? fb : Number(raw);
    return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fb;
  };
  return {
    url: env('SUPABASE_URL'),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    cronSecret: env('DISCORD_CRON_SECRET'),
    botToken: env('DISCORD_BOT_TOKEN'),
    dryRun: /^(1|true|on|yes)$/i.test(env('DISCORD_DRY_RUN')),
    siteBase: (env('EDGEDESK_SITE_BASE') || 'https://edgedesksports.com').replace(/\/+$/, ''),
    signupUrl: env('DISCORD_SIGNUP_URL') || 'https://edgedesksports.com/#pricing',
    recordUrl: env('DISCORD_RECORD_URL') || 'https://edgedesksports.com/record.html',
    performanceUrl: env('DISCORD_PERFORMANCE_URL') || 'https://edgedesksports.com/performance/',
    sampleDelayHours: num('DISCORD_SAMPLE_DELAY_HOURS', 3, 0, 72),
    sampleSelectHour: num('DISCORD_SAMPLE_SELECT_HOUR', 8, 0, 23),
    slateHour: num('DISCORD_SLATE_HOUR', 10, 0, 23),
    scorecardHour: num('DISCORD_SCORECARD_HOUR', 10, 0, 23),
    lineMaxAgeMin: num('DISCORD_LINE_MAX_AGE_MIN', 180, 15, 7 * 24 * 60),
    scheduleMaxAgeMin: num('DISCORD_SCHEDULE_MAX_AGE_MIN', 180, 15, 24 * 60),
    followupAfterHours: num('DISCORD_FOLLOWUP_AFTER_HOURS', 4, 3, 48),
    followupGiveUpHours: 48,
    tickMinutes: 15,
  };
}
export type Cfg = ReturnType<typeof config>;

/* the clock and the pause are injectable so the tests can run a day in a second */
export type Runtime = { c: Cfg; now: () => number; sleep: (ms: number) => Promise<void> };
export function runtime(over: Partial<Runtime> = {}): Runtime {
  return { c: config(), now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), ...over };
}

export const CHANNEL = {
  clv: 'DISCORD_WEBHOOK_CLV_RESULTS',
  nfl: 'DISCORD_WEBHOOK_NFL',
  cfb: 'DISCORD_WEBHOOK_CFB',
  nba: 'DISCORD_WEBHOOK_NBA',
  cbb: 'DISCORD_WEBHOOK_CBB',
  nhl: 'DISCORD_WEBHOOK_NHL',
} as const;

export type SportId = 'nfl' | 'cfb' | 'nba' | 'cbb' | 'nhl';
type LineKind = 'collective' | 'cfb_lab' | 'espn';
export const SPORTS: Record<SportId, { label: string; channel: string; slate: string; oddsKey: string; perf: string; lines: LineKind; weather: 'nfl' | 'cfb' | null }> = {
  nfl: { label: 'NFL', channel: CHANNEL.nfl, slate: 'nfl', oddsKey: 'americanfootball_nfl', perf: 'nfl', lines: 'collective', weather: 'nfl' },
  cfb: { label: 'College football', channel: CHANNEL.cfb, slate: 'cfb', oddsKey: 'americanfootball_ncaaf', perf: 'cfb', lines: 'cfb_lab', weather: 'cfb' },
  nba: { label: 'NBA', channel: CHANNEL.nba, slate: 'nba', oddsKey: 'basketball_nba', perf: 'nba', lines: 'espn', weather: null },
  cbb: { label: "Men's college basketball", channel: CHANNEL.cbb, slate: 'ncaam', oddsKey: 'basketball_ncaab', perf: 'ncaab_m', lines: 'espn', weather: null },
  nhl: { label: 'NHL', channel: CHANNEL.nhl, slate: 'nhl', oddsKey: 'icehockey_nhl', perf: 'nhl', lines: 'espn', weather: null },
};
export const SPORT_ORDER: SportId[] = ['nfl', 'cfb', 'nba', 'cbb', 'nhl'];
export const SAMPLE_SPORTS: ('cfb' | 'nfl')[] = ['cfb', 'nfl'];

// ------------------------------------------------------------------ brand

export const BRAND_COLOR = 0x2fa79a; /* --obs / --accent on the site (index.html) */
export const AUTHOR = { name: 'EdgeDesk', url: 'https://edgedesksports.com/' };
export const FOOTER_SLATE = 'Research, not betting advice. 18+.';
export const FOOTER_SAMPLE = 'Research, not betting advice. 18+. Full slate on EdgeDesk';
export const SAMPLE_RULE = 'discord_sample_order_v1';

// ------------------------------------------------------------------ small helpers

const H = 36e5, MIN = 6e4;
type Row = Record<string, unknown>;
const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const ms = (v: unknown): number | null => { const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN; return Number.isFinite(t) ? t : null; };
const iso = (v: number) => new Date(v).toISOString();
const str = (v: unknown) => (v == null ? '' : String(v));
const clip = (s: string, n: number) => (s.length <= n ? s : s.slice(0, Math.max(0, n - 1)) + '…');
const errMsg = (e: unknown) => String((e as Error)?.message ?? e);
const r2 = (v: number) => Math.round(v * 100) / 100;
const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
function list(v: unknown): string[] {
  let a: unknown = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { a = v.trim() ? [v] : []; } }
  if (!Array.isArray(a)) return [];
  return a.map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? str((x as Row).text ?? (x as Row).label ?? (x as Row).name ?? JSON.stringify(x)) : str(x))).filter((x) => x.trim() !== '');
}

/* A webhook URL is a credential. Deno's fetch errors quote the URL they were
   sending to, so every error string passes through here before it is stored
   or returned. */
export function scrub(s: unknown): string {
  return String(s ?? '')
    .replace(/https?:\/\/[^\s"'<>]*\/api\/(?:v\d+\/)?webhooks\/[^\s"'<>]*/gi, '[webhook]')
    .replace(/\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+/g, '/api/webhooks/[redacted]')
    .replace(/Bot\s+[A-Za-z0-9._-]{20,}/g, 'Bot [redacted]');
}

// ------------------------------------------------------------------ Central time

export const ZONE = 'America/Chicago';
const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23',
});
export function localParts(t: number) {
  const p: Record<string, string> = {};
  for (const x of PARTS.formatToParts(new Date(t))) p[x.type] = x.value;
  return { date: `${p.year}-${p.month}-${p.day}`, y: Number(p.year), m: Number(p.month), d: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), second: Number(p.second), weekday: p.weekday };
}
export const localDate = (t: number) => localParts(t).date;
function offsetAt(t: number) {
  const p = localParts(t);
  return Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute, p.second) - Math.floor(t / 1000) * 1000;
}
/* the UTC instant of 00:00 Central on a YYYY-MM-DD date (DST-correct: the
   switch happens at 02:00, so midnight's offset is the day's opening one) */
export function localMidnight(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  let guess = t - offsetAt(t + 6 * H);
  guess = t - offsetAt(guess);
  return guess;
}
export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const FMT_TIME = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', minute: '2-digit', hour12: true });
const FMT_DAY = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'short', month: 'short', day: 'numeric' });
const FMT_LONG = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, weekday: 'long', month: 'short', day: 'numeric' });
export const fmtTime = (t: number) => FMT_TIME.format(new Date(t)) + ' CT';
export const fmtDay = (t: number) => FMT_DAY.format(new Date(t));
export const fmtWhen = (t: number) => `${fmtDay(t)}, ${fmtTime(t)}`;
const fmtLongDate = (date: string) => FMT_LONG.format(new Date(localMidnight(date) + 12 * H));
const fmtShortDate = (date: string) => FMT_DAY.format(new Date(localMidnight(date) + 12 * H));
/* the season a date belongs to: from Aug 1 (football Aug-Feb, basketball and hockey Oct-Jun) */
export function seasonStart(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return `${m >= 8 ? y : y - 1}-08-01`;
}

// ------------------------------------------------------------------ copy check

/* EdgeDesk posts research, not betting advice: no picks, no locks, no EV, no
   win probabilities. postToDiscord refuses a payload that carries any of
   these, and text quoted from a research module is withheld when it does. */
const BANNED: [RegExp, string][] = [
  [/\blocks?\b/i, 'lock'], [/\bbest bets?\b/i, 'best bet'], [/\bbet (this|it|now)\b/i, 'bet this'],
  [/\bguarantee/i, 'guarantee'], [/\bsmash\b/i, 'smash'], [/\bmust[- ]?bet\b/i, 'must bet'],
  [/\bcan'?t lose\b/i, "can't lose"], [/\bfree money\b/i, 'free money'], [/\bsure thing\b/i, 'sure thing'],
  [/\bwinning plays?\b/i, 'winning play'], [/(?:^|[^A-Za-z0-9])\+?EV(?![A-Za-z0-9])/, 'EV'],
  [/\bexpected value\b/i, 'expected value'], [/\bwin(?:ning)? prob/i, 'win probability'],
  [/\bimplied prob/i, 'implied probability'], [/\bundervalued\b/i, 'undervalued'], [/\bovervalued\b/i, 'overvalued'],
  [/\bpicks?\b/i, 'pick'], [/\bvalue (?:play|bet)s?\b/i, 'value play'], [/\bhammer\b/i, 'hammer'],
];
export function copyViolations(text: string): string[] {
  const out: string[] = [];
  for (const [re, name] of BANNED) if (re.test(text) && !out.includes(name)) out.push(name);
  return out;
}
export const WITHHELD = '(withheld: wording failed the EdgeDesk copy check)';
export const safeText = (s: unknown) => (copyViolations(str(s)).length ? WITHHELD : str(s));

// ------------------------------------------------------------------ PostgREST

type Res = { ok: boolean; status: number; data: unknown; error: string | null };
async function sb(c: Cfg, path: string, o: { method?: string; body?: unknown; profile?: string; prefer?: string } = {}): Promise<Res> {
  const method = o.method ?? 'GET';
  const headers: Record<string, string> = { apikey: c.serviceKey, authorization: `Bearer ${c.serviceKey}`, 'content-type': 'application/json' };
  if (o.profile) headers[method === 'GET' ? 'accept-profile' : 'content-profile'] = o.profile;
  if (o.prefer) headers.prefer = o.prefer;
  try {
    const r = await fetch(`${c.url}/rest/v1/${path}`, { method, headers, body: o.body === undefined ? undefined : JSON.stringify(o.body) });
    const text = await r.text();
    let data: unknown = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { ok: r.ok, status: r.status, data, error: r.ok ? null : `HTTP ${r.status}: ${clip(scrub(text), 200)}` };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: clip(scrub(errMsg(e)), 200) };
  }
}
/* every page of a read (PostgREST caps a page; a silent cap is a wrong count) */
async function sbAll(c: Cfg, path: string, profile?: string): Promise<{ rows: Row[] | null; error: string | null }> {
  const PAGE = 1000, rows: Row[] = [];
  for (let p = 0; p < 100; p++) {
    const r = await sb(c, `${path}&limit=${PAGE}&offset=${p * PAGE}`, { profile });
    if (!r.ok) return { rows: null, error: r.error };
    if (!Array.isArray(r.data)) return { rows: null, error: 'not a list' };
    rows.push(...(r.data as Row[]));
    if (r.data.length < PAGE) return { rows, error: null };
  }
  return { rows: null, error: 'more than 100 pages' };
}
const rpc = (c: Cfg, fn: string, args: Row, profile?: string) => sb(c, `rpc/${fn}`, { method: 'POST', body: args, profile });
const inList = (ids: string[]) => `in.(${ids.map((x) => encodeURIComponent(x)).join(',')})`;
const q = (v: string) => encodeURIComponent(v);

// ================================================================== postToDiscord

export const LIMITS = { embedsPerMessage: 10, fields: 25, message: 6000, title: 256, description: 4096, fieldName: 256, fieldValue: 1024, footer: 2048, author: 256, content: 2000 };
export type Field = { name: string; value: string; inline?: boolean };
export type Embed = { title?: string; description?: string; url?: string; color?: number; author?: { name: string; url?: string }; fields?: Field[]; footer?: { text: string }; timestamp?: string };
export type Payload = { content?: string; embeds?: Embed[] };
export type Message = Payload & { username: string; allowed_mentions: { parse: string[] } };
export type PostType = 'clv_scorecard' | 'slate' | 'results' | 'sample' | 'sample_followup' | 'adhoc';
export type PostOpts = { type?: PostType; postKey?: string | null; postDate?: string | null; threadId?: string | null; dryRun?: boolean; detail?: Row };
export type PostResult = {
  status: 'sent' | 'failed' | 'partial' | 'unknown' | 'dry_run' | 'duplicate';
  messageIds: string[]; channelId: string | null; error: string | null; httpStatus: number | null; attempts: number; messages: number; printed?: Message[];
};

const WEBHOOK_RE = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[A-Za-z0-9_-]+$/;
const MAX_429_TRIES = 5, MAX_429_WAIT_MS = 60_000;

export function embedChars(e: Embed): number {
  return (e.title?.length ?? 0) + (e.description?.length ?? 0) + (e.footer?.text?.length ?? 0) + (e.author?.name?.length ?? 0)
    + (e.fields ?? []).reduce((a, f) => a + f.name.length + f.value.length, 0);
}

/* One embed in, as many embeds as Discord's limits need out: every string cut
   to its own limit, at most 25 fields and 6000 characters per embed. The
   author stays on the first, the footer moves to the last. */
export function splitEmbed(e: Embed): Embed[] {
  const color = e.color ?? BRAND_COLOR;
  const author = { ...(e.author ?? AUTHOR), name: clip(str((e.author ?? AUTHOR).name), LIMITS.author) };
  const footer = e.footer ? { text: clip(str(e.footer.text), LIMITS.footer) } : null;
  const head: Embed = { color, author };
  if (e.title) head.title = clip(e.title, LIMITS.title);
  if (e.url) head.url = e.url;
  if (e.timestamp) head.timestamp = e.timestamp;
  const footLen = footer?.text.length ?? 0;
  if (e.description) {
    const room = LIMITS.message - footLen - (head.title?.length ?? 0) - author.name.length;
    head.description = clip(clip(e.description, LIMITS.description), Math.max(1, room));
  }
  const out: Embed[] = [head];
  for (const f of e.fields ?? []) {
    const field: Field = { name: clip(f.name || '​', LIMITS.fieldName), value: clip(f.value || '​', LIMITS.fieldValue) };
    if (f.inline) field.inline = true;
    let cur = out[out.length - 1];
    const n = cur.fields?.length ?? 0;
    if (n >= LIMITS.fields || embedChars(cur) + field.name.length + field.value.length + footLen > LIMITS.message) {
      cur = { color };
      if (e.title) cur.title = clip(e.title + ' (continued)', LIMITS.title);
      out.push(cur);
    }
    (cur.fields ??= []).push(field);
  }
  if (footer) out[out.length - 1].footer = footer;
  return out;
}

/* Embeds into messages: at most 10 embeds and 6000 embed characters each. */
export function packMessages(p: Payload): Message[] {
  const embeds = (p.embeds ?? []).flatMap(splitEmbed);
  const msgs: Message[] = [];
  let cur: Embed[] = [], chars = 0;
  const flush = () => { if (cur.length) msgs.push({ username: 'EdgeDesk', allowed_mentions: { parse: [] }, embeds: cur }); cur = []; chars = 0; };
  for (const e of embeds) {
    const n = embedChars(e);
    if (cur.length && (cur.length >= LIMITS.embedsPerMessage || chars + n > LIMITS.message)) flush();
    cur.push(e); chars += n;
  }
  flush();
  if (!msgs.length) msgs.push({ username: 'EdgeDesk', allowed_mentions: { parse: [] } });
  if (p.content) msgs[0].content = clip(p.content, LIMITS.content);
  return msgs;
}

function messageText(ms: Message[]): string {
  return ms.map((m) => [m.content ?? '', ...(m.embeds ?? []).map((e) => [e.title, e.description, e.footer?.text, e.author?.name, ...(e.fields ?? []).flatMap((f) => [f.name, f.value])].join('\n'))].join('\n')).join('\n');
}

async function logPost(c: Cfg, row: Row): Promise<void> {
  const r = await sb(c, 'discord_posts', { method: 'POST', body: row, prefer: 'return=minimal' });
  if (!r.ok) console.error('discord_posts: the log row was not written', r.error);
}

type Sent = { ok: boolean; definite: boolean; id: string; channelId: string | null; status: number | null; error: string | null; attempts: number; waitMs: number };
async function sendWebhook(url: string, body: Message, threadId: string | null, rt: Runtime): Promise<Sent> {
  const target = `${url}?wait=true${threadId ? `&thread_id=${encodeURIComponent(threadId)}` : ''}`;
  let attempts = 0;
  for (;;) {
    attempts++;
    let r: Response;
    try {
      r = await fetch(target, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    } catch (e) {
      /* the request may have reached Discord: never retried, never re-claimed */
      return { ok: false, definite: false, id: '', channelId: null, status: null, error: 'network error, outcome unknown: ' + clip(scrub(errMsg(e)), 200), attempts, waitMs: 0 };
    }
    if (r.status === 429) {
      /* a 429 was not processed: wait as long as Discord says, then retry */
      let j: Row | null = null;
      try { j = await r.json() as Row; } catch { /* the header is enough */ }
      const ra = num(j?.retry_after) ?? num(r.headers.get('retry-after')) ?? 1;
      const wait = Math.ceil(Math.max(0, ra) * 1000) + 100;
      if (attempts >= MAX_429_TRIES || wait > MAX_429_WAIT_MS) {
        return { ok: false, definite: true, id: '', channelId: null, status: 429, error: `rate limited by Discord (retry_after ${ra}s, ${attempts} attempts)`, attempts, waitMs: 0 };
      }
      await rt.sleep(wait);
      continue;
    }
    if (r.ok) {
      let j: Row = {};
      try { j = await r.json() as Row; } catch { /* wait=true returns the message; tolerate its absence */ }
      const reset = num(r.headers.get('x-ratelimit-reset-after'));
      const waitMs = r.headers.get('x-ratelimit-remaining') === '0' && reset != null ? Math.ceil(reset * 1000) : 0;
      return { ok: true, definite: true, id: str(j.id), channelId: j.channel_id ? str(j.channel_id) : null, status: r.status, error: null, attempts, waitMs };
    }
    let text = '';
    try { text = await r.text(); } catch { /* status is enough */ }
    /* 4xx: Discord refused it (safe to try again later); 5xx: it may have landed */
    return { ok: false, definite: r.status < 500, id: '', channelId: null, status: r.status, error: `HTTP ${r.status}: ${clip(scrub(text), 300)}`, attempts, waitMs: 0 };
  }
}

/**
 * THE ONE WAY A DISCORD POST LEAVES EDGEDESK.
 *   webhookSecretName  the NAME of the secret holding the webhook URL
 *                      (DISCORD_WEBHOOK_*); the URL is read here and never
 *                      logged, returned or stored.
 *   payload            content and embeds; split to Discord's limits (10
 *                      embeds and 6000 characters per message, 25 fields per
 *                      embed, every string to its own limit).
 *   opts.postKey       the idempotency key: claimed before the send, so the
 *                      same key is never posted twice.
 * Handles 429 by waiting retry_after. Logs every call to discord_posts.
 */
export async function postToDiscord(webhookSecretName: string, payload: Payload, opts: PostOpts = {}, rt: Runtime = runtime()): Promise<PostResult> {
  const c = rt.c;
  const type: PostType = opts.type ?? 'adhoc';
  const messages = packMessages(payload);
  const res: PostResult = { status: 'failed', messageIds: [], channelId: null, error: null, httpStatus: null, attempts: 0, messages: messages.length };
  const done = async (extra: Row = {}) => {
    await logPost(c, {
      channel: webhookSecretName, type, post_key: opts.postKey ?? null, post_date: opts.postDate ?? null,
      status: res.status, error: res.error ? clip(scrub(res.error), 500) : null, http_status: res.httpStatus, attempts: res.attempts,
      message_ids: res.messageIds, discord_channel_id: res.channelId, thread_id: opts.threadId ?? null,
      payload: { messages }, detail: { ...(opts.detail ?? {}), ...extra },
    });
    return res;
  };
  if (!/^DISCORD_WEBHOOK_[A-Z0-9_]+$/.test(webhookSecretName)) {
    res.error = 'not a DISCORD_WEBHOOK_* secret name';
    console.error('postToDiscord:', res.error);
    return res; /* the log's own check would refuse this row */
  }
  const bad = copyViolations(messageText(messages));
  if (bad.length) { res.error = 'refused by the copy check: ' + bad.join(', '); return done(); }

  if (opts.dryRun ?? c.dryRun) {
    console.log('DISCORD_DRY_RUN ' + JSON.stringify({ channel: webhookSecretName, type, post_key: opts.postKey ?? null, thread_id: opts.threadId ?? null, messages }));
    res.status = 'dry_run';
    res.printed = messages;
    return done();
  }

  const url = (Deno.env.get(webhookSecretName) ?? '').trim();
  if (!url) { res.error = `${webhookSecretName} is not set`; return done(); }
  if (!WEBHOOK_RE.test(url)) { res.error = `${webhookSecretName} is not a Discord webhook URL; refused (the value is not logged)`; return done(); }

  if (opts.postKey) {
    if (!opts.postDate) { res.error = 'a post key needs a post date'; return done(); }
    const cl = await rpc(c, 'discord_claim_post', { p_post_key: opts.postKey, p_channel: webhookSecretName, p_type: type, p_post_date: opts.postDate });
    if (!cl.ok) { res.error = 'could not claim the post, so it was not sent: ' + cl.error; return done(); }
    const d = (cl.data ?? {}) as Row;
    if (d.claimed !== true) { res.status = 'duplicate'; res.error = `already ${str(d.state) || 'claimed'} for ${opts.postKey}`; return done(); }
  }

  for (let i = 0; i < messages.length; i++) {
    const s = await sendWebhook(url, messages[i], opts.threadId ?? null, rt);
    res.attempts += s.attempts;
    res.httpStatus = s.status;
    if (!s.ok) {
      res.error = s.error;
      res.status = i > 0 ? 'partial' : s.definite ? 'failed' : 'unknown';
      break;
    }
    res.messageIds.push(s.id);
    res.channelId = res.channelId ?? s.channelId;
    if (s.waitMs > 0 && i < messages.length - 1) await rt.sleep(s.waitMs);
  }
  if (res.messageIds.length === messages.length) { res.status = 'sent'; res.error = null; }
  if (opts.postKey) {
    const f = await rpc(c, 'discord_finish_post', { p_post_key: opts.postKey, p_state: res.status, p_message_ids: res.messageIds, p_error: res.error });
    if (!f.ok) res.error = (res.error ? res.error + '; ' : '') + 'the claim was not finished: ' + f.error;
  }
  return done();
}

/* a skip is logged like a send, so "why was there no NFL slate today" has an answer */
async function logSkip(c: Cfg, channel: string, type: PostType, postKey: string | null, postDate: string | null, reason: string, detail: Row = {}) {
  await logPost(c, { channel, type, post_key: postKey, post_date: postDate, status: 'skipped', error: clip(scrub(reason), 500), attempts: 0, message_ids: [], detail });
}
async function claimState(c: Cfg, key: string): Promise<{ state: string | null; message_ids: string[]; claimed_at: string | null }> {
  const r = await sb(c, `discord_post_claims?select=state,message_ids,claimed_at&post_key=eq.${q(key)}`);
  const row = r.ok && Array.isArray(r.data) ? (r.data[0] as Row | undefined) : undefined;
  return { state: row ? str(row.state) : null, message_ids: row ? list(row.message_ids) : [], claimed_at: row ? str(row.claimed_at) : null };
}

// ------------------------------------------------------------------ Discord API (bot): threads

/* Webhooks cannot start a thread on a message in a text channel; a bot can.
   An existing thread (code 160004) has the message's own id. */
async function ensureThread(rt: Runtime, channelId: string, messageId: string, name: string): Promise<{ id: string | null; error: string | null }> {
  if (!rt.c.botToken) return { id: null, error: 'DISCORD_BOT_TOKEN is not set' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    let r: Response;
    try {
      r = await fetch(`https://discord.com/api/v10/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(messageId)}/threads`, {
        method: 'POST',
        headers: { authorization: `Bot ${rt.c.botToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name: clip(name, 100), auto_archive_duration: 10080 }),
      });
    } catch (e) { return { id: null, error: clip(scrub(errMsg(e)), 200) }; }
    let j: Row = {};
    try { j = await r.json() as Row; } catch { /* status is enough */ }
    if (r.ok) return { id: str(j.id) || messageId, error: null };
    if (r.status === 400 && num(j.code) === 160004) return { id: messageId, error: null };
    if (r.status === 429) { await rt.sleep(Math.ceil((num(j.retry_after) ?? 1) * 1000) + 100); continue; }
    return { id: null, error: `thread not created: HTTP ${r.status} ${clip(scrub(str(j.message)), 120)}` };
  }
  return { id: null, error: 'thread not created: rate limited' };
}
/* the server id, for a link to the original post when no thread can be made */
async function webhookGuild(name: string): Promise<string | null> {
  const url = (Deno.env.get(name) ?? '').trim();
  if (!WEBHOOK_RE.test(url)) return null;
  try { const r = await fetch(url); if (!r.ok) return null; const j = await r.json() as Row; return j.guild_id ? str(j.guild_id) : null; } catch { return null; }
}

// ================================================================== the data EdgeDesk owns

/* the site's own published files (the slate, the forecasts): read fresh */
async function siteJson(rt: Runtime, path: string): Promise<{ data: Row | null; error: string | null }> {
  try {
    const r = await fetch(`${rt.c.siteBase}/${path}?t=${Math.floor(rt.now() / MIN)}`, { headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) return { data: null, error: `${path}: HTTP ${r.status}` };
    return { data: await r.json() as Row, error: null };
  } catch (e) { return { data: null, error: `${path}: ${clip(errMsg(e), 120)}` }; }
}

export type GameRef = { id: string; home: string; away: string; homeFull: string; awayFull: string; kickoff: number | null; tbd: boolean; status: string; slateId: string | null; entity?: string | null };

/* team names from two feeds. The same club when the names match; when one is
   a bare nickname that is the other's last word ("Jaguars", "Jacksonville
   Jaguars"); or when both end in the same nickname and the city agrees, an
   abbreviated city ("LA", "NY") by its initial. "Ohio State" is never
   "Oklahoma State": the cities disagree. */
const norm = (s: string) => s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
export function sameTeam(a: string, b: string): boolean {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const wx = x.split(' '), wy = y.split(' ');
  if (wx.length === 1 || wy.length === 1) return wx.length === 1 ? wy[wy.length - 1] === x : wx[wx.length - 1] === y;
  if (wx[wx.length - 1] !== wy[wy.length - 1]) return false;
  const [s, l] = wx[0].length <= wy[0].length ? [wx[0], wy[0]] : [wy[0], wx[0]];
  return s === l || (s.length <= 2 && l[0] === s[0]);
}

export type LineRow = { home: number | null; total: number | null; openHome: number | null; openTotal: number | null; asOf: number | null; books: number | null; openQuality: string | null; book: string | null; mlHome?: number | null; mlAway?: number | null };
/* readFailed: the source could not be READ (try again next tick), as opposed
   to read fine and found stale or empty (a fact to record) */
export type LineBook = { ok: boolean; reason: string | null; source: string; consensus: boolean; newestAsOf: number | null; rows: Map<string, LineRow>; readFailed?: boolean; fallbackReason?: string | null };

function finishBook(rt: Runtime, book: LineBook, label: string): LineBook {
  if (!book.ok) return book;
  if (book.newestAsOf == null) return { ...book, ok: false, reason: `${label}: no line captured for these games` };
  const age = (rt.now() - book.newestAsOf) / MIN;
  if (age > rt.c.lineMaxAgeMin) return { ...book, ok: false, reason: `${label}: the newest line is ${Math.round(age / 60)} h old (limit ${Math.round(rt.c.lineMaxAgeMin / 60)} h)` };
  return book;
}
export function lineFresh(rt: Runtime, row: LineRow | undefined): row is LineRow {
  return !!row && row.home != null && row.asOf != null && rt.now() - row.asOf <= rt.c.lineMaxAgeMin * MIN;
}

/* CFB: the CFB Model Lab's consensus (median over books, cfb_lab_consensus_now)
   and its own opener as known pregame (cfb_lab_predictions.opening_spread,
   rule cfb_lab_open_v1). Keyed by ESPN game id. */
async function cfbLabLines(rt: Runtime, games: GameRef[]): Promise<LineBook> {
  const source = 'CFB Lab consensus (median across books)';
  const book: LineBook = { ok: true, reason: null, source, consensus: true, newestAsOf: null, rows: new Map() };
  const ids = [...new Set(games.map((g) => g.id))];
  if (!ids.length) return finishBook(rt, book, source);
  const cur = await sbAll(rt.c, `cfb_lab_consensus_now?select=game_id,market_type,median_home_line,median_total_points,n_books,as_of&game_id=${inList(ids)}&market_type=in.(spread,total)&order=game_id.asc,market_type.asc`);
  if (cur.error) return { ...book, ok: false, readFailed: true, reason: 'the CFB Lab consensus could not be read: ' + cur.error };
  const op = await sbAll(rt.c, `cfb_lab_predictions?select=game_id,opening_spread,opening_quality,prediction_ts&game_id=${inList(ids)}&opening_spread=not.is.null&order=game_id.asc,prediction_ts.desc`);
  if (op.error) return { ...book, ok: false, readFailed: true, reason: 'the CFB Lab openers could not be read: ' + op.error };
  const blank = (): LineRow => ({ home: null, total: null, openHome: null, openTotal: null, asOf: null, books: null, openQuality: null, book: null });
  for (const r of cur.rows!) {
    const id = str(r.game_id), row = book.rows.get(id) ?? blank();
    if (r.market_type === 'spread') { row.home = num(r.median_home_line); row.books = num(r.n_books); row.asOf = ms(r.as_of); }
    else if (r.market_type === 'total') row.total = num(r.median_total_points);
    book.rows.set(id, row);
    const t = ms(r.as_of);
    if (r.market_type === 'spread' && t != null && (book.newestAsOf == null || t > book.newestAsOf)) book.newestAsOf = t;
  }
  for (const r of op.rows!) {
    const row = book.rows.get(str(r.game_id));
    if (row && row.openHome == null) { row.openHome = num(r.opening_spread); row.openQuality = str(r.opening_quality) || null; }
  }
  return finishBook(rt, book, source);
}

/* NFL: the odds feed's board (collective.odds_board): consensus = median main
   line across retail books, opening = median of each book's first stored
   price, closing written only after kickoff. Matched to games by teams and
   kickoff. */
async function oddsBoard(rt: Runtime, from: number, to: number): Promise<{ board: Row | null; error: string | null }> {
  const r = await rpc(rt.c, 'odds_board', { p_league: 'nfl', p_from: iso(from), p_to: iso(to), p_include_books: false, p_limit: 80 }, 'collective');
  if (!r.ok) return { board: null, error: 'the NFL odds board could not be read: ' + r.error };
  return { board: (r.data ?? {}) as Row, error: null };
}
function matchBoard(games: Row[], g: GameRef): Row | undefined {
  return games.find((b) => {
    const k = ms(b.commence_time);
    return k != null && g.kickoff != null && Math.abs(k - g.kickoff) <= 3 * H
      && (sameTeam(str(b.home_name || b.home), g.homeFull) || sameTeam(str(b.home_name || b.home), g.home))
      && (sameTeam(str(b.away_name || b.away), g.awayFull) || sameTeam(str(b.away_name || b.away), g.away));
  });
}
const lineOf = (o: unknown, ...keys: string[]) => {
  for (const k of keys) { const v = num(((o as Row | null)?.[k] as Row | undefined)?.line); if (v != null) return v; }
  return null;
};
async function collectiveLines(rt: Runtime, games: GameRef[]): Promise<LineBook> {
  const source = 'NFL odds feed consensus (median across books)';
  const book: LineBook = { ok: true, reason: null, source, consensus: true, newestAsOf: null, rows: new Map() };
  const ks = games.map((g) => g.kickoff).filter((k): k is number => k != null);
  if (!ks.length) return finishBook(rt, book, source);
  const { board, error } = await oddsBoard(rt, Math.min(...ks) - 6 * H, Math.max(...ks) + 6 * H);
  if (error) return { ...book, ok: false, readFailed: true, reason: error };
  const bg = Array.isArray(board!.games) ? board!.games as Row[] : [];
  book.newestAsOf = ms(board!.last_odds_at);
  for (const g of games) {
    const b = matchBoard(bg, g);
    if (!b) continue;
    const cons = (b.consensus ?? {}) as Row;
    book.rows.set(g.id, {
      home: num((cons.spread as Row | undefined)?.median), total: num((cons.total as Row | undefined)?.median),
      openHome: lineOf(b.opening, 'spread:home'), openTotal: lineOf(b.opening, 'total', 'total:over'),
      asOf: ms(b.last_odds_at) ?? book.newestAsOf, books: num(b.book_count), openQuality: null, book: null,
    });
  }
  return finishBook(rt, book, source);
}

/* NBA / CBB / NHL (and the NFL / CFB slate when their consensus feed is
   down): EdgeDesk captures one book's pregame quote from ESPN's scoreboard
   (today/slate.json markets). One book is not a consensus, and no opener is
   kept, so no move is drawn. Hockey's main line is the moneyline: a book
   that prices no puck line still has one. */
function espnLines(rt: Runtime, slate: Row, games: GameRef[]): LineBook {
  const markets = (slate.markets ?? {}) as Record<string, Row>;
  let label = 'one book via ESPN';
  const book: LineBook = { ok: true, reason: null, source: label, consensus: false, newestAsOf: null, rows: new Map() };
  for (const g of games) {
    const m = g.slateId ? markets[g.slateId] : undefined;
    if (!m) continue;
    const sp = ((m.spread as Row | undefined)?.home ?? {}) as Row;
    const t = ms(m.captured_at);
    const ml = (m.moneyline ?? {}) as Row;
    book.rows.set(g.id, {
      home: num(sp.point), total: num((m.total as Row | undefined)?.point), openHome: null, openTotal: null, asOf: t, books: 1, openQuality: null,
      book: str(m.book) || null, mlHome: num(ml.home), mlAway: num(ml.away),
    });
    if (t != null && (book.newestAsOf == null || t > book.newestAsOf)) book.newestAsOf = t;
    if (m.book) label = `${str(m.book)} via ESPN (one book)`;
  }
  book.source = label;
  return finishBook(rt, book, label);
}

function linesFor(rt: Runtime, sport: SportId, games: GameRef[], slate: Row | null): Promise<LineBook> {
  const k = SPORTS[sport].lines;
  if (k === 'cfb_lab') return cfbLabLines(rt, games);
  if (k === 'collective') return collectiveLines(rt, games);
  if (!slate) return Promise.resolve({ ok: false, reason: 'the slate file is not loaded', source: 'ESPN', consensus: false, newestAsOf: null, rows: new Map() });
  return Promise.resolve(espnLines(rt, slate, games));
}

/* forecasts for OUTDOOR football games where EdgeDesk has one (open-meteo,
   committed by the football builds). Indoor venues get none. */
type Wx = { temp: number; wind: number | null; from: string | null; precipPct: number | null; text: string | null; asOf: number | null };
function wxOf(f: Row | undefined): Wx | null {
  if (!f || f.dome === true || f.roof === true) return null;
  const temp = num(f.temp_f);
  if (temp == null) return null;
  return { temp, wind: num(f.wind_mph), from: f.wind_from ? str(f.wind_from) : null, precipPct: num(f.precip_pct), text: f.text ? str(f.text) : null, asOf: ms(f.as_of) };
}
async function weatherFor(rt: Runtime, sport: SportId, games: GameRef[]): Promise<{ wx: Map<string, Wx>; error: string | null }> {
  const wx = new Map<string, Wx>();
  const kind = SPORTS[sport].weather;
  if (!kind) return { wx, error: null };
  if (kind === 'cfb') {
    const { data, error } = await siteJson(rt, 'football/venues/forecasts.json');
    if (error) return { wx, error };
    const by = (data!.by_game ?? {}) as Record<string, Row>;
    for (const g of games) { const w = wxOf(by[g.id]); if (w) wx.set(g.id, w); }
    return { wx, error: null };
  }
  const { data, error } = await siteJson(rt, 'football/nfl/slate.json');
  if (error) return { wx, error };
  const ng = Array.isArray(data!.games) ? data!.games as Row[] : [];
  for (const g of games) {
    const m = ng.find((x) => { const k = ms(x.kickoff); return k != null && g.kickoff != null && Math.abs(k - g.kickoff) <= 2 * H && sameTeam(str(x.home_team), g.homeFull); });
    if (!m) continue;
    const roof = str(m.roof || ((m.venue_geography ?? {}) as Row).roof);
    if (roof && roof !== 'outdoors') continue;
    const w = wxOf(m.forecast as Row | undefined);
    if (w) wx.set(g.id, w);
  }
  return { wx, error: null };
}

// ------------------------------------------------------------------ formatting

const fmtPts = (v: number) => { const a = Math.abs(v); return (Number.isInteger(a) ? String(a) : String(r2(a))); };
/* a home-convention spread, as the favourite and the number: "Memphis -7" */
export function fmtSpread(home: number | null, homeTeam: string, awayTeam: string): string {
  if (home == null) return 'not captured';
  if (home === 0) return 'Even (0)';
  return home < 0 ? `${homeTeam} -${fmtPts(home)}` : `${awayTeam} -${fmtPts(home)}`;
}
/* the move from the open, described, never attributed */
export function fmtMove(open: number | null, cur: number | null, homeTeam: string, awayTeam: string): string | null {
  if (open == null || cur == null) return null;
  const d = r2(cur - open);
  if (d === 0) return 'no move since the open';
  return `${fmtPts(d)} pts toward ${d < 0 ? homeTeam : awayTeam} since the open`;
}
/* a signed figure at a fixed precision, so +1.0 and -1.0 read alike */
const signed = (v: number, unit: string, d = 1) => `${v > 0 ? '+' : v < 0 ? '-' : ''}${Math.abs(v).toFixed(d)}${unit}`;
const fmtMl = (v: number) => (v > 0 ? `+${Math.round(v)}` : String(Math.round(v)));
/* a model line, to one decimal: "Memphis -4.8" */
export function fmtModelLine(home: number, homeTeam: string, awayTeam: string): string {
  const a = Math.abs(home).toFixed(1);
  if (a === '0.0') return 'Even (0)';
  return home < 0 ? `${homeTeam} -${a}` : `${awayTeam} -${a}`;
}
/* a two-way moneyline without the book's margin: the home side's share */
export function noVigHome(mlHome: number, mlAway: number): number | null {
  const imp = (ml: number) => (ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100));
  const h = imp(mlHome), a = imp(mlAway);
  return Number.isFinite(h + a) && h + a > 0 ? h / (h + a) : null;
}

// ================================================================== EdgeDesk's own numbers

/* engine/projections.json: every sport engine's pregame projection, frozen
   BEFORE any price is read (engine/build_projections.js, every 3 hours), with
   each market's validation state from engine/registry.json. The slate shows
   these beside the book's line; it never computes a number of its own. */
export const PROJ_SPORT: Record<SportId, string> = { nfl: 'nfl', cfb: 'cfb', nba: 'nba', cbb: 'ncaab_m', nhl: 'nhl' };
const PROJ_MAX_AGE_H = 8;
export type ProjBook = { ok: boolean; reason: string | null; builtAt: number | null; list: Row[] };
async function loadProjections(rt: Runtime): Promise<ProjBook> {
  const { data, error } = await siteJson(rt, 'engine/projections.json');
  if (error || !data) return { ok: false, reason: 'EdgeDesk projections could not be read (' + (error ?? 'empty') + ')', builtAt: null, list: [] };
  const builtAt = ms(data.built_at);
  if (builtAt == null || rt.now() - builtAt > PROJ_MAX_AGE_H * H) {
    return { ok: false, reason: `EdgeDesk projections are ${builtAt == null ? 'undated' : Math.round((rt.now() - builtAt) / H) + ' h old'}`, builtAt, list: [] };
  }
  return { ok: true, reason: null, builtAt, list: Array.isArray(data.projections) ? data.projections as Row[] : [] };
}
const nameIs = (proj: string, full: string, short: string) => {
  const p = norm(proj);
  return !!p && (p === norm(full) || p === norm(short) || norm(full).startsWith(p + ' ') || sameTeam(proj, full));
};
/* by id first (the slate's research entity, or the ESPN id), then by both
   teams within three hours of the start */
export function matchProjection(list: Row[], sport: SportId, g: GameRef): Row | undefined {
  const sp = PROJ_SPORT[sport];
  const ids = [g.entity ? g.entity.replace(/^[a-z_]+\|/i, '') : null, g.id].filter(Boolean) as string[];
  const byId = list.find((p) => p.sport === sp && ids.includes(str(p.event_id)));
  if (byId) return byId;
  return list.find((p) => {
    const t = ms(p.start_utc), h = (p.home ?? {}) as Row, a = (p.away ?? {}) as Row;
    return p.sport === sp && t != null && g.kickoff != null && Math.abs(t - g.kickoff) <= 3 * H
      && nameIs(str(h.name), g.homeFull, g.home) && nameIs(str(a.name), g.awayFull, g.away);
  });
}
const STATE_WORD: Record<string, string> = { OUTCOME_VALIDATED: 'outcome-validated', VALIDATED: 'validated', EXPERIMENTAL: 'experimental', PROVISIONAL: 'provisional', RESEARCH: 'research only' };
const TEST_WORD: Record<string, string> = { NOT_TESTED: 'not yet tested against the close', TESTED_BEHIND: 'behind the close when tested', TESTED_EVEN: 'break-even against the close', TESTED_AHEAD: 'ahead of the close when tested' };
/* "EdgeDesk: …" and "Gap: …" for one game. A gap is the difference between
   two numbers, never a recommendation: no side is called a play. */
export function modelLines(p: Row | undefined, row: LineRow | undefined, g: GameRef, sport: SportId): string[] {
  if (!p) return ['EdgeDesk: no projection for this game'];
  if (str(((p.research ?? {}) as Row).outcome) === 'DATA_INSUFFICIENT') return ['EdgeDesk: not enough data for a number on this game'];
  const ph = num(((p.outcome ?? {}) as Row).p_home);
  if (ph == null) return ['EdgeDesk: no projection for this game'];
  const fair = (p.fair ?? {}) as Row, ps = (p.projected_score ?? {}) as Row;
  const homeFav = ph >= 0.5, fav = homeFav ? g.home : g.away, favP = homeFav ? ph : 1 - ph;
  const mlFav = num(((fair.moneyline ?? {}) as Row)[homeFav ? 'home' : 'away']);
  const fl = num(((fair.spread ?? {}) as Row).home_line);
  const tot = num(((fair.total ?? {}) as Row).expected) ?? num(((fair.total ?? {}) as Row).line);
  const pa = num(ps.away), phs = num(ps.home);
  const parts = [`EdgeDesk: ${fav} ${Math.round(favP * 100)}%${mlFav != null ? ` (fair ${fmtMl(mlFav)})` : ''}`];
  if (fl != null && sport !== 'nhl') parts.push(`line ${fmtModelLine(fl, g.home, g.away)}`);
  if (pa != null && phs != null) parts.push(`proj ${g.away} ${pa.toFixed(1)}, ${g.home} ${phs.toFixed(1)}`);
  if (tot != null) parts.push(`total ${tot.toFixed(1)}`);
  const gap: string[] = [];
  let market = 'moneyline';
  if (row?.home != null && fl != null && sport !== 'nhl') {
    market = 'spread';
    const d = r2(row.home - fl);
    gap.push(Math.abs(d) < 0.5 ? 'book within 0.5 pts of EdgeDesk' : `EdgeDesk's line is ${Math.abs(d).toFixed(1)} pts further toward ${d > 0 ? g.home : g.away}`);
  } else if (row?.mlHome != null && row?.mlAway != null) {
    const bp = noVigHome(row.mlHome, row.mlAway);
    if (bp != null) {
      const bFav = homeFav ? bp : 1 - bp, diff = (favP - bFav) * 100;
      gap.push(Math.abs(diff) < 1 ? `book within 1 pt of EdgeDesk on ${fav}` : `EdgeDesk ${fav} ${Math.round(favP * 100)}% vs the book's no-vig ${Math.round(bFav * 100)}%`);
    }
  }
  if (row?.total != null && tot != null) {
    const dt = r2(tot - row.total);
    gap.push(Math.abs(dt) < 0.1 ? 'total level with the book' : `total ${Math.abs(dt).toFixed(1)} ${dt < 0 ? 'lower' : 'higher'} than the book`);
  }
  const v = (((p.validation ?? {}) as Row).markets ?? {}) as Record<string, Row>;
  const mv = v[market];
  /* a market the registry has no record for is said to be unvalidated, never left blank */
  const check = mv ? `model: ${market} ${STATE_WORD[str(mv.state)] ?? str(mv.state).toLowerCase().replace(/_/g, ' ')}${TEST_WORD[str(mv.market_test)] ? ', ' + TEST_WORD[str(mv.market_test)] : ''}` : `model: ${market} not yet validated`;
  const out = [parts.join(' · ')];
  if (gap.length || check) out.push(`Gap: ${[...gap, ...(check ? [check] : [])].join(' · ')}`);
  return out;
}
const fmtWx = (w: Wx) => [`${Math.round(w.temp)}°F`, w.wind != null ? `wind ${Math.round(w.wind)} mph${w.from ? ' ' + w.from : ''}` : null, w.precipPct != null ? `${Math.round(w.precipPct)}% precip` : null, w.text].filter(Boolean).join(', ');

// ================================================================== the slate

type Outcome = Row & { sport?: string; action: string };

function slateGames(slate: Row, sport: SportId, date: string): GameRef[] {
  const ev = Array.isArray(slate.events) ? slate.events as Row[] : [];
  return ev.filter((e) => e.sport === SPORTS[sport].slate).map((e) => {
    const h = (e.home ?? {}) as Row, a = (e.away ?? {}) as Row;
    return {
      id: str(e.provider_id || e.id), slateId: str(e.id) || null, entity: str(((e.research ?? {}) as Row).entity) || null,
      home: str(h.short || h.name), away: str(a.short || a.name), homeFull: str(h.name || h.short), awayFull: str(a.name || a.short),
      kickoff: ms(e.start_utc), tbd: e.time_tbd === true, status: str(e.status),
    };
  }).filter((g) => g.kickoff != null && localDate(g.kickoff) === date && !/postpon|cancel/i.test(g.status))
    .sort((x, y) => (x.kickoff! - y.kickoff!) || x.home.localeCompare(y.home));
}

export function renderSlate(sport: SportId, date: string, games: GameRef[], book: LineBook, wx: Map<string, Wx>, startedCount: number, now: number, proj: ProjBook | null = null): Payload {
  const S = SPORTS[sport];
  const desc: string[] = [];
  if (book.fallbackReason) desc.push(`The consensus feed is unavailable (${book.fallbackReason}), so this shows one book via ESPN, with no open or move.`);
  desc.push(book.consensus
    ? `Lines: ${book.source}, as captured by EdgeDesk at ${fmtTime(book.newestAsOf ?? now)}. The open is the first consensus EdgeDesk recorded; the move is the difference, not a reason.`
    : `Lines: ${book.source}, as captured at ${fmtTime(book.newestAsOf ?? now)}.${book.fallbackReason ? '' : ` EdgeDesk keeps no consensus or opening line for the ${S.label}, so no move is shown.`}`);
  /* one sentence, not a line per game, when the model has nothing for this slate (the NBA preseason) */
  const projected = proj?.ok ? games.filter((g) => matchProjection(proj.list, sport, g)).length : 0;
  if (proj?.ok && projected) desc.push(`EdgeDesk: our own model's numbers, frozen before any price was read (built ${fmtTime(proj.builtAt!)}). A gap is the difference between two numbers, not a recommendation.`);
  else if (proj?.ok) desc.push(`EdgeDesk has no projection for any of today's ${S.label} games yet.`);
  else if (proj) desc.push(`EdgeDesk numbers are not shown today: ${proj.reason}.`);
  if (S.weather) desc.push('Weather: forecast at kickoff for outdoor venues, where EdgeDesk has one.');
  if (startedCount > 0) desc.push(`${startedCount} game${startedCount === 1 ? '' : 's'} already under way ${startedCount === 1 ? 'is' : 'are'} not listed.`);
  desc.push('Times are Central.');
  const fields: Field[] = games.map((g) => {
    const row = book.rows.get(g.id);
    const lines: string[] = [];
    const label = book.consensus ? 'Consensus' : `Book (${row?.book ?? 'one book'})`;
    const stale = row?.asOf != null && now - row.asOf > 3 * H ? ` (as of ${fmtWhen(row.asOf)})` : '';
    const tot = row?.total != null ? ` · Total ${fmtPts(row.total)}` : '';
    if (row?.home != null) lines.push(`${label}: ${fmtSpread(row.home, g.home, g.away)}${tot}${stale}`);
    else if (row?.mlHome != null && row?.mlAway != null) lines.push(`${label}: ${g.home} ${fmtMl(row.mlHome)} / ${g.away} ${fmtMl(row.mlAway)}${tot}${stale}`);
    else lines.push(`${label}: not captured`);
    if (book.consensus && row?.home != null) {
      const mv = fmtMove(row.openHome, row.home, g.home, g.away);
      lines.push(row.openHome == null ? 'Open: not captured' : `Open: ${fmtSpread(row.openHome, g.home, g.away)}${row.openTotal != null ? ` · Total ${fmtPts(row.openTotal)}` : ''}${mv ? ` · ${mv}` : ''}`);
    }
    if (proj?.ok && projected) lines.push(...modelLines(matchProjection(proj.list, sport, g), row, g, sport));
    const w = wx.get(g.id);
    if (w) lines.push(`Weather: ${fmtWx(w)}`);
    return { name: `${g.away} @ ${g.home} · ${g.tbd ? 'time TBD' : fmtTime(g.kickoff!)}`, value: lines.join('\n') };
  });
  return {
    embeds: [{
      title: `${S.label} slate · ${fmtLongDate(date)}`,
      url: 'https://edgedesksports.com/today/',
      description: desc.join('\n'),
      fields,
      footer: { text: FOOTER_SLATE },
    }],
  };
}

async function slateForSport(rt: Runtime, sport: SportId, slate: { data: Row | null; error: string | null }, o: { dryRun: boolean }, proj: ProjBook | null = null): Promise<Outcome> {
  const c = rt.c, now = rt.now(), date = localDate(now), S = SPORTS[sport];
  const key = `slate:${S.channel}:${date}`;
  const out: Outcome = { action: 'slate', sport, key };
  if (!o.dryRun) {
    const cs = await claimState(c, key);
    if (cs.state && cs.state !== 'failed') return { ...out, result: 'already_posted', state: cs.state };
  }
  const skip = async (reason: string, detail: Row = {}) => { await logSkip(c, S.channel, 'slate', key, date, reason, detail); return { ...out, result: 'skipped', reason }; };
  if (slate.error || !slate.data) return skip('the schedule (today/slate.json) could not be read: ' + (slate.error ?? 'empty'));
  const gen = ms(slate.data.generated_at);
  if (gen == null || now - gen > c.scheduleMaxAgeMin * MIN) return skip(`the schedule sync is stale: today/slate.json was built ${gen == null ? 'at an unknown time' : Math.round((now - gen) / MIN) + ' min ago'}`);
  const st = ((slate.data.sports ?? {}) as Record<string, Row>)[S.slate];
  if (!st || !['ok', 'fallback'].includes(str(st.state))) return skip(`the ${S.label} schedule sync is ${st ? str(st.state) : 'missing'}${st?.note ? ': ' + str(st.note) : ''}`);
  const all = slateGames(slate.data, sport, date);
  const games = all.filter((g) => g.tbd || g.kickoff! > now);
  if (!games.length) return skip(all.length ? `no ${S.label} games left to start today` : `no ${S.label} games today`, { listed: all.length });
  let book = await linesFor(rt, sport, games, slate.data);
  if (!book.ok && S.lines !== 'espn') {
    /* the consensus feed is down (the NFL odds feed is paused until
       2026-11-01): one fresh book via ESPN, said so, beats no slate at all */
    const one = espnLines(rt, slate.data, games);
    if (one.ok) book = { ...one, fallbackReason: book.reason };
  }
  if (!book.ok) return skip('line sync failed: ' + book.reason, { games: games.length });
  const w = await weatherFor(rt, sport, games);
  const payload = renderSlate(sport, date, games, book, w.wx, all.length - games.length, now, proj);
  const r = await postToDiscord(S.channel, payload, { type: 'slate', postKey: key, postDate: date, dryRun: o.dryRun, detail: { games: games.length, weather_error: w.error, line_source: book.source, fallback: book.fallbackReason ?? null, projections: proj ? (proj.ok ? 'ok' : proj.reason) : null } }, rt);
  return { ...out, result: r.status, error: r.error, games: games.length, messages: r.messages, printed: r.printed, ...(book.fallbackReason ? { fallback: book.fallbackReason } : {}) };
}

// ================================================================== the morning results

/* How EdgeDesk's pregame numbers did yesterday, per sport, read from the
   /performance/ record (performance/data, rebuilt hourly from the
   hash-chained ledger): the same grades the public page shows, misses
   printed exactly like hits. Posted at the 10:00 tick; when a game from
   yesterday still has no verified final it waits for the 10:30 tick, then
   posts with that game marked pending. */
export type PerfBook = { ok: boolean; reason: string | null; rows: Row[] };
async function loadPerformance(rt: Runtime): Promise<PerfBook> {
  const sum = await siteJson(rt, 'performance/data/summary.json');
  if (sum.error || !sum.data) return { ok: false, reason: 'the /performance/ summary could not be read (' + (sum.error ?? 'empty') + ')', rows: [] };
  const rows: Row[] = [];
  for (const f of (Array.isArray(sum.data.games) ? sum.data.games as Row[] : [])) {
    const path = str(f.path).replace(/^\//, '');
    if (!path) continue;
    const g = await siteJson(rt, path);
    if (g.error || !g.data) return { ok: false, reason: `${path} could not be read (${g.error ?? 'empty'})`, rows: [] };
    rows.push(...(Array.isArray(g.data.rows) ? g.data.rows as Row[] : []));
  }
  return { ok: true, reason: null, rows };
}

export function resultLine(r: Row): Field {
  const res = (r.result ?? {}) as Row, g = (r.grade ?? null) as Row | null;
  const home = str(r.home), away = str(r.away);
  const hs = num(res.home_score), as = num(res.away_score);
  const final = hs != null && as != null ? ` · final ${away} ${as}, ${home} ${hs}${res.decided && res.decided !== 'REG' ? ` (${str(res.decided)})` : ''}` : '';
  const name = `${away} @ ${home}${final}`;
  if (!g) return { name, value: str(res.state) === 'VOID' ? 'Not graded: the game was void' : 'Result not yet verified' };
  if (g.eligible !== true) return { name, value: `Not graded: ${str(g.why).toLowerCase().replace(/_/g, ' ') || 'not eligible'}` };
  const lines: string[] = [];
  const w = (g.winner ?? null) as Row | null;
  if (w && num(w.p_home) != null) {
    const ph = num(w.p_home)!, fav = ph >= 0.5 ? home : away, favP = Math.max(ph, 1 - ph);
    const verdict = w.correct === true ? 'right winner' : w.correct === false ? 'wrong winner' : 'no favourite (50/50)';
    lines.push(`EdgeDesk: ${fav} ${Math.round(favP * 100)}% · ${verdict}${num(w.brier) != null ? ` · Brier ${num(w.brier)!.toFixed(3)}` : ''}`);
  }
  const sp = (g.spread ?? null) as Row | null, mk = (g.market ?? {}) as Row, msp = (mk.spread ?? null) as Row | null;
  if (sp && num(sp.projected_margin) != null && num(sp.actual_margin) != null) {
    const pm = num(sp.projected_margin)!, am = num(sp.actual_margin)!;
    const side = (m: number) => (m === 0 ? 'level' : `${m > 0 ? home : away} by ${Math.abs(m).toFixed(1).replace(/\.0$/, '')}`);
    lines.push(`Margin: EdgeDesk ${side(pm)} · actual ${side(am)} · off by ${Math.abs(num(sp.abs_error) ?? am - pm).toFixed(1)}${msp && num(msp.market_abs_error) != null ? ` (the book's line off by ${num(msp.market_abs_error)!.toFixed(1)})` : ''}`);
  }
  const tt = (g.total ?? null) as Row | null, mt = (mk.total ?? null) as Row | null;
  if (tt && num(tt.projected_total) != null && num(tt.actual_total) != null) {
    lines.push(`Total: EdgeDesk ${num(tt.projected_total)!.toFixed(1)} · actual ${num(tt.actual_total)} · off by ${Math.abs(num(tt.abs_error) ?? 0).toFixed(1)}${mt && num(mt.market_abs_error) != null ? ` (the book's off by ${num(mt.market_abs_error)!.toFixed(1)})` : ''}`);
  }
  const clv = num(((mk.clv ?? {}) as Row).spread_pts);
  if (clv != null) lines.push(`Close: ${clv === 0 ? "the line closed where EdgeDesk's number started" : `the line moved ${Math.abs(clv).toFixed(1)} pts ${clv > 0 ? 'toward' : 'away from'} EdgeDesk's number`}`);
  if (str(r.tier) === 'RECORDED') lines.push('(recorded pregame, before the ledger locked forecasts)');
  return { name, value: lines.join('\n') || 'Graded' };
}

export function renderResults(sport: SportId, date: string, rows: Row[], c: Cfg): Payload {
  const S = SPORTS[sport];
  const graded = rows.filter((r) => (r.grade as Row | undefined)?.eligible === true);
  const called = graded.filter((r) => ((r.grade as Row).winner as Row | undefined)?.correct != null);
  const right = called.filter((r) => ((r.grade as Row).winner as Row).correct === true).length;
  const briers = graded.map((r) => num(((r.grade as Row).winner as Row | undefined)?.brier)).filter((x): x is number => x != null);
  const totErr = graded.map((r) => num(((r.grade as Row).total as Row | undefined)?.abs_error)).filter((x): x is number => x != null);
  const summary = [
    called.length ? `Right winner: ${right} of ${called.length}` : null,
    briers.length ? `Brier ${mean(briers)!.toFixed(3)}` : null,
    totErr.length ? `avg total miss ${mean(totErr)!.toFixed(1)}` : null,
  ].filter(Boolean).join(' · ');
  return {
    embeds: [{
      title: `${S.label} results · ${fmtLongDate(date)}`,
      url: c.performanceUrl,
      description: [
        summary || 'No graded games.',
        "How EdgeDesk's pregame numbers did, every game, from the public record. Shown the same way right or wrong. Brier: lower is better.",
        `Full record: ${c.performanceUrl}`,
      ].join('\n'),
      fields: rows.map((r) => resultLine(r)),
      footer: { text: FOOTER_SLATE },
    }],
  };
}

async function resultsForSport(rt: Runtime, sport: SportId, perf: PerfBook, o: { dryRun: boolean; ignoreSchedule: boolean }): Promise<Outcome> {
  const c = rt.c, now = rt.now(), lp = localParts(now), S = SPORTS[sport];
  const day = addDays(lp.date, -1);
  const key = `results:${S.channel}:${day}`;
  const out: Outcome = { action: 'results', sport, key };
  if (!o.dryRun) {
    const cs = await claimState(c, key);
    if (cs.state && cs.state !== 'failed') return { ...out, result: 'already_posted', state: cs.state };
  }
  if (!perf.ok) { await logSkip(c, S.channel, 'results', key, day, 'results not posted: ' + perf.reason); return { ...out, result: 'skipped', reason: perf.reason }; }
  const rows = perf.rows.filter((r) => r.sport === S.perf && ms(r.start_utc) != null && localDate(ms(r.start_utc)!) === day)
    .sort((a, b) => ms(a.start_utc)! - ms(b.start_utc)! || str(a.home).localeCompare(str(b.home)));
  if (!rows.length) return { ...out, result: 'none', reason: `no ${S.label} games on record for ${day}` };
  const pending = rows.filter((r) => !r.grade && str((r.result as Row | undefined)?.state) !== 'VOID').length;
  if (pending && !o.ignoreSchedule && lp.minute < 30) return { ...out, result: 'waiting', reason: `${pending} final${pending === 1 ? '' : 's'} not yet verified; posting at the :30 tick` };
  const r = await postToDiscord(S.channel, renderResults(sport, day, rows, c), { type: 'results', postKey: key, postDate: day, dryRun: o.dryRun, detail: { games: rows.length, pending } }, rt);
  return { ...out, result: r.status, error: r.error, games: rows.length, pending, messages: r.messages, printed: r.printed };
}

export async function runSlate(rt: Runtime, o: { dryRun?: boolean; ignoreSchedule?: boolean; sports?: SportId[] } = {}): Promise<Row> {
  const now = rt.now(), lp = localParts(now);
  if (!o.ignoreSchedule && lp.hour !== rt.c.slateHour) return { ok: true, action: 'slate', result: 'not_due', local: `${lp.date} ${lp.hour}:${String(lp.minute).padStart(2, '0')} CT` };
  const slate = await siteJson(rt, 'today/slate.json');
  const proj = await loadProjections(rt);
  const perf = await loadPerformance(rt);
  const dryRun = o.dryRun ?? rt.c.dryRun;
  const results: Outcome[] = [];
  for (const sport of o.sports ?? SPORT_ORDER) {
    /* yesterday's results first, so the channel reads results, then today */
    try { results.push(await resultsForSport(rt, sport, perf, { dryRun, ignoreSchedule: !!o.ignoreSchedule })); }
    catch (e) { results.push({ action: 'results', sport, result: 'error', error: clip(scrub(errMsg(e)), 300) }); }
    try { results.push(await slateForSport(rt, sport, slate, { dryRun }, proj)); }
    catch (e) { results.push({ action: 'slate', sport, result: 'error', error: clip(scrub(errMsg(e)), 300) }); }
  }
  return { ok: !results.some((x) => ['failed', 'partial', 'unknown', 'error'].includes(str(x.result))), action: 'slate', date: lp.date, results };
}

// ================================================================== the CLV scorecard

export type ClvStats = { graded: number; withClv: number; avgClv: number | null; beat: number; beatPct: number | null };
export function clvStats(rows: Row[]): ClvStats {
  const v = rows.map((r) => num(r.clv)).filter((x): x is number => x != null);
  const beat = v.filter((x) => x > 0).length;
  return { graded: rows.length, withClv: v.length, avgClv: mean(v), beat, beatPct: v.length ? beat / v.length : null };
}
export type BrierStats = { n: number; brier: number | null; tier: 'VERIFIED' | 'RECORDED' | null };
/* the /performance/ headline: the latest revision per game, eligible, not a
   push; verified pregame first, recorded pregame (labelled) only when no
   verified game exists in the window */
export function brierStats(rows: Row[]): BrierStats {
  const latest = new Map<string, Row>();
  for (const r of rows) {
    const k = str(r.event_key), prev = latest.get(k);
    if (!prev || (num(r.revision) ?? 0) > (num(prev.revision) ?? 0)) latest.set(k, r);
  }
  const by = (tier: string) => [...latest.values()].filter((r) => r.eligible === true && str(r.forecast_tier) === tier)
    .map((r) => num(r.b1) ?? num(r.b2)).filter((x): x is number => x != null);
  const v = by('VERIFIED');
  if (v.length) return { n: v.length, brier: mean(v), tier: 'VERIFIED' };
  const rec = by('RECORDED');
  return rec.length ? { n: rec.length, brier: mean(rec), tier: 'RECORDED' } : { n: 0, brier: null, tier: null };
}

function statBlock(s: ClvStats, b: BrierStats | null, brierError: string | null): string {
  const lines = [
    `Graded signals: ${s.graded}`,
    `Avg CLV: ${s.avgClv == null ? '—' : signed(s.avgClv * 100, '%')}${s.withClv && s.withClv !== s.graded ? ` (n=${s.withClv} with a close)` : ''}`,
    `Beat the close: ${s.beatPct == null ? '—' : `${(s.beatPct * 100).toFixed(1)}% (${s.beat} of ${s.withClv})`}`,
  ];
  if (brierError) lines.push('Brier: unavailable (the performance mirror could not be read)');
  else if (!b || b.brier == null) lines.push('Brier: no graded forecasts');
  else lines.push(`Brier${b.tier === 'RECORDED' ? ' (recorded pregame, not ledger-verified)' : ''}: ${b.brier.toFixed(3)} (n=${b.n})`);
  if (s.graded < 10) lines.push('⚠️ Small sample (fewer than 10 graded signals)');
  return lines.join('\n');
}

type SampleRow = Row;
export function sampleStats(rows: SampleRow[]) {
  const posted = rows.filter((r) => r.status === 'posted' || r.status === 'followed_up');
  const closed = rows.filter((r) => r.status === 'followed_up' && num(r.close_line) != null);
  const det = closed.map((r) => num(r.clv_at_detection)).filter((x): x is number => x != null);
  const post = closed.map((r) => num(r.clv_at_post)).filter((x): x is number => x != null);
  return {
    selected: rows.length, posted: posted.length, missed: rows.filter((r) => r.status === 'missed').length, closed: closed.length,
    avgDet: mean(det), avgPost: mean(post), positivePost: post.filter((x) => x > 0).length, nPost: post.length,
  };
}
function sampleBlock(rows: SampleRow[]): string {
  const s = sampleStats(rows);
  if (!s.selected) return 'No samples selected';
  return [
    `Selected: ${s.selected} · Posted: ${s.posted} · Not posted: ${s.missed}`,
    `Closed with a line: ${s.closed}`,
    `Avg CLV at detection: ${s.avgDet == null ? '—' : signed(s.avgDet, ' pts', 2)}`,
    `Avg CLV at post: ${s.avgPost == null ? '—' : signed(s.avgPost, ' pts', 2)}`,
    `CLV at post above zero: ${s.nPost ? `${s.positivePost} of ${s.nPost}` : '—'}`,
  ].join('\n');
}
function sampleLine(r: SampleRow): string {
  const k = ms(r.kickoff_at);
  const when = k != null ? fmtDay(k) : str(r.slate_date);
  const head = `${when} · ${str(r.away)} @ ${str(r.home)} · ${str(r.classification)}`;
  if (r.status === 'missed') return `${head} · not posted (${clip(str(r.miss_reason), 80)})`;
  if (r.status === 'scheduled') return `${head} · scheduled`;
  if (r.status === 'posted') return `${head} · awaiting close`;
  const p = num(r.clv_at_post);
  return `${head} · CLV at post ${p == null ? 'not measured' : signed(p, ' pts')}`;
}

export function renderScorecard(date: string, weekStart: string, season: string, perSport: { sport: SportId; week: ClvStats; season: ClvStats; bWeek: BrierStats | null; bSeason: BrierStats | null }[], brierError: string | null, samples: { week: SampleRow[]; season: SampleRow[] } | null, samplesError: string | null, c: Cfg): Payload {
  const weekEnd = addDays(date, -1);
  const embeds: Embed[] = [{
    title: `Weekly CLV scorecard · ${fmtShortDate(weekStart)} – ${fmtShortDate(weekEnd)}`,
    url: c.recordUrl,
    description: [
      'Every graded signal, good weeks and bad, read straight from the database behind the public record. Nothing is edited by hand.',
      '• **Graded signals**: signals graded in the window, filtered the way the public record filters them.',
      '• **Avg CLV**: the entry price against the de-vigged closing price, in percent.',
      '• **Beat the close**: the share of signals with CLV above zero.',
      '• **Brier**: pregame winner forecasts on /performance/ (lower is better).',
      `Week: Monday to Sunday, Central. Season: since ${fmtShortDate(season)}.`,
      `Public record: ${c.recordUrl}`,
      `Model performance: ${c.performanceUrl}`,
    ].join('\n'),
  }];
  for (const p of perSport) {
    embeds.push({
      title: SPORTS[p.sport].label,
      fields: [
        { name: 'Past 7 days', value: statBlock(p.week, p.bWeek, brierError), inline: true },
        { name: 'Season to date', value: statBlock(p.season, p.bSeason, brierError), inline: true },
      ],
    });
  }
  const sf: Field[] = [];
  if (samplesError || !samples) sf.push({ name: 'Record', value: 'Unavailable: the sample ledger could not be read.' });
  else {
    for (const sp of SAMPLE_SPORTS) {
      sf.push({ name: `${sp.toUpperCase()} · past 7 days`, value: sampleBlock(samples.week.filter((r) => r.sport === sp)), inline: true });
      sf.push({ name: `${sp.toUpperCase()} · season`, value: sampleBlock(samples.season.filter((r) => r.sport === sp)), inline: true });
    }
    const lines = samples.week.map(sampleLine);
    sf.push({ name: "This week's samples", value: lines.length ? clip(lines.join('\n'), LIMITS.fieldValue) : 'None selected this week.' });
  }
  embeds.push({
    title: 'Discord samples',
    description: 'The free research samples posted in this server, counted on their own. Every selected sample is listed, including any that could not be posted. CLV is in points, on the side the research flagged, from the line at detection and at post time to the close.',
    fields: sf,
    footer: { text: FOOTER_SLATE },
  });
  return { embeds };
}

/* the public record's own query (record.html: public_record + EDGEQ), read
   with the service role, every page */
const EDGEQ = 'flagged_at=not.is.null&flagged_edge=gte.0.005&flagged_edge=lte.0.1';

export async function runScorecard(rt: Runtime, o: { dryRun?: boolean; ignoreSchedule?: boolean } = {}): Promise<Row> {
  const c = rt.c, now = rt.now(), lp = localParts(now);
  if (!o.ignoreSchedule && (lp.weekday !== 'Mon' || lp.hour !== c.scorecardHour)) return { ok: true, action: 'scorecard', result: 'not_due', local: `${lp.weekday} ${lp.date} ${lp.hour}h CT` };
  const dryRun = o.dryRun ?? c.dryRun;
  const date = lp.date, key = `clv_scorecard:${CHANNEL.clv}:${date}`;
  if (!dryRun) {
    const cs = await claimState(c, key);
    if (cs.state && cs.state !== 'failed') return { ok: true, action: 'scorecard', result: 'already_posted', state: cs.state };
  }
  const weekStart = addDays(date, -7), season = seasonStart(weekStart);
  const wFrom = localMidnight(weekStart), wTo = localMidnight(date), sFrom = localMidnight(season);

  const clv = await sbAll(c, `public_record?select=sport_key,clv,graded_at&${EDGEQ}&graded_at=gte.${q(iso(sFrom))}&graded_at=lt.${q(iso(wTo))}&order=graded_at.asc`);
  if (clv.error) {
    await logSkip(c, CHANNEL.clv, 'clv_scorecard', key, date, 'the CLV record (public_record) could not be read: ' + clv.error);
    return { ok: false, action: 'scorecard', result: 'skipped', reason: 'CLV read failed: ' + clv.error };
  }
  const perf = await sbAll(c, `perf_grades?select=event_key,sport,revision,eligible,forecast_tier,start_utc,b1:row->winner->>brier,b2:row->grade->winner->>brier&start_utc=gte.${q(iso(sFrom))}&start_utc=lt.${q(iso(wTo))}&order=event_key.asc`);
  const smp = await sbAll(c, `discord_samples?select=sport,slate_date,game_id,home,away,kickoff_at,classification,status,miss_reason,close_line,clv_at_detection,clv_at_post&slate_date=gte.${season}&slate_date=lt.${date}&order=slate_date.asc,sport.asc,rank.asc`);

  const inWeek = (t: number | null) => t != null && t >= wFrom && t < wTo;
  const perSport = SPORT_ORDER.map((sport) => {
    const S = SPORTS[sport];
    const rows = clv.rows!.filter((r) => r.sport_key === S.oddsKey);
    const pr = perf.rows ? perf.rows.filter((r) => r.sport === S.perf) : null;
    return {
      sport,
      week: clvStats(rows.filter((r) => inWeek(ms(r.graded_at)))), season: clvStats(rows),
      bWeek: pr ? brierStats(pr.filter((r) => inWeek(ms(r.start_utc)))) : null, bSeason: pr ? brierStats(pr) : null,
    };
  });
  const samples = smp.rows ? { week: smp.rows.filter((r) => str(r.slate_date) >= weekStart), season: smp.rows } : null;
  const payload = renderScorecard(date, weekStart, season, perSport, perf.error, samples, smp.error, c);
  const r = await postToDiscord(CHANNEL.clv, payload, { type: 'clv_scorecard', postKey: key, postDate: date, dryRun, detail: { week_from: iso(wFrom), week_to: iso(wTo), season_from: iso(sFrom), brier_error: perf.error, samples_error: smp.error } }, rt);
  return { ok: !['failed', 'partial', 'unknown'].includes(r.status), action: 'scorecard', date, result: r.status, error: r.error, messages: r.messages, printed: r.printed };
}

// ================================================================== free research samples

/* one module's view of a game: every game in the window (to know a slate
   exists), with its classification when it is INVESTIGATE or MONITOR */
export type ModGame = {
  id: string; home: string; away: string; kickoff: number | null;
  classification: 'INVESTIGATE' | 'MONITOR' | null; side: 'home' | 'away' | null;
  signal: Row; k: Row;
};

const CFB_FLAG_COLS = 'game_id,classification,undervalued_side,sp_plus_implied_spread,market_spread,sp_disagreement_points,elo_implied_spread,elo_disagreement_points,second_order_win_gap,third_down_delta,net_ypg_delta,corroborator_count,conflict,reference_provider,flag_spread,flag_total,available_inputs,missing_inputs,why,observable_factors,partial_factors,hidden_factors,data_limitations,thresholds_version';

function sideOf(v: unknown, home: string, away: string): 'home' | 'away' | null {
  const s = str(v).trim();
  if (!s) return null;
  if (/^home$/i.test(s)) return 'home';
  if (/^away$/i.test(s)) return 'away';
  if (norm(s) === norm(home)) return 'home';
  if (norm(s) === norm(away)) return 'away';
  const h = sameTeam(s, home), a = sameTeam(s, away);
  return h === a ? null : h ? 'home' : 'away';
}
const ptsF = (v: unknown) => { const n = num(v); return n == null ? null : signed(n, ' pts'); };

/* CFB: the app's "Analyst pass" (cfb.analyst_flags), joined to cfb.games */
export function cfbSignal(f: Row, home: string, away: string): Row {
  const factors: string[] = [];
  const add = (label: string, v: string | null) => { if (v != null) factors.push(`${label}: ${v}`); };
  add('SP+ disagreement', ptsF(f.sp_disagreement_points));
  add('Elo disagreement', ptsF(f.elo_disagreement_points));
  if (num(f.sp_plus_implied_spread) != null || num(f.market_spread) != null) {
    factors.push(`SP+ implied spread / reference market spread: ${num(f.sp_plus_implied_spread) == null ? '—' : fmtSpread(num(f.sp_plus_implied_spread), home, away)} / ${num(f.market_spread) == null ? '—' : fmtSpread(num(f.market_spread), home, away)}`);
  }
  add('Second-order wins gap', num(f.second_order_win_gap) == null ? null : signed(num(f.second_order_win_gap)!, ''));
  add('Net yards per game difference', num(f.net_ypg_delta) == null ? null : signed(num(f.net_ypg_delta)!, ' yd/g', 0));
  add('Third-down conversion difference', num(f.third_down_delta) == null ? null : signed(num(f.third_down_delta)! * 100, '%'));
  if (f.corroborator_count != null) factors.push(`Corroborating indicators: ${str(f.corroborator_count)}${f.conflict ? ' (one or more conflicting)' : ''}`);
  if (f.reference_provider) factors.push(`Reference book: ${str(f.reference_provider)}`);
  const available = list(f.available_inputs), missing = list(f.missing_inputs);
  const hasWhy = !!str(f.why).trim();
  return {
    module: 'CFB analyst pass (cfb.analyst_flags)',
    classification: str(f.classification).toUpperCase(),
    factors: factors.map(safeText),
    why: hasWhy ? safeText(f.why) : null,
    observability: { observable: list(f.observable_factors).map(safeText), partial: list(f.partial_factors).map(safeText), hidden: list(f.hidden_factors).map(safeText) },
    observability_note: hasWhy ? null : 'Explanation pending in the analyst pass.',
    availability: {
      result: missing.length ? `${missing.length} input${missing.length === 1 ? '' : 's'} missing` : available.length ? 'All listed inputs available' : 'Not reported',
      available: available.map(safeText), missing: missing.map(safeText),
    },
    limitations: list(hasWhy ? f.data_limitations : f.missing_inputs).map(safeText),
    flagged_team: str(f.undervalued_side) || null,
    version: str(f.thresholds_version) || null,
  };
}

/* NFL: the NFL board's research status (game_research_state). INVESTIGATE is
   "EdgeDesk differs from the market by 2+ points"; there is no MONITOR. */
export function nflSignal(r: Row): Row {
  const st = (r.state ?? {}) as Row;
  const factors: string[] = [];
  const gap = num(r.gap_pts) ?? num((st.gap as Row | undefined)?.points);
  if (gap != null) factors.push(`EdgeDesk's fair line differs from the market by ${fmtPts(gap)} pts`);
  for (const d of (Array.isArray(st.drivers) ? st.drivers as Row[] : []).slice(0, 5)) {
    if (d && d.text) factors.push(`${str(d.text)}${num(d.points) != null ? ` (${signed(num(d.points)!, ' pts')})` : ''}`);
  }
  const mv = (st.movement ?? {}) as Row;
  if (num(mv.toward_model) != null) factors.push(`Market move since the open, measured toward EdgeDesk's number: ${signed(num(mv.toward_model)!, ' pts')}`);
  const qb = (st.qb ?? {}) as Row, inj = (st.injuries ?? {}) as Row, mk = (st.market ?? {}) as Row, rel = (st.reliability ?? {}) as Row;
  const available: string[] = [], missing: string[] = [];
  (r.fair_home_line != null || (st.fair as Row | undefined)?.home_line != null ? available : missing).push('EdgeDesk projection');
  const stale = r.market_stale === true || mk.stale === true;
  if ((num(r.market_home_line) ?? num(mk.home_line)) != null && !stale) available.push('Captured market line');
  else missing.push(stale ? 'A current market line (the captured one is stale)' : 'Captured market line (none)');
  (qb.confirmed_both === true ? available : missing).push(qb.confirmed_both === true ? 'Both starting quarterbacks confirmed' : 'Both starting quarterbacks confirmed (not yet)');
  const injKnown = ((inj.home as Row | undefined)?.known === true) && ((inj.away as Row | undefined)?.known === true);
  (injKnown ? available : missing).push(injKnown ? 'Injury report for both teams' : 'Injury report for both teams (incomplete)');
  if (rel.scored === false) missing.push('Reliability score (the NFL model publishes none)');
  const limitations = [
    ...list(st.warnings), ...list((st.priority as Row | undefined)?.uncertainty),
    'Out of sample, no gap size has cleared p<0.05 against the NFL close: INVESTIGATE is a prompt to look harder, not a finding.',
  ];
  return {
    module: 'NFL research status (game_research_state)',
    classification: 'INVESTIGATE',
    factors: factors.map(safeText),
    why: r.key_reason ? safeText(r.key_reason) : null,
    observability: null,
    observability_note: 'Not published for the NFL: the NFL research status has no observability tiers.',
    availability: { result: missing.length ? `${missing.length} input${missing.length === 1 ? '' : 's'} missing or incomplete` : 'All listed inputs available', available: available.map(safeText), missing: missing.map(safeText) },
    limitations: [...new Set(limitations)].map(safeText),
    flagged_team: null,
    version: str(st.schema ?? '') || null,
  };
}

async function readModule(rt: Runtime, sport: 'cfb' | 'nfl', from: number, to: number): Promise<{ games: ModGame[] | null; error: string | null }> {
  const c = rt.c;
  if (sport === 'cfb') {
    const g = await sbAll(c, `games?select=game_id,start_date,home_team,away_team,completed&start_date=gte.${q(iso(from))}&start_date=lt.${q(iso(to))}&order=game_id.asc`, 'cfb');
    if (g.error) return { games: null, error: 'cfb.games could not be read: ' + g.error };
    const open = g.rows!.filter((x) => x.completed !== true);
    const ids = open.map((x) => str(x.game_id));
    const flags = new Map<string, Row>();
    for (let i = 0; i < ids.length; i += 150) {
      const f = await sbAll(c, `analyst_flags?select=${CFB_FLAG_COLS}&game_id=${inList(ids.slice(i, i + 150))}&order=game_id.asc`, 'cfb');
      if (f.error) return { games: null, error: 'cfb.analyst_flags could not be read: ' + f.error };
      for (const r of f.rows!) flags.set(str(r.game_id), r);
    }
    return {
      games: open.map((x) => {
        const id = str(x.game_id), f = flags.get(id), home = str(x.home_team), away = str(x.away_team);
        const cls = str(f?.classification).toUpperCase();
        const classification = cls === 'INVESTIGATE' || cls === 'MONITOR' ? cls : null;
        return {
          id, home, away, kickoff: ms(x.start_date), classification,
          side: f ? sideOf(f.undervalued_side, home, away) : null,
          signal: f && classification ? cfbSignal(f, home, away) : {},
          k: { corr: num(f?.corroborator_count) ?? 0, conflict: f?.conflict ? 1 : 0, absSp: num(f?.sp_disagreement_points) == null ? -1 : Math.abs(num(f?.sp_disagreement_points)!) },
        };
      }),
      error: null,
    };
  }
  const g = await sbAll(c, `game_research_state?select=game_id,home,away,kickoff_at,status,gap_pts,priority_rank,key_reason,market_home_line,market_stale,fair_home_line,state&sport=eq.nfl&kickoff_at=gte.${q(iso(from))}&kickoff_at=lt.${q(iso(to))}&order=game_id.asc`);
  if (g.error) return { games: null, error: 'game_research_state could not be read: ' + g.error };
  return {
    games: g.rows!.map((x) => {
      const inv = str(x.status).toUpperCase() === 'INVESTIGATE';
      const tw = str((((x.state ?? {}) as Row).gap as Row | undefined)?.toward);
      return {
        id: str(x.game_id), home: str(x.home), away: str(x.away), kickoff: ms(x.kickoff_at),
        classification: inv ? 'INVESTIGATE' as const : null,
        side: tw === 'home' || tw === 'away' ? tw : null,
        signal: inv ? nflSignal(x) : {},
        k: { prank: num(x.priority_rank) ?? Number.MAX_SAFE_INTEGER, absGap: num(x.gap_pts) == null ? -1 : Math.abs(num(x.gap_pts)!) },
      };
    }),
    error: null,
  };
}
const asRef = (g: ModGame): GameRef => ({ id: g.id, home: g.home, away: g.away, homeFull: g.home, awayFull: g.away, kickoff: g.kickoff, tbd: false, status: '', slateId: null });
const sampleRef = (s: Row): GameRef => ({ id: str(s.game_id), home: str(s.home), away: str(s.away), homeFull: str(s.home), awayFull: str(s.away), kickoff: ms(s.kickoff_at), tbd: false, status: '', slateId: null });

/* THE ORDER (discord_sample_order_v1). Deterministic and total:
     CFB: INVESTIGATE before MONITOR; more corroborating indicators; no
          conflict before conflict; larger |SP+ disagreement|; earlier
          kickoff; game id.
     NFL: the board's own priority rank (lib/research_priority.js); larger
          |gap|; earlier kickoff; game id. */
export function compareCandidates(sport: 'cfb' | 'nfl', a: ModGame, b: ModGame): number {
  const cls = (x: ModGame) => (x.classification === 'INVESTIGATE' ? 0 : 1);
  const ka = a.k as Record<string, number>, kb = b.k as Record<string, number>;
  const keys = sport === 'cfb'
    ? [cls(a) - cls(b), kb.corr - ka.corr, ka.conflict - kb.conflict, kb.absSp - ka.absSp]
    : [cls(a) - cls(b), ka.prank - kb.prank, kb.absGap - ka.absGap];
  for (const d of keys) if (d) return d;
  return ((a.kickoff ?? Infinity) - (b.kickoff ?? Infinity)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export type Candidate = ModGame & { detectedAt: number | null; eligible: boolean; excluded: string | null; rank?: number; reason?: string };
/* up to two eligible INVESTIGATE games; if there are none, the top eligible
   MONITOR. Eligible: a detection record, a fresh consensus line, and a
   kickoff late enough to post at least 60 minutes before it. */
export function chooseSamples(sport: 'cfb' | 'nfl', games: ModGame[], detected: Map<string, number>, fresh: Set<string>, now: number, c: Cfg): { ranked: Candidate[]; chosen: Candidate[]; note: string } {
  const ranked: Candidate[] = games.filter((g) => g.classification).sort((a, b) => compareCandidates(sport, a, b)).map((g) => {
    const det = detected.get(`${g.id}|${g.classification}`) ?? null;
    let excluded: string | null = null;
    if (g.kickoff == null || g.kickoff - (60 + c.tickMinutes) * MIN <= now) excluded = 'too close to kickoff to post at least 60 minutes before it';
    else if (det == null) excluded = 'no detection record';
    else if (!fresh.has(g.id)) excluded = 'no fresh consensus line';
    return { ...g, detectedAt: det, eligible: !excluded, excluded };
  });
  const inv = ranked.filter((x) => x.eligible && x.classification === 'INVESTIGATE');
  const mon = ranked.filter((x) => x.eligible && x.classification === 'MONITOR');
  let chosen: Candidate[];
  let note: string;
  if (inv.length) {
    chosen = inv.slice(0, 2).map((x, i) => ({ ...x, rank: i + 1, reason: `INVESTIGATE, #${i + 1} of ${inv.length} eligible INVESTIGATE game${inv.length === 1 ? '' : 's'} on this slate by ${SAMPLE_RULE}` }));
    note = `${chosen.length} INVESTIGATE`;
  } else if (mon.length) {
    chosen = [{ ...mon[0], rank: 1, reason: `No eligible INVESTIGATE game; the top of ${mon.length} eligible MONITOR game${mon.length === 1 ? '' : 's'} by ${SAMPLE_RULE}` }];
    note = '1 MONITOR (no eligible INVESTIGATE)';
  } else {
    chosen = [];
    note = ranked.length ? 'no eligible INVESTIGATE or MONITOR game' : 'no INVESTIGATE or MONITOR game on this slate';
  }
  return { ranked, chosen, note };
}

/* CLV in points on the flagged side: home (L_ref - L_close), away the reverse.
   Positive = the market moved toward the flagged side after that moment. */
export function clvPoints(side: unknown, ref: number | null, close: number | null): number | null {
  if (ref == null || close == null || (side !== 'home' && side !== 'away')) return null;
  return r2(side === 'home' ? ref - close : close - ref);
}

function bullet(a: unknown, max = 6): string {
  const l = list(a);
  if (!l.length) return '—';
  return l.slice(0, max).map((x) => `• ${x}`).join('\n') + (l.length > max ? `\n• …and ${l.length - max} more` : '');
}

export function renderSample(s: Row, row: LineRow, source: string, now: number, c: Cfg): Payload {
  const sig = (s.signal ?? {}) as Row;
  const home = str(s.home), away = str(s.away), k = ms(s.kickoff_at)!, det = ms(s.detected_at);
  const sport = str(s.sport).toUpperCase();
  const obs = sig.observability as Row | null;
  const av = (sig.availability ?? {}) as Row;
  const fields: Field[] = [
    {
      name: `Lines · ${source}${row.books ? `, ${row.books} books` : ''}`,
      value: [
        `Current: ${fmtSpread(row.home, home, away)}${row.total != null ? ` · Total ${fmtPts(row.total)}` : ''} (${fmtTime(row.asOf ?? now)})`,
        `Opening: ${row.openHome == null ? 'not captured' : fmtSpread(row.openHome, home, away)}`,
        `At detection${det ? ` (${fmtWhen(det)})` : ''}: ${num(s.line_at_detection) == null ? 'not captured' : fmtSpread(num(s.line_at_detection), home, away)}`,
      ].join('\n'),
    },
    {
      name: `Classification: ${str(s.classification)}`,
      value: [`Source: ${str(sig.module)}`, ...list(sig.factors).map((x) => `• ${x}`), ...(sig.why ? [`Why: ${str(sig.why)}`] : [])].join('\n'),
    },
    {
      name: 'Observability',
      value: obs
        ? [`Observable:\n${bullet(obs.observable)}`, `Partially observable:\n${bullet(obs.partial)}`, `Mostly hidden:\n${bullet(obs.hidden)}`, ...(sig.observability_note ? [str(sig.observability_note)] : [])].join('\n')
        : str(sig.observability_note) || 'Not published.',
    },
    {
      name: `Data-availability check: ${str(av.result) || 'not reported'}`,
      value: [list(av.available).length ? `Available:\n${bullet(av.available)}` : '', list(av.missing).length ? `Missing:\n${bullet(av.missing)}` : ''].filter(Boolean).join('\n') || '—',
    },
    { name: 'Known limitations', value: bullet(sig.limitations, 8) },
    { name: 'How this game was chosen', value: `${str(s.reason)}. Chosen before kickoff and recorded; every sample is graded after the close, in this thread.` },
  ];
  return {
    embeds: [{
      title: `Free research sample · ${sport} · ${away} @ ${home}`,
      url: c.signupUrl,
      description: [
        `**${away} @ ${home}** · ${fmtWhen(k)}`,
        `Detected ${det ? fmtWhen(det) : '—'} · posted ${fmtWhen(now)}. Subscribers saw it when it was detected.`,
        'Observed data only: what EdgeDesk recorded and why the research flagged the game. It is not a recommendation to bet.',
        `Full slate on EdgeDesk: ${c.signupUrl}`,
      ].join('\n'),
      fields,
      footer: { text: FOOTER_SAMPLE },
    }],
  };
}

export function renderFollowup(s: Row, close: { line: number | null; source: string; quality: string | null; books: number | null }, clvDet: number | null, clvPost: number | null, link: string | null, c: Cfg): Payload {
  const home = str(s.home), away = str(s.away);
  const side = s.side === 'home' ? home : s.side === 'away' ? away : null;
  const ld = num(s.line_at_detection), lp = num(s.line_at_post);
  const clvLine = (label: string, ref: number | null, v: number | null) =>
    `${label}: ${v == null ? (ref == null ? 'not measured (no line recorded then)' : side == null ? 'not measured (no flagged side recorded)' : 'not measured (no closing line)') : signed(v, ' pts')}${ref != null ? ` (from ${fmtSpread(ref, home, away)})` : ''}`;
  return {
    embeds: [{
      title: `Closed · ${away} @ ${home}`,
      url: c.signupUrl,
      description: [
        link ? `Follow-up to the free research sample: ${link}` : 'Follow-up to the free research sample above.',
        'Posted for every sample, whichever way the market went.',
        `Full slate on EdgeDesk: ${c.signupUrl}`,
      ].join('\n'),
      fields: [
        { name: 'Closing line', value: close.line == null ? `Not captured by EdgeDesk (${close.source})` : `${fmtSpread(close.line, home, away)} · ${close.source}${close.books ? `, ${close.books} books` : ''}${close.quality && close.quality !== 'OBSERVED' ? ` (${close.quality.toLowerCase().replace(/_/g, ' ')})` : ''}` },
        {
          name: 'CLV',
          value: [
            clvLine('At detection', ld, clvDet),
            clvLine('At post time', lp, clvPost),
            side ? `Measured on ${side}, the side the research flagged (recorded at selection). Positive means the market moved toward it after that moment.` : 'No flagged side was recorded for this game, so no CLV is measured.',
          ].join('\n'),
        },
      ],
      footer: { text: FOOTER_SAMPLE },
    }],
  };
}

async function closeFor(rt: Runtime, sport: 'cfb' | 'nfl', s: Row): Promise<{ line: number | null; source: string; quality: string | null; books: number | null; observedAt: string | null } | null> {
  if (sport === 'cfb') {
    const r = await sb(rt.c, `cfb_lab_market_lines?select=home_line,quality,observed_at,n_books&kind=eq.CLOSE&book=eq.CONSENSUS&market_type=eq.spread&game_id=eq.${q(str(s.game_id))}&limit=1`);
    const row = r.ok && Array.isArray(r.data) ? (r.data[0] as Row | undefined) : undefined;
    if (!row) return null;
    const line = str(row.quality) === 'MISSING' ? null : num(row.home_line);
    return { line, source: 'CFB Lab consensus close', quality: str(row.quality) || null, books: num(row.n_books), observedAt: str(row.observed_at) || null };
  }
  const k = ms(s.kickoff_at)!;
  const { board } = await oddsBoard(rt, k - 3 * H, k + 3 * H);
  if (!board) return null;
  const b = matchBoard(Array.isArray(board.games) ? board.games as Row[] : [], sampleRef(s));
  const line = b ? lineOf(b.closing, 'spread:home') : null;
  return line == null ? null : { line, source: 'NFL odds feed consensus close', quality: 'OBSERVED', books: num(b!.book_count), observedAt: null };
}

async function patchSample(c: Cfg, id: unknown, patch: Row): Promise<string | null> {
  const r = await sb(c, `discord_samples?id=eq.${q(str(id))}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' });
  return r.ok ? null : r.error;
}

async function samplesForSport(rt: Runtime, sport: 'cfb' | 'nfl', o: { dryRun: boolean; ignoreSchedule: boolean }): Promise<Row> {
  const c = rt.c, now = rt.now(), today = localDate(now), channel = SPORTS[sport].channel;
  const out: Row = { sport, sightings: 0, selection: null, posted: [], missed: [], followups: [], errors: [] as string[] };
  const errors = out.errors as string[];
  const mod = await readModule(rt, sport, now - 6 * H, localMidnight(addDays(today, 8)));
  if (mod.error) errors.push(mod.error);
  const dryDetected = new Map<string, number>();
  let drySamples: Row[] = [];

  // 1. SIGHTINGS — the first time each classification is seen, with the line then.
  const detected = new Map<string, number>();
  let sightingsOk = !!mod.games;
  if (mod.games) {
    const classified = mod.games.filter((g) => g.classification && g.kickoff != null && g.kickoff > now);
    if (classified.length) {
      const ex = await sbAll(c, `discord_sample_sightings?select=game_id,classification,first_seen_at&sport=eq.${sport}&game_id=${inList([...new Set(classified.map((g) => g.id))])}&order=game_id.asc`);
      if (ex.error) { sightingsOk = false; errors.push('sightings could not be read: ' + ex.error); }
      else {
        for (const r of ex.rows!) detected.set(`${str(r.game_id)}|${str(r.classification)}`, ms(r.first_seen_at)!);
        const fresh = classified.filter((g) => !detected.has(`${g.id}|${g.classification}`));
        if (fresh.length) {
          const book = await linesFor(rt, sport, fresh.map(asRef), null);
          const rows = fresh.map((g) => {
            const l = book.ok ? book.rows.get(g.id) : undefined;
            const ok = lineFresh(rt, l);
            return {
              sport, game_id: g.id, classification: g.classification, kickoff_at: iso(g.kickoff!), home: g.home, away: g.away, side: g.side,
              line_home: ok ? l!.home : null, line_total: ok ? l!.total : null, line_as_of: ok ? iso(l!.asOf!) : null, line_source: book.source, signal: g.signal,
            };
          });
          if (o.dryRun) for (const g of fresh) dryDetected.set(`${g.id}|${g.classification}`, now);
          else {
            const w = await sb(c, 'discord_sample_sightings?on_conflict=sport,game_id,classification', { method: 'POST', body: rows, prefer: 'resolution=ignore-duplicates,return=representation' });
            if (!w.ok) { sightingsOk = false; errors.push('sightings could not be written: ' + w.error); }
            else for (const r of (Array.isArray(w.data) ? w.data as Row[] : [])) detected.set(`${str(r.game_id)}|${str(r.classification)}`, ms(r.first_seen_at)!);
            out.sightings = Array.isArray(w.data) ? w.data.length : 0;
          }
        }
      }
    }
  }

  // 2. SELECTION — once per slate date, from the selection hour, before play.
  /* a selection is final, so it is never made on a failed read: it waits for
     a tick that could see the sightings and the lines */
  selection: if (mod.games && sightingsOk && (o.ignoreSchedule || localParts(now).hour >= c.sampleSelectHour)) {
    const have = await sb(c, `discord_sample_selections?select=slate_date&sport=eq.${sport}&slate_date=eq.${today}`);
    if (!have.ok) errors.push('selections could not be read: ' + have.error);
    else if (!(have.data as Row[]).length) {
      const todays = mod.games.filter((g) => g.kickoff != null && localDate(g.kickoff) === today);
      if (todays.length) {
        const cands = todays.filter((g) => g.classification);
        const book = cands.length ? await linesFor(rt, sport, cands.map(asRef), null) : null;
        if (book?.readFailed) { errors.push('selection postponed: ' + book.reason); break selection; }
        const freshIds = new Set(cands.filter((g) => book?.ok && lineFresh(rt, book.rows.get(g.id))).map((g) => g.id));
        const det = new Map([...detected, ...dryDetected]);
        const sel = chooseSamples(sport, todays, det, freshIds, now, c);
        const candidates = sel.ranked.map((x, i) => ({
          order: i + 1, game_id: x.id, matchup: `${x.away} @ ${x.home}`, kickoff_at: x.kickoff ? iso(x.kickoff) : null,
          classification: x.classification, detected_at: x.detectedAt ? iso(x.detectedAt) : null, order_keys: x.k, eligible: x.eligible, excluded: x.excluded,
        }));
        const chosen = sel.chosen.map((x) => ({
          game_id: x.id, rank: x.rank, classification: x.classification, reason: x.reason, home: x.home, away: x.away,
          kickoff_at: iso(x.kickoff!), side: x.side, signal: x.signal,
        }));
        out.selection = { note: sel.note, chosen: chosen.map((x) => x.game_id), candidates: candidates.length };
        if (o.dryRun) {
          drySamples = sel.chosen.map((x) => {
            const l = book?.rows.get(x.id);
            return {
              id: `dry-${x.id}`, sport, slate_date: today, game_id: x.id, rank: x.rank, classification: x.classification, reason: x.reason,
              home: x.home, away: x.away, kickoff_at: iso(x.kickoff!), detected_at: iso(x.detectedAt!), line_at_detection: l?.home ?? null,
              side: x.side, signal: x.signal, channel, status: 'scheduled',
              scheduled_post_at: iso(Math.min(x.detectedAt! + c.sampleDelayHours * H, x.kickoff! - (60 + c.tickMinutes) * MIN)),
            };
          });
          (out.selection as Row).dry_run = true;
        } else {
          const w = await rpc(c, 'discord_record_selection', {
            p_sport: sport, p_slate_date: today, p_rule_version: SAMPLE_RULE, p_delay_hours: c.sampleDelayHours, p_buffer_minutes: c.tickMinutes,
            p_channel: channel, p_candidates: candidates, p_chosen: chosen, p_note: sel.note,
          });
          if (!w.ok) errors.push('the selection could not be recorded: ' + w.error);
          else (out.selection as Row).recorded = w.data;
        }
      }
    }
  }

  // 3. POST what is due, never later than 60 minutes before kickoff.
  let due: Row[] = [];
  if (o.dryRun) due = drySamples.filter((s) => ms(s.scheduled_post_at)! <= now);
  else {
    const d = await sbAll(c, `discord_samples?select=*&sport=eq.${sport}&status=eq.scheduled&scheduled_post_at=lte.${q(iso(now))}&order=scheduled_post_at.asc`);
    if (d.error) errors.push('due samples could not be read: ' + d.error);
    else due = d.rows!;
  }
  for (const s of due) {
    const k = ms(s.kickoff_at)!, deadline = k - 60 * MIN;
    const key = `sample:${channel}:${str(s.slate_date)}:${str(s.game_id)}`;
    const missed = async (why: string) => {
      (out.missed as Row[]).push({ game_id: s.game_id, why });
      if (!o.dryRun) { const e = await patchSample(c, s.id, { status: 'missed', miss_reason: why }); if (e) errors.push(e); }
    };
    if (!o.dryRun) {
      /* a send that landed but was not recorded (the function died between) */
      const cs = await claimState(c, key);
      if (cs.state === 'sent' && cs.message_ids.length) {
        const e = await patchSample(c, s.id, { status: 'posted', posted_at: cs.claimed_at, message_id: cs.message_ids[0] });
        if (e) errors.push(e);
        continue;
      }
      if (cs.state && cs.state !== 'failed') { errors.push(`sample ${str(s.game_id)}: claim is ${cs.state}; an operator must check the channel`); continue; }
    }
    if (now > deadline) { await missed(`the post window closed at ${fmtWhen(deadline)} (60 minutes before kickoff) before it could be posted`); continue; }
    const book = await linesFor(rt, sport, [sampleRef(s)], null);
    const row = book.ok ? book.rows.get(str(s.game_id)) : undefined;
    if (!lineFresh(rt, row)) {
      if (now + c.tickMinutes * MIN > deadline) await missed('no fresh consensus line before the post window closed');
      else errors.push(`sample ${str(s.game_id)}: waiting for a fresh line (${book.reason ?? 'none for this game'})`);
      continue;
    }
    const payload = renderSample(s, row, book.source, now, c);
    const r = await postToDiscord(channel, payload, { type: 'sample', postKey: key, postDate: str(s.slate_date), dryRun: o.dryRun, detail: { game_id: s.game_id, sample_id: s.id } }, rt);
    (out.posted as Row[]).push({ game_id: s.game_id, result: r.status, error: r.error, printed: r.printed });
    if (r.status === 'sent' && !o.dryRun) {
      const e = await patchSample(c, s.id, {
        status: 'posted', posted_at: iso(now), line_at_post: row.home, total_at_post: row.total, line_as_of_post: iso(row.asOf!),
        message_id: r.messageIds[0] ?? '', discord_channel_id: r.channelId,
      });
      if (e) errors.push(e);
    }
  }

  // 4. FOLLOW-UP after the close, in a thread on the sample.
  if (!o.dryRun) {
    const p = await sbAll(c, `discord_samples?select=*&sport=eq.${sport}&status=eq.posted&kickoff_at=lte.${q(iso(now - c.followupAfterHours * H))}&order=kickoff_at.asc`);
    if (p.error) errors.push('posted samples could not be read: ' + p.error);
    for (const s of p.rows ?? []) {
      const k = ms(s.kickoff_at)!;
      const close = await closeFor(rt, sport, s);
      const giveUp = now >= k + c.followupGiveUpHours * H;
      if ((!close || close.line == null) && !giveUp) continue;
      const cl = close ?? { line: null, source: 'no close found', quality: null, books: null, observedAt: null };
      const det = clvPoints(s.side, num(s.line_at_detection), cl.line);
      const pst = clvPoints(s.side, num(s.line_at_post), cl.line);
      let thread = str(s.thread_id) || null, link: string | null = null;
      if (!thread && s.discord_channel_id && s.message_id) {
        const t = await ensureThread(rt, str(s.discord_channel_id), str(s.message_id), `Follow-up · ${str(s.away)} @ ${str(s.home)}`);
        if (t.id) { thread = t.id; const e = await patchSample(c, s.id, { thread_id: t.id }); if (e) errors.push(e); }
        else {
          const guild = await webhookGuild(channel);
          if (guild) link = `https://discord.com/channels/${guild}/${str(s.discord_channel_id)}/${str(s.message_id)}`;
        }
      }
      const payload = renderFollowup(s, cl, det, pst, thread ? null : link, c);
      const fkey = `sample_followup:${channel}:${str(s.slate_date)}:${str(s.game_id)}`;
      let r = await postToDiscord(channel, payload, { type: 'sample_followup', postKey: fkey, postDate: str(s.slate_date), threadId: thread, detail: { game_id: s.game_id, sample_id: s.id } }, rt);
      let mid = r.messageIds[0] ?? null;
      if (r.status === 'duplicate') { const cs = await claimState(c, fkey); if (cs.state === 'sent') { mid = cs.message_ids[0] ?? ''; r = { ...r, status: 'sent' }; } }
      (out.followups as Row[]).push({ game_id: s.game_id, result: r.status, error: r.error, clv_at_post: pst });
      if (r.status === 'sent') {
        const e = await patchSample(c, s.id, {
          status: 'followed_up', followup_at: iso(now), followup_message_id: mid ?? '', close_line: cl.line, close_source: cl.source,
          close_quality: cl.quality, close_observed_at: cl.observedAt, clv_at_detection: det, clv_at_post: pst,
          followup_note: cl.line == null ? 'no closing line was captured within 48 hours of kickoff' : null,
        });
        if (e) errors.push(e);
      }
    }
  }
  return out;
}

export async function runSamples(rt: Runtime, o: { dryRun?: boolean; ignoreSchedule?: boolean; sports?: ('cfb' | 'nfl')[] } = {}): Promise<Row> {
  const dryRun = o.dryRun ?? rt.c.dryRun;
  const results: Row[] = [];
  for (const sport of o.sports ?? SAMPLE_SPORTS) {
    try { results.push(await samplesForSport(rt, sport, { dryRun, ignoreSchedule: !!o.ignoreSchedule })); }
    catch (e) { results.push({ sport, errors: [clip(scrub(errMsg(e)), 300)] }); }
  }
  const failed = results.some((r) => ((r.posted ?? []) as Row[]).some((p) => ['failed', 'partial', 'unknown'].includes(str(p.result)))
    || ((r.followups ?? []) as Row[]).some((p) => ['failed', 'partial', 'unknown'].includes(str(p.result))));
  return { ok: !failed, action: 'samples', dry_run: dryRun, results };
}

// ================================================================== the handler

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function probe(): Row {
  const c = config();
  return {
    ok: true, service: 'discord_cron', build: BUILD, dry_run: c.dryRun,
    configured: {
      supabase: !!(c.url && c.serviceKey), cron_secret: !!c.cronSecret, bot_token: !!c.botToken,
      webhooks: Object.fromEntries(Object.values(CHANNEL).map((n) => [n, WEBHOOK_RE.test((Deno.env.get(n) ?? '').trim())])),
    },
  };
}

export async function handle(req: Request, rt: Runtime = runtime()): Promise<Response> {
  if (req.method === 'GET') return Response.json(probe());
  if (req.method !== 'POST') return Response.json({ ok: false, error: 'method not allowed' }, { status: 405 });
  const c = rt.c;
  if (!c.cronSecret) return Response.json({ ok: false, error: 'unauthorized', reason: 'DISCORD_CRON_SECRET is not set on this function' }, { status: 401 });
  if (!safeEqual(req.headers.get('x-cron-secret') ?? '', c.cronSecret)) return Response.json({ ok: false, error: 'unauthorized', reason: 'the x-cron-secret header did not match' }, { status: 401 });
  if (!c.url || !c.serviceKey) return Response.json({ ok: false, error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set' }, { status: 503 });
  let body: Row = {};
  try { body = await req.json() as Row; } catch { /* an empty body is an empty action */ }
  /* a manual call may turn dry run ON, never off */
  const o = { dryRun: c.dryRun || body.dry_run === true, ignoreSchedule: body.ignore_schedule === true };
  const sports = Array.isArray(body.sports) ? (body.sports as string[]).filter((s) => s in SPORTS) as SportId[] : undefined;
  try {
    let out: Row;
    if (body.action === 'scorecard') out = await runScorecard(rt, o);
    else if (body.action === 'slate') out = await runSlate(rt, { ...o, sports });
    else if (body.action === 'samples') out = await runSamples(rt, { ...o, sports: sports?.filter((s): s is 'cfb' | 'nfl' => s === 'cfb' || s === 'nfl') });
    else return Response.json({ ok: false, error: 'action must be scorecard, slate or samples' }, { status: 400 });
    console.log('DISCORD_CRON ' + JSON.stringify({ build: BUILD, action: body.action, ok: out.ok, result: out.result ?? null }));
    return Response.json({ build: BUILD, ...out }, { status: out.ok === false ? 503 : 200 });
  } catch (e) {
    return Response.json({ ok: false, build: BUILD, error: clip(scrub(errMsg(e)), 300) }, { status: 500 });
  }
}

if (typeof (Deno as unknown as { serve?: unknown })?.serve === 'function') {
  Deno.serve((req) => handle(req));
}
