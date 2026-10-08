#!/usr/bin/env node
/* ===========================================================================
   PHASE 11 — WHATEVER ARRIVES: the outbound database fed malformed,
   hostile and random input (supabase/growth_outbound.sql).

   Seeded, so a failure is reproducible: FUZZ_SEED=<n> node … replays it.
   Every case runs inside one guarded call (fz.try), so a raised error is
   caught, recorded and reported with the input that caused it.

     H  HELPERS     the text helpers never fail, whatever the text:
                    tag_links (idempotent; leaves text without an EdgeDesk
                    link, or with a bad campaign code, exactly as it was),
                    draft_lint, canonical_url (idempotent), url_identity,
                    norm_email (idempotent), quote_in, greeting_problem,
                    uncited_details, uncited_sentences
     P  PUBLIC      the three doors anyone may knock on — webhook, opt-out,
                    scheduled — answer every junk request without an error
                    and write NOTHING without their proof
     O  OWNER       the owner's doors answer junk with a refusal, never an
                    error: settings, prospects, evidence, drafts, batches,
                    suppressions, lookups, candidates, the results window
     I  INJECTION   quotes, dollar quotes, backslashes, comment markers and
                    statement separators are data, never code: every table
                    still there, nothing dropped

   Run: node tools/growth/outbound_fuzz_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const crypto = require('crypto');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED_ = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound fuzz SQL');
const chk = T.chk;
const lit = PG.lit;

const db = PG.start('gofuzz');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const SEED = +(process.env.FUZZ_SEED || 20261008);
const N = +(process.env.FUZZ_N || 300);
const OWNER = '00000000-0000-0000-0000-0000000000a1';
const SECRET = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const J = (o) => '$fz$' + JSON.stringify(o) + '$fz$::jsonb';

/* ── a seeded generator ─────────────────────────────────────────────── */
let state = SEED >>> 0;
function rnd() { state = (state + 0x6D2B79F5) >>> 0; let t = state; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }
const pick = (a) => a[Math.floor(rnd() * a.length)];
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const PIECES = ['a', 'Z', '7', ' ', '  ', '\n', '\t', '.', ',', ';', ':', '!', '?', "'", '"', '`', '(', ')', '[', ']', '{', '}', '<', '>', '/', '\\', '|', '&', '%', '$',
  '#', '@', '*', '+', '-', '=', '_', '~', '^', 'é', 'ñ', 'ß', '中文', '😀', '‮', '​', ' ',
  'https://', 'http://', 'edgedesksports.com', 'EdgeDeskSports.COM', 'www.', '/', '?utm_source=x', '?a=1&b=2', '#frag', '.com', ':443', '.evil.test',
  'https://edgedesksports.com/', 'https://www.edgedesksports.com/pricing?x=1#y', 'mailto:', '@', 'pat@cfbnumbers.test', '.test',
  "'; drop table growth_outbound.prospects; --", '$$', '$fz', '$q$', '\\x00', '%s', '%I', '{{first_name}}', '[name]', 'lock', 'guaranteed', '$19', '$49.99',
  '14-day free trial', 'Hi Pat,', 'Pat', 'CFB', '2024', 'your model', 'null', 'true', '-1', '1e309', '9999999999999999999999'];
function str(maxPieces) {
  const n = int(0, maxPieces || 12);
  let s = '';
  for (let i = 0; i < n; i++) s += pick(PIECES);
  return s.replace(/\$fz\$/g, '$f$');
}
function jval(depth) {
  const d = depth || 0;
  const r = rnd();
  if (r < 0.2) return str(6);
  if (r < 0.32) return pick([0, 1, -1, 7, 49.99, 1e9, -1e9, 3.5, 2147483648]);
  if (r < 0.4) return pick([true, false]);
  if (r < 0.46) return null;
  if (r < 0.6 && d < 2) return Array.from({ length: int(0, 3) }, () => jval(d + 1));
  if (d < 2) { const o = {}; for (let i = int(0, 4); i > 0; i--) o[pick(['a', 'url', 'email', 'claim', 'text', 'evidence_id', str(2)])] = jval(d + 1); return o; }
  return str(3);
}
function obj(keys) { const o = {}; keys.forEach((k) => { if (rnd() < 0.6) o[k] = jval(1); }); if (rnd() < 0.2) o[str(2) || 'x'] = jval(1); return o; }
const hex = (n) => crypto.randomBytes(n).toString('hex');
/* near-valid input: the right shape, any one part wrong — what reaches past the first check */
const FIELDS = ['full_name', 'organization', 'job_title', 'email', 'project', 'article', 'podcast', 'newsletter', 'model', 'topic', 'sports_focus',
  'audience_size', 'fit_signal'];
