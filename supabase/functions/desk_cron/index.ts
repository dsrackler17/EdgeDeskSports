// ============================================================
//  FILE:    supabase/functions/desk_cron/index.ts
//  TYPE:    Edge Function (deployed): the desk's scheduler and messenger
//  DEPLOY:  supabase functions deploy desk_cron --no-verify-jwt
//  CRON:    supabase/desk_articles_cron.sql (generate daily, notify every
//           30 minutes)
// ============================================================
// WHAT IT DOES. Three small things, none of which writes an article:
//
//   action 'generate'  (pg_cron, x-cron-secret) asks GitHub to run
//       .github/workflows/desk-drafts.yml. It does NOT generate drafts: the
//       generators read the committed record files in the repository, which
//       an edge runtime does not have. One generator, several ways to wake it
//       (the same shape as editorial_cron).
//
//   action 'notify'  (pg_cron, x-cron-secret) claims every draft that has not
//       been announced (public.desk_notify_claim, which stamps them in the
//       same statement, so nothing is announced twice) and tells the owner:
//       a Discord DM when DISCORD_BOT_TOKEN and DESK_OWNER_DISCORD_ID are
//       set, else the owner-only webhook DISCORD_WEBHOOK_OWNER, else nothing
//       but the dashboard badge. The outcome is logged with
//       public.desk_notify_done; a failed send is released for a retry.
//
//   action 'publish_now'  (the owner, from /admin/desk/, with their own
//       token) asks GitHub to run the publish workflow, so a page the owner
//       just published appears in minutes instead of at the next scheduled
//       build. The caller must be the owner: the function asks the database
//       (public.desk_is_owner) under the caller's own token.
//
// NEVER A SECRET IN A LOG. Tokens and webhook URLs are read by NAME and used
// only as a request target or header; every error string is scrubbed, and
// the database refuses a log row that carries one.
//
// DRY RUN. DESK_DRY_RUN=1 prints the message instead of sending it and
// claims nothing.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ANON_KEY  (platform)
//   DESK_CRON_SECRET        required; equals Vault desk_cron_secret
//   DESK_GH_TOKEN           a GitHub token with actions:write; falls back to
//                           EDITORIAL_GH_TOKEN, which already exists
//   DESK_GH_REPO            default dsrackler17/EdgeDeskSports
//   DESK_DRAFTS_WORKFLOW    default desk-drafts.yml
//   DESK_PUBLISH_WORKFLOW   default publish-articles.yml
//   DISCORD_BOT_TOKEN       optional (already set for discord_cron)
//   DESK_OWNER_DISCORD_ID   optional: the owner's Discord user id, for a DM
//   DISCORD_WEBHOOK_OWNER   optional: an owner-only channel's webhook
//   DESK_DRY_RUN            1 = print, never send
//   DESK_ADMIN_URL          default https://edgedesksports.com/admin/desk/
// ============================================================

export const BUILD = 'desk_cron-2026-10-19-r1';

const TYPE_LABEL: Record<string, string> = {
  weekly_clv: 'Weekly CLV Report',
  disagreement: 'Where My Number Disagrees',
  line_movement: 'Line Movement Recap',
  got_wrong: 'What I Got Wrong',
  research_notes: 'Research Notes'
};
const ORIGIN = 'https://edgedesksports.com';

export function config() {
  const env = (k: string) => Deno.env.get(k) ?? '';
  return {
    url: env('SUPABASE_URL').replace(/\/+$/, ''),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: env('SUPABASE_ANON_KEY'),
    cronSecret: env('DESK_CRON_SECRET'),
    ghToken: env('DESK_GH_TOKEN') || env('EDITORIAL_GH_TOKEN'),
    ghRepo: env('DESK_GH_REPO') || 'dsrackler17/EdgeDeskSports',
    draftsWorkflow: env('DESK_DRAFTS_WORKFLOW') || 'desk-drafts.yml',
    publishWorkflow: env('DESK_PUBLISH_WORKFLOW') || 'publish-articles.yml',
    ref: env('DESK_GH_REF') || 'main',
    botToken: env('DISCORD_BOT_TOKEN'),
    ownerDiscordId: env('DESK_OWNER_DISCORD_ID'),
    ownerWebhook: env('DISCORD_WEBHOOK_OWNER'),
    dryRun: /^(1|true|on|yes)$/i.test(env('DESK_DRY_RUN')),
    adminUrl: env('DESK_ADMIN_URL') || 'https://edgedesksports.com/admin/desk/'
  };
}
export type Cfg = ReturnType<typeof config>;

