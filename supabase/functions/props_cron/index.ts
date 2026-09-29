// ============================================================
//  FILE:    supabase/functions/props_cron/index.ts
//  TYPE:    Edge Function (deployed) — the Player Props price pipeline's
//           PRIMARY scheduler, and the page's "refresh prices now".
//  DEPLOY:  supabase functions deploy props_cron --no-verify-jwt
//           (pg_cron sends no JWT; Refresh and status check the reader's
//           session themselves — see supabase/player_props_cron.sql)
//  BUILD:   props_cron-2026-09-29-r2   (authoritative value: `export const BUILD` below)
//  CRON:    every 5 minutes (supabase/player_props_cron.sql)
// ============================================================
// WHY THIS EXISTS. On 2026-09-29 the Props page sat on "Sportsbook prices:
// STALE" for hours. The hourly Player props workflow had been fired by
// GitHub's scheduler twice in eight hours (08:42 and 15:59 UTC) — the same
// multi-hour gaps every scheduled workflow here has shown since 2026-09-13
// (supabase/functions/editorial_cron). A price whose whole value is that it
// is minutes old cannot be woken by a scheduler that skips hours.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO.
//
// It does NOT capture prices or build the board. That pipeline is
// football/props (capture → board → grade → commit) and it runs in
// .github/workflows/player-props.yml; a second capture here would be a second
// pipeline that disagrees with the first. It POKES that one pipeline:
//
//   pg_cron (5 min) ──► THIS ──► workflow_dispatch ──► player-props.yml
//   the page's Refresh ─► THIS ──► workflow_dispatch (force, this request)
//   github schedule ─────────────────────────────────► (backup)
//
// WHEN IT POKES (a tick). It reads player_props_pipeline_health, which the
// pipeline writes after every run (football/props/health_sync.js): each
// league's next_due_at is the earliest moment a game is owed a price check —
// its own cadence by hours to kickoff, or a failed game's back-off, never
// before a 429's Retry-After. It dispatches when one is due, when a reader's
// refresh is waiting, or — if the health record itself has gone quiet — on a
// fallback interval, so a broken health record can never silence the prices.
// It refuses to stampede: nothing is dispatched inside the debounce window of
// the last dispatch, and the workflow's concurrency group serializes runs.
//
// A REFRESH. A signed-in reader's POST {action: 'refresh', league}. The
// reader is verified against Supabase Auth (the token is never decoded
// here), then player_props_refresh_admit() admits it atomically under a
// per-reader and a global cool-down — a double click joins the refresh in
// flight, a script is told how long to wait. The run marks the request
// running and completed (or failed, with why), which the page polls with
// {action: 'status', id}.
//
// NO TOKEN IS NOT A SUCCESS. Without PROPS_GH_TOKEN (or EDITORIAL_GH_TOKEN)
// every poke answers 503 and says so.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY   platform
//   PROPS_GH_TOKEN        GitHub token, `actions:write` on the repository
//                         (falls back to EDITORIAL_GH_TOKEN)
//   PROPS_GH_REPO         defaults to dsrackler17/EdgeDeskSports
//   PROPS_WORKFLOW        defaults to player-props.yml
//   PROPS_REF             defaults to main
//   PROPS_DEBOUNCE_S      defaults to 240
//   PROPS_FALLBACK_MIN    defaults to 60: dispatch anyway when the health
//                         record has not moved for this long
//   PROPS_REFRESH_USER_COOLDOWN_S / _GLOBAL_COOLDOWN_S   300 / 120
// ============================================================

/* WHICH CODE IS ANSWERING. The GET health probe returns this, so the
   Intelligence doctor (tools/intelligence/deploy_doctor.js) can tell a
   deployment that is serving this file from one serving an older one, and
   deploy it when they differ. Bump it with every change to this file, or
   the change is never shipped on its own. */
export const BUILD = "props_cron-2026-09-29-r2";

function config() {
  return {
    url: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    anonKey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    ghToken: Deno.env.get('PROPS_GH_TOKEN') || Deno.env.get('EDITORIAL_GH_TOKEN') || '',
    ghRepo: Deno.env.get('PROPS_GH_REPO') ?? 'dsrackler17/EdgeDeskSports',
    workflow: Deno.env.get('PROPS_WORKFLOW') ?? 'player-props.yml',
    ref: Deno.env.get('PROPS_REF') ?? 'main',
    debounceSeconds: Number(Deno.env.get('PROPS_DEBOUNCE_S') ?? '240'),
    fallbackMinutes: Number(Deno.env.get('PROPS_FALLBACK_MIN') ?? '60'),
    userCooldown: Number(Deno.env.get('PROPS_REFRESH_USER_COOLDOWN_S') ?? '300'),
    globalCooldown: Number(Deno.env.get('PROPS_REFRESH_GLOBAL_COOLDOWN_S') ?? '120'),
  };
}
type Cfg = ReturnType<typeof config>;
const LEAGUES = ['nfl', 'cfb'];

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, apikey, content-type',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}

