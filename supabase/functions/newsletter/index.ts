// ============================================================
//  FILE:    supabase/functions/newsletter/index.ts
//  TYPE:    Edge Function (deployed) — the newsletter's PUBLIC door
//  DEPLOY:  supabase functions deploy newsletter --no-verify-jwt
// ============================================================
// EVERYTHING A BROWSER OR A MAIL CLIENT TOUCHES IS HERE, and nothing else is.
// public.newsletter_subscribers has row level security on and NO select policy
// for any client role, so a page cannot read it, cannot write it, and cannot
// enumerate it. This function holds the service role and is the only path in.
//
// ROUTES  (all under /functions/v1/newsletter)
//   POST /subscribe      { email, cfb, nfl }  -> creates a PENDING row and
//                        emails a confirmation link. Always answers the same
//                        way whether or not the address was already known,
//                        because a different answer is an enumeration oracle.
//   GET  /confirm?t=     double opt-in. Renders a page.
//   GET  /unsubscribe?t= renders a confirmation page with a one-click button
//   POST /unsubscribe?t= THE RFC 8058 ENDPOINT. A mail client posts here with
//                        `List-Unsubscribe=One-Click` in the body and expects
//                        a 2xx. It must work with no cookie, no session and no
//                        JavaScript, which is why it is a raw POST handler.
//   GET  /preferences?t= the preference page
//   POST /preferences    { t, cfb, nfl }
//   POST /webhook        provider events, SIGNATURE VERIFIED, deduplicated
//   POST /dispatch       OPERATOR ONLY. Asks GitHub to run the newsletter
//                        workflow — a preview, a test send or a retry of the
//                        failed deliveries. The caller's OWN bearer token is
//                        checked against newsletter_is_admin() before the
//                        GitHub token is touched, so the browser never holds
//                        a credential and a non-operator gets 403.
//
// WHY THE UNSUBSCRIBE TOKEN IS IN THE URL AND NOTHING ELSE IS. It identifies
// one subscriber row and confers exactly two powers: stop sending, and change
// which sport. The pages it opens show a MASKED address. There is no login to
// steal and nothing to escalate to.
//
// ENVIRONMENT
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   provided by the platform
//   RESEND_API_KEY            required to send the confirmation email
//   NEWSLETTER_WEBHOOK_SECRET the provider's signing secret (whsec_...)
//   NEWSLETTER_SITE_URL       defaults to https://edgedesksports.com
//   NEWSLETTER_FROM           defaults to the row in newsletter_settings
// ============================================================

