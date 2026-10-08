// ============================================================
//  FILE:    supabase/functions/growth_outbound_digest/index.ts
//  TYPE:    Edge Function (deployed) — the OWNER'S daily email:
//           "N drafts are waiting for your review"
//  DEPLOY:  supabase functions deploy growth_outbound_digest --no-verify-jwt
//           (pg_cron sends no JWT; its proof is a single-use ticket the
//           database minted, and the database checks it)
// ============================================================
// WHAT IT DOES, AND ALL IT DOES
//   POST { action: 'scheduled', ticket }   (pg_cron, through pg_net: the
//        tick, once a morning at most, when the morning run is done and
//        drafts wait for review — supabase/growth_outbound.sql, section 13)
//     1  asks the DATABASE to write today's note, through the ticket door
//        (growth_outbound_scheduled, door 'digest_compose'). The database
//        decides everything: the address (the confirmed address of the
//        outbound owner who turned the email on, never one typed in and
//        never a prospect's), and the words (counts only: no name, no
//        address, no draft). The ticket opens this door and the one below,
//        and nothing else: no draft, no prospect, no send.
//     2  checks the note is still exactly one EdgeDesk email to one person,
//        with no extra headers, and sends it through Resend;
//     3  tells the database what became of it (door 'digest_result'):
//        Resend's id, or why not and whether trying again is safe. A
//        timeout is NOT safe to retry (it may have gone): it is not sent
//        twice to find out.
//
// WHAT IT NEVER DOES: write to a prospect, read a draft, claim or record a
// send, count against the daily send cap, or answer a browser.
//
// WHAT IT HOLDS. The project URL, the PUBLIC anon key, and RESEND_API_KEY
// (already set for the newsletter and the send function: Supabase secrets are
// shared by every function). NO service-role key. Nothing it logs or returns
// contains a key, a ticket or an address.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_ANON_KEY   provided by the platform
//   RESEND_API_KEY                     the same key the send function uses
// ============================================================

const RESEND_URL = 'https://api.resend.com/emails';
const RESEND_TIMEOUT_MS = 15000;
const DB_TIMEOUT_MS = 10000;
const EMAIL = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const TICKET = /^[0-9a-f]{64}$/;

type Cfg = { url: string; anonKey: string; resendKey: string; fetch: typeof fetch; timeoutMs?: number; log?: (s: string) => void };

// Read PER CALL: a rotated key takes effect on the next request.
function config(): Cfg {
  // @ts-ignore Deno exists in the edge runtime
  const env = (k: string) => (typeof Deno !== 'undefined' ? Deno.env.get(k) : undefined) ?? '';
  return { url: env('SUPABASE_URL'), anonKey: env('SUPABASE_ANON_KEY'), resendKey: env('RESEND_API_KEY'), fetch: globalThis.fetch.bind(globalThis) };
}

// No CORS headers at all: a browser has no business here.
function json(out: unknown, status = 200): Response {
  return new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

// The ticket door, with the PUBLIC key: the ticket is the only credential,
// and the database checks it on every call.
async function door(c: Cfg, ticket: string, name: string, args: Record<string, unknown>): Promise<{ status: number; out: any }> {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, c.timeoutMs ?? DB_TIMEOUT_MS);
  try {
    const r = await c.fetch(c.url.replace(/\/+$/, '') + '/rest/v1/rpc/growth_outbound_scheduled', {
      method: 'POST',
      headers: { apikey: c.anonKey, authorization: 'Bearer ' + c.anonKey, 'content-type': 'application/json' },
      body: JSON.stringify({ p_ticket: ticket, p_door: name, p_args: args }),
      signal: ctl.signal,
    });
    let b: any = null;
    try { b = await r.json(); } catch (_) { b = null; }
    return { status: r.status, out: b };
  } catch (_) {
    return { status: 0, out: null };
  } finally {
    clearTimeout(t);
  }
}

// The database wrote the note; it goes only if it is still one plain
// EdgeDesk email to one address. Anything else is a bug or tampering.
export function checkDigest(m: any): string | null {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return 'no message';
  const extra = Object.keys(m).filter((k) => ['from', 'to', 'subject', 'text'].indexOf(k) < 0);
  if (extra.length) return 'unexpected fields';
  const one = (v: unknown) => typeof v === 'string' && !/[\r\n]/.test(v);
  if (!one(m.from) || !/^[^<>@,]{1,60} <[a-z0-9._%+-]+@edgedesksports\.com>$/.test(m.from)) return 'the sender is not an edgedesksports.com address';
  if (!one(m.to) || !EMAIL.test(m.to) || m.to.length > 254) return 'the recipient is not one email address';
  if (!one(m.subject) || !m.subject.trim() || m.subject.length > 150) return 'the subject is missing, too long or spans lines';
  if (typeof m.text !== 'string' || !m.text.trim() || m.text.length > 5000) return 'the body is missing or too long';
  return null;
}

