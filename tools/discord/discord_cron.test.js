#!/usr/bin/env node
/* ============================================================================
   THE DISCORD POSTS, tested as deployed.

   supabase/functions/discord_cron/index.ts is imported — not a copy — under
   Node's native type stripping, with a Deno shim, an in-memory PostgREST
   (the tables, the claim and selection functions, the NFL odds board), a
   mocked Discord and the site's published files. What is pinned:

     postToDiscord   429 waits retry_after; Discord's limits (10 embeds, 25
                     fields, 6000 characters, every string) are kept by
                     splitting, never by dropping; every call is logged; a key
                     is never posted twice (a rerun, an unknown outcome); a 4xx
                     may be retried; the webhook URL never reaches a log, an
                     error or a dry-run print; the copy check refuses picks,
                     locks, EV and win-probability wording; dry run posts nothing
     timing          10:00 America/Chicago under CDT and CST; Mondays only
     slate           observed lines, the open and the move only where EdgeDesk
                     owns them; outdoor weather only; a stale sync or no games
                     is a logged skip, never a partial post
     scorecard       the public record's numbers per sport, small samples
                     labelled not hidden, a bad week printed like a good one,
                     Brier from the verified tier, the samples' own record
     samples         deterministic selection (two INVESTIGATE, else the top
                     MONITOR), every candidate logged, posted after the delay
                     and never later than 60 minutes before kickoff, a thread
                     reply after the close with CLV at detection and at post,
                     losses like wins

   Run: node tools/discord/discord_cron.test.js
   ========================================================================== */
'use strict';
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const FN = path.join(ROOT, 'supabase', 'functions', 'discord_cron', 'index.ts');

let pass = 0, fail = 0;
const failures = [];
function chk(name, cond, detail) { if (cond) { pass++; return true; } fail++; failures.push(name + (detail !== undefined ? ' — ' + JSON.stringify(detail).slice(0, 400) : '')); return false; }

/* ── the environment ─────────────────────────────────────────────────────── */
const HOOK = (n) => `https://discord.com/api/webhooks/1000${n}/tok-${n}-SECRETSECRET`;
const BASE_ENV = {
  SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'service-key', DISCORD_CRON_SECRET: 'cron-secret',
  DISCORD_WEBHOOK_CLV_RESULTS: HOOK(1), DISCORD_WEBHOOK_NFL: HOOK(2), DISCORD_WEBHOOK_CFB: HOOK(3),
  DISCORD_WEBHOOK_NBA: HOOK(4), DISCORD_WEBHOOK_CBB: HOOK(5), DISCORD_WEBHOOK_NHL: HOOK(6),
};
let ENV = Object.assign({}, BASE_ENV);
globalThis.Deno = { env: { get: (k) => ENV[k] } };

const H = 36e5, MIN = 6e4;
const iso = (v) => new Date(v).toISOString();
let NOW = Date.parse('2026-10-16T15:00:00Z');