// Configuration is read PER CALL, not at module load: an edge instance is
// long-lived, so a rotated key takes effect on the next invocation rather
// than waiting for a redeploy.
function config() {
  return {
    url: Deno.env.get('SUPABASE_URL') ?? '',
    serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    resendKey: Deno.env.get('RESEND_API_KEY') ?? '',
    webhookSecret: Deno.env.get('NEWSLETTER_WEBHOOK_SECRET') ?? '',
    site: Deno.env.get('NEWSLETTER_SITE_URL') ?? 'https://edgedesksports.com',
    fromOverride: Deno.env.get('NEWSLETTER_FROM') ?? '',
    functionBase: Deno.env.get('NEWSLETTER_FUNCTION_URL')
      ?? ((Deno.env.get('SUPABASE_URL') ?? '') + '/functions/v1/newsletter'),
    ghToken: Deno.env.get('NEWSLETTER_GH_TOKEN') ?? '',
    ghRepo: Deno.env.get('NEWSLETTER_GH_REPO') ?? 'dsrackler17/EdgeDeskSports',
    workflow: Deno.env.get('NEWSLETTER_WORKFLOW') ?? 'newsletter.yml',
    ref: Deno.env.get('NEWSLETTER_REF') ?? 'main',
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

async function rpc(c: Cfg, name: string, body: unknown) {
  const r = await sbFor(c)(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const text = await r.text();
  if (!r.ok) throw new Error(`${name} -> ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function settings(c: Cfg) {
  try {
    const r = await sbFor(c)('newsletter_settings?select=*&id=eq.1');
    if (!r.ok) return null;
    const rows = await r.json();
    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (_) { return null; }
}

// ---------------------------------------------------------------- pages ---
// The site's own tokens, inlined. These pages are reached from an email, so
// they load nothing: no font, no script, no stylesheet.
const T = {
  ink: '#100e0a', panel: '#191510', line: '#332a1b',
  text: '#f1ebdf', dim: '#a29581', faint: '#6f6553',
  obs: '#2fa79a', onAccent: '#042320', neg: '#e2664b',
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";

function esc(s: unknown): string {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function page(title: string, bodyHtml: string, site: string, status = 200): Response {
  const html = `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${esc(title)} — EdgeDesk</title>
<style>
 body{margin:0;background:${T.ink};color:${T.text};font-family:${SANS};line-height:1.6;-webkit-font-smoothing:antialiased}
 .wrap{max-width:560px;margin:0 auto;padding:44px 20px 60px}
 .mk{display:inline-block;width:10px;height:19px;background:${T.obs};border-radius:2px;transform:skewX(-11deg);vertical-align:-3px;margin-right:9px}
 h1{font-size:23px;letter-spacing:-.02em;margin:26px 0 10px}
 p{color:${T.dim};font-size:15px;margin:0 0 14px}
 .card{background:${T.panel};border:1px solid ${T.line};border-radius:12px;padding:18px;margin:18px 0}
 label{display:flex;gap:11px;align-items:flex-start;padding:10px 0;cursor:pointer;color:${T.text};font-size:15px}
 input[type=checkbox]{width:18px;height:18px;margin-top:2px;accent-color:${T.obs}}
 button{background:${T.obs};color:${T.onAccent};border:0;border-radius:9px;font:inherit;font-weight:700;font-size:15px;padding:12px 20px;cursor:pointer}
 button.ghost{background:transparent;color:${T.text};border:1px solid ${T.line}}
 a{color:${T.obs}} .f{color:${T.faint};font-size:12.5px;margin-top:26px}
 .bad{color:${T.neg}}
</style></head><body><div class="wrap">
<div><span class="mk"></span><b style="font-size:17px">EdgeDesk</b>
<span style="color:${T.faint};font-size:11px;letter-spacing:.14em;text-transform:uppercase;margin-left:8px">Research, not picks</span></div>
${bodyHtml}
<div class="f">EdgeDesk Sports · research and information only, not betting advice.
21+ · 1-800-GAMBLER · <a href="${esc(site)}/privacy.html">Privacy</a> ·
<a href="${esc(site)}/terms.html">Terms</a></div>
</div></body></html>`;
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

function json(body: unknown, status = 200, extra?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors(), ...(extra ?? {}) },
  });
}
function cors(): Record<string, string> {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,authorization,apikey',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
  };
}

// ------------------------------------------------------- the confirm mail --
function confirmEmail(link: string, cfb: boolean, nfl: boolean, site: string, address: string) {
  const which = cfb && nfl ? 'College football and NFL' : cfb ? 'College football' : 'NFL';
  const text = [
    'EdgeDesk — confirm your research newsletter',
    '',
    'Somebody (we hope you) asked for the EdgeDesk week-ahead research email:',
    '  ' + which,
    '',
    'Confirm here — the link works once and expires in seven days:',
    link,
    '',
    'If this was not you, ignore this email. Nothing is sent until the link above is opened.',
    '',
    'EdgeDesk publishes research, not picks. No guaranteed outcomes, no profit claims.',
    address,
  ].join('\n');
  const html = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml"><head><meta http-equiv="Content-Type" content="text/html; charset=utf-8" /></head>
<body style="margin:0;padding:0;background-color:${T.ink};">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background-color:${T.ink};"><tr><td align="center" style="padding:0;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="width:600px;max-width:600px;">
<tr><td style="padding:28px 24px;font-family:${SANS};color:${T.text};">
<div style="font-size:17px;font-weight:800;">EdgeDesk</div>
<div style="font-family:ui-monospace,monospace;font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:${T.obs};padding-top:6px;">Research, not picks</div>
<div style="font-size:22px;font-weight:800;padding-top:22px;">Confirm your research newsletter</div>
<div style="font-size:15px;line-height:1.6;color:${T.dim};padding-top:12px;">
Somebody (we hope you) asked for the EdgeDesk week-ahead research email: <b style="color:${T.text};">${esc(which)}</b>.
Nothing is sent until you confirm.</div>
<div style="padding:22px 0;"><a href="${esc(link)}" style="display:inline-block;background-color:${T.obs};color:${T.onAccent};font-weight:700;font-size:15px;text-decoration:none;padding:13px 22px;border-radius:9px;">Confirm my subscription</a></div>
<div style="font-size:12.5px;line-height:1.6;color:${T.faint};">The link works once and expires in seven days. If this was not you, ignore this email — no newsletter is sent.</div>
<div style="font-size:12.5px;line-height:1.6;color:${T.faint};padding-top:16px;">${esc(address)}</div>
<div style="font-size:12.5px;line-height:1.6;color:${T.faint};padding-top:8px;">Research and information only. Not betting advice. 21+ &middot; 1-800-GAMBLER</div>
</td></tr></table></td></tr></table></body></html>`;
  return { html, text };
}

async function sendMail(c: Cfg, s: Record<string, unknown> | null, to: string, subject: string, body: { html: string; text: string }) {
  if (!c.resendKey) return { ok: false, reason: 'no_api_key' };
  const from = c.fromOverride
    || `${(s?.from_name as string) ?? 'EdgeDesk Research'} <${(s?.from_email as string) ?? 'research@edgedesksports.com'}>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${c.resendKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from, to: [to], subject, html: body.html, text: body.text,
      reply_to: (s?.reply_to_email as string) ?? undefined,
    }),
  });
  if (!r.ok) return { ok: false, reason: `provider ${r.status}`, detail: (await r.text()).slice(0, 200) };
  return { ok: true };
}

// ------------------------------------------------------ webhook signature --
// Svix, which is what Resend signs with. The signed content is
// `<id>.<timestamp>.<raw body>`; the header may carry several `v1,<sig>`
// values because a secret rotation publishes both.
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export async function verifySignature(raw: string, headers: Headers, secret: string, nowMs?: number) {
  if (!secret) return { ok: false, reason: 'no_secret_configured' };
  const id = headers.get('svix-id') ?? headers.get('webhook-id');
  const ts = headers.get('svix-timestamp') ?? headers.get('webhook-timestamp');
  const sig = headers.get('svix-signature') ?? headers.get('webhook-signature');
  if (!id || !ts || !sig) return { ok: false, reason: 'missing_signature_headers' };
  const t = Number(ts);
  if (!Number.isFinite(t)) return { ok: false, reason: 'unreadable_timestamp' };
  const now = Math.floor((nowMs ?? Date.now()) / 1000);
  // A REPLAY IS THE ATTACK THIS STOPS: a captured, validly signed delivery
  // replayed a week later would re-apply a bounce that has since been cleared.
  if (Math.abs(now - t) > 300) return { ok: false, reason: 'timestamp_outside_tolerance' };

  const key = await crypto.subtle.importKey('raw', b64ToBytes(secret.replace(/^whsec_/, '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${ts}.${raw}`));
  const expected = bytesToB64(new Uint8Array(mac));
  const given = sig.split(' ').map((p) => p.split(',').pop() ?? '');
  return given.some((g) => timingSafeEqual(g, expected))
    ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}

// The provider's vocabulary mapped onto the five states this system tracks.
// An unknown type is STORED and not acted on.
const EVENTS: Record<string, { status: string | null; suppress: string | null }> = {
  'email.sent': { status: 'accepted', suppress: null },
  'email.delivered': { status: 'delivered', suppress: null },
  'email.delivery_delayed': { status: null, suppress: null },
  'email.bounced': { status: 'bounced', suppress: 'bounce' },
  'email.complained': { status: 'complained', suppress: 'complaint' },
  'email.opened': { status: null, suppress: null },
  'email.clicked': { status: null, suppress: null },
};

// ------------------------------------------------------------- the routes --
async function handleSubscribe(c: Cfg, req: Request): Promise<Response> {
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch (_) { /* fall through to the validator */ }
  const email = String(body.email ?? '').trim().toLowerCase();
  const cfb = body.cfb === true || body.cfb === 'true';
  const nfl = body.nfl === true || body.nfl === 'true';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ ok: false, reason: 'invalid_email' }, 400);
  if (!cfb && !nfl) return json({ ok: false, reason: 'no_sport_selected' }, 400);
  // CONSENT MUST BE EXPLICIT AND RECORDED. The page sends `consent: true` from
  // a checkbox the reader ticks; without it there is nothing to record and the
  // signup is refused rather than assumed.
  if (body.consent !== true && body.consent !== 'true') return json({ ok: false, reason: 'consent_required' }, 400);

  const s = await settings(c);
  let out: Record<string, unknown>;
  try {
    out = await rpc(c, 'newsletter_signup', {
      p_email: email, p_wants_cfb: cfb, p_wants_nfl: nfl,
      p_source: String(body.source ?? 'public_form').slice(0, 60),
      p_user_agent: (req.headers.get('user-agent') ?? '').slice(0, 300),
      // The address is hashed before it is stored: enough to see two signups
      // came from one place, useless to anybody who steals the table.
      p_ip_hash: await sha256Hex((req.headers.get('x-forwarded-for') ?? '').split(',')[0].trim()),
    });
  } catch (e) {
    return json({ ok: false, reason: 'signup_failed', detail: String(e).slice(0, 200) }, 500);
  }

  // THE SAME ANSWER EVERY TIME. Whether the address was new, already pending
  // or already confirmed, the caller is told "check your email". A different
  // response per state would turn this endpoint into an address checker.
  if (out?.confirm_token) {
    const link = `${c.functionBase}/confirm?t=${encodeURIComponent(String(out.confirm_token))}`;
    const mail = confirmEmail(link, cfb, nfl, c.site,
      (s?.mailing_address as string) ?? 'Rackler Tech Ventures LLC, 2013 89th St, Lubbock, TX 79423');
    const sent = await sendMail(c, s, email, 'Confirm your EdgeDesk research newsletter', mail);
    if (!sent.ok) return json({ ok: false, reason: 'confirmation_email_failed', detail: sent.reason }, 502);
  }
  return json({ ok: true, state: 'check_your_email' });
}