async function resendSend(c: Cfg, idem: string, m: any): Promise<{ status: number; id?: string; message?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => { try { ctl.abort(); } catch (_) { /* gone */ } }, c.timeoutMs ?? RESEND_TIMEOUT_MS);
  try {
    const r = await c.fetch(RESEND_URL, {
      method: 'POST',
      headers: { authorization: 'Bearer ' + c.resendKey, 'content-type': 'application/json', 'idempotency-key': idem },
      body: JSON.stringify({
        from: m.from, to: [m.to], subject: m.subject, text: m.text,
        // edgedesk=outbound: the newsletter's webhook leaves its events alone
        tags: [{ name: 'edgedesk', value: 'outbound' }, { name: 'kind', value: 'owner_digest' }],
      }),
      signal: ctl.signal,
    });
    let b: any = null;
    try { b = await r.json(); } catch (_) { b = null; }
    return { status: r.status, id: b && typeof b.id === 'string' ? b.id : undefined, message: b && (b.message || b.name) ? String(b.message || b.name).slice(0, 200) : undefined };
  } catch (_) {
    return { status: 0 };
  } finally {
    clearTimeout(t);
  }
}

export async function handle(req: Request, cfg?: Cfg): Promise<Response> {
  const c = cfg ?? config();
  const log = c.log ?? ((s: string) => console.log(s));
  if (req.method !== 'POST') return json({ ok: false, reason: 'method_not_allowed' }, 405);
  // pg_net sends no Origin; a page in a browser always does
  if (req.headers.get('origin')) return json({ ok: false, reason: 'not_for_browsers' }, 403);
  if (!c.url || !c.anonKey) return json({ ok: false, reason: 'not_configured' }, 503);
  let input: any = null;
  try { input = await req.json(); } catch (_) { input = null; }
  if (!input || input.action !== 'scheduled') return json({ ok: false, reason: 'bad_request' }, 400);
  const ticket = typeof input.ticket === 'string' ? input.ticket : '';
  if (!TICKET.test(ticket)) return json({ ok: false, reason: 'invalid_ticket' }, 401);

  // 1  the database writes the note (and decides who it is for)
  const w = await door(c, ticket, 'digest_compose', {});
  if (w.status === 0) { log('growth_outbound_digest: database unreachable'); return json({ ok: false, reason: 'unavailable' }, 503); }
  if (w.status === 404) { log('growth_outbound_digest: the door is not installed (run supabase/growth_outbound.sql)'); return json({ ok: false, reason: 'not_installed' }, 503); }
  if (w.status < 200 || w.status >= 300 || !w.out || typeof w.out !== 'object') {
    log('growth_outbound_digest: the database answered ' + w.status);
    return json({ ok: false, reason: 'unavailable' }, 502);
  }
  if (w.out.ok !== true) {
    // nothing to send (turned off, nobody to send it to, nothing waiting):
    // the database has recorded why
    const why = String(w.out.reason || 'refused').slice(0, 40);
    log('growth_outbound_digest: not sent, ' + why);
    return json({ ok: false, reason: why }, why === 'invalid_ticket' ? 401 : why === 'not_allowed' ? 403 : 200);
  }
  const record = async (args: Record<string, unknown>): Promise<boolean> => {
    const r = await door(c, ticket, 'digest_result', args);
    return r.status >= 200 && r.status < 300 && !!r.out && r.out.ok === true;
  };
  const m = w.out.message;
  const bad = w.out.kind !== 'owner_digest' ? 'not a daily email' : checkDigest(m);
  if (bad) {
    await record({ p_error: 'not sent: ' + bad, p_retryable: false });
    log('growth_outbound_digest: not sent, the message check failed');
    return json({ ok: false, reason: 'message_check_failed', detail: bad }, 500);
  }
  if (!c.resendKey) {
    await record({ p_error: 'RESEND_API_KEY is not set for the Edge Functions', p_retryable: true });
    log('growth_outbound_digest: RESEND_API_KEY is not set');
    return json({ ok: false, reason: 'resend_not_configured' }, 503);
  }

  // 2  Resend
  const idem = typeof w.out.idempotency_key === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(w.out.idempotency_key) ? w.out.idempotency_key : 'edgedesk-outbound-digest-' + String(w.out.digest_id);
  const r = await resendSend(c, idem, m);

  // 3  what became of it
  if (r.status >= 200 && r.status < 300 && r.id) {
    const ok = await record({ p_message_id: r.id });
    log('growth_outbound_digest: sent' + (ok ? '' : ', not recorded'));
    return json({ ok: true, sent: true, recorded: ok });
  }
  // a timeout or a dropped connection: it may have gone, so it is not tried again
  const retryable = r.status !== 0 && r.status !== 400 && r.status !== 422;
  const why = r.status === 0 ? 'Resend did not answer: it may have gone, so it is not sent again'
    : r.status === 401 || r.status === 403 ? 'Resend refused the API key (' + r.status + ')'
    : 'Resend answered ' + r.status + (r.message ? ': ' + r.message : '');
  await record({ p_error: why, p_retryable: retryable });
  log('growth_outbound_digest: not sent, Resend status ' + r.status);
  return json({ ok: false, reason: r.status === 0 ? 'resend_unreachable' : 'resend_' + r.status, retry: retryable }, 502);
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve((req: Request) => handle(req));
}
