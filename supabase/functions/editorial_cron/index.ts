// ============================================================
//  FILE:    supabase/functions/editorial_cron/index.ts
//  TYPE:    Edge Function (deployed) — the editorial system's PRIMARY scheduler
//  DEPLOY:  supabase functions deploy editorial_cron --no-verify-jwt
//  CRON:    every 10 minutes (see supabase/editorial_cron.sql)
// ============================================================
// WHY THIS EXISTS. The editorial dispatcher has to notice a publication window
// that is only twenty to ninety minutes wide. It was woken by a GitHub Actions
// cron, and that cron does not fire.
//
// Not a guess: on 2026-09-13 the editorial workflow logged ZERO scheduled runs
// between 12:58 and 17:03 across two different cron expressions, while every
// other scheduled workflow in the repository showed the same ~4.5 hour gap —
// settle-finals is hourly and went 11:24 → 15:54. GitHub's scheduler is
// degraded for this repository, and a publisher cannot be built on it.
//
// WHAT THIS DOES, AND WHAT IT DELIBERATELY DOES NOT DO.
//
// It does NOT run the editorial pipeline. It cannot: the pipeline boots the
// real football module out of app.html in a Node VM and commits its output to
// the git repository, and neither is possible from an edge runtime. Building a
// second pipeline here to work around that would give EdgeDesk two editorial
// systems that disagree, which is far worse than a late article.
//
// So it does one small, reliable thing: it POKES the one canonical dispatcher,
// by asking GitHub to run the existing workflow via workflow_dispatch. One
// pipeline, one publisher, several ways to wake it.
//
//   supabase pg_cron  ──►  THIS  ──►  workflow_dispatch  ──►  editorial.yml
//   github schedule   ─────────────────────────────────────►  (backup)
//   github push       ─────────────────────────────────────►  (backup)
//   operator          ─────────────────────────────────────►  (manual)
//
// IT REFUSES TO STAMPEDE. Before poking it reads the most recent heartbeat; if
// a run started within the debounce window it does nothing and says so. The
// dispatcher also holds a lease, so a double poke is harmless — but not paying
// for a duplicate Actions run is better than tolerating one.
//
// IT RESPECTS THE KILL SWITCH. editorial_settings.dispatcher_enabled false
// means no poke. The operator's pause is honoured at every layer, not only
// inside the pipeline.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by the platform
//   EDITORIAL_GH_TOKEN    a GitHub token with `actions:write` on the repo.
//                         Required. Without it this returns 503 and says so —
//                         it never pretends to have scheduled something.
//   EDITORIAL_GH_REPO     defaults to dsrackler17/EdgeDeskSports
//   EDITORIAL_WORKFLOW    defaults to editorial.yml
//   EDITORIAL_DEBOUNCE_S  defaults to 300
// ============================================================

// CONFIGURATION IS READ PER CALL, not once at module load. An edge instance is
// long-lived, so a rotated EDITORIAL_GH_TOKEN takes effect on the next
// invocation rather than waiting for a redeploy — and it makes the deployed
// file testable, which is why the suite can exercise THIS code instead of a
// copy of it.
function config() {
  return {
    url: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    ghToken: Deno.env.get('EDITORIAL_GH_TOKEN') ?? '',
    ghRepo: Deno.env.get('EDITORIAL_GH_REPO') ?? 'dsrackler17/EdgeDeskSports',
    workflow: Deno.env.get('EDITORIAL_WORKFLOW') ?? 'editorial.yml',
    debounceSeconds: Number(Deno.env.get('EDITORIAL_DEBOUNCE_S') ?? '300'),
    ref: Deno.env.get('EDITORIAL_REF') ?? 'main',
  };
}

const sbFor = (c: ReturnType<typeof config>) => (path: string, init?: RequestInit) =>
  fetch(`${c.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: c.serviceKey,
      authorization: `Bearer ${c.serviceKey}`,
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

type Result = {
  ok: boolean;
  action: 'dispatched' | 'debounced' | 'paused' | 'no_token' | 'error';
  reason: string;
  detail?: unknown;
};

export async function run(): Promise<Result> {
  const { ghToken, ghRepo, workflow, debounceSeconds, ref } = config();
  const sb = sbFor(config());
  // ---- the operator's pause is honoured here too ------------------------
  let dispatcherEnabled = true;
  try {
    const r = await sb('editorial_settings?select=dispatcher_enabled,editorial_enabled&id=eq.1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) {
        dispatcherEnabled = rows[0].dispatcher_enabled !== false;
      }
    }
  } catch (_) {
    // A settings read that fails is not a reason to stop scheduling: the
    // pipeline re-reads settings itself and will pause if it must.
  }
  if (!dispatcherEnabled) {
    return { ok: true, action: 'paused', reason: 'dispatcher_enabled is false' };
  }

  // ---- do not stampede --------------------------------------------------
  // A run already in flight needs no second one. The dispatcher's lease makes
  // a duplicate safe; this makes it unnecessary.
  try {
    const since = new Date(Date.now() - debounceSeconds * 1000).toISOString();
    const r = await sb(
      `editorial_heartbeats?select=id,started_at,scheduler_source&started_at=gte.${since}` +
      `&order=started_at.desc&limit=1`,
    );
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) {
        return {
          ok: true,
          action: 'debounced',
          reason: `a dispatcher run started at ${rows[0].started_at} (${rows[0].scheduler_source}), inside the ${debounceSeconds}s debounce`,
        };
      }
    }
  } catch (_) { /* a heartbeat read failure must not stop scheduling */ }

  // ---- NO TOKEN IS NOT A SUCCESS ----------------------------------------
  // Returning ok here would make a permanently unscheduled system look
  // healthy, which is the failure this whole function exists to remove.
  if (!ghToken) {
    return {
      ok: false,
      action: 'no_token',
      reason: 'EDITORIAL_GH_TOKEN is not set, so the dispatcher cannot be invoked',
    };
  }

  // ---- poke the one canonical dispatcher --------------------------------
  const res = await fetch(
    `https://api.github.com/repos/${ghRepo}/actions/workflows/${workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${ghToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'edgedesk-editorial-cron',
      },
      body: JSON.stringify({ ref, inputs: { source: 'supabase_cron' } }),
    },
  );

  if (res.status === 204) {
    return { ok: true, action: 'dispatched', reason: `${workflow} dispatched on ${ref}` };
  }
  const body = await res.text().catch(() => '');
  return {
    ok: false,
    action: 'error',
    reason: `workflow_dispatch -> ${res.status}`,
    detail: body.slice(0, 300),
  };
}

// The deployed file is imported directly by tools/editorial/editorial_cron.test.js
// under Node's type stripping with a Deno shim, so the tests exercise THIS
// code rather than a copy. Node has no Deno.serve, so the server is only
// installed when the runtime actually provides one.
if (typeof (Deno as unknown as { serve?: unknown })?.serve === 'function') {
Deno.serve(async (req) => {
  // GET is a health probe; POST actually schedules.
  if (req.method === 'GET') {
    const c = config();
    return Response.json({
      ok: true,
      service: 'editorial_cron',
      configured: { repo: c.ghRepo, workflow: c.workflow, ref: c.ref,
        debounce_seconds: c.debounceSeconds, has_token: !!c.ghToken },
    });
  }
  try {
    const out = await run();
    return Response.json(out, { status: out.ok ? 200 : 503 });
  } catch (e) {
    return Response.json(
      { ok: false, action: 'error', reason: String((e as Error)?.message ?? e) },
      { status: 500 },
    );
  }
});
}
