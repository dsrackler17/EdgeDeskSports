// ============================================================
//  FILE:    supabase/functions/growth_outbound_webhook/index.ts
//  TYPE:    Edge Function (deployed) — relays Resend's events about
//           OUTBOUND email to the database, which checks the signature
//  DEPLOY:  supabase functions deploy growth_outbound_webhook --no-verify-jwt
//           (Resend sends no Supabase token; its proof is its signature)
// ============================================================
// WHAT IT DOES, AND ALL IT DOES
//   POST from Resend (Svix): the raw body, untouched, and the three signature
//   headers go to public.growth_outbound_webhook(), called with the PUBLIC
//   anon key. The DATABASE checks the signature against the secret it holds
//   (set once in the SQL editor), refuses anything not signed by Resend
//   within five minutes, ignores a repeat of an event it has seen, and only
//   then applies it: delivered, bounced (a hard bounce suppresses the
//   address), complained (suppressed), opened, clicked.
//
// WHY IT HOLDS NO SECRET. Not the signing secret, not a service-role key, not
// the Resend key: the only key it has is the public one. If this function
// were replaced by anything at all, the database would still refuse every
// delivery Resend did not sign. The function cannot be the weak link.
//
// ANSWERS (Resend retries anything that is not 2xx)
//   200  applied, or a repeat, or about an email this engine did not send
//   400  signed, but the body is not a JSON object (a retry will not help)
//   401  not signed by Resend — nothing was read or kept
//   405  not a POST
//   413  over 256 KB (Resend's events are a few KB)
//   503  the database is unreachable or the SQL is not installed (retry)
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the platform. Nothing else.
// ============================================================

const MAX_BODY = 262144;
const DB_TIMEOUT_MS = 10000;

type Cfg = { url: string; anonKey: string; fetch: typeof fetch; timeoutMs?: number; log?: (s: string) => void };

function config(): Cfg {
  // @ts-ignore Deno exists in the edge runtime
  const env = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';
  return { url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY'), fetch: globalThis.fetch.bind(globalThis) };
}

// No CORS headers at all: a browser has no business here.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// Svix sends svix-*; the Standard Webhooks names are the same scheme.
function header(req: Request, name: string): string {
  return (req.headers.get('svix-' + name) ?? req.headers.get('webhook-' + name) ?? '').trim();
}

export async function relay(c: Cfg, id: string, ts: string, sig: string, body: string): Promise<{ status: number; body: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, c.timeoutMs ?? DB_TIMEOUT_MS);
  try {
    const r = await c.fetch(c.url.replace(/\/+$/, '') + '/rest/v1/rpc/growth_outbound_webhook', {
      method: 'POST',
      headers: { apikey: c.anonKey, authorization: 'Bearer ' + c.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_id: id, p_timestamp: ts, p_signature: sig, p_body: body }),
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

export async function handle(req: Request, cfg?: Cfg): Promise<Response> {
  const c = cfg ?? config();
  const log = c.log ?? ((s: string) => console.log(s));
  if (req.method !== 'POST') return json({ ok: false }, 405);
  if (!c.url || !c.anonKey) return json({ ok: false, reason: 'not_configured' }, 503);

  const len = Number(req.headers.get('content-length') ?? '0');
  if (len > MAX_BODY) return json({ ok: false, reason: 'too_large' }, 413);
  const id = header(req, 'id'), ts = header(req, 'timestamp'), sig = header(req, 'signature');
  // Without the three headers it is not from Resend: refused before the
  // database is asked anything.
  if (!id || !ts || !sig || id.length > 200 || ts.length > 20 || sig.length > 2000) return json({ ok: false }, 401);
  // The body exactly as it arrived: the signature covers these bytes.
  let raw: string;
  try { raw = await req.text(); } catch (_) { return json({ ok: false }, 400); }
  if (raw.length > MAX_BODY) return json({ ok: false, reason: 'too_large' }, 413);

  const r = await relay(c, id, ts, sig, raw);
  if (r.status === 0) { log('growth_outbound_webhook: database unreachable'); return json({ ok: false, reason: 'unavailable' }, 503); }
  if (r.status === 404) { log('growth_outbound_webhook: the door is not installed (run supabase/growth_outbound.sql)'); return json({ ok: false, reason: 'unavailable' }, 503); }
  if (r.status < 200 || r.status >= 300 || !r.body || typeof r.body !== 'object') {
    log('growth_outbound_webhook: the database answered ' + r.status);
    return json({ ok: false, reason: 'unavailable' }, 503);
  }
  const b = r.body;
  if (b.verified === false) {
    // the reason is for the owner's logs (a missing secret, a clock, a wrong
    // secret); the caller learns only that it was refused
    log('growth_outbound_webhook: refused, ' + String(b.reason ?? 'unverified').slice(0, 60));
    return json({ ok: false }, 401);
  }
  if (b.ok !== true) return json({ ok: false, reason: String(b.reason ?? 'refused').slice(0, 40) }, b.reason === 'too_large' ? 413 : 400);
  return json({ ok: true });
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req));
}