async function sha256Hex(s: string): Promise<string | null> {
  if (!s) return null;
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function handleConfirm(c: Cfg, url: URL): Promise<Response> {
  const t = url.searchParams.get('t') ?? '';
  const out = await rpc(c, 'newsletter_confirm', { p_token: t });
  if (!out?.ok) {
    return page('Link not valid', `<h1>That link is not valid</h1>
<p>${out?.reason === 'token_expired'
  ? 'Confirmation links expire after seven days.'
  : 'It may have already been used, or it may have been copied incompletely.'}</p>
<p><a href="${esc(c.site)}/newsletter/">Sign up again</a></p>`, c.site, 400);
  }
  const which = out.wants_cfb && out.wants_nfl ? 'college football and the NFL'
    : out.wants_cfb ? 'college football' : 'the NFL';
  return page('Subscribed', `<h1>You are subscribed</h1>
<p>${esc(String(out.email_masked ?? 'Your address'))} will get the EdgeDesk week-ahead research email for ${esc(which)}.</p>
<p>College football arrives Monday at 10:00 AM Central. The NFL edition arrives Tuesday at 10:00 AM Central, after Monday Night Football.</p>
<div class="card"><p style="margin:0">It is research, not picks: five to ten games worth your own time, EdgeDesk's number against the market's, what the model can see and what it cannot.</p></div>
<p><a href="${esc(c.functionBase)}/preferences?t=${encodeURIComponent(String(out.manage_token ?? ''))}">Change your preferences</a> ·
<a href="${esc(c.site)}/articles">Read the research</a></p>`, c.site);
}

function prefsPage(c: Cfg, token: string, state: Record<string, unknown>): Response {
  const cfb = state.wants_cfb ? ' checked' : '';
  const nfl = state.wants_nfl ? ' checked' : '';
  return page('Email preferences', `<h1>Email preferences</h1>
<p>${esc(String(state.email_masked ?? ''))}</p>
<form method="POST" action="${esc(c.functionBase)}/preferences">
<input type="hidden" name="t" value="${esc(token)}">
<div class="card">
  <label><input type="checkbox" name="cfb" value="1"${cfb}><span><b>College Football Week Ahead</b><br><span style="color:${T.faint};font-size:13px">Mondays, 10:00 AM Central</span></span></label>
  <label><input type="checkbox" name="nfl" value="1"${nfl}><span><b>NFL Week Ahead</b><br><span style="color:${T.faint};font-size:13px">Tuesdays, 10:00 AM Central, after Monday Night Football</span></span></label>
</div>
<button type="submit">Save preferences</button>
</form>
<p style="margin-top:20px"><a href="${esc(c.functionBase)}/unsubscribe?t=${encodeURIComponent(token)}">Unsubscribe from everything</a></p>`, c.site);
}

async function handlePreferences(c: Cfg, req: Request, url: URL): Promise<Response> {
  if (req.method === 'GET') {
    const t = url.searchParams.get('t') ?? '';
    const state = await rpc(c, 'newsletter_preferences_get', { p_token: t });
    if (!state?.ok) {
      return page('Link not valid', `<h1>That link is not valid</h1>
<p>It may have been copied incompletely. <a href="${esc(c.site)}/newsletter/">Sign up again</a></p>`, c.site, 400);
    }
    return prefsPage(c, t, state);
  }
  const form = await readBody(req);
  const t = String(form.t ?? url.searchParams.get('t') ?? '');
  const out = await rpc(c, 'newsletter_preferences_set', {
    p_token: t,
    p_wants_cfb: form.cfb === '1' || form.cfb === true || form.cfb === 'true',
    p_wants_nfl: form.nfl === '1' || form.nfl === true || form.nfl === 'true',
  });
  if (!out?.ok) return page('Link not valid', '<h1>That link is not valid</h1>', c.site, 400);
  if (out.state === 'unsubscribed') {
    return page('Unsubscribed', `<h1>Unsubscribed</h1>
<p>${esc(String(out.email_masked ?? ''))} will receive no further EdgeDesk research emails.</p>
<p><a href="${esc(c.site)}/newsletter/">Subscribe again</a></p>`, c.site);
  }
  return page('Saved', `<h1>Preferences saved</h1>
<p>${esc(String(out.email_masked ?? ''))} now receives ${out.wants_cfb && out.wants_nfl
    ? 'both editions' : out.wants_cfb ? 'the college football edition' : 'the NFL edition'}.</p>
<p><a href="${esc(c.functionBase)}/preferences?t=${encodeURIComponent(t)}">Change again</a></p>`, c.site);
}

async function handleUnsubscribe(c: Cfg, req: Request, url: URL): Promise<Response> {
  const t = url.searchParams.get('t') ?? '';
  const sport = (url.searchParams.get('sport') ?? 'all').toUpperCase();

  if (req.method === 'POST') {
    // RFC 8058 ONE-CLICK. The mail client posts `List-Unsubscribe=One-Click`
    // and wants a 2xx; it renders nothing, so the response body does not
    // matter and a redirect would break it. A POST here is unconditional:
    // the reader used their client's own unsubscribe control.
    const body = await readBody(req);
    const scope = body['List-Unsubscribe'] === 'One-Click' ? 'all' : (String(body.scope ?? sport));
    const out = await rpc(c, 'newsletter_unsubscribe', {
      p_token: t, p_scope: scope, p_source: 'one_click',
    });
    if (!out?.ok) return json({ ok: false, reason: out?.reason ?? 'unknown_token' }, 400);
    return json({ ok: true, state: out.state });
  }

  // A GET is a person following the link in the footer. Unsubscribing them
  // straight from a GET would let a mail scanner that prefetches links do it
  // for them, so this ASKS — with the sport-only option beside it.
  const state = await rpc(c, 'newsletter_preferences_get', { p_token: t });
  if (!state?.ok) {
    return page('Link not valid', `<h1>That link is not valid</h1>
<p>It may have been copied incompletely.</p>`, c.site, 400);
  }
  const sportLabel = sport === 'CFB' ? 'college football' : sport === 'NFL' ? 'the NFL' : null;
  return page('Unsubscribe', `<h1>Unsubscribe</h1>
<p>${esc(String(state.email_masked ?? ''))}</p>
<form method="POST" action="${esc(c.functionBase)}/unsubscribe?t=${encodeURIComponent(t)}">
<input type="hidden" name="scope" value="all">
<div class="card"><p style="margin:0 0 12px">Stop all EdgeDesk research emails to this address.</p>
<button type="submit">Unsubscribe from everything</button></div>
</form>
${sportLabel ? `<form method="POST" action="${esc(c.functionBase)}/unsubscribe?t=${encodeURIComponent(t)}">
<input type="hidden" name="scope" value="${esc(sport)}">
<div class="card"><p style="margin:0 0 12px">Or stop only the ${esc(sportLabel)} edition and keep the other one.</p>
<button class="ghost" type="submit">Unsubscribe from ${esc(sportLabel)} only</button></div></form>` : ''}
<p><a href="${esc(c.functionBase)}/preferences?t=${encodeURIComponent(t)}">Change preferences instead</a></p>`, c.site);
}

async function handleWebhook(c: Cfg, req: Request): Promise<Response> {
  const raw = await req.text();
  const check = await verifySignature(raw, req.headers, c.webhookSecret);
  // A BAD SIGNATURE IS A 401 AND NOTHING IS STORED. Storing it "for
  // investigation" would let anybody fill this table.
  if (!check.ok) return json({ ok: false, reason: check.reason }, 401);

  let payload: Record<string, unknown>;
  try { payload = JSON.parse(raw); } catch (_) { return json({ ok: false, reason: 'unparseable' }, 400); }

  const type = String(payload.type ?? '');
  const data = (payload.data ?? {}) as Record<string, unknown>;
  const to = Array.isArray(data.to) ? String(data.to[0]) : (data.to ? String(data.to) : null);
  const messageId = String(data.email_id ?? data.id ?? '') || null;
  const eventId = req.headers.get('svix-id') ?? req.headers.get('webhook-id');

  // DUPLICATES ARE THE NORMAL CASE, not the exception: every provider worth
  // using retries. The unique index on (provider, event_id) makes the second
  // delivery a no-op, and `ignore-duplicates` makes that a 201 rather than a
  // conflict the provider would keep retrying.
  const ins = await sbFor(c)('newsletter_events?on_conflict=provider,event_id', {
    method: 'POST',
    headers: { prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify([{
      provider: 'resend', event_id: eventId, event_type: type,
      email: to ? to.toLowerCase() : null, message_id: messageId, payload,
    }]),
  });
  const inserted = ins.ok ? await ins.json() : [];
  if (!Array.isArray(inserted) || !inserted.length) {
    return json({ ok: true, state: 'duplicate_ignored', type });
  }

  const map = EVENTS[type];
  if (!map) {
    await markProcessed(c, inserted[0].id, 'event type not in the handled set; stored only');
    return json({ ok: true, state: 'stored_unhandled', type });
  }

  // DELIVERY STATE, per recipient. Matched on the provider's message id,
  // which is what this system stored when the provider accepted the send.
  if (map.status && messageId) {
    await sbFor(c)(`newsletter_deliveries?provider_message_id=eq.${encodeURIComponent(messageId)}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ status: map.status, ambiguous: false }),
    });
  }

  // SUPPRESSION. A complaint always suppresses. A bounce suppresses only when
  // it is permanent: a full mailbox is not a dead address, and suppressing on
  // a soft bounce loses subscribers who did nothing wrong.
  if (map.suppress && to) {
    const bounce = (data.bounce ?? {}) as Record<string, unknown>;
    const permanent = type !== 'email.bounced'
      || !/transient|soft/i.test(String(bounce.type ?? data.bounce_type ?? 'permanent'));
    if (permanent) {
      await rpc(c, 'newsletter_suppress', {
        p_email: to, p_reason: map.suppress,
        p_detail: String(bounce.subType ?? bounce.type ?? type).slice(0, 200),
        p_event_id: eventId,
      });
    }
  }
  await markProcessed(c, inserted[0].id, `applied ${type}`);
  return json({ ok: true, state: 'processed', type });
}

// ------------------------------------------------- the operator controls --
// AUTHORISATION IS THE CALLER'S OWN TOKEN, NOT A SHARED SECRET. The bearer
// token from the browser is used to call newsletter_is_admin(), which is
// security-definer over the same operator allowlist the article manager uses.
// Only after that answers true is the GitHub token — which the browser has
// never seen and never will — used to start the workflow.
async function callerIsAdmin(c: Cfg, req: Request): Promise<boolean> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();
  // The anon key is not a person. A request carrying it is anonymous, and an
  // anonymous caller is never an operator.
  if (!token || token === (Deno.env.get('SUPABASE_ANON_KEY') ?? '')) return false;
  try {
    const r = await fetch(`${c.url}/rest/v1/rpc/newsletter_is_admin`, {
      method: 'POST',
      headers: {
        apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? token,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: '{}',
    });
    if (!r.ok) return false;
    return (await r.json()) === true;
  } catch (_) { return false; }
}

const DISPATCH_PHASES = ['preview', 'build', 'test', 'send', 'retry', 'rank', 'due'];

async function handleDispatch(c: Cfg, req: Request): Promise<Response> {
  if (!(await callerIsAdmin(c, req))) return json({ ok: false, reason: 'not_authorised' }, 403);
  const body = await readBody(req);
  const phase = String(body.phase ?? 'preview');
  if (DISPATCH_PHASES.indexOf(phase) < 0) return json({ ok: false, reason: 'unknown_phase', phase }, 400);
  if (!c.ghToken) return json({ ok: false, reason: 'no_gh_token' }, 503);
  const inputs: Record<string, string> = { phase, source: 'admin' };
  const sport = String(body.sport ?? '').toUpperCase();
  if (sport === 'CFB' || sport === 'NFL') inputs.sport = sport;
  // A TEST SEND MAY NAME ONE ADDRESS and nothing else: it is added to the
  // stored test recipients, never substituted for the subscriber list.
  if (phase === 'test' && body.to) inputs.to = String(body.to).slice(0, 120);
  if (body.force === true || body.force === 'true') inputs.force = 'true';

  const res = await fetch(
    `https://api.github.com/repos/${c.ghRepo}/actions/workflows/${c.workflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${c.ghToken}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'edgedesk-newsletter-admin',
      },
      body: JSON.stringify({ ref: c.ref, inputs }),
    },
  );
  if (res.status === 204) return json({ ok: true, state: 'dispatched', phase, inputs });
  return json({ ok: false, reason: `workflow_dispatch -> ${res.status}`,
    detail: (await res.text().catch(() => '')).slice(0, 300) }, 502);
}

async function markProcessed(c: Cfg, id: number, note: string) {
  try {
    await sbFor(c)(`newsletter_events?id=eq.${id}`, {
      method: 'PATCH', headers: { prefer: 'return=minimal' },
      body: JSON.stringify({ processed_at: new Date().toISOString(), process_note: note }),
    });
  } catch (_) { /* the event is stored; a note that did not stick is cosmetic */ }
}

// A body that may be JSON or a form post, because a mail client's one-click
// request is `application/x-www-form-urlencoded` and a page's fetch is JSON.
async function readBody(req: Request): Promise<Record<string, unknown>> {
  const ct = (req.headers.get('content-type') ?? '').toLowerCase();
  try {
    if (ct.includes('application/json')) return await req.json();
    const text = await req.text();
    const out: Record<string, unknown> = {};
    new URLSearchParams(text).forEach((v, k) => { out[k] = v; });
    return out;
  } catch (_) { return {}; }
}

export async function handle(req: Request): Promise<Response> {
  const c = config();
  const url = new URL(req.url);
  // The function name is the first path segment Supabase strips; anything
  // after it is ours.
  const route = url.pathname.replace(/^\/functions\/v1\/newsletter/, '').replace(/\/+$/, '') || '/';

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors() });
  if (!c.url || !c.serviceKey) return json({ ok: false, reason: 'not_configured' }, 503);

  try {
    if (route === '/subscribe' && req.method === 'POST') return await handleSubscribe(c, req);
    if (route === '/confirm') return await handleConfirm(c, url);
    if (route === '/unsubscribe') return await handleUnsubscribe(c, req, url);
    if (route === '/preferences') return await handlePreferences(c, req, url);
    if (route === '/webhook' && req.method === 'POST') return await handleWebhook(c, req);
    if (route === '/dispatch' && req.method === 'POST') return await handleDispatch(c, req);
    if (route === '/health') {
      return json({ ok: true, routes: ['/subscribe', '/confirm', '/unsubscribe', '/preferences', '/webhook', '/dispatch'] });
    }
  } catch (e) {
    return json({ ok: false, reason: 'unhandled', detail: String(e).slice(0, 300) }, 500);
  }
  return json({ ok: false, reason: 'unknown_route', route }, 404);
}

// @ts-ignore Deno.serve exists in the edge runtime
if (typeof Deno !== 'undefined' && typeof (Deno as { serve?: unknown }).serve === 'function') {
  // @ts-ignore
  Deno.serve(handle);
}
