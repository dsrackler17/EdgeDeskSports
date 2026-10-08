#!/usr/bin/env node
/* ===========================================================================
   supabase/content_engine_evidence.sql against a real PostgreSQL, on top of
   supabase/content_engine.sql (the order the owner applies them in).

     F  FILE     no psql meta-commands; idempotent; the report reads ok
     K  KINDS    a matchup analysis topic and both analysis formats are allowed
     E  FLOOR    no approval without the football evidence gate in the stored
                 checks, never when the gate blocked; a held article may be
                 approved once the owner has reviewed it
     B  BUDGET   the optional monthly cap refuses the call that would exceed it
     U  USAGE    tokens are recorded and priced with growth_outbound.model_price
     M  METRICS  owner-only; editorial and traffic apart; unmeasured is null

   Run: node tools/content/content_engine_evidence_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('content engine evidence SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'content_engine_evidence.sql');
const SQL = fs.readFileSync(FILE, 'utf8');
chk('F no psql meta-commands', !/^\s*\\/m.test(SQL));
chk('F ends in a report', /select check_name, case when passed then 'ok' else 'CHECK THIS' end/.test(SQL));
chk('F refuses to run before content_engine.sql', /apply supabase\/content_engine\.sql first/.test(SQL));

const db = PG.start('ceevidence');
if (db.skip) { console.log((process.env.CONTENT_PG_REQUIRED ? 'FAIL | ' : 'NOTE | ') + db.skip + ' — skipped'); if (process.env.CONTENT_PG_REQUIRED) process.exit(1); process.exit(T.done()); }

const lit = PG.lit;
const OWNER = '00000000-0000-0000-0000-0000000000e1';
const J = (s) => (s === '' ? null : JSON.parse(s));
const own = (s) => J(db.as(OWNER, s));
const svc = (s) => J(db.service(s));
const one = (s) => db.sql(s);
const fails = (fn) => db.mustFail(fn);
const REVIEW = { source_verification: true, data_freshness: true, model_accuracy: true, seo_review: true, compliance: true, notes: 'evidence record checked' };
const SECTIONS = [{ key: 'intro', heading: null, body: 'Ole Miss visits Vanderbilt. A projection is not a bet.' }];
const GATE_CHECK = { id: 'football_evidence', status: 'pass', label: 'Football evidence, not just the projection', gate: 'evidence' };

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'funnel.sql', 'growth_outbound.sql', 'growth_engine.sql', 'content_engine.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  const rep1 = db.applyFileAtomic(FILE), rep2 = db.applyFileAtomic(FILE);
  const bad = (r) => r.split('\n').filter((l) => l && !/\|ok\|/.test(l));
  chk('F the report reads ok', bad(rep1).length === 0 && rep1.split('\n').filter(Boolean).length >= 5, bad(rep1));
  chk('F applied twice: still ok', bad(rep2).length === 0);
  chk('F … and the core file can be re-applied, then this one again', (() => { db.applyFileAtomic(path.join(PG.ROOT, 'supabase', 'content_engine.sql')); return bad(db.applyFileAtomic(FILE)).length === 0; })());

  one(`insert into auth.users (id, email, email_confirmed_at) values (${lit(OWNER)}, 'owner@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values (${lit(OWNER)});
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  const SR = (own('select public.content_engine_publishers();') || []).find((p) => p.slug === 'stadium-rant');

  /* ── K kinds and formats ──────────────────────────────────────────── */
  const opp = { key: 'cfb:2026:w6:matchup_analysis:401856718', league: 'cfb', season: 2026, week: 6, kind: 'matchup_analysis', title: 'Ole Miss vs. Vanderbilt: Can Vanderbilt’s Pass Rush Get to Chambliss?',
    angle: 'a', summary: 's', teams: ['Vanderbilt', 'Ole Miss'], research: { as_of: '2026-10-08T20:07:42Z', games: [{ home: 'Vanderbilt', away: 'Ole Miss' }] }, research_hash: 'h',
    sources: [{ kind: 'edgedesk_research', url: 'https://edgedesksports.com/football/evidence/packets.json', as_of: '2026-10-08T20:07:42Z' }],
    scores: { total: 70 }, priority: 70, formats: ['matchup_analysis', 'edgedesk_analysis'], expires_at: '2099-01-01T00:00:00Z' };
  const u = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp))}::jsonb, null);`);
  chk('K a matchup analysis topic is recorded', u && u.ok === true, u);
  const content = (extra) => Object.assign({ title: 'Ole Miss vs. Vanderbilt: Can Vanderbilt’s Pass Rush Get to Chambliss?', slug: 'ole-miss-vs-vanderbilt-pass-rush',
    meta_description: 'm', standfirst: 's', primary_keyword: 'ole miss vs vanderbilt prediction', secondary_keywords: [], sections: SECTIONS, word_count: 12,
    generator: 'template:content_engine_v2', checks: { ok: true, failed: [], warned: [], readiness: 'HOLD_FOR_REVIEW', checks: [GATE_CHECK] } }, extra || {});
  const pa = own(`select public.content_engine_article_create(${lit(u.id)}, ${lit(SR.id)}, 'matchup_analysis', 'full_slate', ${lit(JSON.stringify(content()))}::jsonb, null);`);
  chk('K the publisher format is allowed', pa && pa.ok, pa);
  const fp = own(`select public.content_engine_article_create(${lit(u.id)}, null, 'edgedesk_analysis', 'full_slate', ${lit(JSON.stringify(content({ slug: 'ole-miss-vs-vanderbilt-prediction' })))}::jsonb, null);`);
  chk('K the first-party format is allowed', fp && fp.ok, fp);
  chk('K an unknown format is still refused', !!fails(() => one(`insert into content_engine.articles (opportunity_id, format, title, slug, sections, generator, research_hash, campaign_code, created_by)
     values (${lit(u.id)}, 'listicle', 'A title of length', 'a-title', '[{"key":"intro","body":"x"}]'::jsonb, 'gen', 'h', 'ce_x_y', 'owner');`)));

  /* ── E the floor ──────────────────────────────────────────────────── */
  const hashOf = (id) => one(`select content_hash from content_engine.articles where id = ${lit(id)};`);
  const reviewAndApprove = (id) => { own(`select public.content_engine_article_review(${lit(id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`); return db.mustFail(() => own(`select public.content_engine_article_approve(${lit(id)}, ${lit(hashOf(id))});`)); };
  /* an article whose checks never ran the evidence gate (an old page) */
  own(`select public.content_engine_article_save(${lit(pa.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], warned: [] } }))}::jsonb, 'old page', null);`);
  own(`select public.content_engine_article_submit(${lit(pa.id)});`);
  chk('E no approval without the evidence gate in the checks', /football evidence gate/.test(reviewAndApprove(pa.id) || ''));
  chk('E … the article stays in review', one(`select status from content_engine.articles where id = ${lit(pa.id)};`) === 'in_review');
  /* re-checked with the current page: held for review, then approved by the owner */
  own(`select public.content_engine_article_save(${lit(pa.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], warned: [], readiness: 'HOLD_FOR_REVIEW', checks: [GATE_CHECK] } }))}::jsonb, 'current page', null);`);
  own(`select public.content_engine_article_submit(${lit(pa.id)});`);
  const err = reviewAndApprove(pa.id);
  chk('E with the gate on record, a held article is approved after the owner’s review', err === null && one(`select status from content_engine.articles where id = ${lit(pa.id)};`) === 'approved', err);
  /* a blocked article (a direct write that claims ok but carries the gate's BLOCKED) */
  own(`select public.content_engine_article_save(${lit(fp.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], readiness: 'BLOCKED', checks: [GATE_CHECK] } }))}::jsonb, 'blocked', null);`);
  own(`select public.content_engine_article_submit(${lit(fp.id)});`);
  chk('E never when the gate blocked', /blocks this article/.test(reviewAndApprove(fp.id) || ''));

  /* ── B the monthly cap ────────────────────────────────────────────── */
  chk('B off by default: the daily cap alone', one(`select coalesce(llm_calls_per_month::text, 'null') from content_engine.settings where id = 1;`) === 'null'
    && svc(`select public.content_engine_spend('llm', 1);`).ok === true);
  one(`update content_engine.settings set llm_calls_per_month = 3 where id = 1;`);
  const s2 = svc(`select public.content_engine_spend('llm', 1);`), s3 = svc(`select public.content_engine_spend('llm', 1);`), s4 = svc(`select public.content_engine_spend('llm', 1);`);
  chk('B the call that would exceed the month is refused, before it is made', s2.ok && s3.ok && s4.ok === false && s4.reason === 'budget_exhausted' && s4.period === 'month', [s2, s3, s4]);
  chk('B … and logged', one(`select count(*) from content_engine.events where kind = 'budget_exhausted' and detail ->> 'period' = 'month';`) === '1');
  chk('B the daily cap still applies first', (() => { one(`update content_engine.settings set llm_calls_per_month = null, llm_calls_per_day = 4 where id = 1;`); const r = svc(`select public.content_engine_spend('llm', 1);`); const r2 = svc(`select public.content_engine_spend('llm', 1);`); return r.ok === true && r2.ok === false && !r2.period; })());
  chk('B a cap outside 0–5000 is refused', !!fails(() => one(`update content_engine.settings set llm_calls_per_month = 99999 where id = 1;`)));

  /* ── U usage ──────────────────────────────────────────────────────── */
  /* a model growth_outbound.model_price() lists, and its rates, read from that file */
  const PRICE = /when '([a-z0-9.-]+)'\s+then '(\{[^']+\})'::jsonb/.exec(fs.readFileSync(path.join(PG.ROOT, 'supabase', 'growth_outbound.sql'), 'utf8').split('function growth_outbound.model_price')[1]);
  const RATE = JSON.parse(PRICE[2]);
  const rec = svc(`select public.content_engine_ai_usage_record(${lit(JSON.stringify({ model: PRICE[1], purpose: 'draft', input_tokens: 1000, output_tokens: 500 }))}::jsonb);`);
  chk('U a call’s tokens are priced from the published list price', rec.ok && rec.priced === true && Math.abs(rec.cost_usd - (1000 * RATE.in + 500 * RATE.out) / 1e6) < 1e-9, rec);
  const rec2 = svc(`select public.content_engine_ai_usage_record(${lit(JSON.stringify({ model: 'some-unknown-model', input_tokens: 10, output_tokens: 10 }))}::jsonb);`);
  chk('U an unpriced model records tokens, cost unknown (null, not zero)', rec2.ok && rec2.cost_usd === null && rec2.priced === false);
  chk('U the usage log is append-only', !!fails(() => one(`update content_engine.ai_usage set cost_usd = 0;`)) && !!fails(() => one(`delete from content_engine.ai_usage;`)));
  chk('U anon cannot record', !!fails(() => db.anon(`select public.content_engine_ai_usage_record('{}'::jsonb);`)));

  /* ── M metrics ────────────────────────────────────────────────────── */
  const m = own(`select public.content_engine_editorial_metrics(90);`);
  chk('M the owner sees editorial, traffic and cost apart', m && m.editorial && m.traffic && m.cost && /reported separately/.test(m.note), m);
  chk('M editorial counts what happened', m.editorial.articles === 2 && m.editorial.approved_or_later === 1 && m.editorial.first_party_articles === 1, m.editorial);
  chk('M nothing sent yet: acceptance is not measured (null)', m.editorial.publisher_acceptance_rate === null && m.editorial.sent === 0);
  chk('M cost is the token log, and per-article cost is null with nothing published', Math.abs(m.cost.cost_usd - 0.014) < 1e-9 && m.cost.cost_per_published_article === null && m.cost.cost_per_paid_conversion === null, m.cost);
  chk('M the service role cannot read metrics', !!fails(() => db.service(`select public.content_engine_editorial_metrics(90);`)));
  chk('M nor can anon', !!fails(() => db.anon(`select public.content_engine_editorial_metrics(90);`)));
  /* a revision that failed the evidence gate counts as an unsupported claim caught */
  own(`select public.content_engine_article_save(${lit(fp.id)}, ${lit(JSON.stringify({ standfirst: 'changed', checks: { ok: false, failed: ['football_evidence', 'causal_supported'], readiness: 'BLOCKED', checks: [GATE_CHECK] } }))}::jsonb, 'gate failed', null);`);
  const m2 = own(`select public.content_engine_editorial_metrics(90);`);
  chk('M failing evidence checks are counted by check', m2.editorial.unsupported_claims_caught.football_evidence >= 1 && m2.editorial.unsupported_claims_caught.causal_supported >= 1 && m2.editorial.unsupported_claims_caught_total >= 2, m2.editorial);
} catch (e) {
  chk('no unexpected error', false, String(e && (e.sqlMessage || e.message) || e).slice(0, 600));
} finally {
  db.stop();
}
process.exit(T.done());