const sbFor = (c: Cfg) => (path: string, init?: RequestInit) =>
  fetch(`${c.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: c.serviceKey,
      authorization: `Bearer ${c.serviceKey}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

type HealthRow = { league: string; next_due_at: string | null; last_dispatch_at: string | null; updated_at: string | null; rate_limited_until: string | null; health: string | null };
const ms = (t: string | null | undefined) => { const v = t ? Date.parse(t) : NaN; return Number.isFinite(v) ? v : null; };

async function readHealth(c: Cfg): Promise<HealthRow[] | null> {
  try {
    const r = await sbFor(c)('player_props_pipeline_health?select=league,next_due_at,last_dispatch_at,updated_at,rate_limited_until,health');
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) ? rows : null;
  } catch (_) { return null; }
}

/* the scheduler's own record on the health rows: every tick, and every dispatch */
async function stamp(c: Cfg, action: string, reason: string, dispatched: boolean, nowIso: string) {
  const rows = LEAGUES.map((league) => ({ league, scheduler_tick_at: nowIso, scheduler_action: action, scheduler_reason: reason.slice(0, 300), ...(dispatched ? { last_dispatch_at: nowIso } : {}) }));
  try {
    await sbFor(c)('player_props_pipeline_health?on_conflict=league', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  } catch (_) { /* a stamp that fails must not stop scheduling */ }
}

/* poke the one canonical pipeline. A workflow on `ref` that predates an input
   answers 422 "Unexpected inputs": it is retried with only the inputs every
   version accepts, and the reason says so (a silent fallback would hide a
   version mismatch an operator should fix). */
async function dispatch(c: Cfg, inputs: Record<string, string>, legacy: Record<string, string>) {
  const post = (body: Record<string, unknown>) => fetch(`https://api.github.com/repos/${c.ghRepo}/actions/workflows/${c.workflow}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.ghToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'edgedesk-props-cron' },
    body: JSON.stringify(body),
  });
  let res = await post({ ref: c.ref, inputs });
  let note = '';
  if (res.status === 422) {
    const why = await res.text().catch(() => '');
    if (!/unexpected inputs/i.test(why)) return { ok: false, status: 422, detail: why.slice(0, 300), note };
    res = await post({ ref: c.ref, inputs: legacy });
    note = ' (with only ' + (Object.keys(legacy).join(', ') || 'no inputs') + ': the workflow on ' + c.ref + ' does not accept the others yet)';
  }
  if (res.status === 204) return { ok: true, status: 204, detail: '', note };
  return { ok: false, status: res.status, detail: (await res.text().catch(() => '')).slice(0, 300), note };
}

export type TickResult = { ok: boolean; action: 'dispatched' | 'debounced' | 'not_due' | 'no_token' | 'error'; reason: string; next_due_at?: string | null; detail?: unknown };

export async function tick(nowMs?: number): Promise<TickResult> {
  const c = config();
  const now = nowMs ?? Date.now(), nowIso = new Date(now).toISOString();
  const rows = await readHealth(c);
  const byLeague: Record<string, HealthRow> = {};
  (rows || []).forEach((r) => { byLeague[r.league] = r; });
  const lastDispatch = Math.max(0, ...(rows || []).map((r) => ms(r.last_dispatch_at) || 0));

  /* a reader's refresh that never started is retried here: its own dispatch
     failed (still queued), or its run was dispatched and never began — the
     workflow's concurrency group cancels a PENDING run when a newer dispatch
     arrives, so a backup-schedule run can silently replace a queued refresh */
  let queued: { id: string; league: string; event_ids: string[] | null } | null = null;
  try {
    const since = new Date(now - 20 * 60e3).toISOString();
    const r = await sbFor(c)(`player_props_refresh_requests?select=id,league,event_ids,status,dispatched_at&status=in.(queued,dispatched)&started_at=is.null&requested_at=gte.${since}&order=requested_at.asc&limit=5`);
    if (r.ok) {
      const q = await r.json();
      if (Array.isArray(q)) queued = q.find((x: { status: string; dispatched_at: string | null }) => x.status === 'queued' || (ms(x.dispatched_at) != null && now - (ms(x.dispatched_at) as number) > 6 * 60e3)) ?? null;
    }
  } catch (_) { /* no refresh to retry */ }

  const dueAt = LEAGUES.map((lg) => byLeague[lg] ? ms(byLeague[lg].next_due_at) : null).filter((x): x is number => x != null);
  const nextDue = dueAt.length ? Math.min(...dueAt) : null;
  const quietFor = Math.min(...LEAGUES.map((lg) => byLeague[lg] ? now - (ms(byLeague[lg].updated_at) || 0) : Infinity));
  let why = '';
  if (queued) why = 'a reader\'s refresh (' + queued.id + ') is waiting';
  else if (nextDue != null && nextDue <= now + 60e3) why = 'a game is due for a price check (' + new Date(nextDue).toISOString() + ')';
  else if (!rows || !rows.length || !Number.isFinite(quietFor) || quietFor > c.fallbackMinutes * 60e3) why = rows ? 'the health record has been quiet for ' + (Number.isFinite(quietFor) ? Math.round(quietFor / 60e3) + ' min' : 'ever') + ' (fallback)' : 'the health record is unreadable (fallback)';
  if (!why) {
    const out: TickResult = { ok: true, action: 'not_due', reason: 'no game is due' + (nextDue != null ? ' before ' + new Date(nextDue).toISOString() : ''), next_due_at: nextDue != null ? new Date(nextDue).toISOString() : null };
    await stamp(c, out.action, out.reason, false, nowIso);
    return out;
  }
  if (lastDispatch && now - lastDispatch < c.debounceSeconds * 1000) {
    const out: TickResult = { ok: true, action: 'debounced', reason: why + '; the last dispatch was ' + Math.round((now - lastDispatch) / 1000) + ' s ago, inside the ' + c.debounceSeconds + ' s debounce' };
    await stamp(c, out.action, out.reason, false, nowIso);
    return out;
  }
  if (!c.ghToken) {
    const out: TickResult = { ok: false, action: 'no_token', reason: 'PROPS_GH_TOKEN (or EDITORIAL_GH_TOKEN) is not set, so the Player props workflow cannot be run: ' + why };
    await stamp(c, out.action, out.reason, false, nowIso);
    return out;
  }
  const inputs: Record<string, string> = queued
    ? { source: 'manual_refresh', force_capture: 'true', refresh_request: queued.id, leagues: queued.league === 'all' ? 'nfl,cfb' : queued.league, events: (queued.event_ids || []).join(',') }
    : { source: 'supabase_cron' };
  const d = await dispatch(c, inputs, queued ? { force_capture: 'true' } : {});
  if (!d.ok) {
    const out: TickResult = { ok: false, action: 'error', reason: 'workflow_dispatch -> ' + d.status, detail: d.detail };
    await stamp(c, out.action, out.reason + ': ' + d.detail, false, nowIso);
    return out;
  }
  if (queued) await sbFor(c)(`player_props_refresh_requests?id=eq.${queued.id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify({ status: 'dispatched', dispatched_at: nowIso }) }).catch(() => null);
  const out: TickResult = { ok: true, action: 'dispatched', reason: c.workflow + ' dispatched on ' + c.ref + ': ' + why + d.note };
  await stamp(c, out.action, out.reason, true, nowIso);
  return out;
}

/* the caller, verified by Supabase Auth; never decoded here */
async function getUser(c: Cfg, req: Request): Promise<{ id: string } | null> {
  const authz = req.headers.get('authorization') ?? '';
  if (!/^Bearer\s+\S+/i.test(authz)) return null;
  try {
    const res = await fetch(`${c.url}/auth/v1/user`, { headers: { apikey: c.anonKey, authorization: authz } });
    if (!res.ok) return null;
    const u = await res.json().catch(() => null) as { id?: string } | null;
    return u && typeof u.id === 'string' && u.id ? { id: u.id } : null;
  } catch (_) { return null; }
}

export async function refresh(req: Request, body: Record<string, unknown>, nowMs?: number) {
  const c = config();
  const now = nowMs ?? Date.now(), nowIso = new Date(now).toISOString();
  const user = await getUser(c, req);
  if (!user) return json({ ok: false, reason: 'sign_in_required', message: 'Sign in to ask for a fresh price capture. The page has reloaded the latest published prices.' }, 401);
  const league = String(body.league ?? 'all').toLowerCase();
  if (['nfl', 'cfb', 'all'].indexOf(league) < 0) return json({ ok: false, reason: 'bad_league', message: 'league must be nfl, cfb or all' }, 400);
  const events = Array.isArray(body.event_ids) ? (body.event_ids as unknown[]).map(String).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 20) : [];
  const r = await sbFor(c)('rpc/player_props_refresh_admit', { method: 'POST', body: JSON.stringify({ p_user: user.id, p_league: league, p_event_ids: events.length ? events : null, p_user_cooldown_s: c.userCooldown, p_global_cooldown_s: c.globalCooldown }) });
  if (!r.ok) return json({ ok: false, reason: 'unavailable', message: 'The refresh service is not installed yet (supabase/player_props_pipeline.sql).', detail: (await r.text().catch(() => '')).slice(0, 200) }, 503);
  const rows = await r.json();
  const a = Array.isArray(rows) ? rows[0] : rows;
  if (!a || !a.admitted) return json({ ok: false, reason: 'rate_limited', message: 'Prices ' + (a && /recently/.test(a.reason) ? 'were refreshed at your request moments ago' : 'were refreshed moments ago') + '. Try again in ' + Math.max(1, Math.ceil(((a && a.retry_after_s) || 60) / 60)) + ' min.', retry_after_s: a ? a.retry_after_s : null }, 429);
  if (a.status !== 'queued') return json({ ok: true, request_id: a.request_id, status: a.status, joined: true, message: 'A price refresh is already running; this page will update when it lands.' }, 202);
  const patch = (p: Record<string, unknown>) => sbFor(c)(`player_props_refresh_requests?id=eq.${a.request_id}`, { method: 'PATCH', headers: { prefer: 'return=minimal' }, body: JSON.stringify(p) }).catch(() => null);
  if (!c.ghToken) {
    await patch({ status: 'failed', reason: 'the scheduler has no GitHub token (PROPS_GH_TOKEN)', completed_at: nowIso });
    return json({ ok: false, reason: 'no_token', request_id: a.request_id, message: 'A fresh capture cannot be started: the price scheduler is not configured (no GitHub token). The latest published prices are shown.' }, 503);
  }
  const d = await dispatch(c, { source: 'manual_refresh', force_capture: 'true', refresh_request: a.request_id, leagues: league === 'all' ? 'nfl,cfb' : league, events: events.join(',') }, { force_capture: 'true' });
  if (!d.ok) {
    await patch({ status: 'failed', reason: 'workflow_dispatch -> ' + d.status + ': ' + d.detail.slice(0, 200), completed_at: nowIso });
    return json({ ok: false, reason: 'dispatch_failed', request_id: a.request_id, message: 'A fresh capture could not be started (GitHub answered ' + d.status + '). The latest published prices are shown.' }, 502);
  }
  await patch({ status: 'dispatched', dispatched_at: nowIso, reason: d.note ? d.note.trim() : null });
  await stamp(c, 'dispatched', 'a reader\'s refresh (' + a.request_id + ')' + d.note, true, nowIso);
  return json({ ok: true, request_id: a.request_id, status: 'dispatched', message: 'Refreshing prices…' + (d.note ? ' ' + d.note.trim() : '') }, 202);
}