const KINDS = ['own_site', 'own_profile', 'publication', 'interview', 'directory', 'owner_verified', 'pattern_guess', 'provider_verified', 'provider_found'];
const maybe = (good, p) => (rnd() < (p || 0.8) ? good : jval(1));
// a coherent fact (claim in the excerpt, on a page of the right kind), then — half the time — one part of it replaced by junk
const GOOD_EV = [
  { field_name: 'full_name', claim: 'Pat Analyst', source_url: 'https://cfbnumbers.test/about', source_kind: 'own_site', source_excerpt: 'I am Pat Analyst, founder of CFB Numbers' },
  { field_name: 'organization', claim: 'CFB Numbers', source_url: 'https://x.com/patanalyst', source_kind: 'own_profile', source_excerpt: 'founder, CFB Numbers' },
  { field_name: 'project', claim: 'weekly CFB power ratings', source_url: 'https://cfbnumbers.test/ratings', source_kind: 'own_site', source_excerpt: 'Our weekly CFB power ratings, updated Monday' },
  { field_name: 'topic', claim: 'closing line value', source_url: 'https://podnews.test/ep1', source_kind: 'publication', source_excerpt: 'Pat talks closing line value', source_published_at: '2026-09-01' },
  { field_name: 'audience_size', claim: '12500', source_url: 'https://cfbnumbers.test/', source_kind: 'own_site', source_excerpt: 'with 12,500 subscribers' }];
function evItem() {
  const e = Object.assign({}, pick(GOOD_EV));
  if (rnd() < 0.5) e[pick(['field_name', 'claim', 'source_url', 'source_kind', 'source_excerpt', 'source_published_at'])] =
    pick([jval(1), str(4), -1000000000, '9999-99-99', '2026-02-30', 'javascript:alert(1)', 1e308, [], {}]);
  return e;
}
const nearProspect = () => ({ email: maybe(pick(['p' + int(1, 99) + '@cfbnumbers.test', 'PAT@CFBNumbers.test', 'not an email', str(3)])),
  urls: maybe([pick(['https://cfbnumbers.test', 'https://' + int(1, 99) + '.example.test', 'https://x.com/p' + int(1, 99), str(3)])]),
  prospect_type: maybe(pick(['cfb_analyst', 'podcast', 'other'])),
  sports_focus: maybe(['CFB']), evidence: Array.from({ length: int(0, 4) }, evItem),
  fit_factors: rnd() < 0.5 ? [{ code: maybe(pick(['quant_analysis', 'covers_cfb', 'touting'])), evidence: [maybe(int(1, 40))] }] : undefined });
const nearDraft = () => ({ sequence_number: maybe(pick([1, 2, 3]), 0.85), subject: maybe(pick(['Your ratings', 'A research tool for your work', str(4)])),
  body_text: maybe('Hi Pat,\n\n' + pick(['I read your CFB power ratings against the market.', str(10)]) + ' Try it free for 7 days at https://edgedesksports.com/ (then $49.99/month).'),
  claims: maybe([{ text: maybe('CFB power ratings against the market'), evidence_id: maybe(int(1, 12)) }]) });

