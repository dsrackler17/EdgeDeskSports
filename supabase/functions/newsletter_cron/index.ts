// ============================================================
//  FILE:    supabase/functions/newsletter_cron/index.ts
//  TYPE:    Edge Function (deployed) — the newsletter's PRIMARY scheduler
//  DEPLOY:  supabase functions deploy newsletter_cron --no-verify-jwt
//  CRON:    every 20 minutes on Monday and Tuesday (see supabase/newsletter_cron.sql)
// ============================================================
// THE SAME REASONING AS editorial_cron, for the same reason: GitHub's
// scheduler is degraded on this repository — the editorial workflow's own cron
// logged zero scheduled runs across a four-and-a-half hour window while every
// other scheduled workflow showed the same gap. A newsletter that must go out
// at 10:00 local cannot be built on a scheduler that may not fire until 14:00.
//
// WHY IT POKES RATHER THAN SENDS. The pipeline boots the real football module
// out of app.html in a Node VM and commits its editions to the git repository;
// an edge runtime can do neither. Building a second, edge-shaped newsletter
// pipeline here would give EdgeDesk two systems that disagree about what the
// model said, which is far worse than a late email.
//
//   supabase pg_cron  ──►  THIS  ──►  workflow_dispatch  ──►  newsletter.yml
//   github schedule   ─────────────────────────────────────►  (backup)
//   operator          ─────────────────────────────────────►  (manual)
//
// THE CRON IS NOT THE SCHEDULE. It fires many times across the plausible
// hours; tools/newsletter/schedule.js decides whether an edition is actually
// owed, in America/Chicago, using the zone database. That is what makes the
// whole thing correct across daylight saving without anybody editing a cron
// line twice a year.
//
// IT RESPECTS THE SWITCHES. newsletter_settings.dispatcher_enabled false means
// no poke. It does NOT check sending_enabled: an edition should still be built,
// validated and previewed while the launch gate is closed.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by the platform
//   NEWSLETTER_GH_TOKEN   a GitHub token with `actions:write` on the repo.
//                         Required. Without it this returns 503 and says so —
//                         it never reports success while scheduling nothing.
//   NEWSLETTER_GH_REPO    defaults to dsrackler17/EdgeDeskSports
//   NEWSLETTER_WORKFLOW   defaults to newsletter.yml
//   NEWSLETTER_DEBOUNCE_S defaults to 600
// ============================================================

function config() {
  return {
    url: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    ghToken: Deno.env.get('NEWSLETTER_GH_TOKEN') ?? Deno.env.get('EDITORIAL_GH_TOKEN') ?? '',
    ghRepo: Deno.env.get('NEWSLETTER_GH_REPO') ?? 'dsrackler17/EdgeDeskSports',
    workflow: Deno.env.get('NEWSLETTER_WORKFLOW') ?? 'newsletter.yml',
    debounceSeconds: Number(Deno.env.get('NEWSLETTER_DEBOUNCE_S') ?? '600'),
    ref: Deno.env.get('NEWSLETTER_REF') ?? 'main',
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
  const c = config();
  const sb = sbFor(c);

  // ---- the operator's pause is honoured here too -------------------------
  let dispatcherEnabled = true;
  try {
    const r = await sb('newsletter_settings?select=dispatcher_enabled&id=eq.1');
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) dispatcherEnabled = rows[0].dispatcher_enabled !== false;
    }
  } catch (_) {
    // A settings read that fails is not a reason to stop scheduling: the
    // pipeline re-reads settings itself and pauses if it must.
  }
  if (!dispatcherEnabled) {
    return { ok: true, action: 'paused', reason: 'dispatcher_enabled is false' };
  }

  // ---- do not stampede ---------------------------------------------------
  // A run already in flight needs no second one. The edition lease makes a
  // duplicate safe; this makes it unnecessary.
  try {
    const since = new Date(Date.now() - c.debounceSeconds * 1000).toISOString();
    const r = await sb(`newsletter_runs?select=run_id,at,phase&at=gte.${since}&order=at.desc&limit=1`);
    if (r.ok) {
      const rows = await r.json();
      if (Array.isArray(rows) && rows.length) {
        return {
          ok: true, action: 'debounced',
          reason: `a newsletter run logged ${rows[0].phase} at ${rows[0].at}, inside the ${c.debounceSeconds}s debounce`,
        };
      }
    }
  } catch (_) { /* a run-log read failure must not stop scheduling */ }

  // ---- NO TOKEN IS NOT A SUCCESS ----------------------------------------
  if (!c.ghToken) {
    return { ok: false, action: 'no_token', reason: 'NEWSLETTER_GH_TOKEN is not set, so the pipeline cannot be invoked' };
  }

  const res = await fetch(
    `https://api.github.com/repos/${c.ghRepo}/actions/workflows/${c.workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${c.ghToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'edgedesk-newsletter-cron',
      },
      body: JSON.stringify({ ref: c.ref, inputs: { source: 'supabase_cron' } }),
    },
  );
  if (res.status === 204) {
    return { ok: true, action: 'dispatched', reason: `${c.workflow} dispatched on ${c.ref}` };
  }
  const body = await res.text().catch(() => '');
  return { ok: false, action: 'error', reason: `workflow_dispatch -> ${res.status}`, detail: body.slice(0, 300) };
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve(async () => {
    const out = await run();
    return new Response(JSON.stringify(out), {
      status: out.ok ? 200 : (out.action === 'no_token' ? 503 : 502),
      headers: { 'content-type': 'application/json' },
    });
  });
}
