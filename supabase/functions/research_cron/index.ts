// ============================================================
//  FILE:    supabase/functions/research_cron/index.ts
//  TYPE:    Edge Function (deployed) — the Personal research state job's
//           PRIMARY scheduler
//  DEPLOY:  the Deploy research scheduler workflow, or
//           supabase functions deploy research_cron --no-verify-jwt
//  CRON:    every 5 minutes (supabase/research_state_cron.sql)
// ============================================================
// WHY THIS EXISTS. public.game_research_state is what the landing page's
// board and the terminal read, and only .github/workflows/research-state.yml
// writes it. Its cron is `38 * * * *`; GitHub's scheduler ran it at 01:09,
// 07:34, 15:55 and 22:15 UTC on 2026-09-28 and at 02:16, 08:59, 16:06 and
// 21:00 on 2026-09-29 — every five to eight hours, the same multi-hour gaps
// every scheduled workflow here has shown since 2026-09-13 (props_cron,
// editorial_cron). The game-line capture itself is minutes old (capture.yml
// has a pg_cron primary), but the market stored in game_research_state only
// moves when this job runs, so the site lagged the captures by hours. On game
// day a line inside six hours of kickoff is listed only while it is under
// three hours old (lib/edgedesk_home.js GAME_WINDOW), so whole games dropped
// off the board between runs.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO.
//
// It does NOT compute a research state. That is the football module, booted
// headlessly by tools/personal/research_state.js in research-state.yml; a
// second writer here would be a second pipeline that disagrees with the
// first. It POKES that one job:
//
//   pg_cron (5 min) ──► THIS ──► workflow_dispatch ──► research-state.yml
//   github schedule ──────────────────────────────────► (backup)
//
// WHEN IT POKES (a tick). It reads the newest computed_at in
// game_research_state — the job stamps every upcoming game's row on every
// run — and the next kickoff. When the newest state is older than the
// cadence it dispatches:
//
//   next kickoff within 24 h   25 min   (a run every ~30 min on game day)
//   otherwise                  55 min   (hourly)
//
// An empty table, or one it cannot read, is due: a broken read must never
// silence the job.
//
// IT NEVER STAMPEDES. It never dispatches twice inside one cadence: its own
// last dispatch is kept in public.research_state_scheduler, and a tick inside
// the cadence of it is debounced. A run that wrote nothing (it failed, or the
// slate is empty) is therefore retried once per cadence, not every tick, and
// the workflow's concurrency group (research-state) serializes whatever does
// arrive. Without that record (the SQL was never applied) it refuses to
// dispatch at all rather than dispatch undebounced.
//
// NO TOKEN IS NOT A SUCCESS. Without a GitHub token every tick answers 503
// and says so.
//
// JWT VERIFICATION IS OFF, as for props_cron (supabase/player_props_cron.sql
// says why: this project's gateway refuses pg_cron's anon key, and Supabase
// refuses the database settings a service key would live in). Nothing is
// opened by it: a GET is a read-only health probe, and a POST can at most
// cause the one dispatch per cadence the schedule would have made anyway.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by the platform
//   RESEARCH_GH_TOKEN     GitHub token, `actions:write` on the repository.
//                         Falls back to PROPS_GH_TOKEN, then
//                         EDITORIAL_GH_TOKEN: Supabase secrets are shared by
//                         every function in the project, so the token
//                         props_cron already holds serves here with nothing
//                         new to set.
//   RESEARCH_GH_REPO      defaults to dsrackler17/EdgeDeskSports
//   RESEARCH_WORKFLOW     defaults to research-state.yml
//   RESEARCH_REF          defaults to main
//   RESEARCH_CADENCE_MIN        defaults to 55
//   RESEARCH_NEAR_CADENCE_MIN   defaults to 25
//   RESEARCH_NEAR_HOURS         defaults to 24
//   (a cadence below 10 minutes is read as 10)
// ============================================================

/* WHICH CODE IS ANSWERING. The GET health probe returns this, so the
   Intelligence doctor (tools/intelligence/deploy_doctor.js) can tell a
   deployment that is serving this file from one serving an older one, and
   deploy it when they differ. Bump it with every change to this file, or the
   change is never shipped on its own. */
export const BUILD = "research_cron-2026-09-30-r1";

/* the floor under any configured cadence: five-minute ticks, ~30 s runs */
const MIN_CADENCE = 10;

/* configuration is read per call, so a rotated token takes effect on the next
   tick and the tests can exercise this file rather than a copy of it */