export async function status(req: Request, body: Record<string, unknown>) {
  const c = config();
  const user = await getUser(c, req);
  if (!user) return json({ ok: false, reason: 'sign_in_required' }, 401);
  const id = String(body.id ?? body.request_id ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ ok: false, reason: 'bad_id' }, 400);
  const r = await sbFor(c)(`player_props_refresh_requests?select=id,league,status,reason,requested_at,dispatched_at,started_at,completed_at,result,retry_after_s&id=eq.${id}&user_id=eq.${user.id}`);
  const rows = r.ok ? await r.json() : [];
  if (!Array.isArray(rows) || !rows.length) return json({ ok: false, reason: 'not_found' }, 404);
  return json({ ok: true, request: rows[0] });
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const c = config();
  if (req.method === 'GET') {
    const rows = await readHealth(c);
    return json({ ok: true, service: 'props_cron', build: BUILD, configured: { repo: c.ghRepo, workflow: c.workflow, ref: c.ref, debounce_seconds: c.debounceSeconds, fallback_minutes: c.fallbackMinutes, has_token: !!c.ghToken },
      health: (rows || []).map((r) => ({ league: r.league, health: r.health, next_due_at: r.next_due_at, last_dispatch_at: r.last_dispatch_at, rate_limited_until: r.rate_limited_until })) });
  }
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { body = {}; }
  try {
    if (body.action === 'refresh') return await refresh(req, body);
    if (body.action === 'status') return await status(req, body);
    /* a tick: pg_cron (the service key) — nothing a reader sends reaches here
       with more than a debounced poke */
    const out = await tick();
    return json(out, out.ok ? 200 : 503);
  } catch (e) {
    return json({ ok: false, action: 'error', reason: String((e as Error)?.message ?? e) }, 500);
  }
}

// Imported directly by tools/props/props_cron.test.js under Node's type
// stripping with a Deno shim: the server is installed only where the runtime
// provides one.
if (typeof (Deno as unknown as { serve?: unknown })?.serve === 'function') {
  Deno.serve(handle);
}
