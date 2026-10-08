#!/usr/bin/env node
/* ===========================================================================
   THE OUTBOUND PIPELINE, DRY RUN (Phase 12)

   Puts candidates through the real database doors the research engine uses,
   in a THROWAWAY PostgreSQL with supabase/growth_outbound.sql installed, and
   reports what the morning queue would hold — then proves nothing was sent.

     node tools/growth/outbound_dryrun.js <candidates.json> [--out report.md]

   For each candidate, exactly as growth_outbound_research does:
     1  research_begin, candidates_record (where it was found)
     2  page_record for every page read (the database stores the text)
     3  research_ingest as the research engine: each fact is a QUOTE from a
        stored page, checked by the database (the claim inside the quote, the
        quote on the page); the database decides which pages are their own;
        fit reasons cite the facts; a segment for a new prospect
     4  evaluate: the 0–100 qualification score, its parts, the gates
     5  the owner's draft check (growth_outbound_draft_check) on the proposed
        email: the engine's rules (every claim cited, nothing specific from
        nowhere, the content rules, the offer, under 150 words) — writing
        nothing
   Then: test mode on, no send row, no draft row, no Resend key, no network.

   candidates.json: [{
     name, found_by: { query, url, title, snippet },
     pages: [{ url, title, text, published? }],
     relevant: false, reason            (optional) not a fit: nothing is recorded,
     facts: [{ field, claim, quote, page }],          page = index into pages
     urls: [profile or site URLs], prospect_type, segment, sports: ['CFB'],
     fit: [{ code, facts: [fact indices] }],          penalties need none
     email: { address, quote, page } | null,         only one published on their page
     draft: { subject, body, claims: [{ text, fact }] } | null
   }]

   The page text is whatever the operator's reader returned for that page.
   The production engine reads the live page itself; the database re-checks
   every quote against what it stored either way.
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const args = process.argv.slice(2);
const inFile = args.find((a) => !a.startsWith('--'));
const outIx = args.indexOf('--out');
const outFile = outIx >= 0 ? args[outIx + 1] : null;
if (!inFile) { console.error('usage: node tools/growth/outbound_dryrun.js <candidates.json> [--out report.md]'); process.exit(2); }
const CANDS = JSON.parse(fs.readFileSync(inFile, 'utf8'));

const OWNER = '00000000-0000-0000-0000-00000000d001';
const lit = PG.lit;
const db = PG.start('godry');
if (db.skip) { console.error(db.skip); process.exit(2); }
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const J = (o) => lit(JSON.stringify(o)) + '::jsonb';
const md = [];
const say = (s) => { md.push(s); };
const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '\\|').replace(/\n+/g, ' ');

let failed = 0;
try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@dryrun.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}');
       select growth_outbound.grant_owner('owner@dryrun.test');`);
  own(`select public.growth_outbound_settings_update(${J({ postal_address: 'EdgeDesk Sports (dry run), 100 Example St, Springfield, IL 62701',
    test_inbox: 'owner@dryrun.test' })});`);

  say('# Outbound pipeline — dry run');
  say('');
  say('Run ' + new Date().toISOString() + ' against `supabase/growth_outbound.sql` in a throwaway database. Test mode on; no Resend key; no network; nothing can be sent.');
  say('');
  const rows = [];
  for (const c of CANDS) {
    const out = { name: c.name, notes: [] };
    // 1 found
    const disc = own(`select public.growth_outbound_research_begin('discover', ${J({ query: c.found_by && c.found_by.query })});`);
    const rec = own(`select public.growth_outbound_candidates_record(${disc.run_id}, ${J([{ url: c.found_by.url, title: c.found_by.title || '', snippet: c.found_by.snippet || '',
      query: c.found_by.query || '', provider: 'websearch' }])});`);
    own(`select public.growth_outbound_research_finish(${disc.run_id}, 'done', '{}'::jsonb, null);`);
    const candId = rec.candidate_ids && rec.candidate_ids[0];
    // not a fit (a tout, a sportsbook, a big outlet's generic page): the engine records nothing about them
    if (c.relevant === false) {
      own(`select public.growth_outbound_candidate_set(${candId}, 'not_a_fit', ${lit(c.reason || 'not relevant')});`);
      out.error = 'not a fit — ' + (c.reason || 'not relevant') + '; nothing was recorded about them';
      rows.push(out); continue;
    }
    // 2 pages
    const run = own(`select public.growth_outbound_research_begin('research', ${J({ candidate_id: candId })});`).run_id;
    const pages = (c.pages || []).map((p) => {
      const r = own(`select public.growth_outbound_page_record(${run}, ${J({ url: p.url, http_status: 200, content_type: 'text/html', title: p.title || '', text: p.text })});`);
      if (!r.ok) out.notes.push('page not stored: ' + p.url + ' (' + (r.detail || r.reason) + ')');
      return r.ok ? { id: r.page_id, url: r.url } : null;
    });
    // 3 facts, as the engine records them
    const facts = (c.facts || []).map((f) => ({ field_name: f.field, claim: f.claim, source_url: pages[f.page] && pages[f.page].url, page_id: pages[f.page] && pages[f.page].id,
      source_excerpt: f.quote, source_kind: 'publication', source_title: (c.pages[f.page] || {}).title || undefined,
      source_published_at: (c.pages[f.page] || {}).published || undefined }));
    if (c.email && pages[c.email.page]) facts.push({ field_name: 'email', claim: c.email.address, source_url: pages[c.email.page].url, page_id: pages[c.email.page].id,
      source_excerpt: c.email.quote, source_kind: 'publication' });
    const payload = { evidence: facts.filter((f) => f.page_id), discovered_via: ('search: ' + (c.found_by.query || '')).slice(0, 200) };
    if (c.urls && c.urls.length) payload.urls = c.urls;
    if (c.prospect_type) payload.prospect_type = c.prospect_type;
    if (c.segment) payload.campaign_type = c.segment;
    if (c.sports) payload.sports_focus = c.sports;
    if (c.email) payload.email = c.email.address;
    if (c.fit) payload.fit_factors = c.fit.map((x) => ({ code: x.code, evidence_index: (x.facts || []).filter((i) => facts[i] && facts[i].page_id) }));
    let res = own(`select public.growth_outbound_research_ingest(${run}, ${candId}, null, 'research_engine', ${J(payload)});`);
    // a fact the database refuses is dropped and said, never fixed (as the engine does)
    for (let k = 0; k < 10 && res.ok === false && res.reason === 'invalid' && /^evidence (\d+)$/.test(String(res.at || '')); k++) {
      const i = +/^evidence (\d+)$/.exec(res.at)[1] - 1;
      out.notes.push('dropped: ' + payload.evidence[i].field_name + ' "' + payload.evidence[i].claim + '" — ' + res.detail);
      payload.evidence.splice(i, 1);
      if (payload.fit_factors) payload.fit_factors = payload.fit_factors.map((x) => ({ code: x.code, evidence_index: x.evidence_index.filter((n) => n !== i).map((n) => n > i ? n - 1 : n) }));
      res = own(`select public.growth_outbound_research_ingest(${run}, ${candId}, null, 'research_engine', ${J(payload)});`);
    }
    own(`select public.growth_outbound_research_finish(${run}, ${lit(res.ok ? 'done' : 'failed')}, '{}'::jsonb, ${lit(res.ok ? null : String(res.reason))});`);
    if (!res.ok) { out.error = res.reason + (res.detail ? ': ' + res.detail : ''); rows.push(out); continue; }
    const pidv = res.prospect_id;
    // 4 the assessment
    one(`select growth_outbound.evaluate(${lit(pidv)});`);
    const d = own(`select public.growth_outbound_prospect(${lit(pidv)});`);
    out.p = d.prospect;
    out.evidence = d.evidence.filter((e) => e.current);
    // 5 the email, checked by the engine's rules, written nowhere
    if (c.draft) {
      const ev = (i) => { const f = facts[i]; const e = out.evidence.find((x) => f && x.field_name === f.field_name && x.claim === f.claim); return e ? e.id : null; };
      const p = { sequence_number: 1, subject: c.draft.subject, body_text: c.draft.body, claims: (c.draft.claims || []).map((k) => ({ text: k.text, evidence_id: ev(k.fact) })).filter((k) => k.evidence_id) };
      out.draft = p;
      out.check = own(`select public.growth_outbound_draft_check(${lit(pidv)}, ${J(p)});`);
    }
    rows.push(out);
  }

  // the summary
  say('| # | Prospect | Segment | Score | Relevance | Analytics | Purchase | Contact | Personal. | Penalties | Status | Address | Email check |');
  say('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r, i) => {
    if (!r.p) { say('| ' + (i + 1) + ' | ' + cell(r.name) + ' | — | — | | | | | | | not recorded: ' + cell(r.error) + ' | | |'); return; }
    const q = r.p.qualification || {}, pt = q.parts || {};
    const part = (k) => pt[k] ? pt[k].points + '/' + pt[k].max : '—';
    say('| ' + (i + 1) + ' | ' + cell(r.p.full_name || r.name) + ' | ' + cell(r.p.campaign_type) + ' | **' + cell(r.p.qualification_score) + '** | ' + part('relevance') + ' | ' + part('analytics')
      + ' | ' + part('purchase') + ' | ' + part('contact') + ' | ' + part('personalization') + ' | ' + cell(pt.penalties ? pt.penalties.points : 0) + ' | ' + cell(r.p.status)
      + ' | ' + cell(r.p.email ? r.p.email + ' (' + r.p.email_status + ')' : 'none found') + ' | ' + (r.check ? (r.check.passes ? 'passes' : r.check.problems.length + ' problem(s)') : '—') + ' |');
  });
  say('');
  rows.forEach((r, i) => {
    say('## ' + (i + 1) + '. ' + (r.p ? (r.p.full_name || r.name) : r.name) + (r.p && r.p.organization ? ' — ' + r.p.organization : ''));
    say('');
    if (!r.p) { say('Not recorded: ' + r.error); say(''); return; }
    const q = r.p.qualification || {};
    say('- **Qualification ' + r.p.qualification_score + '** (bar ' + ((r.p.assessment || {}).thresholds || {}).qualification + '); fit ' + r.p.fit_score + '; segment `' + r.p.campaign_type + '`; status `' + r.p.status + '`');
    if (q.why) say('- Why they fit: ' + q.why);
    if (q.against) say('- Against: ' + q.against);
    if ((r.p.gates || []).length) say('- Gates still unmet: ' + r.p.gates.join('; '));
    say('- Address: ' + (r.p.email ? r.p.email + ' — ' + r.p.email_status : 'none published on their pages (would go to the enrichment/verification queue)'));
    r.notes.forEach((n) => say('- Note: ' + n));
    say('');
    say('| Fact | Claim | Source | Kind | Quote | Now |');
    say('|---|---|---|---|---|---|');
    r.evidence.forEach((e) => say('| ' + e.field_name + ' | ' + cell(e.claim) + ' | ' + cell(e.source_url) + ' | ' + e.source_kind + ' | "' + cell(String(e.source_excerpt || '').slice(0, 220)) + '" | ' + Number(e.claim_confidence).toFixed(2) + ' |'));
    say('');
    if (r.draft) {
      say('**Proposed email** — subject: _' + r.draft.subject + '_');
      say('');
      say('```');
      say(r.draft.body);
      say('```');
      say('');
      say('Engine rules: ' + (r.check.passes ? '**pass**' : '**' + r.check.problems.length + ' problem(s)**: ' + r.check.problems.join('; ')) + ' · ' + r.check.words + ' words · '
        + (r.check.due ? 'due now' : 'not due yet: ' + r.check.due_problem));
      say('');
    }
  });

  // nothing was sent
  const sends = +one(`select count(*) from growth_outbound.sends;`), drafts = +one(`select count(*) from growth_outbound.drafts;`);
  const test = one(`select test_mode from growth_outbound.settings where id = 1;`);
  say('## Nothing was sent');
  say('');
  say('- send rows: **' + sends + '**; draft rows: **' + drafts + '** (the check writes none); test mode: **' + (test === 't' ? 'on' : 'off') + '**; no Resend key and no network in this run.');
  if (sends !== 0 || drafts !== 0 || test !== 't') { failed++; say('- **FAILED: something was written that should not have been.**'); }
  const rep = one(`select string_agg(step || ' ' || outcome, ', ' order by step) from growth_outbound.self_check() where outcome not like 'ok%';`);
  say('- System check: ' + (rep ? 'failing: ' + rep : 'every row ok'));
} catch (err) {
  failed++;
  say('**The dry run stopped:** ' + String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
const text = md.join('\n') + '\n';
if (outFile) fs.writeFileSync(outFile, text); else process.stdout.write(text);
console.error(failed ? 'DRY RUN FAILED' : 'dry run complete: ' + CANDS.length + ' candidate(s), nothing sent');
process.exit(failed ? 1 : 0);
