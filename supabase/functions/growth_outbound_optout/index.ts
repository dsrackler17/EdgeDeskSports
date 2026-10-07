// ============================================================
//  FILE:    supabase/functions/growth_outbound_optout/index.ts
//  TYPE:    Edge Function (deployed) — the opt-out link in every outbound
//           email, and its RFC 8058 one-click endpoint
//  DEPLOY:  supabase functions deploy growth_outbound_optout --no-verify-jwt
//           (the person opting out has no account; the proof is the token)
// ============================================================
// EVERY OUTBOUND EMAIL carries its own link, …/growth_outbound_optout?t=<64
// hex>, in the footer and in the List-Unsubscribe header. The token belongs
// to that one send; its ONLY power is to stop all email to the address that
// send went to.
//
//   POST ?t=   THE RFC 8058 ONE-CLICK ENDPOINT. Gmail, Yahoo and Apple Mail
//              post `List-Unsubscribe=One-Click` here when the reader uses
//              their own unsubscribe control. No cookie, no session, no
//              JavaScript: the token in the URL is the request. The address
//              is suppressed for good and every unsent draft cancelled.
//   GET  ?t=   A PERSON following the footer link. Nothing changes on a GET —
//              a mail scanner that prefetches links must not unsubscribe
//              anybody. Supabase serves an Edge Function's HTML as plain text
//              on GET, so this redirects (303) to a small static page on
//              edgedesksports.com, the token in the FRAGMENT (#t=…, never
//              sent to any server or in a Referer). That page shows the
//              masked address and asks; its button calls the same database
//              door this POST does.
//
// WHAT IT HOLDS. The project URL and the PUBLIC anon key. The door,
// public.growth_outbound_optout(), checks the token's form and that a send
// carries it, answers with a MASKED address only, and changes nothing for a
// test send.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the platform. Nothing else.
//   OUTBOUND_OPTOUT_PAGE              optional; defaults to
//                                     https://edgedesksports.com/email/stop/
// ============================================================

const TOKEN = /^[0-9a-f]{64}$/;
const DB_TIMEOUT_MS = 10000;

type Cfg = { url: string; anonKey: string; page: string; fetch: typeof fetch; timeoutMs?: number; log?: (s: string) => void };

function config(): Cfg {
  // @ts-ignore Deno exists in the edge runtime
  const env = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';
  return { url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY'),
    page: env('OUTBOUND_OPTOUT_PAGE') || 'https://edgedesksports.com/email/stop/', fetch: globalThis.fetch.bind(globalThis) };
}

function text(body: string, status = 200): Response {
  return new Response(body + '\n', { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
}

export async function optout(c: Cfg, token: string): Promise<{ status: number; body: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, c.timeoutMs ?? DB_TIMEOUT_MS);
  try {
    const r = await c.fetch(c.url.replace(/\/+$/, '') + '/rest/v1/rpc/growth_outbound_optout', {
      method: 'POST',
      headers: { apikey: c.anonKey, authorization: 'Bearer ' + c.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_token: token, p_confirm: true }),
      signal: ctl.signal,
    });
    let b: any = null;
    try { b = await r.json(); } catch (_) { b = null; }
    return { status: r.status, body: b };
  } catch (_) {
    return { status: 0, body: null };
  } finally {
    clearTimeout(t);
  }
}

// The token from the query string, or from a form field (a client that posts
// the form instead). Lower-cased hex only; anything else is not a token.
async function tokenOf(req: Request, url: URL): Promise<string> {
  let t = url.searchParams.get('t') ?? '';
  if (!t && req.method === 'POST') {
    try {
      const raw = (await req.text()).slice(0, 4096);
      t = new URLSearchParams(raw).get('t') ?? '';
    } catch (_) { t = ''; }
  }
  return t.trim().toLowerCase();
}

export async function handle(req: Request, cfg?: Cfg): Promise<Response> {
  const c = cfg ?? config();
  const log = c.log ?? ((s: string) => console.log(s));
  const url = new URL(req.url);

  if (req.method === 'GET' || req.method === 'HEAD') {
    // nothing changes on a GET: the page asks first
    const t = (url.searchParams.get('t') ?? '').trim().toLowerCase();
    const to = c.page + (TOKEN.test(t) ? '#t=' + t : '');
    return new Response(null, { status: 303, headers: { location: to, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
  }
  if (req.method !== 'POST') return text('Not allowed.', 405);
  if (!c.url || !c.anonKey) return text('Unavailable. Reply STOP to the email instead.', 503);

  const t = await tokenOf(req, url);
  if (!TOKEN.test(t)) return text('That link is not valid. Reply STOP to the email instead.', 400);
  const r = await optout(c, t);
  if (r.status === 0 || r.status === 404 || r.status >= 500 || !r.body || typeof r.body !== 'object') {
    log('growth_outbound_optout: the database answered ' + r.status);
    return text('Unavailable for a moment. Try again, or reply STOP to the email.', 503);
  }
  if (r.body.ok !== true) return text('That link is not valid. Reply STOP to the email instead.', 400);
  if (r.body.test) return text('That was a test email. Nothing was changed.');
  return text('Done. EdgeDesk will not email ' + String(r.body.masked ?? 'this address').slice(0, 120) + ' again.');
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req));
}
