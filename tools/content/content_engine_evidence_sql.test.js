#!/usr/bin/env node
/* ===========================================================================
   supabase/content_engine_evidence.sql against a real PostgreSQL, on top of
   supabase/content_engine.sql (the order the owner applies them in).

     F  FILE     no psql meta-commands; idempotent; the report reads ok
     K  KINDS    the matchup analysis topic and publisher format (in
                 content_engine.sql); EdgeDesk's own format stays out of the
                 publisher articles table
     E  FLOOR    no approval without the football evidence gate in the stored
                 checks, never when the gate blocked; a held article may be
                 approved once the owner has reviewed it
     M  METRICS  owner-only; editorial, traffic and cost apart (cost from
                 content_engine.sql's AI ledger); unmeasured is null

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
  chk('F the report reads ok', bad(rep1).length === 0 && rep1.split('\n').filter(Boolean).length >= 2, bad(rep1));
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
    scores: { total: 70 }, priority: 70, formats: ['matchup_analysis'], expires_at: '2099-01-01T00:00:00Z' };
  const u = svc(`select public.content_engine_opportunity_upsert(${lit(JSON.stringify(opp))}::jsonb, null);`);
  chk('K a matchup analysis topic is recorded', u && u.ok === true, u);
  const content = (extra) => Object.assign({ title: 'Ole Miss vs. Vanderbilt: Can Vanderbilt’s Pass Rush Get to Chambliss?', slug: 'ole-miss-vs-vanderbilt-pass-rush',
    meta_description: 'm', standfirst: 's', primary_keyword: 'ole miss vs vanderbilt prediction', secondary_keywords: [], sections: SECTIONS, word_count: 12,
    generator: 'template:content_engine_v2', checks: { ok: true, failed: [], warned: [], readiness: 'HOLD_FOR_REVIEW', integrity_status: 'PASS', checks: [GATE_CHECK] } }, extra || {});
  const pa = own(`select public.content_engine_article_create(${lit(u.id)}, ${lit(SR.id)}, 'matchup_analysis', 'full_slate', ${lit(JSON.stringify(content()))}::jsonb, null);`);
  chk('K the publisher format is allowed', pa && pa.ok, pa);
  /* EdgeDesk's own pages are not publisher articles (they live in content_engine.first_party) */
  chk('K the first-party format stays out of the publisher articles table', !!fails(() => own(`select public.content_engine_article_create(${lit(u.id)}, null, 'edgedesk_analysis', 'full_slate', ${lit(JSON.stringify(content({ slug: 'ole-miss-vs-vanderbilt-prediction' })))}::jsonb, null);`))
    || (own(`select public.content_engine_article_create(${lit(u.id)}, null, 'edgedesk_analysis', 'full_slate', ${lit(JSON.stringify(content({ slug: 'ole-miss-vs-vanderbilt-prediction-2' })))}::jsonb, null);`) || {}).ok !== true);
  const fp = own(`select public.content_engine_article_create(${lit(u.id)}, ${lit(SR.id)}, 'matchup_analysis', 'upsets_first', ${lit(JSON.stringify(content({ slug: 'ole-miss-vs-vanderbilt-prediction' })))}::jsonb, null);`);
  chk('K a second angle on the same game is its own article', fp && fp.ok, fp);
  chk('K an unknown format is still refused', !!fails(() => one(`insert into content_engine.articles (opportunity_id, format, title, slug, sections, generator, research_hash, campaign_code, created_by)
     values (${lit(u.id)}, 'listicle', 'A title of length', 'a-title', '[{"key":"intro","body":"x"}]'::jsonb, 'gen', 'h', 'ce_x_y', 'owner');`)));

  /* ── E the floor ──────────────────────────────────────────────────── */
  const hashOf = (id) => one(`select content_hash from content_engine.articles where id = ${lit(id)};`);
  /* the editorial gate's verdict for this exact text (content_engine.sql requires it too), then review and approve */
  const GATE_PASS = { schema: 'edgedesk_editorial_gate_v1', verdict: 'PASS', items: [{ key: 'claims', label: 'Unsupported factual claims', status: 'PASS', findings: [] }] };
  const reviewAndApprove = (id) => {
    own(`select public.content_engine_article_gate(${lit(id)}, ${lit(hashOf(id))}, ${lit(JSON.stringify(GATE_PASS))}::jsonb);`);
    own(`select public.content_engine_article_review(${lit(id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
    return db.mustFail(() => own(`select public.content_engine_article_approve(${lit(id)}, ${lit(hashOf(id))});`));
  };
  /* content_engine.sql's integrity guard runs first: the evidence gate on
     record is not enough without the integrity engine's verdict on this text */
  own(`select public.content_engine_article_save(${lit(pa.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], warned: [], readiness: 'HOLD_FOR_REVIEW', checks: [GATE_CHECK] } }))}::jsonb, 'no integrity verdict', null);`);
  own(`select public.content_engine_article_submit(${lit(pa.id)});`);
  own(`select public.content_engine_article_gate(${lit(pa.id)}, ${lit(hashOf(pa.id))}, ${lit(JSON.stringify(GATE_PASS))}::jsonb);`);
  own(`select public.content_engine_article_review(${lit(pa.id)}, ${lit(JSON.stringify(REVIEW))}::jsonb);`);
  const noIntegrity = own(`select public.content_engine_article_approve(${lit(pa.id)}, ${lit(hashOf(pa.id))});`);
  chk('E no approval without the integrity verdict, even with the evidence gate on record', noIntegrity && noIntegrity.ok === false && noIntegrity.reason === 'integrity_blocked'
    && one(`select status from content_engine.articles where id = ${lit(pa.id)};`) === 'in_review', noIntegrity);
  /* an article whose checks never ran the evidence gate (an old page; the integrity engine passed it) */
  own(`select public.content_engine_article_save(${lit(pa.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], warned: [], integrity_status: 'PASS' } }))}::jsonb, 'old page', null);`);
  own(`select public.content_engine_article_submit(${lit(pa.id)});`);
  chk('E no approval without the evidence gate in the checks', /football evidence gate/.test(reviewAndApprove(pa.id) || ''));
  chk('E … the article stays in review', one(`select status from content_engine.articles where id = ${lit(pa.id)};`) === 'in_review');
  /* re-checked with the current page: held for review, then approved by the owner */
  own(`select public.content_engine_article_save(${lit(pa.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], warned: [], readiness: 'HOLD_FOR_REVIEW', integrity_status: 'PASS', checks: [GATE_CHECK] } }))}::jsonb, 'current page', null);`);
  own(`select public.content_engine_article_submit(${lit(pa.id)});`);
  const err = reviewAndApprove(pa.id);
  chk('E with the gate on record, a held article is approved after the owner’s review', err === null && one(`select status from content_engine.articles where id = ${lit(pa.id)};`) === 'approved', err);
  /* a blocked article (a direct write that claims ok but carries the gate's BLOCKED) */
  own(`select public.content_engine_article_save(${lit(fp.id)}, ${lit(JSON.stringify({ checks: { ok: true, failed: [], readiness: 'BLOCKED', integrity_status: 'PASS', checks: [GATE_CHECK] } }))}::jsonb, 'blocked', null);`);
  own(`select public.content_engine_article_submit(${lit(fp.id)});`);
  chk('E never when the gate blocked', /blocks this article/.test(reviewAndApprove(fp.id) || ''));

  /* ── M metrics ────────────────────────────────────────────────────── */
  const m = own(`select public.content_engine_editorial_metrics(90);`);
  chk('M the owner sees editorial, traffic and cost apart', m && m.editorial && m.traffic && m.cost && /reported separately/.test(m.note), m);
  chk('M editorial counts what happened', m.editorial.articles === 2 && m.editorial.approved_or_later === 1 && m.editorial.matchup_analyses === 2, m.editorial);
  chk('M nothing sent yet: acceptance is not measured (null)', m.editorial.publisher_acceptance_rate === null && m.editorial.sent === 0);
  chk('M no settled AI call yet: cost is not measured (null, not zero)', m.cost.cost_usd_estimated === null && m.cost.llm_calls === 0 && m.cost.cost_per_published_article === null, m.cost);
  /* one call through content_engine.sql's own ledger: reserved, then settled with the API's usage */
  const model = one(`select k from content_engine.settings s, jsonb_object_keys(s.ai_prices -> 'models') k where s.id = 1 order by k limit 1;`);
  const rsv = svc(`select public.content_engine_ai_reserve('draft', null, ${lit(model)}, ${lit('a'.repeat(64))}, 4000, 3000, 1);`);
  svc(`select public.content_engine_ai_settle(${rsv.call_id}, ${lit(JSON.stringify({ input_tokens: 1000, output_tokens: 500 }))}::jsonb, 'accepted', null, null);`);
  const est = +one(`select est_usd from content_engine.ai_calls where id = ${rsv.call_id};`);
  const m1 = own(`select public.content_engine_editorial_metrics(90);`);
  chk('M cost reads the AI ledger’s settled estimate; per-article cost stays null with nothing published', rsv.ok && est > 0 && Math.abs(m1.cost.cost_usd_estimated - est) < 1e-9 && m1.cost.llm_calls === 1
    && m1.cost.cost_per_published_article === null && m1.cost.cost_per_paid_conversion === null, [rsv, est, m1.cost]);
  chk('M the service role cannot read metrics', !!fails(() => db.service(`select public.content_engine_editorial_metrics(90);`)));
  chk('M nor can anon', !!fails(() => db.anon(`select public.content_engine_editorial_metrics(90);`)));
  /* a revision that failed the evidence gate counts as an unsupported claim caught */
  own(`select public.content_engine_article_save(${lit(fp.id)}, ${lit(JSON.stringify({ standfirst: 'changed', checks: { ok: false, failed: ['football_evidence', 'causal_supported'], readiness: 'BLOCKED', integrity_status: 'PASS', checks: [GATE_CHECK] } }))}::jsonb, 'gate failed', null);`);
  const m2 = own(`select public.content_engine_editorial_metrics(90);`);
  chk('M failing evidence checks are counted by check', m2.editorial.unsupported_claims_caught.football_evidence >= 1 && m2.editorial.unsupported_claims_caught.causal_supported >= 1 && m2.editorial.unsupported_claims_caught_total >= 2, m2.editorial);
} catch (e) {
  chk('no unexpected error', false, String(e && (e.sqlMessage || e.message) || e).slice(0, 600));
} finally {
  db.stop();
}
process.exit(T.done());