/* run a batch of SQL expressions, each guarded; returns the failures (in chunks, so one slow stretch shows) */
function guarded(role, exprs) {
  if (exprs.length > 400) {
    let all = [];
    for (let k = 0; k < exprs.length; k += 400) all = all.concat(guarded(role, exprs.slice(k, k + 400)).map((x) => Object.assign(x, { i: x.i + k })));
    return all;
  }
  const arr = JSON.stringify(exprs).replace(/\$fz\$/g, '$f$');
  const sql = `select coalesce(jsonb_agg(jsonb_build_object('i', x.i, 'q', left(x.q, 300), 'err', r->>'err', 'state', r->>'state')) filter (where not (r->>'ok')::boolean), '[]')
                 from jsonb_array_elements_text($fz$${arr}$fz$::jsonb) with ordinality x(q, i), lateral fz.try(x.q) r;`;
  const out = role === 'owner' ? db.as(OWNER, sql) : role === 'anon' ? db.anon(sql) : one(sql);
  return j(out);
}
// each %L filled in turn, as a quoted literal (a replacer function: a '$' in the value is just a '$')
const q = (fmt, ...args) => { let k = 0; return fmt.replace(/%L/g, () => { const a = args[k++]; return a === null ? 'null' : "'" + String(a).replace(/'/g, "''") + "'"; }); };
const counts = () => one(`select (select count(*) from growth_outbound.provider_events) || '|' || (select count(*) from growth_outbound.suppressions)
  || '|' || (select count(*) from growth_outbound.activity) || '|' || (select count(*) from growth_outbound.research_runs)
  || '|' || (select count(*) from growth_outbound.candidates) || '|' || (select count(*) from growth_outbound.pages)
  || '|' || (select count(*) from growth_outbound.drafts) || '|' || (select count(*) from growth_outbound.evidence)
  || '|' || (select string_agg(delivery_status || coalesce(opened_at::text, ''), ',' order by id) from growth_outbound.sends);`);

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at, created_at) values ('${OWNER}', 'owner@edgedesk.test', now(), now() - interval '1 year');
       insert into public.affiliate_admins (user_id) values ('${OWNER}');
       select growth_outbound.grant_owner('owner@edgedesk.test');
       select growth_outbound.set_webhook_secret(${lit(SECRET)});`);
  // the guard: runs one statement as its caller, catches anything it raises
  one(`create schema fz; grant usage on schema fz to anon, authenticated;
       create function fz.try(q text) returns jsonb language plpgsql as $f$
       declare r text;
       begin
         execute q into r;
         return jsonb_build_object('ok', true);
       exception when others then
         return jsonb_build_object('ok', false, 'err', sqlerrm, 'state', sqlstate);
       end $f$;
       grant execute on function fz.try(text) to anon, authenticated;`);
  db.as(OWNER, `select public.growth_outbound_settings_update('{"postal_address": "EdgeDesk Sports, 100 Example St, Springfield, IL 62701", "test_inbox": "owner-test@edgedesk.test", "unsubscribe_url_base": "https://iattxbkbufslbauoumga.supabase.co/functions/v1/"}'::jsonb);`);
  one(SEED_.strong({ id: '10000000-0000-0000-0000-000000000001', name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@cfbnumbers.test', domain: 'cfbnumbers.test', handle: 'patanalyst' })
    + SEED_.draft({ id: '20000000-0000-0000-0000-000000000001', prospect: '10000000-0000-0000-0000-000000000001', subject: 'Your ratings', body: 'Hi Pat, try https://edgedesksports.com/.' }));
  const P1 = '10000000-0000-0000-0000-000000000001', D1 = '20000000-0000-0000-0000-000000000001';
  ['Kim Ratings', 'Lee Lines', 'Ola Reed', 'Uma Ward', 'Vic Stone'].forEach((nm, k) => {
    const [f, l] = nm.split(' '), dom = (f + l).toLowerCase() + '.test';
    one(SEED_.strong({ id: '10000000-0000-0000-0000-00000000000' + (k + 2), name: nm, org: l + ' Media', email: f.toLowerCase() + '@' + dom, domain: dom, handle: (f + l).toLowerCase() }));
  });
  const PS = [1, 2, 3, 4, 5, 6].map((k) => '10000000-0000-0000-0000-00000000000' + k);
  const TABLES = one(`select count(*) from pg_tables where schemaname = 'growth_outbound';`);

  /* ══ H. HELPERS ═══════════════════════════════════════════════════════ */
  const texts = Array.from({ length: N }, () => str(20));
  const CODE = 'ob_0123456789abcdef0123456789abcdef';
  const H = [];
  texts.forEach((t) => {
    const c = pick([CODE, 'ob_test', CODE, str(3), null]);
    H.push(q("select growth_outbound.tag_links(%L, %L)", t, c));
    H.push(q("select growth_outbound.draft_lint(%L, %L)::text", str(5), t));
    H.push(q("select growth_outbound.canonical_url(%L)", t));
    H.push(q("select count(*) from growth_outbound.url_identity(%L)", t));
    H.push(q("select growth_outbound.norm_email(%L)", t));
    H.push(q("select growth_outbound.quote_in(%L, %L)", str(6), t));
    H.push(q("select growth_outbound.greeting_problem(%L, %L)", t, pick(['Pat', null, str(2)])));
    H.push(q("select growth_outbound.uncited_details(%L, %L)::text", t, str(6)));
    H.push(q("select growth_outbound.uncited_sentences(%L, array[%L])::text", t, str(4)));
  });
  let bad = guarded('super', H);
  chk('H ' + H.length + ' calls of the text helpers on random text: none fails', bad.length === 0, bad.slice(0, 5));

  // properties, checked in the database over the same texts
  const props = j(one(`with t(x, c) as (select x, c from jsonb_to_recordset($fz$${JSON.stringify(texts.map((x, i) => ({ x, c: i % 3 === 0 ? 'ob_test' : CODE }))).replace(/\$fz\$/g, '$f$')}$fz$::jsonb) as r(x text, c text))
    select jsonb_build_object(
      'tag_idem', count(*) filter (where growth_outbound.tag_links(growth_outbound.tag_links(x, c), c) is distinct from growth_outbound.tag_links(x, c)),
      'tag_untouched', count(*) filter (where x !~* 'edgedesksports\\.com' and growth_outbound.tag_links(x, c) is distinct from x),
      'tag_badcode', count(*) filter (where growth_outbound.tag_links(x, 'ob_x&utm=1') is distinct from x),
      'canon_idem', count(*) filter (where growth_outbound.canonical_url(x) is not null
                                       and growth_outbound.canonical_url(growth_outbound.canonical_url(x)) is distinct from growth_outbound.canonical_url(x)),
      'norm_idem', count(*) filter (where growth_outbound.norm_email(growth_outbound.norm_email(x)) is distinct from growth_outbound.norm_email(x)),
      'tagged_links', count(*) filter (where growth_outbound.tag_links(x, c) is distinct from x)) from t;`));
  chk('H tag_links is idempotent: tagging tagged text changes nothing', props.tag_idem === 0, props);
  chk('H … text without an EdgeDesk link comes back exactly as it went in', props.tag_untouched === 0, props);
  chk('H … and a campaign code that is not ob_<letters and digits> changes nothing at all', props.tag_badcode === 0, props);
  chk('H … (and the fuzz did tag links: the property was exercised)', props.tagged_links > 10, props);
  chk('H canonical_url is idempotent', props.canon_idem === 0, props);
  chk('H norm_email is idempotent', props.norm_idem === 0, props);

  /* ══ P. THE PUBLIC DOORS ══════════════════════════════════════════════ */
  const before = counts();
  const P = [];
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < N; i++) {
    const body = rnd() < 0.5 ? JSON.stringify({ type: pick(['email.delivered', 'email.bounced', 'email.opened', 'email.complained', str(2)]), data: jval(1) }) : str(15);
    P.push(q("select public.growth_outbound_webhook(%L, %L, %L, %L)", pick([str(4), 'msg_' + hex(8), '', null]),
      pick([String(now), String(now - 10000), str(2), '', null, '99999999999999999999']), pick(['v1,' + Buffer.from(hex(32), 'hex').toString('base64'), str(5), '', null, 'v1,' + str(3) + ' v1,' + str(2)]), body));
    P.push(q("select public.growth_outbound_optout(%L, %L)", pick([hex(32), hex(32).toUpperCase(), str(6), '', null, hex(31) + 'g']), pick(['true', 'false'])));
    P.push(q("select public.growth_outbound_scheduled(%L, %L, %L::jsonb)", pick([hex(32), str(6), '', null]),
      pick(['growth_outbound_candidates_record', 'growth_outbound_draft_approve', 'growth_outbound_send_claim', 'growth_outbound_settings_update', str(3), 'plan', '']),
      JSON.stringify(jval(1) || {})));
  }
  bad = guarded('anon', P);
  chk('P ' + P.length + ' junk requests to the webhook, opt-out and scheduled doors, as anyone: every one answered, none fails', bad.length === 0, bad.slice(0, 5));
  chk('P … and nothing was written: no event, suppression, activity, run, candidate, page, draft or evidence; no send moved', counts() === before, [before, counts()]);
  // a well-formed but forged webhook: Resend's format, the wrong secret
  const id = 'msg_forged', ts = String(now), wb = JSON.stringify({ type: 'email.bounced', data: { email_id: 're_x', bounce: { type: 'Permanent' } } });
  const forged = 'v1,' + crypto.createHmac('sha256', Buffer.from('not-the-secret')).update(id + '.' + ts + '.' + wb).digest('base64');
  const r = j(db.anon(`select public.growth_outbound_webhook(${lit(id)}, ${lit(ts)}, ${lit(forged)}, ${lit(wb)});`));
  chk('P a forged webhook in Resend\'s exact format: refused, nothing kept', r.ok === false && r.verified === false && counts() === before, r);

  /* ══ O. THE OWNER'S DOORS ═════════════════════════════════════════════ */
  const SETTING_KEYS = ['automation_enabled', 'test_mode', 'test_inbox', 'daily_prospect_target', 'max_sends_per_day', 'max_test_sends_per_day', 'min_fit_score',
    'min_identity_confidence', 'followup_enabled', 'followup_delay_days', 'sender_name', 'sender_email', 'reply_to_email', 'cta_url', 'business_name',
    'postal_address', 'unsubscribe_url_base', 'discovery_config', 'automation_timezone', 'automation_start_hour', 'automation_hours', 'attribution_links'];
  const O = [];
  const NO = Math.ceil(N / 2);
  for (let i = 0; i < NO; i++) {
    O.push(q("select public.growth_outbound_settings_update(%L::jsonb)", JSON.stringify(obj(SETTING_KEYS))));
    O.push(q("select public.growth_outbound_prospect_upsert(%L::jsonb)", JSON.stringify(obj(['email', 'website_url', 'x_url', 'prospect_type', 'sports_focus', 'evidence', 'fit_factors', 'campaign_type']))));
    O.push(q("select public.growth_outbound_evidence_add(%L, %L::jsonb)", P1, JSON.stringify(obj(['evidence', 'fit_factors', 'urls']))));
    O.push(q("select public.growth_outbound_draft_create(%L, %L::jsonb)", P1, JSON.stringify(obj(['sequence_number', 'subject', 'body_text', 'claims', 'campaign_type']))));
    O.push(q("select public.growth_outbound_drafts_approve_batch(%L::jsonb, %L)", JSON.stringify(jval(0)), String(int(-1, 30))));
    O.push(q("select public.growth_outbound_suppress(%L, %L, %L)", pick(['address', 'domain', str(2)]), str(6), pick(['manual', 'do_not_contact', str(2)])));
    O.push(q("select public.growth_outbound_identity_lookup(%L)", str(10)));
    O.push(q("select public.growth_outbound_draft_edit(%L, %L, %L, %L)", D1, str(8), str(30), pick([str(3), hex(32)])));
    O.push(q("select public.growth_outbound_prospect_set_status(%L, %L, %L)", P1, pick(['qualified', 'contacted', str(3), 'converted']), str(5)));
    O.push(q("select public.growth_outbound_analytics(%L)", String(pick([0, -5, 1, 90, 400, 2147483647]))));
    O.push(q("select public.growth_outbound_research_begin(%L, %L::jsonb)", pick(['discover', 'research', 'draft', str(2)]), JSON.stringify(jval(1) || {})));
    O.push(q("select public.growth_outbound_prospect_upsert(%L::jsonb)", JSON.stringify(nearProspect())));
    O.push(q("select public.growth_outbound_evidence_add(%L, %L::jsonb)", pick(PS), JSON.stringify({ evidence: Array.from({ length: int(1, 3) }, evItem) })));
    O.push(q("select public.growth_outbound_draft_create(%L, %L::jsonb)", P1, JSON.stringify(nearDraft())));
  }
  // the engine's own doors, inside live runs of each kind
  const RUN = {};
  ['discover', 'research', 'draft'].forEach((k) => { RUN[k] = j(db.as(OWNER, `select public.growth_outbound_research_begin('${k}', '{}'::jsonb);`)).run_id; });
  for (let i = 0; i < NO; i++) {
    const run = pick([RUN.discover, RUN.research, RUN.draft, 999999]);
    O.push(q("select public.growth_outbound_page_record(%L, %L::jsonb)", String(pick([RUN.research, RUN.discover, run])),
      JSON.stringify({ url: maybe(pick(['https://cfbnumbers.test/about', 'https://' + int(1, 9) + '.example.test/p', str(3)])), http_status: maybe(pick([200, 404, 999, -1])),
        content_type: maybe('text/html'), title: maybe(str(4)), text: maybe(pick(['I am Pat Analyst, founder of CFB Numbers. ' + str(6), str(12)])) })));
    O.push(q("select public.growth_outbound_candidates_record(%L, %L::jsonb)", String(run), JSON.stringify(Array.from({ length: int(0, 4) },
      () => ({ url: maybe('https://' + int(1, 50) + '.cand.test/' + str(1)), provider: maybe(pick(['brave', 'Brave!', str(2)])), title: maybe(str(4)), snippet: maybe(str(8)), query: maybe(str(4)) })))));
    O.push(q("select public.growth_outbound_research_ingest(%L, null, %L, %L, %L::jsonb)", String(pick([RUN.research, run])), pick(PS),
      pick(['research_engine', 'provider:hunter', str(2)]), JSON.stringify({ evidence: Array.from({ length: int(0, 3) }, () => Object.assign(evItem(), { page_id: maybe(int(1, 30)) })) })));
    O.push(q("select public.growth_outbound_research_spend(%L, %L, %L)", String(run), pick(['search', 'fetch', 'llm', 'email_finder', str(2)]), String(pick([1, 0, -3, 1000000]))));
    O.push(q("select public.growth_outbound_draft_propose(%L, %L, %L::jsonb)", String(pick([RUN.draft, run])), P1,
      JSON.stringify(Object.assign(nearDraft(), { generator: maybe(pick(['engine:claude:p1', 'engine:template:p1', str(2)])) }))));
    O.push(q("select public.growth_outbound_draft_gave_up(%L, %L, %L, %L::jsonb)", String(pick([RUN.draft, run])), P1, String(pick([1, 2, 3, 9])), JSON.stringify(jval(1) || [])));
    O.push(q("select public.growth_outbound_draft_context(%L, %L)", P1, String(pick([1, 2, 3, 0, 99]))));
  }
  // what the fuzz once found, kept as a fixed case: a numeric date (a time-zone displacement out of range) is refused in words
  O.push(q("select public.growth_outbound_evidence_add(%L, %L::jsonb)", P1, JSON.stringify({ evidence: [Object.assign({}, GOOD_EV[0], { source_published_at: -1000000000 })] })));
  bad = guarded('owner', O);
  const fixedCase = j(db.as(OWNER, q("select public.growth_outbound_evidence_add(%L, %L::jsonb)", P1, JSON.stringify({ evidence: [Object.assign({}, GOOD_EV[0], { source_published_at: -1000000000 })] }))));
  chk('O the case the fuzz found (a date of -1000000000): refused in words, as invalid', fixedCase.ok === false && fixedCase.reason === 'invalid', fixedCase);
  const made = +one(`select count(*) from growth_outbound.prospects;`), evs = +one(`select count(*) from growth_outbound.evidence;`);
  chk('O ' + O.length + ' junk calls to the owner\'s doors: refused in words, none fails', bad.length === 0, bad.slice(0, 6));
  chk('O … and the settings still hold every rule (sender on EdgeDesk\'s domain, the cap within its ceiling)',
    one(`select sender_email ~ '@edgedesksports\\.com$' and max_sends_per_day between 1 and 200 and cta_url ~ '^https://(www\\.)?edgedesksports\\.com' from growth_outbound.settings;`) === 't');
  chk('O … (the near-valid inputs got through: prospects and evidence were made, so the deep paths ran)', made > 3 && evs > 40, { made, evs });
  chk('O … and no junk call approved or sent anything', +one(`select count(*) from growth_outbound.drafts where status in ('approved', 'sent');`) === 0
    && +one(`select count(*) from growth_outbound.sends;`) === 0);

  /* ══ I. INJECTION ═════════════════════════════════════════════════════ */
  chk('I every table is still there, and the prospect rows with it', one(`select count(*) from pg_tables where schemaname = 'growth_outbound';`) === TABLES
    && +one(`select count(*) from growth_outbound.prospects;`) >= 1);
  const out = db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'growth_outbound.sql'));
  chk('I the file runs again over all of this, every report row ok', !/CHECK THIS/.test(out), out.split('\n').filter((l) => /CHECK THIS/.test(l)));
} catch (err) {
  chk('suite ran to the end', false, String(err && err.stack || err).slice(0, 3000));
} finally {
  db.stop();
}
process.exit(T.done('seed ' + SEED + ', ' + N + ' cases per family (FUZZ_SEED and FUZZ_N replay or widen it)'));