function config() {
  const minutes = (name: string, fb: number) => {
    const v = Number(Deno.env.get(name) ?? fb);
    return Math.max(MIN_CADENCE, Number.isFinite(v) ? v : fb);
  };
  const hours = Number(Deno.env.get('RESEARCH_NEAR_HOURS') ?? '24');
  return {
    url: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    ghToken: Deno.env.get('RESEARCH_GH_TOKEN') || Deno.env.get('PROPS_GH_TOKEN') || Deno.env.get('EDITORIAL_GH_TOKEN') || '',
    ghRepo: Deno.env.get('RESEARCH_GH_REPO') ?? 'dsrackler17/EdgeDeskSports',
    workflow: Deno.env.get('RESEARCH_WORKFLOW') ?? 'research-state.yml',
    ref: Deno.env.get('RESEARCH_REF') ?? 'main',
    cadenceMinutes: minutes('RESEARCH_CADENCE_MIN', 55),
    nearCadenceMinutes: minutes('RESEARCH_NEAR_CADENCE_MIN', 25),
    nearHours: Number.isFinite(hours) ? hours : 24,
  };
}
type Cfg = ReturnType<typeof config>;

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

const ms = (t: string | null | undefined) => { const v = t ? Date.parse(t) : NaN; return Number.isFinite(v) ? v : null; };
const isoOf = (v: number | null) => (v == null ? null : new Date(v).toISOString());
const mins = (v: number) => Math.round(v / 60e3);

/* the cadence for a kickoff: tighter when a game is inside nearHours */
export function cadenceFor(nextKickoffMs: number | null, nowMs: number, c: Pick<Cfg, 'cadenceMinutes' | 'nearCadenceMinutes' | 'nearHours'>) {
  if (nextKickoffMs != null && nextKickoffMs - nowMs <= c.nearHours * 36e5) return c.nearCadenceMinutes;
  return c.cadenceMinutes;
}

/* one PostgREST read: rows, or null when it could not be read (and why) */
async function read(c: Cfg, path: string): Promise<{ rows: Record<string, string | null>[] | null; why: string }> {
  try {
    const r = await sbFor(c)(path);
    if (!r.ok) return { rows: null, why: 'HTTP ' + r.status };
    const rows = await r.json();
    return Array.isArray(rows) ? { rows, why: '' } : { rows: null, why: 'not a list' };
  } catch (e) { return { rows: null, why: String((e as Error)?.message ?? e).slice(0, 120) }; }
}

type Seen = { state_computed_at: string | null; next_kickoff_at: string | null; cadence_minutes: number | null };