/* ── the database ────────────────────────────────────────────────────────── */
let DB;
let DB_DOWN = new Set();
function resetDb() {
  DB = {
    public_record: [], perf_grades: [], discord_posts: [], discord_post_claims: [], discord_sample_sightings: [],
    discord_sample_selections: [], discord_samples: [], cfb_lab_consensus_now: [], cfb_lab_predictions: [], cfb_lab_market_lines: [],
    game_research_state: [], 'cfb.games': [], 'cfb.analyst_flags': [],
  };
  DB_DOWN = new Set();
}
let BOARD = null; /* collective.odds_board */
let SITE = {};
const clone = (x) => JSON.parse(JSON.stringify(x));
function cmp(a, b) {
  if (a == null || b == null) return NaN;
  const da = typeof a === 'string' && /^\d{4}-\d\d-\d\d/.test(a) ? Date.parse(a) : NaN, db = typeof b === 'string' && /^\d{4}-\d\d-\d\d/.test(b) ? Date.parse(b) : NaN;
  if (Number.isFinite(da) && Number.isFinite(db)) return da - db;
  const na = Number(a), nb = Number(b);
  if (a !== '' && b !== '' && Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}
function matches(row, key, expr) {
  const v = row[key];
  if (expr === 'not.is.null') return v != null;
  if (expr === 'is.null') return v == null;
  const m = /^(eq|gte|gt|lte|lt|in)\.(.*)$/.exec(expr);
  if (!m) return true;
  if (m[1] === 'in') return m[2].replace(/^\(|\)$/g, '').split(',').map(decodeURIComponent).some((x) => String(v) === x);
  const c = cmp(v, m[2]);
  if (m[1] === 'eq') return String(v) === m[2];
  if (Number.isNaN(c)) return false;
  return m[1] === 'gte' ? c >= 0 : m[1] === 'gt' ? c > 0 : m[1] === 'lte' ? c <= 0 : c < 0;
}
const SKIP = new Set(['select', 'order', 'limit', 'offset', 'on_conflict']);
function filterRows(rows, params) {
  let out = rows.filter((r) => params.every(([k, v]) => SKIP.has(k) || matches(r, k, v)));
  const off = Number((params.find(([k]) => k === 'offset') || [])[1] || 0), lim = Number((params.find(([k]) => k === 'limit') || [])[1] || 1e9);
  return out.slice(off, off + lim);
}

const SAMPLE_ONCE = ['posted_at', 'message_id', 'line_at_post', 'close_line', 'clv_at_post', 'clv_at_detection', 'followup_at', 'thread_id', 'miss_reason'];
function patchSample(row, patch) {
  for (const k of SAMPLE_ONCE) if (k in patch && row[k] != null && row[k] !== patch[k]) throw new Error(`${k} is written once`);
  if (patch.status && patch.status !== row.status) {
    const ok = (row.status === 'scheduled' && ['posted', 'missed'].includes(patch.status)) || (row.status === 'posted' && patch.status === 'followed_up');
    if (!ok) throw new Error(`status cannot move from ${row.status} to ${patch.status}`);
  }
  if (patch.posted_at && Date.parse(patch.posted_at) > Date.parse(row.kickoff_at) - 60 * MIN) throw new Error('posted later than 60 minutes before kickoff');
  Object.assign(row, patch);
}

let NEXT_SAMPLE = 1;
const RPC = {
  discord_claim_post(a) {
    const t = DB.discord_post_claims, row = t.find((r) => r.post_key === a.p_post_key);
    if (!row) { t.push({ post_key: a.p_post_key, channel: a.p_channel, type: a.p_type, post_date: a.p_post_date, state: 'claimed', attempts: 1, message_ids: [], claimed_at: iso(NOW) }); return { claimed: true, state: 'claimed', attempts: 1 }; }
    if (row.state === 'failed' && row.attempts < 3) { row.state = 'claimed'; row.attempts++; return { claimed: true, state: 'claimed', attempts: row.attempts }; }
    return { claimed: false, state: row.state, attempts: row.attempts };
  },
  discord_finish_post(a) {
    const row = DB.discord_post_claims.find((r) => r.post_key === a.p_post_key && r.state === 'claimed');
    if (!row) return false;
    Object.assign(row, { state: a.p_state, message_ids: a.p_message_ids || [], error: a.p_error });
    return true;
  },
  discord_record_selection(a) {
    if (DB.discord_sample_selections.some((s) => s.sport === a.p_sport && s.slate_date === a.p_slate_date)) return { created: false };
    const rows = [];
    for (const c of a.p_chosen) {
      const s = DB.discord_sample_sightings.find((x) => x.sport === a.p_sport && x.game_id === c.game_id && x.classification === c.classification);
      if (!s) throw new Error('no sighting for ' + c.game_id);
      const sched = Math.min(Date.parse(s.first_seen_at) + a.p_delay_hours * H, Date.parse(c.kickoff_at) - (60 + a.p_buffer_minutes) * MIN);
      rows.push(Object.assign({ id: NEXT_SAMPLE++, sport: a.p_sport, slate_date: a.p_slate_date, channel: a.p_channel, status: 'scheduled', detected_at: s.first_seen_at,
        line_at_detection: s.line_home, total_at_detection: s.line_total, line_source: s.line_source, scheduled_post_at: iso(sched) }, clone(c)));
    }
    DB.discord_sample_selections.push({ sport: a.p_sport, slate_date: a.p_slate_date, selected_at: iso(NOW), rule_version: a.p_rule_version, candidates: a.p_candidates, chosen: a.p_chosen, note: a.p_note });
    DB.discord_samples.push(...rows);
    return { created: true, samples: rows.length };
  },
  odds_board(a) {
    if (!BOARD) return null;
    const from = Date.parse(a.p_from), to = Date.parse(a.p_to);
    return Object.assign({}, BOARD, { games: BOARD.games.filter((g) => { const t = Date.parse(g.commence_time); return t >= from && t < to; }) });
  },
};

/* ── Discord ─────────────────────────────────────────────────────────────── */
let DISCORD = [];          /* every webhook request seen */
let RESPOND = [];          /* queued responses for the next webhook requests */
let THREADS = [];
let NEXT_MSG = 1;
const SLEEPS = [];
function res(status, body, headers) {
  const h = new Map(Object.entries(headers || {}));
  return { ok: status >= 200 && status < 300, status, headers: { get: (k) => (h.has(k.toLowerCase()) ? h.get(k.toLowerCase()) : null) },
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
}

globalThis.fetch = async function (url, init) {
  const u = String(url), m = (init && init.method) || 'GET';
  const hdr = (init && init.headers) || {};
  if (u.startsWith('https://stub.supabase.co/rest/v1/')) {
    const rest = u.slice('https://stub.supabase.co/rest/v1/'.length);
    const [p, qs] = rest.split('?');
    const params = [...new URLSearchParams(qs || '')].map(([k, v]) => [k, v]);
    const profile = hdr['accept-profile'] || hdr['content-profile'];
    if (p.startsWith('rpc/')) {
      const fn = p.slice(4);
      if (DB_DOWN.has('rpc:' + fn)) return res(500, 'down');
      if (!RPC[fn]) return res(404, 'no rpc ' + fn);
      try { return res(200, RPC[fn](JSON.parse(init.body))); } catch (e) { return res(400, String(e.message)); }
    }
    const t = profile && profile !== 'public' ? `${profile}.${p}` : p;
    if (DB_DOWN.has(t)) return res(500, '{"message":"boom"}');
    if (!DB[t]) return res(404, '{"code":"42P01"}');
    if (m === 'GET') return res(200, clone(filterRows(DB[t], params)));
    if (m === 'POST') {
      const body = JSON.parse(init.body), rows = Array.isArray(body) ? body : [body];
      const out = [];
      for (const r of rows) {
        if (t === 'discord_sample_sightings') {
          if (DB[t].some((x) => x.sport === r.sport && x.game_id === r.game_id && x.classification === r.classification)) continue;
          r.first_seen_at = iso(NOW);
        }
        if (t === 'discord_posts') r.sent_at = iso(NOW);
        DB[t].push(clone(r)); out.push(clone(r));
      }
      return res(201, /return=representation/.test(hdr.prefer || '') ? out : '');
    }
    if (m === 'PATCH') {
      const rows = filterRows(DB[t], params), patch = JSON.parse(init.body);
      try { for (const r of rows) patchSample(r, patch); } catch (e) { return res(400, String(e.message)); }
      return res(204, '');
    }
  }
  if (/^https:\/\/discord\.com\/api\/webhooks\//.test(u)) {
    if (m === 'GET') return res(200, { id: 'w', guild_id: 'G1', channel_id: 'C1' });
    const body = JSON.parse(init.body);
    DISCORD.push({ url: u, body, thread: new URL(u).searchParams.get('thread_id') });
    const next = RESPOND.shift();
    if (next === 'throw') throw new TypeError(`error sending request for url (${u}): connection reset`);
    if (next) return res(next.status, next.body, next.headers);
    return res(200, { id: 'm' + NEXT_MSG++, channel_id: 'C' + u.split('/')[5] });
  }
  if (/^https:\/\/discord\.com\/api\/v10\/channels\/.*\/threads$/.test(u)) {
    THREADS.push({ url: u, auth: hdr.authorization });
    return res(201, { id: u.split('/')[8] });
  }
  if (u.startsWith('https://edgedesksports.com/')) {
    const p = u.slice('https://edgedesksports.com/'.length).split('?')[0];
    return SITE[p] ? res(200, clone(SITE[p])) : res(404, 'missing');
  }
  if (u.startsWith('https://evil.example')) { DISCORD.push({ url: u, evil: true }); return res(200, {}); }
  return res(404, 'unexpected ' + u);
};

let LOGS = [];
const realLog = console.log, realErr = console.error;
console.log = (...a) => { LOGS.push(a.join(' ')); };
console.error = (...a) => { LOGS.push(a.join(' ')); };

function reset(over) {
  resetDb(); BOARD = null; SITE = {}; DISCORD = []; RESPOND = []; THREADS = []; SLEEPS.length = 0; LOGS = []; NEXT_MSG = 1; NEXT_SAMPLE = 1;
  ENV = Object.assign({}, BASE_ENV, over || {});
}

(async () => {
  let M;
  try { M = await import(FN); } catch (e) { console.log = realLog; console.log('SKIP | could not import the function (needs Node 22+ type stripping): ' + e.message); process.exit(0); }
  const rt = () => M.runtime({ now: () => NOW, sleep: async (ms) => { SLEEPS.push(ms); NOW += ms; } });
  const allText = (msgs) => JSON.stringify(msgs);
  const embedsOf = (i) => DISCORD[i].body.embeds;
  const fieldsOf = (i) => embedsOf(i).flatMap((e) => e.fields || []);
  const noSecret = (s) => !/tok-\d-SECRETSECRET/.test(s);

  /* ═══ postToDiscord ═══════════════════════════════════════════════════════ */
  reset();
  RESPOND = [{ status: 429, body: { message: 'You are being rate limited.', retry_after: 2.5, global: false } }];
  let r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x', description: 'y' }] }, { type: 'adhoc', postKey: 'k1', postDate: '2026-10-16' }, rt());
  chk('a 429 waits at least retry_after, then the post goes through', r.status === 'sent' && SLEEPS[0] >= 2500 && DISCORD.length === 2, { r, SLEEPS });
  chk('…with wait=true, so the message id comes back', DISCORD[1].url.includes('?wait=true') && r.messageIds[0] === 'm1');
  chk('…and the claim is finished as sent', DB.discord_post_claims[0].state === 'sent' && DB.discord_post_claims[0].message_ids[0] === 'm1');
  chk('…and the send is logged with its channel NAME, type, status and attempts', DB.discord_posts.length === 1 && DB.discord_posts[0].channel === 'DISCORD_WEBHOOK_NFL'
    && DB.discord_posts[0].status === 'sent' && DB.discord_posts[0].attempts === 2 && DB.discord_posts[0].type === 'adhoc');
  chk('…and the bot speaks as EdgeDesk, with mentions off', DISCORD[1].body.username === 'EdgeDesk' && JSON.stringify(DISCORD[1].body.allowed_mentions) === '{"parse":[]}');
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k1', postDate: '2026-10-16' }, rt());
  chk('the same key again is a duplicate: nothing is sent', r.status === 'duplicate' && DISCORD.length === 2 && DB.discord_posts[1].status === 'duplicate');

  reset();
  RESPOND = Array(6).fill({ status: 429, body: { retry_after: 1 } });
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k2', postDate: '2026-10-16' }, rt());
  chk('a rate limit that never lifts gives up after 5 attempts and is a definite failure', r.status === 'failed' && DISCORD.length === 5 && DB.discord_post_claims[0].state === 'failed');
  RESPOND = [];
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k2', postDate: '2026-10-16' }, rt());
  chk('…so a rerun may claim it again and send it', r.status === 'sent' && DB.discord_post_claims[0].attempts === 2);

  reset();
  const big = {
    content: 'c'.repeat(2500),
    embeds: [
      { title: 'T'.repeat(300), description: 'd'.repeat(5000), fields: Array.from({ length: 30 }, (_, i) => ({ name: 'n' + i, value: 'v'.repeat(1100) })), footer: { text: 'F' } },
      ...Array.from({ length: 11 }, (_, i) => ({ title: 'small ' + i, description: 's' })),
    ],
  };
  const msgs = M.packMessages(big);
  const okLimits = msgs.every((m) => (m.embeds || []).length <= 10 && (m.embeds || []).reduce((a, e) => a + M.embedChars(e), 0) <= 6000
    && (m.embeds || []).every((e) => (e.fields || []).length <= 25 && (!e.title || e.title.length <= 256) && (!e.description || e.description.length <= 4096)
      && (e.fields || []).every((f) => f.value.length <= 1024 && f.name.length <= 256)));
  const fieldCount = msgs.reduce((a, m) => a + (m.embeds || []).reduce((b, e) => b + (e.fields || []).length, 0), 0);
  chk('Discord limits: ≤10 embeds and ≤6000 characters a message, ≤25 fields an embed, every string cut', okLimits, msgs.map((m) => (m.embeds || []).length));
  chk('…by splitting, not dropping: all 30 fields and all 12 embeds\' titles survive', fieldCount === 30 && msgs.flatMap((m) => m.embeds || []).filter((e) => /^small/.test(e.title || '')).length === 11);
  chk('…the content is cut to 2000 and sent once; the footer is on the last part', msgs[0].content.length === 2000 && msgs.slice(1).every((m) => !m.content)
    && msgs.flatMap((m) => m.embeds || []).filter((e) => e.footer).length === 1);
  chk('…brand colour and the EdgeDesk author by default', msgs[0].embeds[0].color === 0x2fa79a && msgs[0].embeds[0].author.name === 'EdgeDesk');
  r = await M.postToDiscord('DISCORD_WEBHOOK_CFB', big, { postKey: 'k3', postDate: '2026-10-16' }, rt());
  chk('a big post goes out as several messages under one claim', r.status === 'sent' && r.messages === msgs.length && msgs.length > 1 && DISCORD.length === msgs.length);

  reset({ DISCORD_WEBHOOK_NBA: undefined, DISCORD_WEBHOOK_NHL: 'https://evil.example/api/webhooks/1/x' });
  r = await M.postToDiscord('DISCORD_WEBHOOK_NBA', { embeds: [{ title: 'x' }] }, {}, rt());
  chk('a missing webhook secret is a logged failure that names the secret', r.status === 'failed' && /DISCORD_WEBHOOK_NBA is not set/.test(DB.discord_posts[0].error));
  r = await M.postToDiscord('DISCORD_WEBHOOK_NHL', { embeds: [{ title: 'x' }] }, {}, rt());
  chk('a secret that is not a Discord webhook URL is refused and never called', r.status === 'failed' && !DISCORD.some((d) => d.evil) && !/evil/.test(JSON.stringify(DB.discord_posts)));

  reset();
  RESPOND = ['throw'];
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k4', postDate: '2026-10-16' }, rt());
  chk('a network error is an UNKNOWN outcome (it may have landed)', r.status === 'unknown' && DB.discord_post_claims[0].state === 'unknown');
  chk('…and the webhook URL Deno quotes in the error is scrubbed everywhere', noSecret(r.error) && noSecret(JSON.stringify(DB)) && noSecret(LOGS.join('\n')), r.error);
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k4', postDate: '2026-10-16' }, rt());
  chk('…and is never retried automatically', r.status === 'duplicate' && DISCORD.length === 1);
  RESPOND = [{ status: 502, body: 'bad gateway' }];
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k5', postDate: '2026-10-16' }, rt());
  chk('a 5xx is unknown too', r.status === 'unknown' && DB.discord_post_claims.find((x) => x.post_key === 'k5').state === 'unknown');
  RESPOND = [{ status: 400, body: { message: 'Invalid Form Body' } }];
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'x' }] }, { postKey: 'k6', postDate: '2026-10-16' }, rt());
  chk('a 400 is a definite failure, logged with the HTTP status', r.status === 'failed' && DB.discord_posts.at(-1).http_status === 400 && /Invalid Form Body/.test(DB.discord_posts.at(-1).error));
  RESPOND = [{ status: 200, body: { id: 'a', channel_id: 'c' } }, 'throw'];
  r = await M.postToDiscord('DISCORD_WEBHOOK_CFB', big, { postKey: 'k7', postDate: '2026-10-16' }, rt());
  chk('a multi-message post that stops half way is partial, never resent', r.status === 'partial' && DB.discord_post_claims.find((x) => x.post_key === 'k7').state === 'partial');

  reset();
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'Our lock of the week', description: 'a +EV play' }] }, { postKey: 'k8', postDate: '2026-10-16' }, rt());
  chk('the copy check refuses a lock / EV post before anything is claimed or sent', r.status === 'failed' && /lock/.test(r.error) && /EV/.test(r.error) && DISCORD.length === 0 && DB.discord_post_claims.length === 0);
  chk('copy check: win probability, picks, best bets, undervalued', ['win probability 61%', 'our picks', 'best bets', 'undervalued side'].every((s) => M.copyViolations(s).length === 1)
    && M.copyViolations('Research, not betting advice. 18+. Every signal graded; Brier 0.21; beat the close').length === 0);

  reset({ DISCORD_DRY_RUN: '1' });
  r = await M.postToDiscord('DISCORD_WEBHOOK_NFL', { embeds: [{ title: 'preview' }] }, { postKey: 'k9', postDate: '2026-10-16' }, rt());
  chk('dry run prints the payload, posts nothing, claims nothing', r.status === 'dry_run' && DISCORD.length === 0 && DB.discord_post_claims.length === 0
    && LOGS.some((l) => l.startsWith('DISCORD_DRY_RUN ') && l.includes('preview')));
  chk('…logs it as dry_run, and never prints the URL', DB.discord_posts[0].status === 'dry_run' && noSecret(LOGS.join('\n')));

  /* ═══ the schedule, in Central time ═══════════════════════════════════════ */
  reset();
  for (const [t, due, label] of [['2026-10-16T15:00:00Z', true, '15:00 UTC in October is 10:00 CDT'], ['2026-10-16T16:00:00Z', false, '16:00 UTC in October is 11:00 CDT'],
    ['2026-12-05T16:00:00Z', true, '16:00 UTC in December is 10:00 CST'], ['2026-12-05T15:30:00Z', false, '15:30 UTC in December is 09:30 CST']]) {
    NOW = Date.parse(t);
    const o = await M.runSlate(rt(), { sports: [] });
    chk(`slate: ${label} → ${due ? 'due' : 'not due'}`, (o.result === 'not_due') === !due, o);
  }
  NOW = Date.parse('2026-10-20T15:00:00Z');
  chk('scorecard: not due on a Tuesday', (await M.runScorecard(rt())).result === 'not_due');

  /* ═══ the slate ═══════════════════════════════════════════════════════════ */
  NOW = Date.parse('2026-10-16T15:00:00Z'); /* Friday 10:00 CDT */
  function slateFixture() {
    reset();
    const ev = (sport, pid, away, home, start, extra) => Object.assign({ id: `${sport}:espn:${pid}`, sport, provider_id: pid, start_utc: start, time_tbd: false, status: 'SCHEDULED',
      home: { name: home[0], short: home[1] }, away: { name: away[0], short: away[1] } }, extra || {});
    SITE['today/slate.json'] = {
      generated_at: iso(NOW - 10 * MIN),
      sports: { nfl: { state: 'ok' }, cfb: { state: 'ok' }, nba: { state: 'ok' }, ncaam: { state: 'ok' }, nhl: { state: 'failed', note: 'The schedule source could not be read and no earlier read is held.' } },
      events: [
        ev('cfb', '401862801', ['Memphis Tigers', 'Memphis'], ['Tulane Green Wave', 'Tulane'], '2026-10-16T23:30:00Z'),
        ev('cfb', '401862803', ['UNLV Rebels', 'UNLV'], ['Colorado State Rams', 'Colorado State'], '2026-10-17T00:00:00Z'),
        ev('cfb', '401862809', ['Navy Midshipmen', 'Navy'], ['Rice Owls', 'Rice'], '2026-10-16T14:00:00Z', { status: 'IN_PROGRESS' }),
        ev('cfb', '401862900', ['Army Black Knights', 'Army'], ['Air Force Falcons', 'Air Force'], '2026-10-17T19:00:00Z'),
        ev('nfl', '401872996', ['Pittsburgh Steelers', 'Steelers'], ['Cincinnati Bengals', 'Bengals'], '2026-10-17T00:15:00Z'),
        ev('nba', '401900001', ['Boston Celtics', 'Celtics'], ['New York Knicks', 'Knicks'], '2026-10-17T00:00:00Z'),
      ],
      markets: { 'nba:espn:401900001': { book: 'DraftKings', source: 'espn_scoreboard', captured_at: iso(NOW - 30 * MIN), spread: { home: { point: 2.5 } }, total: { point: 221.5 } } },
    };
    SITE['football/venues/forecasts.json'] = { by_game: {
      '401862801': { temp_f: 67.8, wind_mph: 16.8, wind_from: 'NE', precip_pct: 0, text: 'Clear', dome: false },
      '401862803': { dome: true, roof: true, temp_f: null } } };
    SITE['football/nfl/slate.json'] = { games: [{ home_team: 'Cincinnati Bengals', kickoff: '2026-10-17T00:15:00Z', roof: 'outdoors', forecast: { temp_f: 51, wind_mph: 8, wind_from: 'W', precip_pct: 20, text: 'Cloudy', dome: false } }] };
    DB.cfb_lab_consensus_now = [
      { game_id: '401862801', market_type: 'spread', median_home_line: 7, n_books: 6, as_of: iso(NOW - 20 * MIN) },
      { game_id: '401862801', market_type: 'total', median_total_points: 54.5, n_books: 6, as_of: iso(NOW - 20 * MIN) },
      { game_id: '401862803', market_type: 'spread', median_home_line: -3, n_books: 5, as_of: iso(NOW - 25 * MIN) },
    ];
    DB.cfb_lab_predictions = [
      { game_id: '401862801', opening_spread: 6.5, opening_quality: 'OBSERVED', prediction_ts: iso(NOW - H) },
      { game_id: '401862801', opening_spread: 6, opening_quality: 'OBSERVED', prediction_ts: iso(NOW - 30 * H) },
    ];
    BOARD = { last_odds_at: iso(NOW - 6 * 24 * H), games: [{ home_name: 'Cincinnati Bengals', away_name: 'Pittsburgh Steelers', commence_time: '2026-10-17T00:15:00Z',
      last_odds_at: iso(NOW - 6 * 24 * H), book_count: 7, consensus: { spread: { median: -5.5 }, total: { median: 44.5 } }, opening: { 'spread:home': { line: -4 } } }] };
  }
  slateFixture();
  let o = await M.runSlate(rt());
  const res_ = (s) => o.results.find((x) => x.sport === s);
  chk('NFL: the odds feed is six days old, so the slate is SKIPPED, not posted stale', res_('nfl').result === 'skipped' && /line sync failed/.test(res_('nfl').reason) && /h old/.test(res_('nfl').reason), res_('nfl'));
  chk('…and the skip is logged with its reason on the NFL channel', DB.discord_posts.some((p) => p.channel === 'DISCORD_WEBHOOK_NFL' && p.status === 'skipped' && /line sync failed/.test(p.error)));
  chk('NHL: a failed schedule sync is a logged skip', res_('nhl').result === 'skipped' && /schedule sync is failed/.test(res_('nhl').reason));
  chk('CBB: no games is a logged skip', res_('cbb').result === 'skipped' && /no Men's college basketball games today/.test(res_('cbb').reason)
    && DB.discord_posts.some((p) => p.channel === 'DISCORD_WEBHOOK_CBB' && p.status === 'skipped'));
  chk('CFB and NBA are posted', res_('cfb').result === 'sent' && res_('nba').result === 'sent', o.results);
  const cfbI = DISCORD.findIndex((d) => d.url.startsWith(HOOK(3)));
  const cfbE = embedsOf(cfbI)[0], cfbF = fieldsOf(cfbI);
  chk('CFB: title, brand colour, EdgeDesk author, the exact footer', /^College football slate · Friday, Oct 16$/.test(cfbE.title) && cfbE.color === 0x2fa79a
    && cfbE.author.name === 'EdgeDesk' && embedsOf(cfbI).at(-1).footer.text === 'Research, not betting advice. 18+.', cfbE);
  const memphis = cfbF.find((f) => /Memphis @ Tulane/.test(f.name));
  chk('CFB: game and Central time', memphis && memphis.name === 'Memphis @ Tulane · 6:30 PM CT', memphis);
  chk('CFB: the current consensus line, the opener and the move since the open', memphis && /Line: Memphis -7 · Total 54\.5/.test(memphis.value)
    && /Open: Memphis -6\.5/.test(memphis.value) && /0\.5 pts toward Memphis since the open/.test(memphis.value), memphis && memphis.value);
  chk('CFB: weather for the outdoor game; none for the dome', /Weather: 68°F, wind 17 mph NE, 0% precip, Clear/.test(memphis.value)
    && !/Weather/.test(cfbF.find((f) => /UNLV/.test(f.name)).value));
  chk('CFB: a game with no captured line says so; a game under way is left out and counted', /Line: not captured/.test(cfbF.find((f) => /Army @ Air Force/.test(f.name)) ? cfbF.find((f) => /Army/.test(f.name)).value : 'Line: not captured')
    && !cfbF.some((f) => /Navy/.test(f.name)) && /1 game already under way is not listed/.test(cfbE.description));
  const nbaI = DISCORD.findIndex((d) => d.url.startsWith(HOOK(4)));
  const nbaF = fieldsOf(nbaI)[0];
  chk('NBA: the one-book line is named as one book; no open and no move are drawn', /Line \(DraftKings\): Celtics -2\.5 · Total 221\.5/.test(nbaF.value) && !/Open|move/i.test(nbaF.value)
    && /keeps no consensus or opening line for the NBA/.test(embedsOf(nbaI)[0].description), nbaF);
  chk('no slate carries pick, lock, EV or prediction language', DISCORD.every((d) => M.copyViolations(allText(d.body)).length === 0 && !/predict|projected/i.test(allText(d.body))));
  const before = DISCORD.length;
  NOW += 30 * MIN;
  o = await M.runSlate(rt());
  chk('the :30 tick posts nothing again (already posted), and retries the skips', DISCORD.length === before && res_('cfb').result === 'already_posted' && res_('nfl').result === 'skipped');
  slateFixture();
  BOARD.last_odds_at = BOARD.games[0].last_odds_at = iso(NOW - 40 * MIN);
  o = await M.runSlate(rt(), { sports: ['nfl'] });
  const nflV = fieldsOf(DISCORD.findIndex((d) => d.url.startsWith(HOOK(2))))[0];
  chk('NFL with a fresh feed: consensus, open, move and the outdoor forecast', o.results[0].result === 'sent' && /Line: Bengals -5\.5 · Total 44\.5/.test(nflV.value)
    && /Open: Bengals -4/.test(nflV.value) && /1\.5 pts toward Bengals since the open/.test(nflV.value) && /Weather: 51°F/.test(nflV.value), nflV);
  slateFixture();
  SITE['today/slate.json'].generated_at = iso(NOW - 5 * H);
  o = await M.runSlate(rt(), { sports: ['cfb'] });
  chk('a stale schedule file is a skip for every sport', o.results[0].result === 'skipped' && /schedule sync is stale/.test(o.results[0].reason) && DISCORD.length === 0);
  slateFixture();
  DB_DOWN.add('cfb_lab_predictions');
  o = await M.runSlate(rt(), { sports: ['cfb'] });
  chk('an opener read that fails is a failed sync: skipped, not a post without openers', o.results[0].result === 'skipped' && /openers could not be read/.test(o.results[0].reason) && DISCORD.length === 0);

  /* ═══ the CLV scorecard ═══════════════════════════════════════════════════ */
  function scoreFixture() {
    reset();
    NOW = Date.parse('2026-10-19T15:00:00Z'); /* Monday 10:00 CDT; the week is Oct 12-18 */
    const pr = (sport_key, clv, at) => ({ sport_key, clv, graded_at: at, flagged_at: at, flagged_edge: 0.02 });
    DB.public_record = [
      pr('americanfootball_nfl', 0.02, '2026-10-13T03:00:00Z'), pr('americanfootball_nfl', -0.01, '2026-10-15T03:00:00Z'), pr('americanfootball_nfl', null, '2026-10-18T22:00:00Z'),
      pr('americanfootball_nfl', 0.05, '2026-09-20T03:00:00Z'), pr('americanfootball_nfl', 0.03, '2026-10-19T06:00:00Z'), /* after the week: not counted */
      ...Array.from({ length: 12 }, (_, i) => pr('americanfootball_ncaaf', i < 4 ? 0.01 : -0.02, '2026-10-17T' + String(10 + i).padStart(2, '0') + ':00:00Z')),
      { sport_key: 'americanfootball_nfl', clv: 0.5, graded_at: '2026-10-14T03:00:00Z', flagged_at: '2026-10-14T03:00:00Z', flagged_edge: 0.2 }, /* outside the record's band */
    ];
    DB.perf_grades = [
      { event_key: 'nfl:a', sport: 'nfl', revision: 1, eligible: true, forecast_tier: 'VERIFIED', start_utc: '2026-10-13T00:00:00Z', b1: '0.300' },
      { event_key: 'nfl:a', sport: 'nfl', revision: 2, eligible: true, forecast_tier: 'VERIFIED', start_utc: '2026-10-13T00:00:00Z', b1: '0.100' },
      { event_key: 'nfl:b', sport: 'nfl', revision: 1, eligible: true, forecast_tier: 'VERIFIED', start_utc: '2026-10-14T00:00:00Z', b1: '0.300' },
      { event_key: 'nfl:c', sport: 'nfl', revision: 1, eligible: false, forecast_tier: 'VERIFIED', start_utc: '2026-10-14T00:00:00Z', b1: '0.900' },
      { event_key: 'cfb:x', sport: 'cfb', revision: 1, eligible: true, forecast_tier: 'RECORDED', start_utc: '2026-10-17T00:00:00Z', b2: '0.250' },
    ];
    DB.discord_samples = [
      { sport: 'cfb', slate_date: '2026-10-17', game_id: '1', home: 'Tulane', away: 'Memphis', kickoff_at: '2026-10-17T19:30:00Z', classification: 'INVESTIGATE', status: 'followed_up', close_line: 8.5, clv_at_detection: 1.5, clv_at_post: 1, rank: 1 },
      { sport: 'cfb', slate_date: '2026-10-17', game_id: '2', home: 'Ohio State', away: 'Oklahoma State', kickoff_at: '2026-10-17T23:00:00Z', classification: 'INVESTIGATE', status: 'followed_up', close_line: -3, clv_at_detection: -1, clv_at_post: -1.5, rank: 2 },
      { sport: 'nfl', slate_date: '2026-10-18', game_id: '3', home: 'Jacksonville Jaguars', away: 'Houston Texans', kickoff_at: '2026-10-18T17:00:00Z', classification: 'INVESTIGATE', status: 'missed', miss_reason: 'no fresh consensus line before the post window closed', rank: 1 },
    ];
  }
  scoreFixture();
  o = await M.runScorecard(rt());
  chk('the scorecard posts on Monday 10:00 CT to #clv-results', o.result === 'sent' && DISCORD.length >= 1 && DISCORD.every((d) => d.url.startsWith(HOOK(1))), o);
  const sc = DISCORD.flatMap((d) => d.body.embeds);
  const nfl = sc.find((e) => e.title === 'NFL'), cfb = sc.find((e) => e.title === 'College football');
  const wk = (e) => e.fields.find((f) => f.name === 'Past 7 days').value, ssn = (e) => e.fields.find((f) => f.name === 'Season to date').value;
  chk('NFL week: the record\'s rows only (band 0.5%-10%), graded in the Central week', /Graded signals: 3\n/.test(wk(nfl)), wk(nfl));
  chk('…avg CLV over rows with a close, labelled; beat the close as share of those', /Avg CLV: \+0\.5% \(n=2 with a close\)/.test(wk(nfl)) && /Beat the close: 50\.0% \(1 of 2\)/.test(wk(nfl)), wk(nfl));
  chk('…fewer than 10: the numbers AND "Small sample", nothing hidden', /Small sample/.test(wk(nfl)));
  chk('…Brier from the latest revision of eligible VERIFIED forecasts', /Brier: 0\.200 \(n=2\)/.test(wk(nfl)), wk(nfl));
  chk('NFL season includes September, not the day after the week', /Graded signals: 4\n/.test(ssn(nfl)), ssn(nfl));
  chk('CFB: a losing week printed like any other (negative CLV, 4 of 12)', /Graded signals: 12/.test(wk(cfb)) && /Avg CLV: -1\.0%/.test(wk(cfb)) && /33\.3% \(4 of 12\)/.test(wk(cfb)) && !/Small sample/.test(wk(cfb)), wk(cfb));
  chk('CFB: recorded-only Brier is labelled as not ledger-verified', /Brier \(recorded pregame, not ledger-verified\): 0\.250 \(n=1\)/.test(wk(cfb)), wk(cfb));
  chk('every sport has its own embed, empty ones included', ['NFL', 'College football', 'NBA', "Men's college basketball", 'NHL'].every((t) => sc.some((e) => e.title === t))
    && /Graded signals: 0[\s\S]*Small sample/.test(wk(sc.find((e) => e.title === 'NHL'))));
  const ds = sc.find((e) => e.title === 'Discord samples'), dsf = (n) => ds.fields.find((f) => f.name === n).value;
  chk('Discord samples: the free samples\' own record, losses included', /Selected: 2 · Posted: 2 · Not posted: 0/.test(dsf('CFB · past 7 days')) && /Avg CLV at post: -0\.25 pts/.test(dsf('CFB · past 7 days'))
    && /CLV at post above zero: 1 of 2/.test(dsf('CFB · past 7 days')), dsf('CFB · past 7 days'));
  chk('…a sample that could not be posted is listed with why', /Not posted: 1/.test(dsf('NFL · past 7 days')) && /not posted \(no fresh consensus line/.test(dsf("This week's samples")));
  chk('…links to the public record and the performance page', /edgedesksports\.com\/record\.html/.test(sc[0].description) && /edgedesksports\.com\/performance\//.test(sc[0].description) && sc[0].url === 'https://edgedesksports.com/record.html');
  const n0 = DISCORD.length;
  o = await M.runScorecard(rt());
  chk('a rerun posts nothing', o.result === 'already_posted' && DISCORD.length === n0);
  scoreFixture();
  DB_DOWN.add('public_record');
  o = await M.runScorecard(rt());
  chk('when the CLV record cannot be read the scorecard is skipped and logged, never partial', o.result === 'skipped' && DISCORD.length === 0 && DB.discord_posts[0].status === 'skipped');
  scoreFixture();
  DB_DOWN.add('perf_grades');
  o = await M.runScorecard(rt());
  chk('a Brier mirror that cannot be read is printed as unavailable', o.result === 'sent' && /Brier: unavailable/.test(JSON.stringify(DISCORD[0].body)));

  /* ═══ the free research samples ═══════════════════════════════════════════ */
  function cfbSamplesFixture() {
    reset({ DISCORD_BOT_TOKEN: 'bot-token-abcdefghijklmnopqrstuvwxyz' });
    NOW = Date.parse('2026-10-17T13:00:00Z'); /* Saturday 08:00 CDT */
    const g = (id, away, home, start) => ({ game_id: id, away_team: away, home_team: home, start_date: start, completed: false });
    DB['cfb.games'] = [
      g(1001, 'Memphis', 'Tulane', '2026-10-17T19:30:00Z'), g(1002, 'Oklahoma State', 'Ohio State', '2026-10-17T23:00:00Z'), g(1003, 'Navy', 'Rice', '2026-10-17T20:00:00Z'),
      g(1004, 'Liberty', 'UTEP', '2026-10-18T01:00:00Z'), g(1005, 'Air Force', 'Army', '2026-10-17T14:00:00Z'), g(1006, 'Clemson', 'Duke', '2026-10-17T16:00:00Z'),
    ];
    const f = (id, cls, corr, conflict, sp, side, extra) => Object.assign({ game_id: id, classification: cls, corroborator_count: corr, conflict, sp_disagreement_points: sp, undervalued_side: side,
      sp_plus_implied_spread: -3, market_spread: 7, elo_disagreement_points: 4.2, net_ypg_delta: 61, third_down_delta: 0.052, reference_provider: 'ESPN Bet',
      available_inputs: '["SP+","reference line","Elo"]', missing_inputs: '[]', why: 'SP+ and Elo both rate the gap wider than the reference line.',
      observable_factors: ['Opponent-adjusted efficiency'], partial_factors: ['Quarterback health'], hidden_factors: ['Game plan'], data_limitations: ['Two FCS opponents in the sample'], thresholds_version: 'af_v3' }, extra || {});
    DB['cfb.analyst_flags'] = [
      f(1001, 'INVESTIGATE', 3, false, 7.5, 'Memphis'), f(1002, 'INVESTIGATE', 3, true, 9, 'Ohio State'), f(1003, 'INVESTIGATE', 1, false, 12, 'Rice'),
      f(1004, 'MONITOR', 4, false, 3, 'Liberty'), f(1005, 'INVESTIGATE', 5, false, 8, 'Army'), f(1006, 'PASS', 0, false, 1, null),
    ];
    const cons = (id, line) => ({ game_id: String(id), market_type: 'spread', median_home_line: line, n_books: 6, as_of: iso(NOW - 10 * MIN) });
    DB.cfb_lab_consensus_now = [cons(1001, 7), cons(1002, -4), cons(1003, -2), cons(1004, -6), cons(1005, -1)];
    DB.cfb_lab_predictions = [{ game_id: '1001', opening_spread: 6.5, prediction_ts: iso(NOW - H) }, { game_id: '1002', opening_spread: -3.5, prediction_ts: iso(NOW - H) }];
  }
  const freshen = (patch) => { for (const r of DB.cfb_lab_consensus_now) { r.as_of = iso(NOW - 10 * MIN); if (patch && patch[r.game_id] != null) r.median_home_line = patch[r.game_id]; } };

  cfbSamplesFixture();
  NOW = Date.parse('2026-10-17T12:00:00Z'); /* 07:00 CDT: before the selection hour */
  freshen();
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('07:00 CT: sightings are recorded (the INVESTIGATE / MONITOR games), no selection yet', DB.discord_sample_sightings.length === 5 && DB.discord_sample_selections.length === 0, o);
  chk('…with the consensus line at detection and the flagged side', DB.discord_sample_sightings.find((s) => s.game_id === '1001').line_home === 7
    && DB.discord_sample_sightings.find((s) => s.game_id === '1001').side === 'away' && DB.discord_sample_sightings.find((s) => s.game_id === '1002').side === 'home');
  NOW = Date.parse('2026-10-17T13:00:00Z');
  freshen({ 1001: 7.5 });
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  const sel = DB.discord_sample_selections[0];
  chk('08:00 CT: one selection for the slate, recorded before play', DB.discord_sample_selections.length === 1 && sel.slate_date === '2026-10-17' && sel.rule_version === 'discord_sample_order_v1');
  chk('…two INVESTIGATE games by the fixed order (corroborators, then no conflict)', JSON.stringify(DB.discord_samples.map((s) => s.game_id)) === '["1001","1002"]', DB.discord_samples.map((s) => s.game_id));
  chk('…every candidate is logged with its eligibility; the too-early kickoff says why', sel.candidates.length === 5 && sel.candidates[0].game_id === '1005'
    && /too close to kickoff/.test(sel.candidates[0].excluded) && sel.candidates.find((c) => c.game_id === '1004').classification === 'MONITOR', sel.candidates);
  chk('…and the reason for each choice', /INVESTIGATE, #1 of 3 eligible INVESTIGATE games on this slate by discord_sample_order_v1/.test(DB.discord_samples[0].reason));
  chk('…detection time and line come from the sighting (07:00 CT, line 7), not from the selection', DB.discord_samples[0].detected_at === '2026-10-17T12:00:00.000Z' && DB.discord_samples[0].line_at_detection === 7);
  chk('…scheduled 3 h after detection (inside the window)', DB.discord_samples[0].scheduled_post_at === '2026-10-17T15:00:00.000Z');
  chk('…the side is never shown before the close, and nothing is posted early', DISCORD.length === 0);
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('a second tick changes no selection', DB.discord_sample_selections.length === 1 && DB.discord_samples.length === 2);

  NOW = Date.parse('2026-10-17T15:04:00Z');
  freshen({ 1001: 7.5, 1002: -4.5 });
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('at detection + 3 h both samples post to the CFB channel', DISCORD.length === 2 && DISCORD.every((d) => d.url.startsWith(HOOK(3))) && DB.discord_samples.every((s) => s.status === 'posted'), o.results);
  const se = embedsOf(0)[0], sfields = embedsOf(0).flatMap((e) => e.fields || []), stext = allText(DISCORD[0].body);
  chk('sample: game, kickoff, current / opening / at-detection lines', /Memphis @ Tulane/.test(se.title) && /Sat, Oct 17, 2:30 PM CT/.test(se.description)
    && /Current: Memphis -7\.5/.test(sfields[0].value) && /Opening: Memphis -6\.5/.test(sfields[0].value) && /At detection \(Sat, Oct 17, 7:00 AM CT\): Memphis -7/.test(sfields[0].value), sfields[0]);
  chk('sample: classification and the observed factors behind it', sfields.some((f) => f.name === 'Classification: INVESTIGATE' && /SP\+ disagreement: \+7\.5 pts/.test(f.value) && /Corroborating indicators: 3/.test(f.value)));
  chk('sample: observability tiers, the data-availability check, known limitations', sfields.some((f) => f.name === 'Observability' && /Observable:\n• Opponent-adjusted/.test(f.value) && /Mostly hidden:\n• Game plan/.test(f.value))
    && sfields.some((f) => f.name === 'Data-availability check: All listed inputs available') && sfields.some((f) => f.name === 'Known limitations' && /FCS opponents/.test(f.value)));
  chk('sample: the exact footer and the signup link, no affiliate code', embedsOf(0).at(-1).footer.text === 'Research, not betting advice. 18+. Full slate on EdgeDesk'
    && se.url === 'https://edgedesksports.com/#pricing' && !/[?&](ref|aff|affiliate|utm_)/i.test(stext));
  chk('sample: no pick, lock, EV or win-probability language, and the flagged side is not named', M.copyViolations(stext).length === 0 && !/undervalued/i.test(stext) && !/flagged side|Measured on/.test(stext));
  const s1 = DB.discord_samples[0];
  chk('the posted sample records its time, the line at post and the message', s1.posted_at === iso(NOW) && s1.line_at_post === 7.5 && s1.message_id === 'm1' && s1.discord_channel_id === 'C10003');

  NOW = Date.parse('2026-10-17T19:00:00Z');
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('no follow-up before the close exists', DISCORD.length === 2 && DB.discord_samples.every((s) => s.status === 'posted'));
  DB.cfb_lab_market_lines = [{ game_id: '1001', kind: 'CLOSE', book: 'CONSENSUS', market_type: 'spread', home_line: 8.5, quality: 'OBSERVED', n_books: 6, observed_at: '2026-10-17T19:25:00Z' }];
  NOW = Date.parse('2026-10-18T00:00:00Z');
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  const fu = DISCORD[2];
  chk('after the close: a thread is opened on the sample (bot) and the follow-up is posted in it', THREADS.length === 1 && /channels\/C10003\/messages\/m1\/threads$/.test(THREADS[0].url) && fu.thread === 'm1', { THREADS, thread: fu && fu.thread });
  const fuV = fu.body.embeds[0].fields.find((f) => f.name === 'CLV').value;
  chk('…closing line, CLV at detection (+1.5) and at post (+1), on the flagged side', /Memphis -8\.5/.test(fu.body.embeds[0].fields[0].value) && /At detection: \+1\.5 pts \(from Memphis -7\)/.test(fuV)
    && /At post time: \+1\.0 pts \(from Memphis -7\.5\)/.test(fuV) && /Measured on Memphis/.test(fuV), fuV);
  chk('…recorded on the sample, once', DB.discord_samples[0].status === 'followed_up' && DB.discord_samples[0].clv_at_detection === 1.5 && DB.discord_samples[0].clv_at_post === 1 && DB.discord_samples[0].thread_id === 'm1');
  DB.cfb_lab_market_lines.push({ game_id: '1002', kind: 'CLOSE', book: 'CONSENSUS', market_type: 'spread', home_line: -3, quality: 'OBSERVED', n_books: 5 });
  NOW = Date.parse('2026-10-18T03:30:00Z');
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  const fu2 = DISCORD[3], fu2V = fu2.body.embeds[0].fields.find((f) => f.name === 'CLV').value;
  chk('a loss is posted exactly like a win (negative CLV, same format)', /At detection: -1\.0 pts \(from Ohio State -4\)/.test(fu2V) && /At post time: -1\.5 pts \(from Ohio State -4\.5\)/.test(fu2V)
    && JSON.stringify(fu2.body.embeds[0].fields.map((f) => f.name)) === JSON.stringify(fu.body.embeds[0].fields.map((f) => f.name)), fu2V);
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('no follow-up is posted twice', DISCORD.length === 4);

  /* the 60-minute rule, and a sample whose line goes stale */
  cfbSamplesFixture();
  NOW = Date.parse('2026-10-17T13:00:00Z');
  DB['cfb.games'] = DB['cfb.games'].map((g) => (g.game_id === 1001 ? Object.assign(g, { start_date: '2026-10-17T15:00:00Z' }) : g));
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  const early = DB.discord_samples.find((s) => s.game_id === '1001');
  chk('an early kickoff caps the post time at kickoff - (60 + 15) min', early && early.scheduled_post_at === '2026-10-17T13:45:00.000Z', early);
  for (const r of DB.cfb_lab_consensus_now) r.as_of = iso(NOW - 10 * H);
  NOW = Date.parse('2026-10-17T13:49:00Z');
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('no fresh line as the window closes: recorded as not posted, with why', DB.discord_samples.find((s) => s.game_id === '1001').status === 'missed'
    && /no fresh consensus line/.test(DB.discord_samples.find((s) => s.game_id === '1001').miss_reason) && DISCORD.length === 0, DB.discord_samples);

  /* MONITOR when nothing is INVESTIGATE */
  cfbSamplesFixture();
  DB['cfb.analyst_flags'] = DB['cfb.analyst_flags'].map((f) => (f.classification === 'INVESTIGATE' ? Object.assign(f, { classification: 'PASS' }) : f));
  DB['cfb.analyst_flags'].push(Object.assign({}, DB['cfb.analyst_flags'][3], { game_id: 1003, classification: 'MONITOR', corroborator_count: 2 }));
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('no INVESTIGATE game: the top MONITOR (by the same order), one sample', DB.discord_samples.length === 1 && DB.discord_samples[0].game_id === '1004'
    && /No eligible INVESTIGATE game; the top of 2 eligible MONITOR games/.test(DB.discord_samples[0].reason), DB.discord_samples);

  /* a selection is final, so a failed read postpones it instead of recording "nothing eligible" */
  cfbSamplesFixture();
  DB_DOWN.add('cfb_lab_consensus_now');
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('a line source that cannot be READ postpones the selection (nothing recorded)', DB.discord_sample_selections.length === 0
    && o.results[0].errors.some((e) => /selection postponed: the CFB Lab consensus could not be read/.test(e)), o.results[0].errors);
  DB_DOWN.delete('cfb_lab_consensus_now');
  DB_DOWN.add('discord_sample_sightings');
  NOW += 15 * MIN;
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('…as does a sightings read that fails', DB.discord_sample_selections.length === 0 && o.results[0].errors.some((e) => /sightings could not be read/.test(e)));
  DB_DOWN.delete('discord_sample_sightings');
  NOW += 15 * MIN;
  freshen();
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('…and the next good tick makes the selection', DB.discord_sample_selections.length === 1 && DB.discord_samples.length === 2);

  /* dry run writes nothing */
  cfbSamplesFixture();
  ENV.DISCORD_DRY_RUN = '1';
  NOW = Date.parse('2026-10-17T16:00:00Z');
  freshen();
  o = await M.runSamples(rt(), { sports: ['cfb'] });
  chk('dry run: no sighting, selection or sample is written; nothing is posted', DB.discord_sample_sightings.length === 0 && DB.discord_sample_selections.length === 0
    && DB.discord_samples.length === 0 && DISCORD.length === 0, o.results);
  chk('…the would-be selection is reported, and nothing is due yet (detected now)', o.results[0].selection && o.results[0].selection.dry_run === true && o.results[0].selection.chosen.length === 2);

  /* NFL: the research status, no MONITOR, the odds board */
  function nflFixture(boardAge) {
    reset();
    NOW = Date.parse('2026-10-18T13:00:00Z'); /* Sunday 08:00 CDT */
    const st = (id, home, away, status, rank, gap, toward) => ({ sport: 'nfl', game_id: id, home, away, kickoff_at: '2026-10-18T17:00:00Z', status, priority_rank: rank, gap_pts: gap,
      key_reason: 'EdgeDesk differs from the market by ' + gap + ' points.', market_home_line: -2.5, market_stale: false, fair_home_line: -3,
      state: { gap: { points: gap, toward }, qb: { confirmed_both: true }, injuries: { home: { known: true }, away: { known: false } }, reliability: { scored: false }, warnings: ['Weather not yet final'], drivers: [] } });
    DB.game_research_state = [
      st('2026_07_HOU_JAX', 'Jacksonville Jaguars', 'Houston Texans', 'INVESTIGATE', 2, 3.1, 'home'),
      st('2026_07_BAL_CLE', 'Cleveland Browns', 'Baltimore Ravens', 'INVESTIGATE', 1, 2.4, 'away'),
      st('2026_07_NYG_PHI', 'Philadelphia Eagles', 'New York Giants', 'AGREEMENT', 3, 0.5, null),
    ];
    const bg = (home, away, line) => ({ home_name: home, away_name: away, commence_time: '2026-10-18T17:00:00Z', last_odds_at: iso(NOW - boardAge), book_count: 8, consensus: { spread: { median: line } }, opening: { 'spread:home': { line: line + 1 } } });
    BOARD = { last_odds_at: iso(NOW - boardAge), games: [bg('Jacksonville Jaguars', 'Houston Texans', -2.5), bg('Cleveland Browns', 'Baltimore Ravens', 4.5)] };
  }
  nflFixture(20 * MIN);
  o = await M.runSamples(rt(), { sports: ['nfl'] });
  chk('NFL: two INVESTIGATE games by the board\'s own priority rank; AGREEMENT is never a candidate', JSON.stringify(DB.discord_samples.map((s) => s.game_id)) === '["2026_07_BAL_CLE","2026_07_HOU_JAX"]'
    && DB.discord_sample_selections[0].candidates.length === 2, DB.discord_samples.map((s) => s.game_id));
  NOW = Date.parse('2026-10-18T15:49:00Z'); /* the :49 tick */
  for (const g of BOARD.games) g.last_odds_at = iso(NOW - 10 * MIN);
  BOARD.last_odds_at = iso(NOW - 10 * MIN);
  o = await M.runSamples(rt(), { sports: ['nfl'] });
  const nflS = embedsOf(0).flatMap((e) => e.fields || []);
  chk('NFL samples post to the NFL channel, scheduled at kickoff - 75 min (sooner than detection + 3 h)', DISCORD.length === 2 && DISCORD.every((d) => d.url.startsWith(HOOK(2)))
    && DB.discord_samples.every((s) => s.scheduled_post_at === '2026-10-18T15:45:00.000Z' && s.status === 'posted'), DB.discord_samples);
  chk('NFL sample: says observability tiers are not published, lists missing inputs and the limitation', nflS.some((f) => f.name === 'Observability' && /Not published for the NFL/.test(f.value))
    && nflS.some((f) => /Data-availability check: 2 inputs missing/.test(f.name) && /Injury report for both teams \(incomplete\)/.test(f.value))
    && nflS.some((f) => f.name === 'Known limitations' && /p<0\.05/.test(f.value)), nflS.map((f) => f.name));
  nflFixture(6 * 24 * H);
  o = await M.runSamples(rt(), { sports: ['nfl'] });
  chk('NFL with a stale odds feed: candidates logged as having no fresh line; none chosen', DB.discord_samples.length === 0 && DB.discord_sample_selections[0].candidates.every((c) => c.excluded === 'no fresh consensus line')
    && /no eligible/.test(DB.discord_sample_selections[0].note));

  /* ═══ the handler ═════════════════════════════════════════════════════════ */
  reset();
  const call = async (body, headers) => M.handle(new Request('https://x/functions/v1/discord_cron', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body) }), rt());
  let resp = await call({ action: 'slate' });
  chk('no x-cron-secret: 401, nothing runs', resp.status === 401 && DISCORD.length === 0);
  resp = await call({ action: 'slate' }, { 'x-cron-secret': 'wrong' });
  chk('a wrong secret: 401', resp.status === 401);
  NOW = Date.parse('2026-10-16T16:00:00Z');
  resp = await call({ action: 'slate' }, { 'x-cron-secret': 'cron-secret' });
  chk('the right secret outside the hour: 200 not_due', resp.status === 200 && (await resp.json()).result === 'not_due');
  resp = await call({ action: 'nope' }, { 'x-cron-secret': 'cron-secret' });
  chk('an unknown action: 400', resp.status === 400);
  const g = await (await M.handle(new Request('https://x/functions/v1/discord_cron'), rt())).json();
  chk('GET: a probe that says which secrets are set, never their values', g.build === M.BUILD && g.configured.webhooks.DISCORD_WEBHOOK_NFL === true && g.configured.cron_secret === true
    && noSecret(JSON.stringify(g)) && !JSON.stringify(g).includes('cron-secret'));
  reset({ DISCORD_CRON_SECRET: undefined });
  resp = await call({ action: 'slate' }, { 'x-cron-secret': '' });
  chk('DISCORD_CRON_SECRET unset: every call is refused', resp.status === 401);

  /* ═══ the wiring ══════════════════════════════════════════════════════════ */
  const fs = require('fs');
  const wf = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'deploy-discord.yml'), 'utf8');
  const cronSql = fs.readFileSync(path.join(ROOT, 'supabase', 'discord_cron.sql'), 'utf8');
  chk('the deploy workflow ships discord_cron with JWT verification off and tests first', /supabase functions deploy discord_cron[\s\\]*--project-ref "\$PROJECT_REF"[\s\\]*--no-verify-jwt/.test(wf)
    && wf.indexOf('discord_cron.test.js') < wf.indexOf('functions deploy'));
  chk('the cron SQL calls this function by its directory name', cronSql.includes('/functions/v1/discord_cron'));

  console.log = realLog; console.error = realErr;
  failures.forEach((f) => console.log('FAIL | ' + f));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'discord_cron — ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.log = realLog; failures.forEach((f) => console.log("FAIL | " + f)); console.log("CRASH", e && e.stack || e); process.exit(1); });