/* ------------------------------------------------------------- helpers */
export function scrub(s: string): string {
  return String(s ?? '')
    .replace(/https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\S+/gi, '[webhook]')
    .replace(/\b(Bot|Bearer)\s+[A-Za-z0-9._-]{12,}/g, '$1 [token]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[token]');
}
function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function cors(extra?: Record<string, string>): Record<string, string> {
  return Object.assign({
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-headers': 'authorization, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    'vary': 'origin'
  }, extra || {});
}
function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) });
}
async function rpc(c: Cfg, fn: string, args: unknown, bearer?: string): Promise<unknown> {
  const r = await fetch(c.url + '/rest/v1/rpc/' + fn, {
    method: 'POST',
    headers: { apikey: bearer ? (c.anonKey || c.serviceKey) : c.serviceKey, authorization: 'Bearer ' + (bearer || c.serviceKey), 'content-type': 'application/json' },
    body: JSON.stringify(args ?? {})
  });
  const t = await r.text();
  if (!r.ok) throw new Error(fn + ' HTTP ' + r.status + ': ' + t.slice(0, 200));
  return t ? JSON.parse(t) : null;
}
async function dispatch(c: Cfg, workflow: string, inputs: Record<string, string>): Promise<{ ok: boolean; status: number; error?: string }> {
  if (!c.ghToken) return { ok: false, status: 503, error: 'no GitHub token (DESK_GH_TOKEN or EDITORIAL_GH_TOKEN): nothing was dispatched' };
  const r = await fetch('https://api.github.com/repos/' + c.ghRepo + '/actions/workflows/' + workflow + '/dispatches', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + c.ghToken, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'user-agent': 'edgedesk-desk-cron' },
    body: JSON.stringify({ ref: c.ref, inputs })
  });
  if (r.status === 204) return { ok: true, status: 204 };
  return { ok: false, status: r.status, error: scrub((await r.text()).slice(0, 200)) };
}

/* ------------------------------------------------------------- message */
export type Claimed = { id: number; article_key: string; type: string; title: string; lead: string; status: string };
/* Plain words, no mention pings, no em dashes. The owner opens the desk from
   the link; the message never carries a draft body. */
export function composeNotice(drafts: Claimed[], adminUrl: string): string {
  const n = drafts.length;
  const lines = drafts.slice(0, 10).map(d => {
    const label = TYPE_LABEL[d.type] || d.type;
    const when = d.status === 'published' ? 'newer data for a published article' : 'needs your take';
    return '- ' + label + ': ' + String(d.title).slice(0, 150) + ' (' + when + ')';
  });
  if (n > 10) lines.push('- and ' + (n - 10) + ' more');
  return (n === 1 ? 'A new desk draft is ready.' : n + ' new desk drafts are ready.') + ' Nothing publishes until you write your take.\n'
    + lines.join('\n') + '\n' + adminUrl;
}