/* the scheduler's own record: every tick, and every dispatch */
async function stamp(c: Cfg, action: string, reason: string, dispatched: boolean, nowIso: string, seen: Seen) {
  const row = {
    id: 1, scheduler_tick_at: nowIso, scheduler_action: action, scheduler_reason: reason.slice(0, 300), ...seen,
    ...(dispatched ? { last_dispatch_at: nowIso, last_dispatch_reason: reason.slice(0, 300) } : {}),
  };
  try {
    await sbFor(c)('research_state_scheduler?on_conflict=id', { method: 'POST', headers: { prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(row) });
  } catch (_) { /* a stamp that fails must not stop scheduling */ }
}

/* poke the one job. A workflow on `ref` that predates the `source` input
   answers 422 "Unexpected inputs": it is retried with no inputs, and the
   reason says so (a silent fallback would hide a version mismatch). */
async function dispatch(c: Cfg) {
  const post = (body: Record<string, unknown>) => fetch(`https://api.github.com/repos/${c.ghRepo}/actions/workflows/${c.workflow}/dispatches`, {
    method: 'POST',
    headers: { authorization: `Bearer ${c.ghToken}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'edgedesk-research-cron' },
    body: JSON.stringify(body),
  });
  let res = await post({ ref: c.ref, inputs: { source: 'supabase_cron' } });
  let note = '';
  if (res.status === 422) {
    const why = await res.text().catch(() => '');
    if (!/unexpected inputs/i.test(why)) return { ok: false, status: 422, detail: why.slice(0, 300), note };
    res = await post({ ref: c.ref });
    note = ' (without the `source` input: the workflow on ' + c.ref + ' does not accept it yet)';
  }
  if (res.status === 204) return { ok: true, status: 204, detail: '', note };
  return { ok: false, status: res.status, detail: (await res.text().catch(() => '')).slice(0, 300), note };
}

export type TickResult = {
  ok: boolean;
  action: 'dispatched' | 'debounced' | 'not_due' | 'no_token' | 'not_installed' | 'error';
  reason: string;
  state_computed_at?: string | null;
  next_kickoff_at?: string | null;
  cadence_minutes?: number;
  detail?: unknown;
};

export async function tick(nowMs?: number): Promise<TickResult> {
  const c = config();
  const now = nowMs ?? Date.now(), nowIso = new Date(now).toISOString();

  /* the scheduler's own record first: without it there is no debounce, and an
     undebounced dispatcher is the one thing this must never be */
  const sched = await read(c, 'research_state_scheduler?select=last_dispatch_at&id=eq.1');
  if (!sched.rows) {
    return { ok: false, action: 'not_installed', reason: 'public.research_state_scheduler could not be read (' + sched.why + '), so nothing is dispatched: apply supabase/research_state_cron.sql' };
  }
  const lastDispatch = sched.rows.length ? ms(sched.rows[0].last_dispatch_at) : null;

  const newest = await read(c, 'game_research_state?select=computed_at&order=computed_at.desc.nullslast&limit=1');
  const next = await read(c, 'game_research_state?select=kickoff_at&kickoff_at=gt.' + encodeURIComponent(nowIso) + '&order=kickoff_at.asc&limit=1');
  const computedAt = newest.rows && newest.rows.length ? ms(newest.rows[0].computed_at) : null;
  const nextKick = next.rows && next.rows.length ? ms(next.rows[0].kickoff_at) : null;
  const cadence = cadenceFor(nextKick, now, c);
  const seen: Seen = { state_computed_at: isoOf(computedAt), next_kickoff_at: isoOf(nextKick), cadence_minutes: cadence };
  const facts = { state_computed_at: seen.state_computed_at, next_kickoff_at: seen.next_kickoff_at, cadence_minutes: cadence };
  const pace = 'cadence ' + cadence + ' min: ' + (nextKick == null ? 'no upcoming kickoff on file'
    : 'next kickoff in ' + (nextKick - now < 36e5 ? mins(nextKick - now) + ' min' : Math.round((nextKick - now) / 36e5) + ' h'));

  let why = '';
  if (!newest.rows) why = 'game_research_state could not be read (' + newest.why + ')';
  else if (computedAt == null) why = 'game_research_state holds no research state yet';
  /* a stamp from the future (a clock that jumped) would silence the job until
     then; it is not trusted, and the next run writes an honest one */
  else if (computedAt - now > 5 * 60e3) why = 'the newest research state is stamped ' + mins(computedAt - now) + ' min in the future (' + isoOf(computedAt) + ')';
  else if (now - computedAt >= cadence * 60e3) why = 'the newest research state is ' + mins(now - computedAt) + ' min old (' + pace + ')';
  if (!why) {
    const out: TickResult = { ok: true, action: 'not_due', reason: 'the newest research state is ' + Math.max(0, mins(now - (computedAt as number))) + ' min old; due in '
      + Math.max(1, mins((computedAt as number) + cadence * 60e3 - now)) + ' min (' + pace + ')', ...facts };
    await stamp(c, out.action, out.reason, false, nowIso, seen);
    return out;
  }
  if (lastDispatch != null && now - lastDispatch < cadence * 60e3) {
    const out: TickResult = { ok: true, action: 'debounced', reason: why + '; the last dispatch was ' + mins(now - lastDispatch)
      + ' min ago, inside the ' + cadence + '-min cadence (a run that wrote nothing is retried once per cadence)', ...facts };
    await stamp(c, out.action, out.reason, false, nowIso, seen);
    return out;
  }
  if (!c.ghToken) {
    const out: TickResult = { ok: false, action: 'no_token', reason: 'no GitHub token (RESEARCH_GH_TOKEN, PROPS_GH_TOKEN or EDITORIAL_GH_TOKEN), so ' + c.workflow + ' cannot be run: ' + why, ...facts };
    await stamp(c, out.action, out.reason, false, nowIso, seen);
    return out;
  }
  const d = await dispatch(c);
  if (!d.ok) {
    const out: TickResult = { ok: false, action: 'error', reason: 'workflow_dispatch -> ' + d.status, detail: d.detail, ...facts };
    await stamp(c, out.action, out.reason + ': ' + d.detail, false, nowIso, seen);
    return out;
  }
  const out: TickResult = { ok: true, action: 'dispatched', reason: c.workflow + ' dispatched on ' + c.ref + ': ' + why + d.note, ...facts };
  await stamp(c, out.action, out.reason, true, nowIso, seen);
  return out;
}

/* The GET health probe. Read-only: which build is answering, how it is
   configured (never the token itself), and the scheduler's last word. */
export async function probe() {
  const c = config();
  const s = await read(c, 'research_state_scheduler?select=scheduler_tick_at,scheduler_action,scheduler_reason,state_computed_at,next_kickoff_at,cadence_minutes,last_dispatch_at&id=eq.1');
  return {
    ok: true, service: 'research_cron', build: BUILD,
    configured: { repo: c.ghRepo, workflow: c.workflow, ref: c.ref, cadence_minutes: c.cadenceMinutes,
      near_cadence_minutes: c.nearCadenceMinutes, near_hours: c.nearHours, has_token: !!c.ghToken },
    scheduler: s.rows ? (s.rows[0] ?? null) : { unreadable: s.why },
  };
}

export async function handle(req: Request): Promise<Response> {
  /* GET is a health probe and never ticks: the deployment doctor sends one */
  if (req.method === 'GET') return Response.json(await probe());
  if (req.method !== 'POST') return Response.json({ ok: false, reason: 'GET is the probe, POST is a tick' }, { status: 405 });
  try {
    const out = await tick();
    return Response.json(out, { status: out.ok ? 200 : 503 });
  } catch (e) {
    return Response.json({ ok: false, action: 'error', reason: String((e as Error)?.message ?? e) }, { status: 500 });
  }
}

// Imported directly by tools/personal/research_cron.test.js under Node's type
// stripping with a Deno shim: the server is installed only where the runtime
// provides one.
if (typeof (Deno as unknown as { serve?: unknown })?.serve === 'function') {
  Deno.serve(handle);
}