async function sendOwner(c: Cfg, content: string): Promise<{ channel: string; ok: boolean; error?: string }> {
  if (c.dryRun) { console.log('DESK_DRY_RUN ' + JSON.stringify({ content })); return { channel: 'dry_run', ok: true }; }
  const body = JSON.stringify({ content: content.slice(0, 1900), allowed_mentions: { parse: [] } });
  if (c.botToken && c.ownerDiscordId) {
    const h = { authorization: 'Bot ' + c.botToken, 'content-type': 'application/json' };
    const ch = await fetch('https://discord.com/api/v10/users/@me/channels', { method: 'POST', headers: h, body: JSON.stringify({ recipient_id: c.ownerDiscordId }) });
    if (!ch.ok) return { channel: 'discord_dm', ok: false, error: 'open DM HTTP ' + ch.status + ': ' + scrub((await ch.text()).slice(0, 160)) };
    const id = (await ch.json() as { id?: string }).id;
    const m = await fetch('https://discord.com/api/v10/channels/' + id + '/messages', { method: 'POST', headers: h, body });
    return m.ok ? { channel: 'discord_dm', ok: true } : { channel: 'discord_dm', ok: false, error: 'send HTTP ' + m.status + ': ' + scrub((await m.text()).slice(0, 160)) };
  }
  if (c.ownerWebhook) {
    const r = await fetch(c.ownerWebhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    return r.ok ? { channel: 'discord_webhook', ok: true } : { channel: 'discord_webhook', ok: false, error: 'webhook HTTP ' + r.status };
  }
  return { channel: 'dashboard_only', ok: true };
}

export async function runNotify(c: Cfg) {
  if (c.dryRun) {
    return { ok: true, dry_run: true, note: 'dry run: nothing was claimed; the next live tick will announce whatever is waiting' };
  }
  const claim = await rpc(c, 'desk_notify_claim', { p_limit: 20 }) as { enabled: boolean; drafts: Claimed[] };
  if (!claim || !claim.enabled) return { ok: true, sent: 0, note: 'notifications are switched off in desk_settings' };
  const drafts = claim.drafts || [];
  if (!drafts.length) return { ok: true, sent: 0 };
  let out: { channel: string; ok: boolean; error?: string };
  try { out = await sendOwner(c, composeNotice(drafts, c.adminUrl)); }
  catch (e) { out = { channel: 'error', ok: false, error: scrub(String((e as Error)?.message ?? e)) }; }
  await rpc(c, 'desk_notify_done', { p_ids: drafts.map(d => d.id), p_channel: out.channel, p_ok: out.ok, p_error: out.error ?? null });
  return { ok: out.ok, sent: out.ok ? drafts.length : 0, channel: out.channel, error: out.error ?? null };
}

/* -------------------------------------------------------------- handle */
export async function handle(req: Request): Promise<Response> {
  const c = config();
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (req.method === 'GET') {
    return json({ build: BUILD, dry_run: c.dryRun, set: {
      DESK_CRON_SECRET: !!c.cronSecret, github_token: !!c.ghToken, DISCORD_BOT_TOKEN: !!c.botToken,
      DESK_OWNER_DISCORD_ID: !!c.ownerDiscordId, DISCORD_WEBHOOK_OWNER: !!c.ownerWebhook },
      notify_channel: c.botToken && c.ownerDiscordId ? 'discord_dm' : c.ownerWebhook ? 'discord_webhook' : 'dashboard_only' }, 200,
      /* the owner's settings tab reads this probe: booleans only, no values */
      { 'access-control-allow-origin': ORIGIN, 'vary': 'origin' });
  }
  if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);
  let body: { action?: string } = {};
  try { body = await req.json(); } catch (_) { return json({ ok: false, error: 'body must be JSON' }, 400); }
  try {
    if (body.action === 'publish_now') {
      const auth = req.headers.get('authorization') || '';
      const token = auth.replace(/^Bearer\s+/i, '');
      if (!token) return json({ ok: false, error: 'sign in first' }, 401, cors());
      let owner = false;
      try { owner = (await rpc(c, 'desk_is_owner', {}, token)) === true; } catch (_) { owner = false; }
      if (!owner) return json({ ok: false, error: 'owner only' }, 403, cors());
      const d = await dispatch(c, c.publishWorkflow, {});
      return json({ ok: d.ok, build: BUILD, dispatched: d.ok ? c.publishWorkflow : null, error: d.error ?? null }, d.ok ? 200 : 503, cors());
    }
    if (!safeEqual(req.headers.get('x-cron-secret') || '', c.cronSecret)) return json({ ok: false, error: 'not authorised' }, 401);
    if (body.action === 'generate') {
      const d = await dispatch(c, c.draftsWorkflow, { source: 'supabase_cron' });
      console.log('DESK_CRON ' + JSON.stringify({ build: BUILD, action: 'generate', ok: d.ok, status: d.status }));
      return json({ ok: d.ok, build: BUILD, dispatched: d.ok ? c.draftsWorkflow : null, error: d.error ?? null }, d.ok ? 200 : 503);
    }
    if (body.action === 'notify') {
      const out = await runNotify(c);
      console.log('DESK_CRON ' + JSON.stringify({ build: BUILD, action: 'notify', ok: out.ok, sent: (out as { sent?: number }).sent ?? 0 }));
      return json({ build: BUILD, ...out }, out.ok ? 200 : 503);
    }
    return json({ ok: false, error: 'action must be generate, notify or publish_now' }, 400);
  } catch (e) {
    return json({ ok: false, build: BUILD, error: scrub(String((e as Error)?.message ?? e)).slice(0, 300) }, 500);
  }
}

if (typeof (Deno as unknown as { serve?: unknown })?.serve === 'function') {
  Deno.serve((req) => handle(req));
}
