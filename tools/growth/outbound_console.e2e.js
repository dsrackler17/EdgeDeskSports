#!/usr/bin/env node
/* ===========================================================================
   /admin/growth/ — THE OUTBOUND TAB, IN A REAL BROWSER (admin/growth/outbound.js).

   Supabase mocked; the page is the shipped file.

     1  an OWNER sees the Outbound tab; TEST MODE is marked in the header and
        on the tab, with the test inbox; what blocks sending is said in words;
        "sent automatically" is zero; prospects show their emails
     2  raising the daily cap: the dialog states both numbers; declining sends
        NOTHING; accepting sends the confirmation flag with the new value
     3  leaving test mode must be typed (LIVE); anything else sends nothing;
        once live, the header says LIVE
     4  suppressing asks first, then calls the suppress door with the scope
     5  an AFFILIATE ADMIN WHO IS NOT AN OWNER: no tab, no header tag, and the
        only outbound call the page ever makes is growth_outbound_is_owner
     6  an owner demoted mid-session is refused by the database and the tab
        disappears
     7  sign-out removes the tab and the mode tag
     8  at 390 px the tab fits the screen; no page errors anywhere
     9  RESEARCH (Phase 3): a prospect opens into each number beside its bar,
        the gates, the facts with their sources and rivals, the warnings in
        words, and the evidence history ("previously … superseded: why");
        text from the web is shown as text (no markup runs) and only an
        https: source becomes a link (noopener, noreferrer, nofollow)
    10  superseding asks why; no reason sends nothing
    11  adding evidence sends exactly what was typed; a refusal is shown
    12  fit reasons: added resting on evidence, or removed
    13  "not theirs" releases an identifier, with a reason
    14  "needs more research" and "reject" ask first
    15  "have we seen them?" finds the existing record and opens it
    16  adding a prospect sends the email, the URLs one per line, the sports
        and the first fact; a suppressed person is reported, not added
    17  before the Phase 3 SQL is applied (no fit catalogue), a prospect still
        opens; one with no assessment is never shown as clearing the gates;
        before the Phase 4 SQL, the queue says so instead of failing
    18  THE REVIEW QUEUE (Phase 4): each card is the message as it would be
        sent (TEST to the test inbox, footer included), what it says about the
        person with the evidence behind it; text from the web stays text; a
        blocked draft cannot be selected or approved, and says why
    19  approving one asks first and sends the content hash on screen
    20  a batch: the count must be TYPED; a wrong number sends nothing; the
        typed number goes to the database with exactly the selected drafts;
        a refusal says that nothing was approved, and why
    21  edit inline, against the version on screen
    22  reject asks first
    23  approved, not sent: withdraw the approval; no batch there
    24  the test-draft button, and its refusal without a test inbox
    25  write a draft from a prospect: claims with their evidence and words
    26  SENDING (Phase 5): the Sends table (TEST/LIVE, who for, status, why,
        "Try again" only for an unanswered send); before going live, what
        live sending still needs
    27  Send asks first, names the inbox, and calls the send function with
        exactly that draft
    28  "Send all shown": the count must be typed; a wrong number sends nothing
    29  the function's refusals are said in words: the database's reason, a
        function not deployed, no Resend key
    30  "Try again" asks, and resends the same draft (the same key)
    31  WHAT COMES BACK (Phase 6): whether Resend's events can arrive (the
        signing secret), how many and when the last did; going live is said
        to need the secret
    32  opened and clicked, with when, on the send Resend reported
    33  a contacted prospect: "They replied" asks, then records the note and
        stops follow-ups without suppressing
    34  "They replied: stop emailing them" asks, naming the address, then
        suppresses; neither is offered where it no longer applies
    35  DISCOVER AND RESEARCH (Phase 7): which providers are set up and today's
        use of each; the saved searches and budget; the runs; the queue counts;
        opening the page searches and researches nothing
    36  candidates: web text stays text, only https: links; a short search is
        refused here; a search is tidied and its result said; saved searches;
        a missing search key named
    37  Research one candidate: what was recorded, dropped (could not be
        quoted), the address and the status; not a fit; the next one
    38  Dismiss asks, with a reason
    39  Research again, from a prospect
    40  saving the searches and the budget; a refused budget in the database's
        words
    41  the research function not deployed: said, the queue still shown
    42  THE DRAFTING ENGINE (Phase 8): the review queue says whether Claude
        writes and today's use, who is due, how the engine's drafts fare;
        opening the page drafts nothing
    43  "Write the next N drafts": the function is asked for exactly that
        many; what was drafted, by whom, and why not, is said; the queue
        is reloaded
    44  each card says who wrote it (the engine, its template, you, edited
        by you); a greeting the evidence no longer supports blocks approval
        and says so; a follow-up for a contacted prospect can be approved
    45  rejecting an engine draft says the engine reads the reason
    46  "Let the engine write it" from a prospect, for the chosen step; a
        step not due is said in the database's words
    47  the drafting function not deployed: said, who is due still shown,
        the button off
    48  THE MORNING RUN (Phase 9): on or off, the window in the owner's zone,
        whether the clock ticks, the next step, today's progress, the steps;
        opening the page starts nothing
    49  turning automation on says what it does (and that it never approves
        or sends) and asks; declining saves nothing
    50  the window and the zone are settings like any other
    51  the clock not running, or pg_net missing: said, with what to run
    52  before the Phase 9 SQL: said
    53  RESULTS (Phase 10): whether links are tagged, when results were last
        matched, provider calls; the people written to and what they did,
        with rates; the emails; what stands out (only past the minimum
        sample); by step; by group with each rate's 95% range ("few" below
        the sample); the latest results, opening the prospect; the days
        that had activity. Opening the page reads the last 90 days
    54  the window and the grouping: a new window is read again; a new
        grouping is only redrawn
    55  each card shows the words as sent (tagged links) and says what the
        tag is; an address that already has an account blocks the card
    56  a prospect lists its results; link tagging is a setting (turning it
        off is saved and said); a matching failure is said; before the
        Phase 10 SQL, said

   Run:  node tools/growth/outbound_console.e2e.js [--shots <dir>]
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.join(__dirname, '..', '..');
const args = process.argv.slice(2);
const SHOTS = args.indexOf('--shots') >= 0 ? args[args.indexOf('--shots') + 1] : null;
const SKEY = 'edgedesk_growth_admin_session';

let pass = 0, fail = 0;
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; console.log('  FAIL ' + name + (detail !== undefined ? '  ' + JSON.stringify(detail).slice(0, 400) : '')); }

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]); if (p.endsWith('/')) p += 'index.html';
      const file = path.join(ROOT, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end(); return; }
      const type = p.endsWith('.html') ? 'text/html; charset=utf-8' : p.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': type }); res.end(fs.readFileSync(file));
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}
function jwt(tag, expSec) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return b({ alg: 'HS256' }) + '.' + b({ sub: tag, exp: expSec, role: 'authenticated' }) + '.sig' + tag;
}
const nowSec = () => Math.floor(Date.now() / 1000);

const ACTIVATION = { window_days: 90, trials: 0, activated_trials: 0, activation_rate: null, paid_conversions: 0, trial_to_paid_rate: null, activated_to_paid_rate: null,
  activated_paid: 0, not_activated_to_paid_rate: null, not_activated_paid: 0, time_to_activation_hours: {}, states: {}, actions: {}, cohorts: [], settings: { weights: {}, core_kinds: [] } };
const FUNNEL = { touch: 'first', retained_rule: '2+ paid invoices', rows: [], totals: {} };
const SAMPLES = { samples: [], candidates: [] };

function freshSettings() {
  return { automation_enabled: false, test_mode: true, test_inbox: 'owner-test@edgedesk.test', daily_prospect_target: 15, max_sends_per_day: 20, max_test_sends_per_day: 25,
    min_fit_score: 80, min_identity_confidence: 0.9, min_role_confidence: 0.85, min_research_confidence: 0.85, min_email_confidence: 0.9,
    followup_enabled: true, followup_delay_days: 5, final_followup_enabled: false, final_followup_delay_days: 10,
    automation_timezone: 'America/New_York', automation_start_hour: 6, automation_hours: 4, attribution_links: true,
    sender_name: 'Davis', sender_email: 'davis@edgedesksports.com', reply_to_email: null, cta_url: 'https://edgedesksports.com/', business_name: 'EdgeDesk Sports',
    postal_address: null, unsubscribe_url_base: null, discovery_config: {},
    send_blockers: ['postal_address_missing', 'unsubscribe_endpoint_missing'], live_send_blockers: ['postal_address_missing', 'unsubscribe_endpoint_missing', 'webhook_secret_missing'],
    today: { live_sends: 0, test_sends: 0, cap: 20, test_cap: 25 }, webhook: { secret_set: false, last_event_at: null, events_24h: 0 } };
}
const XSS = '<img src=x onerror="window.__pwned=1">';
const RESEARCH_OV = { budget: { search: { cap: 20, used: 3, left: 17 }, fetch: { cap: 150, used: 40, left: 110 }, llm: { cap: 30, used: 2, left: 28 },
    email_finder: { cap: 15, used: 0, left: 15 }, email_verifier: { cap: 30, used: 1, left: 29 } },
  queries: ['college football betting model newsletter', 'cfb power ratings substack'], shared_sites: [], daily_prospect_target: 15,
  candidates: { new: 2, researched: 4, failed: 1 },
  runs: [{ id: 9, kind: 'discover', started_by: 'owner', started_at: '2026-10-07T09:00:00Z', finished_at: '2026-10-07T09:00:05Z', status: 'done',
           input: { query: 'cfb models' }, counts: { new: 5, results: 18, spent: { search: 1 } }, error: null },
         { id: 10, kind: 'research', started_by: 'owner', started_at: '2026-10-07T09:05:00Z', finished_at: '2026-10-07T09:05:40Z', status: 'failed',
           input: { candidate_id: 70 }, counts: { pages: 0, spent: { fetch: 2 } }, error: 'robots.txt disallows it' },
         { id: 11, kind: 'draft', started_by: 'schedule', started_at: '2026-10-07T09:10:00Z', finished_at: '2026-10-07T09:11:00Z', status: 'done',
           input: { next: 3 }, counts: { drafted: 2, not_drafted: 1, spent: { llm: 3 } }, error: null }] };
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
const AM_OV = () => ({ enabled: true, timezone: 'America/New_York', start_hour: 6, hours: 4,
  plan: { step: { kind: 'research', fn: 'growth_outbound_research', input: { next: true } }, reason: null, local_time: '2026-10-08 07:30', timezone: 'America/New_York', in_window: true,
    today: { day: '2026-10-08', runs: 3, searched: true, researched: 2, research_target: 15, drafted: 1, draft_cap: 20, new_candidates: 5, due: 4 } },
  scheduler: { last_tick_at: ago(2), last_action: 'started', last_reason: 'research (run 12)', last_run_id: 12, ticks: 40, ticking: true },
  pg_net: true, cron_job: true,
  runs: [{ id: 12, kind: 'research', started_by: 'schedule', started_at: ago(2), status: 'running', counts: {}, error: null },
         { id: 11, kind: 'discover', started_by: 'schedule', started_at: ago(30), status: 'done', counts: { new: 5, results: 18 }, error: null },
         { id: 10, kind: 'draft', started_by: 'schedule', started_at: ago(90), status: 'failed', counts: {}, error: 'never finished (the function stopped)' }] });
const DRAFT_OV = { llm_budget: { cap: 30, used: 4, left: 26 }, due_counts: { first: 3, followup: 1, final: 0 },
  due: [{ prospect_id: 'pc', sequence_number: 2, full_name: 'Cam Contacted', fit_score: 88 }, { prospect_id: 'p1', sequence_number: 1, full_name: 'Pat Analyst', fit_score: 89 }],
  stats: { engine: { drafts: 6, waiting: 2, approved_as_written: 2, approved_after_edit: 1, rejected: 1, sent: 2, replied: 0 },
           template: { drafts: 2, waiting: 1, approved_as_written: 1, approved_after_edit: 0, rejected: 0, sent: 1, replied: 0 },
           owner: { drafts: 3, waiting: 0, approved_as_written: 0, approved_after_edit: 3, rejected: 0, sent: 3, replied: 1 } },
  lessons: ['too long'], cadence: { followup_enabled: true, followup_delay_days: 5, final_followup_enabled: false, final_followup_delay_days: 10 }, runs: [] };
const CANDS = [
  { id: 71, url: 'https://cfbnumbers.test', title: 'CFB Numbers', snippet: 'Ratings ' + XSS, query: 'cfb models', times_seen: 2, status: 'new', last_seen_at: '2026-10-07T09:00:00Z' },
  { id: 72, url: 'javascript:alert(1)', title: XSS, snippet: null, query: 'cfb models', times_seen: 1, status: 'new', last_seen_at: '2026-10-07T09:00:00Z' }];
const DETAIL = { ok: true,
  prospect: { id: 'p1', full_name: 'Pat Analyst', first_name: 'Pat', organization: 'CFB Numbers', job_title: 'Founder', prospect_type: 'cfb_analyst', is_test: false, suppressed: false,
    email: 'pat@cfbnumbers.test', email_status: 'verified', email_confidence: 0.99, identity_confidence: 0.91, role_confidence: 0.35, research_confidence: 0.91, fit_score: 89,
    status: 'ready_for_review', warnings: ['stale:job_title', 'possible_duplicate'], gates: [],
    assessment: { evaluated_at: '2026-10-07T09:00:00Z', gates: [], thresholds: { fit: 80, identity: 0.9, role: 0.85, email: 0.9, research: 0.85 },
      fields: { full_name: { claim: 'Pat Analyst', confidence: 0.91, sources: 2, reasons: [], alternatives: [] },
                job_title: { claim: 'Founder', confidence: 0.35, sources: 1, reasons: ['conflicting_sources', 'single_source'], alternatives: [{ claim: 'Head of Data', confidence: 0.35 }] } },
      email: { kinds: ['own_site', 'owner_verified'] }, research: { from: 'draft_claims' },
      fit: { factors: [{ code: 'quant_analysis', label: 'publishes quantitative sports analysis', points: 18, evidence: [9], confidence: 0.7 },
                       { code: 'touting', label: 'sells picks or promises winnings', points: -40, evidence: [], confidence: null }] } } },
  evidence: [
    { id: 7, field_name: 'job_title', claim: 'Founder', source_url: 'https://cfbnumbers.test/about', source_kind: 'own_site', source_excerpt: 'Founder of CFB Numbers', observed_at: '2026-10-06T00:00:00Z', current: true, claim_confidence: 0.35 },
    { id: 5, field_name: 'job_title', claim: 'Head of Data', source_url: 'https://cfbnumbers.test/about', source_kind: 'own_site', source_excerpt: 'Head of Data', source_published_at: '2024-01-01T00:00:00Z',
      observed_at: '2026-10-01T00:00:00Z', current: false, superseded_at: '2026-10-06T00:00:00Z', superseded_reason: 'replaced by evidence 7', claim_confidence: null },
    { id: 9, field_name: 'project', claim: XSS, source_url: 'javascript:alert(1)', source_kind: 'publication', source_excerpt: XSS, observed_at: '2026-10-06T00:00:00Z', current: true, claim_confidence: 0.55 }],
  identifiers: [{ id: 31, kind: 'email', value: 'pat@cfbnumbers.test', strength: 'strong', first_seen: '2026-10-01T00:00:00Z' },
                { id: 32, kind: 'name_org', value: 'pat analyst|cfb numbers', strength: 'weak', first_seen: '2026-10-01T00:00:00Z' }],
  related: [{ id: 'p2', full_name: 'Ed Itor', organization: 'CFB Numbers', relation: 'possible_duplicate' }],
  drafts: [{ sequence_number: 1, subject: 'Your ratings', status: 'pending_review', claims: [{ evidence_id: 9 }] }], sends: [], activity: [] };
const CATALOG = [{ code: 'quant_analysis', label: 'publishes quantitative sports analysis', points: 18, needs_evidence: true },
                 { code: 'touting', label: 'sells picks or promises winnings', points: -40, needs_evidence: false }];
const MAILFOOT = '--\nDavis, EdgeDesk Sports\n[no postal address is set: sending is blocked until there is one]\nNot for you? Reply "stop", or opt out in one click: [your personal opt-out link is added when this is sent]';
const RESULTS = (o) => Object.assign({ ok: true, days: 90, since: '2026-07-10T00:00:00Z', min_sample: 10, attribution_links: true,
  synced: { new: {}, converted: 0, drafts_cancelled: 0 }, sync_error: null, synced_at: '2026-10-08T01:00:00Z',
  pipeline: { found: 40, prospects: 31, drafted: 30, approved: 26, rejected: 3 },
  sends: { sent: 34, delivered: 32, bounced: 1, complained: 0, opened: 12, clicked: 6, links_tagged: 34, delivery_rate: 0.9412, bounce_rate: 0.0294, complaint_rate: 0 },
  people: { contacted: 24, replied: 13, opted_out: 1, bounced: 1, complained: 0, visited: 5, signed_up: 4, trial: 2, paid: 1,
    reply_rate: 0.5417, opt_out_rate: 0.0417, visit_rate: 0.2083, signup_rate: 0.1667, trial_rate: 0.0833, paid_rate: 0.0417 },
  by_step: [{ step: 1, sent: 24, delivered: 23, bounced: 1, opened: 10, clicked: 5, replies_after: 12, signups_after: 3 },
            { step: 2, sent: 10, delivered: 9, bounced: 0, opened: 2, clicked: 1, replies_after: 1, signups_after: 1 }],
  groups: {
    prospect_type: [{ group: 'podcast', contacted: 12, replied: 12, opted_out: 0, visited: 1, signed_up: 1, trial: 0, paid: 0, reply_rate: 1, reply_interval: [0.757, 1], signup_rate: 0.0833, signup_interval: [0.015, 0.354], enough: true },
                    { group: 'cfb_analyst', contacted: 12, replied: 1, opted_out: 1, visited: 4, signed_up: 3, trial: 2, paid: 1, reply_rate: 0.0833, reply_interval: [0.015, 0.354], signup_rate: 0.25, signup_interval: [0.089, 0.532], enough: true }],
    query: [{ group: 'added by hand', contacted: 20, replied: 11, opted_out: 1, visited: 4, signed_up: 3, trial: 2, paid: 1, reply_rate: 0.55, reply_interval: [0.342, 0.742], signup_rate: 0.15, signup_interval: [0.052, 0.36], enough: true },
            { group: XSS, contacted: 4, replied: 2, opted_out: 0, visited: 1, signed_up: 1, trial: 0, paid: 0, reply_rate: 0.5, reply_interval: [0.15, 0.85], signup_rate: 0.25, signup_interval: [0.046, 0.699], enough: false }],
    writer: [{ group: 'owner', contacted: 24, replied: 13, opted_out: 1, visited: 5, signed_up: 4, trial: 2, paid: 1, reply_rate: 0.5417, reply_interval: [0.351, 0.721], signup_rate: 0.1667, signup_interval: [0.067, 0.359], enough: true }],
    fit_band: [] },
  signals: [{ dimension: 'prospect_type', group: 'podcast', metric: 'reply', direction: 'higher', k: 12, n: 12, rate: 1, overall: 0.5417 }],
  daily: [{ day: '2026-10-06', sent: 0, replied: 0, visited: 0, signed_up: 0 }, { day: '2026-10-07', sent: 20, replied: 3, visited: 2, signed_up: 1 },
          { day: '2026-10-08', sent: 14, replied: 1, visited: 0, signed_up: 0 }],
  providers: { search: 3, llm: 5 },
  latest: [{ prospect_id: 'p1', full_name: 'Pat Analyst', organization: 'CFB Numbers', stage: 'paid', matched_by: 'link', occurred_at: '2026-10-07T12:00:00Z' },
           { prospect_id: 'pc', full_name: XSS, organization: null, stage: 'signed_up', matched_by: 'address', occurred_at: '2026-10-07T11:00:00Z' }] }, o || {});
const card = (o) => ({
  draft: { id: o.id, prospect_id: o.pid, sequence_number: o.seq || 1, status: o.status || 'pending_review', subject: o.subject, body_text: o.body, content_hash: 'h-' + o.id,
    approved_at: o.status === 'approved' ? '2026-10-07T10:00:00Z' : null, generator_version: o.gen || 'owner', edited_by_owner: o.edited == null ? !o.gen : !!o.edited },
  prospect: { id: o.pid, full_name: o.name, organization: o.org || null, fit_score: o.fit == null ? null : o.fit, status: o.pstatus || 'ready_for_review', is_test: !!o.test, gates: o.gates || [], email: o.email },
  lint: o.lint || [], claims_missing: o.missing || [], claims: o.claims || [], greeting_problem: o.greeting || null, existing_account: !!o.customer,
  preview: { test: o.live ? false : true, from: 'Davis <davis@edgedesksports.com>', to: o.live ? o.email : 'owner-test@edgedesk.test', intended_recipient: o.email, subject: o.subject,
    body: o.pbody || o.body, links_tagged: o.tagged == null ? !!o.pbody : o.tagged, footer: MAILFOOT } });
const SENDS = [
  { id: 's1', draft_id: 'd7', prospect_id: 'p1', full_name: 'Pat Analyst', is_test: true, sequence_number: 1, recipient: 'owner-test@edgedesk.test', intended_recipient: 'pat@cfbnumbers.test',
    subject: 'Your CFB ratings', delivery_status: 'delivered', claimed_at: '2026-10-07T10:00:00Z', sent_at: '2026-10-07T10:00:02Z', attempts: 1,
    opened_at: '2026-10-07T10:30:00Z', clicked_at: '2026-10-07T10:31:00Z' },
  { id: 's2', draft_id: 'd8', prospect_id: 'p2', full_name: 'Lo Confidence', is_test: true, sequence_number: 1, recipient: 'owner-test@edgedesk.test', intended_recipient: 'lo@maybe.test',
    subject: 'Hello', delivery_status: 'claimed', claimed_at: '2026-10-07T10:05:00Z', last_error: 'Resend answered 503', attempts: 2 },
  { id: 's3', draft_id: 'd6', prospect_id: 'p1', full_name: 'Pat Analyst', is_test: false, sequence_number: 1, recipient: 'pat@cfbnumbers.test', intended_recipient: 'pat@cfbnumbers.test',
    subject: '<b>bold</b>', delivery_status: 'failed', claimed_at: '2026-10-07T09:00:00Z', failure_reason: 'refused by Resend (422): Invalid `to` field', attempts: 1 }];
const QPENDING = { ok: true, status: 'pending_review', total: 3, rows: [
  card({ id: 'dt', pid: 'pt', name: 'EdgeDesk Test Prospect', test: true, email: 'owner-test@edgedesk.test', subject: '[TEST] EdgeDesk outbound check', body: 'Hi,\n\nThis message is the EdgeDesk outbound pipeline check.' }),
  card({ id: 'd1', pid: 'p1', name: 'Pat Analyst', org: 'CFB Numbers', fit: 89, email: 'pat@cfbnumbers.test', subject: 'Your CFB ratings',
    body: '<script>window.__pwned2=1</script>Hi Pat, I read your CFB power ratings against the market.',
    claims: [{ text: 'your CFB power ratings against the market', evidence_id: 9, confidence: 0.91,
      evidence: { id: 9, field_name: 'project', claim: 'CFB power ratings against the market', source_url: 'https://cfbnumbers.test/ratings', source_kind: 'own_site', source_excerpt: 'Week 5 power ratings against the closing line', current: true, own: true } }] }),
  card({ id: 'd2', pid: 'p2', name: 'Lo Confidence', fit: 0, pstatus: 'needs_research', email: 'lo@maybe.test', subject: 'A lock for you', body: 'Hi, a lock.',
    gates: ['fit 0 < 80', 'identity 0.2500 < 0.90'], lint: ['promises winnings, a lock or a guarantee'], missing: ['your show'],
    claims: [{ text: 'your show', evidence_id: null, confidence: 0, evidence: null }] })] };
const PAT_CLAIM = [{ text: 'CFB power ratings against the market', evidence_id: 9, confidence: 0.91,
  evidence: { id: 9, field_name: 'project', claim: 'CFB power ratings against the market', source_url: 'https://cfbnumbers.test/ratings', source_kind: 'own_site', source_excerpt: 'Week 5 power ratings against the closing line', current: true, own: true } }];
const Q8 = { ok: true, status: 'pending_review', total: 3, rows: [
  card({ id: 'd81', pid: 'p1', name: 'Pat Analyst', org: 'CFB Numbers', fit: 89, email: 'pat@cfbnumbers.test', subject: 'A research tool for your work', gen: 'engine:claude:p1',
    body: 'Hi Pat,\n\nI came across your CFB power ratings against the market and wanted to reach out.', claims: PAT_CLAIM }),
  card({ id: 'd82', pid: 'p1', name: 'Pat Analyst', org: 'CFB Numbers', fit: 89, email: 'pat@cfbnumbers.test', subject: 'EdgeDesk Sports, for your research', gen: 'engine:template:p1', edited: true,
    body: 'Hi Pat,\n\nI came across your work recently, in particular this: "CFB power ratings against the market".', claims: PAT_CLAIM,
    greeting: 'the greeting names "Pat", but their established first name is "Patricia"' }),
  card({ id: 'd83', pid: 'pc', name: 'Cam Contacted', fit: 88, seq: 2, pstatus: 'contacted', email: 'cam@contacted.test', subject: 'Following up',
    body: 'Hi Cam,\n\nFollowing up on my note about your CFB power ratings against the market.', claims: PAT_CLAIM })] };
const LINKED = 'Hi Pat,\n\nTry it free for 7 days at https://edgedesksports.com/ (then $49.99/month).';
const Q10 = { ok: true, status: 'pending_review', total: 2, rows: [
  card({ id: 'd101', pid: 'p1', name: 'Pat Analyst', org: 'CFB Numbers', fit: 89, email: 'pat@cfbnumbers.test', subject: 'Your CFB ratings', live: true, claims: PAT_CLAIM_10(),
    body: LINKED, pbody: LINKED.replace('https://edgedesksports.com/', 'https://edgedesksports.com/?utm_source=outbound&utm_medium=email&utm_campaign=ob_0123456789abcdef0123456789abcdef') }),
  card({ id: 'd102', pid: 'p2', name: 'Kai Customer', org: 'Moss Models', fit: 90, email: 'kai@mossmodels.test', subject: 'Your models', live: true, customer: true, claims: PAT_CLAIM_10(),
    body: 'Hi Kai,\n\nI read your CFB power ratings against the market.' })] };
function PAT_CLAIM_10() { return [{ text: 'CFB power ratings against the market', evidence_id: 9, confidence: 0.91,
  evidence: { id: 9, field_name: 'project', claim: 'CFB power ratings against the market', source_url: 'https://cfbnumbers.test/ratings', source_kind: 'own_site', source_excerpt: 'Week 5', current: true, own: true } }]; }
const QAPPROVED = { ok: true, status: 'approved', total: 1, rows: [
  card({ id: 'd9', pid: 'p1', name: 'Pat Analyst', status: 'approved', fit: 89, email: 'pat@cfbnumbers.test', subject: 'Approved one', body: 'Hi Pat.' })] };
const PROSPECTS = { total: 2, rows: [
  { id: 'p1', full_name: 'Pat Analyst', organization: 'CFB Numbers', prospect_type: 'cfb_analyst', sports_focus: ['CFB'], fit_score: 88, identity_confidence: 0.95, role_confidence: 0.9,
    email_confidence: 0.95, research_confidence: 0.9, email: 'pat@cfbnumbers.test', email_status: 'verified', status: 'ready_for_review', updated_at: '2026-10-05T12:00:00Z', is_test: false, suppressed: false },
  { id: 'pt', full_name: 'TEST PROSPECT', organization: null, prospect_type: 'other', sports_focus: [], fit_score: null, email: 'owner-test@edgedesk.test', email_status: 'verified',
    status: 'ready_for_review', updated_at: '2026-10-05T12:00:00Z', is_test: true, suppressed: false }] };

(async function main() {
  let pw = null;
  try { pw = require('playwright'); } catch (_) { try { pw = require('/opt/node22/lib/node_modules/playwright'); } catch (e2) { pw = null; } }
  if (!pw) { console.log('SKIPPED: playwright is not installed here'); process.exit(0); }
  const site = await serve();
  let browser;
  try { browser = await pw.chromium.launch({ headless: true }); }
  catch (e) {
    const exe = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium'].find((x) => fs.existsSync(x));
    if (exe) browser = await pw.chromium.launch({ headless: true, executablePath: exe }); else { console.log('SKIPPED: no Chromium'); process.exit(0); }
  }
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const BASE = 'http://127.0.0.1:' + site.port;

  /* role: 'owner' | 'admin' ; demoteAfter: number of outbound data calls before the owner is refused */
  async function open(o) {
    const ctx = await browser.newContext({ viewport: o.viewport || { width: 1280, height: 900 } });
    const T = jwt(o.role, nowSec() + 3600);
    await ctx.addInitScript(([k, v]) => { try { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem(k, v); sessionStorage.setItem('__seeded', '1'); } } catch (_) {} },
      [SKEY, JSON.stringify({ access_token: T, refresh_token: 'rt', expires_at: nowSec() + 3600, user: { id: o.role + '-id', email: o.role + '@edgedesk.test' } })]);
    const calls = [];
    const state = { batchRefuse: false, noInbox: false, fn: 'ok' };
    let st = Object.assign(freshSettings(), o.settings || {}), outboundData = 0;
    await ctx.route('**/*', async (route) => {
      const req = route.request(), url = req.url();
      if (url.indexOf('127.0.0.1') >= 0) return route.continue();
      const reply = (s, b) => route.fulfill({ status: s, contentType: 'application/json', body: JSON.stringify(b) });
      if (/auth\/v1\/logout/.test(url)) { calls.push(['logout']); return route.fulfill({ status: 204, body: '' }); }
      if (/functions\/v1\/growth_outbound_research/.test(url)) {
        const body = JSON.parse(req.postData() || '{}');
        calls.push(['fn:growth_outbound_research', body]);
        if (state.research === 'missing') return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
        if (body.action === 'status') return reply(200, { ok: true, providers: { search: true, email: false, llm: true, fetch: true, model: 'claude-opus-5-5' }, overview: RESEARCH_OV });
        if (body.action === 'discover') {
          if (state.research === 'nobrave') return reply(503, { ok: false, reason: 'search_not_configured', code: 'search_not_configured' });
          return reply(200, { ok: true, run_id: 9, queries: body.query ? 1 : 2, results: 18, new: 5, seen_again: 3, duplicates: 1, suppressed: 0, invalid: 0, per_query: [], notes: [] });
        }
        if (body.action === 'research') {
          if (body.next) return reply(200, { ok: false, reason: 'queue_empty', code: 'queue_empty' });
          if (body.candidate_id === 72) return reply(200, { ok: true, outcome: 'not_a_fit', reason: 'a tout selling picks', pages: 1 });
          return reply(200, { ok: true, outcome: body.prospect_id ? 'added' : 'created', prospect_id: body.prospect_id || 'p1', status: 'needs_research', evidence: 7, pages: 3,
            dropped: [{ field: 'job_title', why: 'quote not on the page' }, { field: 'organization', why: 'claim not in the quote' }],
            email: { address: 'pat@cfbnumbers.test', from: 'their own page', verdict: 'valid' }, urls_left_out: [], spent: { fetch: 4, llm: 1 }, notes: [] });
        }
        return reply(400, { ok: false, reason: 'bad_request' });
      }
      if (/functions\/v1\/growth_outbound_draft/.test(url)) {
        const body = JSON.parse(req.postData() || '{}');
        calls.push(['fn:growth_outbound_draft', body]);
        if (state.draft === 'missing') return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
        if (body.action === 'status') return reply(200, { ok: true, providers: { llm: true, model: 'claude-opus-5-5' }, overview: DRAFT_OV });
        if (body.action === 'draft' && body.prospect_id) {
          if (body.sequence_number === 2) return reply(200, { ok: false, prospect_id: body.prospect_id, sequence_number: 2, reason: 'not_due', code: 'not_due', detail: 'not due until 2026-10-12 09:00 UTC' });
          return reply(200, { ok: true, prospect_id: body.prospect_id, sequence_number: body.sequence_number, draft_id: 'd88', writer: 'claude', status: 'ready_for_review', attempts: [], run_id: 31, llm_calls: 1, notes: [] });
        }
        if (body.action === 'draft') {
          return reply(200, { ok: true, run_id: 30, asked: body.next, tried: 3, drafted: 2, by_claude: 1, by_template: 1, not_drafted: 1, llm_calls: 3, notes: [],
            results: [{ ok: true, writer: 'claude', prospect_id: 'p1', sequence_number: 1, draft_id: 'd81' },
              { ok: true, writer: 'template', prospect_id: 'p2', sequence_number: 1, draft_id: 'd82', attempts: [{ writer: 'claude', problems: ['"2024" comes from no cited claim'] }] },
              { ok: false, prospect_id: 'p3', sequence_number: 2, reason: 'no_citeable_fact' }] });
        }
        return reply(400, { ok: false, reason: 'bad_request' });
      }
      if (/functions\/v1\/growth_outbound_send/.test(url)) {
        const body = JSON.parse(req.postData() || '{}');
        calls.push(['fn:growth_outbound_send', body, req.headers().authorization]);
        if (state.fn === 'missing') return reply(404, { code: 'NOT_FOUND', message: 'Requested function was not found' });
        if (state.fn === 'nokey') return reply(503, { ok: false, reason: 'resend_not_configured', code: 'resend_not_configured' });
        if (state.fn === 'refused') return reply(200, { ok: true, sent: 0, results: body.draft_ids.map((d) => ({ draft_id: d, ok: false, reason: 'refused', detail: 'the daily send cap (20) is reached' })) });
        return reply(200, { ok: true, sent: body.draft_ids.length, results: body.draft_ids.map((d) => ({ draft_id: d, ok: true, state: 'sent', test: true, to: 'owner-test@edgedesk.test' })) });
      }
      const m = /rest\/v1\/rpc\/([a-z_]+)/.exec(url);
      if (!m) return route.fulfill({ status: 204, body: '' });
      const name = m[1], body = JSON.parse(req.postData() || '{}');
      calls.push([name, body]);
      if (name === 'growth_is_admin') return reply(200, true);
      if (name === 'growth_admin_activation') return reply(200, ACTIVATION);
      if (name === 'growth_admin_funnel') return reply(200, FUNNEL);
      if (name === 'growth_admin_samples') return reply(200, SAMPLES);
      if (name === 'growth_outbound_is_owner') return reply(200, o.role === 'owner');
      if (name.indexOf('growth_outbound_') === 0) {
        outboundData++;
        if (o.role !== 'owner' || (o.demoteAfter != null && outboundData > o.demoteAfter)) return reply(403, { code: '42501', message: 'outbound owner only' });
        if (name === 'growth_outbound_settings') return reply(200, st);
        if (name === 'growth_outbound_overview') return reply(200, { settings: st, prospects_by_status: { ready_for_review: 2, needs_research: 3 }, drafts_pending_review: 2, drafts_approved_unsent: 0, sends_7d_by_status: {}, suppressions: 1, discovered_today: 4 });
        if (name === 'growth_outbound_prospects') return reply(200, PROSPECTS);
        if (name === 'growth_outbound_suppressions') return reply(200, [{ created_at: '2026-10-05T11:00:00Z', scope: 'address', target: 'no@thanks.test', kind: 'unsubscribe', source: 'owner', reason: 'asked' }]);
        if (name === 'growth_outbound_activity') return reply(200, [{ at: '2026-10-05T11:00:00Z', actor_kind: 'owner', action: 'settings_changed', entity: 'settings', entity_id: '1', detail: { x: 1 } }]);
        if (name === 'growth_outbound_suppress') return reply(200, { ok: true, id: 9, prospects_suppressed: 1, drafts_cancelled: 1 });
        if (name === 'growth_outbound_review_queue') {
          if (o.noQueue) return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
          return reply(200, body.p_status === 'approved' ? QAPPROVED : state.queue10 ? Q10 : state.queue8 ? Q8 : QPENDING);
        }
        if (name === 'growth_outbound_sends') return reply(200, SENDS);
        if (name === 'growth_outbound_research_overview') return reply(200, RESEARCH_OV);
        if (name === 'growth_outbound_drafting_overview') return reply(200, DRAFT_OV);
        if (name === 'growth_outbound_automation_overview') {
          if (state.am === 'missing') return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
          return reply(200, Object.assign(AM_OV(), typeof state.am === 'object' ? state.am : {}));
        }
        if (name === 'growth_outbound_analytics') {
          if (state.results === 'missing') return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
          return reply(200, RESULTS(Object.assign({ days: body.p_days || 90, attribution_links: st.attribution_links !== false }, typeof state.results === 'object' ? state.results : {})));
        }
        if (name === 'growth_outbound_candidates') return reply(200, body.p_status === 'new' ? CANDS : []);
        if (name === 'growth_outbound_candidate_set') return reply(200, { ok: true, status: body.p_status });
        if (name === 'growth_outbound_draft_approve') return reply(200, { ok: true, draft_id: body.p_draft_id, approved_hash: body.p_content_hash });
        if (name === 'growth_outbound_drafts_approve_batch') {
          if (state.batchRefuse) return reply(200, { ok: false, reason: 'not_all_approvable', refused: [{ draft_id: 'd1', reason: 'below_gate', gates: ['fit score below minimum'] }] });
          return reply(200, { ok: true, approved: body.p_items.length, drafts: body.p_items.map((x) => x.draft_id) });
        }
        if (name === 'growth_outbound_draft_edit') return reply(200, { ok: true, content_hash: 'h-new', status: 'pending_review' });
        if (name === 'growth_outbound_draft_reject') return reply(200, { ok: true });
        if (name === 'growth_outbound_draft_unapprove') return reply(200, { ok: true, status: 'pending_review' });
        if (name === 'growth_outbound_test_fixture') return reply(200, state.noInbox ? { ok: false, reason: 'test_inbox_missing' } : { ok: true, prospect_id: 'pt', draft_id: 'dt', created: true });
        if (name === 'growth_outbound_draft_create') {
          if (/guaranteed/i.test(body.p.body_text)) return reply(200, { ok: false, reason: 'content', problems: ['promises winnings, a lock or a guarantee'] });
          return reply(200, { ok: true, draft_id: 'd77', content_hash: 'h-d77', status: 'ready_for_review' });
        }
        if (name === 'growth_outbound_fit_catalog') return o.noCatalog ? reply(404, { code: 'PGRST202', message: 'Could not find the function' }) : reply(200, CATALOG);
        if (name === 'growth_outbound_prospect_replied') {
          if (o.noReplied) return reply(404, { code: 'PGRST202', message: 'Could not find the function' });
          return reply(200, { ok: true, status: 'replied', drafts_cancelled: 1, suppressed: !!body.p_stop });
        }
        if (name === 'growth_outbound_prospect') {
          if (body.p_id === 'p1') return reply(200, Object.assign({}, DETAIL, o.results10 ? { conversions: [
            { stage: 'visited', matched_by: 'link', occurred_at: '2026-10-07T10:00:00Z', recorded_at: '2026-10-07T11:00:00Z' },
            { stage: 'signed_up', matched_by: 'link', occurred_at: '2026-10-07T10:05:00Z', recorded_at: '2026-10-07T11:00:00Z' },
            { stage: 'paid', matched_by: 'link', occurred_at: '2026-10-07T12:00:00Z', recorded_at: '2026-10-07T13:00:00Z' }] } : {}));
          if (body.p_id === 'pc') {
            return reply(200, Object.assign({}, DETAIL, { prospect: Object.assign({}, DETAIL.prospect, { id: 'pc', full_name: 'Cam Contacted', status: o.pcStatus || 'contacted',
              email: 'cam@contacted.test', suppressed: !!o.pcSuppressed }) }));
          }
          return reply(200, { ok: true, prospect: { id: body.p_id, full_name: null, prospect_type: 'other', status: 'discovered', warnings: [], assessment: { gates: [] } },
            evidence: [], identifiers: [], related: [], drafts: [], sends: [], activity: [] });
        }
        if (name === 'growth_outbound_evidence_add') {
          const ev = (body.p && body.p.evidence) || [];
          if (ev.length && !/^https:/.test(ev[0].source_url)) return reply(200, { ok: false, reason: 'invalid', at: 'evidence 1', detail: 'the source must be a web page (https://…)' });
          return reply(200, { ok: true, prospect_id: body.p_prospect, created: false, evidence_ids: [99], status: 'ready_for_review', warnings: [], possible_duplicates: [] });
        }
        if (name === 'growth_outbound_evidence_supersede') return reply(200, { ok: true, status: 'ready_for_review', warnings: [] });
        if (name === 'growth_outbound_identifier_release') return reply(200, { ok: true, cleared: ['email'], status: 'needs_research' });
        if (name === 'growth_outbound_prospect_set_status') return reply(200, { ok: true, status: body.p_status, drafts_cancelled: 1 });
        if (name === 'growth_outbound_prospect_evaluate') return reply(200, { ok: true, status: 'ready_for_review' });
        if (name === 'growth_outbound_identity_lookup') {
          if (!/[@/.]/.test(body.p_text)) return reply(200, { ok: false, reason: 'not_an_email_or_url' });
          return reply(200, { ok: true, canonical: 'https://x.com/PatAnalyst', suppressed: false,
            keys: [{ kind: 'handle', value: 'x:patanalyst', strength: 'strong', matches: [{ prospect_id: 'p1', full_name: 'Pat Analyst', status: 'ready_for_review', released: false }] }] });
        }
        if (name === 'growth_outbound_prospect_upsert') {
          if (/gone@/.test(body.p && body.p.email)) return reply(200, { ok: false, reason: 'suppressed', prospect_id: null });
          return reply(200, { ok: true, prospect_id: 'p9', created: true, evidence_ids: [100], status: 'discovered', warnings: [], possible_duplicates: [] });
        }
        if (name === 'growth_outbound_settings_update') {
          const p = body.p || {};
          if (p.max_sends_per_day > st.max_sends_per_day && !p.confirm_cap_increase) return reply(200, { ok: false, reason: 'cap_increase_needs_confirmation' });
          if (p.test_mode === false && st.test_mode && !p.confirm_live) return reply(200, { ok: false, reason: 'going_live_needs_confirmation' });
          const changed = {};
          if (p.discovery_config && p.discovery_config.budget && typeof p.discovery_config.budget.llm !== 'number' && p.discovery_config.budget.llm != null) {
            return reply(200, { ok: false, reason: 'invalid_value', detail: 'budget: llm must be a whole number' });
          }
          Object.keys(p).filter((k) => k.indexOf('confirm_') !== 0).forEach((k) => { changed[k] = { from: st[k], to: p[k] }; st[k] = p[k]; });
          return reply(200, { ok: true, changed, settings: st });
        }
      }
      return reply(404, { code: 'PGRST202', message: 'no such function' });
    });
    const page = await ctx.newPage();
    const errors = [], dialogs = [];
    let answer = [];
    page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
    page.on('dialog', async (d) => { dialogs.push({ type: d.type(), msg: d.message() }); const a = answer.shift(); if (a === undefined || a === false) await d.dismiss(); else await d.accept(a === true ? undefined : a); });
    await page.goto(BASE + '/admin/growth/', { waitUntil: 'load' });
    await page.waitForSelector('#app:not(.hide)', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(500);
    return { ctx, page, calls, errors, dialogs, state, setAnswers: (a) => { answer = a; }, settings: () => st };
  }
  const visible = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return !!e && !e.closest('.hide') && e.getBoundingClientRect().height > 0; }, sel);
  const text = (page, sel) => page.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);
  const settle = (page, ms) => page.waitForTimeout(ms || 400);
  const outboundCalls = (calls) => calls.filter((c) => /^growth_outbound_/.test(c[0])).map((c) => c[0]);

  /* ── 1–4. the owner ─────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    chk('1 the owner sees the Outbound tab', await visible(t.page, '#tabBtnOutbound'));
    chk('1 TEST MODE is marked in the header before the tab is even opened', await visible(t.page, '#obModeTag') && /test mode/i.test(await text(t.page, '#obModeTag')));
    chk('1 … and no outbound DATA is loaded until the tab is opened', !outboundCalls(t.calls).some((n) => /overview|prospects|suppressions|activity/.test(n)));
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    chk('1 the tab opens', await visible(t.page, '#tabOutbound') && !(await visible(t.page, '#actKpis')));
    chk('1 the TEST MODE chip names the test inbox', /TEST MODE — sends go only to owner-test@edgedesk\.test/.test(await text(t.page, '#obChips')));
    chk('1 what blocks sending is said in words', await visible(t.page, '#obBlock') && /postal address/.test(await text(t.page, '#obBlock')) && /opt-out endpoint/.test(await text(t.page, '#obBlock')));
    const k = await text(t.page, '#obKpis');
    chk('1 the morning numbers, and "sent automatically" is zero', /Discovered today4/.test(k) && /Ready for review2/.test(k) && /Sent automatically0/.test(k), k);
    const pr = await text(t.page, '#obProspects');
    chk('1 prospects show their emails and confidence (owner only)', /pat@cfbnumbers\.test/.test(pr) && /0\.95/.test(pr));
    chk('1 a test prospect is marked TEST', /TEST PROSPECT\s*TEST/.test(pr));
    chk('1 suppressions and activity render', /no@thanks\.test/.test(await text(t.page, '#obSupp')) && /settings_changed/.test(await text(t.page, '#obActivity')));
    chk('1 settings render from the database', (await t.page.inputValue('#obf_max_sends_per_day')) === '20' && (await t.page.inputValue('#obf_sender_email')) === 'davis@edgedesksports.com');
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-owner.png'), fullPage: true });

    /* 2. raise the cap: decline, then accept */
    await t.page.fill('#obf_max_sends_per_day', '30');
    t.setAnswers([false]);
    await t.page.click('#obSave'); await settle(t.page);
    chk('2 raising the cap asks, with both numbers', t.dialogs.length === 1 && /from 20 to 30/.test(t.dialogs[0].msg), t.dialogs);
    chk('2 declining sends nothing to the database', !t.calls.some((c) => c[0] === 'growth_outbound_settings_update') && /not confirmed/.test(await text(t.page, '#obSetMsg')));
    t.setAnswers([true]);
    await t.page.click('#obSave'); await settle(t.page);
    const up = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update');
    chk('2 accepting sends the new cap WITH the confirmation flag', up.length === 1 && up[0][1].p.max_sends_per_day === 30 && up[0][1].p.confirm_cap_increase === true, up);
    chk('2 … and says what was saved', /Saved: max_sends_per_day/.test(await text(t.page, '#obSetMsg')));

    /* lowering needs no dialog */
    const before = t.dialogs.length;
    await t.page.fill('#obf_max_sends_per_day', '12'); await t.page.click('#obSave'); await settle(t.page);
    const up2 = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update');
    chk('2 lowering the cap needs no confirmation and sends no flag', t.dialogs.length === before && up2.length === 2 && up2[1][1].p.max_sends_per_day === 12 && !up2[1][1].p.confirm_cap_increase);

    /* 3. leave test mode */
    await t.page.uncheck('#obf_test_mode');
    t.setAnswers(['live']);
    await t.page.click('#obSave'); await settle(t.page);
    chk('3 leaving test mode must be TYPED: "live" (lower case) is not enough, nothing is sent',
      t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').length === 2 && /still in test mode/.test(await text(t.page, '#obSetMsg')));
    t.setAnswers(['LIVE']);
    await t.page.click('#obSave'); await settle(t.page);
    const up3 = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update');
    chk('3 typing LIVE sends test_mode false WITH confirm_live', up3.length === 3 && up3[2][1].p.test_mode === false && up3[2][1].p.confirm_live === true, up3[2]);
    chk('3 once live, the header and the chip say LIVE', /LIVE/.test(await text(t.page, '#obModeTag')) && /LIVE — approved drafts reach real prospects/.test(await text(t.page, '#obChips')));
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-live.png') });

    /* 4. suppress */
    await t.page.fill('#supTarget', 'propslab.test'); await t.page.selectOption('#supScope', 'domain'); await t.page.selectOption('#supKind', 'do_not_contact');
    t.setAnswers([false]);
    await t.page.click('#supAdd'); await settle(t.page);
    chk('4 suppressing asks first; declining sends nothing', !t.calls.some((c) => c[0] === 'growth_outbound_suppress') && /every address at propslab\.test/.test(t.dialogs[t.dialogs.length - 1].msg));
    t.setAnswers([true]);
    await t.page.click('#supAdd'); await settle(t.page);
    const sp = t.calls.filter((c) => c[0] === 'growth_outbound_suppress');
    chk('4 accepting calls the suppress door with the scope and kind', sp.length === 1 && sp[0][1].p_target === 'propslab.test' && sp[0][1].p_scope === 'domain' && sp[0][1].p_kind === 'do_not_contact');
    chk('4 … and reports what it did', /1 prospect\(s\) marked, 1 draft\(s\) cancelled/.test(await text(t.page, '#supMsg')));

    /* 7. sign out */
    await t.page.click('#signOut'); await settle(t.page);
    chk('7 sign-out hides the tab and the mode tag', !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#obModeTag')) && !(await visible(t.page, '#tabOutbound')));
    chk('1-7 no page errors for the owner', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 9–16. research ─────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    const last = (n) => t.calls.filter((c) => c[0] === n).slice(-1)[0];
    const countOf = (n) => t.calls.filter((c) => c[0] === n).length;
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    chk('9 no prospect is fetched until one is opened', countOf('growth_outbound_prospect') === 0);
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    chk('9 opening a prospect asks for exactly that one', countOf('growth_outbound_prospect') === 1 && last('growth_outbound_prospect')[1].p_id === 'p1');
    const dt = await text(t.page, '#obDetail');
    chk('9 the detail is shown, every gate clearing', await visible(t.page, '#obDetail') && /Every gate clears/.test(dt), dt.slice(0, 200));
    chk('9 each number beside its bar', /Identity0\.91needs 0\.9/.test(dt) && /Role0\.35aim 0\.85 · a gate only when a draft cites it/.test(dt) && /Fit89needs 80/.test(dt), dt.slice(0, 400));
    chk('9 a weak bar is marked short, a met one passing', await t.page.evaluate(() => !!document.querySelector('#obDetail .kpi.short') && !!document.querySelector('#obDetail .kpi.pass')));
    chk('9 why a fact is not more certain, and its rival claim', /sources disagree; only one independent source/.test(dt) && /Head of Data \(0\.35\)/.test(dt));
    chk('9 warnings in words', /the title or role is old/.test(dt) && /may be the same person as another prospect/.test(dt));
    chk('9 a possible duplicate is named and can be opened', /Possibly the same person as Ed Itor/.test(dt) && await visible(t.page, '#obDetail [data-open="p2"]'));
    chk('9 history: previously, superseded, and why', /previously — superseded 2026-10-06: replaced by evidence 7/.test(dt));
    chk('9 a penalty shows it needs no evidence; a positive reason cites its evidence', /\+18#9/.test(dt) && /-40— \(a penalty needs none\)/.test(dt));
    const xss = await t.page.evaluate(() => ({ pwned: window.__pwned === 1, img: !!document.querySelector('#obDetail img'), js: !!document.querySelector('a[href^="javascript"]') }));
    chk('9 text from the web is shown as text: no markup from it runs', !xss.pwned && !xss.img && dt.indexOf('<img src=x') >= 0, xss);
    chk('9 a non-https source is never a link', !xss.js);
    const a = await t.page.evaluate(() => { const x = document.querySelector('#obDetail a[href="https://cfbnumbers.test/about"]'); return x && [x.target, x.rel]; });
    chk('9 an https source is a link that opens apart, with no referrer', a && a[0] === '_blank' && /noopener/.test(a[1]) && /noreferrer/.test(a[1]) && /nofollow/.test(a[1]), a);
    await t.page.click('[data-open="pt"]'); await settle(t.page, 600);
    chk('9 a prospect the database has not assessed is never shown as clearing the gates', /Not assessed yet/.test(await text(t.page, '#obDetail'))
      && !/Every gate clears/.test(await text(t.page, '#obDetail')));
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    chk('9 an email can be released; the name+organization key cannot', await visible(t.page, '[data-release="31"]') && !(await t.page.$('[data-release="32"]')));
    if (SHOTS) await (await t.page.$('#obDetailWrap')).screenshot({ path: path.join(SHOTS, 'outbound-prospect.png') });

    /* 10. supersede */
    t.setAnswers(['  ']);
    await t.page.click('[data-supersede="7"]'); await settle(t.page);
    chk('10 superseding asks why; no reason sends nothing', countOf('growth_outbound_evidence_supersede') === 0 && /stays on the record as "previously"/.test(t.dialogs.slice(-1)[0].msg));
    t.setAnswers(['the site changed it']);
    await t.page.click('[data-supersede="7"]'); await settle(t.page, 600);
    const sup = last('growth_outbound_evidence_supersede');
    chk('10 with a reason, that observation is superseded, and the prospect re-read', sup && sup[1].p_evidence_id === 7 && sup[1].p_reason === 'the site changed it'
      && countOf('growth_outbound_prospect') === 4, sup);

    /* 11. add evidence */
    await t.page.click('#evAdd'); await settle(t.page);
    chk('11 a claim and its page are both needed; nothing is sent without them', countOf('growth_outbound_evidence_add') === 0 && /both needed/.test(await text(t.page, '#evMsg')));
    await t.page.selectOption('#evField', 'job_title'); await t.page.fill('#evClaim', 'Head of Research');
    await t.page.fill('#evUrl', 'ftp://cfbnumbers.test/x'); await t.page.selectOption('#evKind', 'own_profile'); await t.page.fill('#evQuote', 'Head of Research at CFB Numbers');
    await t.page.fill('#evDate', '2026-09-30');
    await t.page.click('#evAdd'); await settle(t.page);
    const ea = last('growth_outbound_evidence_add');
    chk('11 exactly what was typed is sent, to that prospect', ea && ea[1].p_prospect === 'p1' && JSON.stringify(ea[1].p) === JSON.stringify({ evidence: [{ field_name: 'job_title',
      claim: 'Head of Research', source_url: 'ftp://cfbnumbers.test/x', source_kind: 'own_profile', source_excerpt: 'Head of Research at CFB Numbers', source_published_at: '2026-09-30T00:00:00Z' }] }), ea && ea[1]);
    chk('11 the database\'s refusal is shown', /Not added: the source must be a web page/.test(await text(t.page, '#evMsg')));
    await t.page.fill('#evUrl', 'https://x.com/patanalyst'); await t.page.click('#evAdd'); await settle(t.page, 600);
    chk('11 accepted, the prospect is re-read', countOf('growth_outbound_evidence_add') === 2 && countOf('growth_outbound_prospect') === 5);

    /* 12. fit reasons */
    await t.page.selectOption('#fitCode', 'quant_analysis'); await t.page.selectOption('#fitEv', '9');
    await t.page.click('#fitAdd'); await settle(t.page, 600);
    chk('12 a reason is added resting on the chosen evidence', JSON.stringify(last('growth_outbound_evidence_add')[1].p) === JSON.stringify({ fit_factors: [{ code: 'quant_analysis', evidence: [9] }] }));
    await t.page.selectOption('#fitCode', 'touting'); await t.page.click('#fitDrop'); await settle(t.page, 600);
    chk('12 … or removed', JSON.stringify(last('growth_outbound_evidence_add')[1].p) === JSON.stringify({ fit_factors: [{ code: 'touting', remove: true }] }));
    chk('12 the email address is never offered as fit evidence', !(await t.page.$('#fitEv option[value="31"]')));

    /* 13. release */
    t.setAnswers([false]);
    await t.page.click('[data-release="31"]'); await settle(t.page);
    chk('13 "not theirs" asks first; cancelling sends nothing', countOf('growth_outbound_identifier_release') === 0);
    t.setAnswers(['belongs to the editor']);
    await t.page.click('[data-release="31"]'); await settle(t.page, 600);
    const rl = last('growth_outbound_identifier_release');
    chk('13 with a reason, that identifier is released', rl && rl[1].p_identifier_id === 31 && rl[1].p_reason === 'belongs to the editor', rl);

    /* 14. status */
    t.setAnswers(['confirm the title']);
    await t.page.click('#pdResearch'); await settle(t.page, 600);
    const ss = last('growth_outbound_prospect_set_status');
    chk('14 "needs more research" asks what, then says so to the database', ss && ss[1].p_id === 'p1' && ss[1].p_status === 'needs_research' && ss[1].p_reason === 'confirm the title', ss);
    t.setAnswers([false]);
    await t.page.click('#pdReject'); await settle(t.page);
    chk('14 "reject" asks first; cancelling sends nothing', countOf('growth_outbound_prospect_set_status') === 1);
    await t.page.click('#pdEval'); await settle(t.page, 600);
    chk('14 re-evaluate asks the database, which does the arithmetic', countOf('growth_outbound_prospect_evaluate') === 1);

    /* 15. have we seen them? */
    await t.page.fill('#obLook', 'hello'); await t.page.click('#obLookBtn'); await settle(t.page);
    chk('15 anything but an email or a web address is said to be so', /not an email address or a web address/.test(await text(t.page, '#obLookOut')));
    await t.page.fill('#obLook', 'https://m.twitter.com/PatAnalyst?s=20'); await t.page.press('#obLook', 'Enter'); await settle(t.page);
    const lo = await text(t.page, '#obLookOut');
    chk('15 a tagged mobile link is recognised as Pat, already known', /https:\/\/x\.com\/PatAnalyst/.test(lo) && /Already known: Pat Analyst \(Ready for review, by handle\)/.test(lo), lo);
    const before = countOf('growth_outbound_prospect');
    await t.page.click('#obLookOut [data-open="p1"]'); await settle(t.page, 600);
    chk('15 … and opens their record', countOf('growth_outbound_prospect') === before + 1);

    /* 16. add a prospect */
    await t.page.click('#apAdd'); await settle(t.page);
    chk('16 a prospect needs an email or a URL; nothing is sent without', countOf('growth_outbound_prospect_upsert') === 0 && /recognise again/.test(await text(t.page, '#apMsg')));
    await t.page.fill('#apEmail', 'new@new.test'); await t.page.fill('#apUrls', 'https://x.com/newperson\n https://new.test ');
    await t.page.selectOption('#apType', 'nfl_analyst'); await t.page.fill('#apSports', 'NFL, props');
    await t.page.selectOption('#apField', 'full_name'); await t.page.fill('#apClaim', 'New Person'); await t.page.fill('#apSrc', 'https://new.test/about');
    await t.page.selectOption('#apKind', 'own_site'); await t.page.fill('#apQuote', 'I am New Person');
    await t.page.click('#apAdd'); await settle(t.page, 700);
    const ap = last('growth_outbound_prospect_upsert');
    chk('16 the email, each URL, the sports and the first fact are sent — and no test flag', ap && JSON.stringify(ap[1].p) === JSON.stringify({ email: 'new@new.test',
      urls: ['https://x.com/newperson', 'https://new.test'], prospect_type: 'nfl_analyst', campaign_type: 'customer', sports_focus: ['NFL', 'props'],
      evidence: [{ field_name: 'full_name', claim: 'New Person', source_url: 'https://new.test/about', source_kind: 'own_site', source_excerpt: 'I am New Person' }] }), ap && ap[1]);
    chk('16 it says what happened and opens the new record', /Added\. Status: Discovered\./.test(await text(t.page, '#apMsg')) && last('growth_outbound_prospect')[1].p_id === 'p9');
    await t.page.fill('#apEmail', 'gone@optout.test'); await t.page.click('#apAdd'); await settle(t.page);
    chk('16 a suppressed person is reported, not added', /suppressed/.test(await text(t.page, '#apMsg')));
    chk('9-16 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 18–25. the review queue ────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    const last = (n) => t.calls.filter((c) => c[0] === n).slice(-1)[0];
    const countOf = (n) => t.calls.filter((c) => c[0] === n).length;
    chk('18 the queue is not loaded before the tab is opened', countOf('growth_outbound_review_queue') === 0);
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    chk('18 opening the tab loads the drafts waiting for review', last('growth_outbound_review_queue') && last('growth_outbound_review_queue')[1].p_status === 'pending_review'
      && /3 waiting for review/.test(await text(t.page, '#rqTotal')));
    const c1 = await text(t.page, '[data-draft="d1"]');
    chk('18 a card is the message as it would be sent: from, to (the test inbox, not the person), subject, body, footer',
      /FromDavis <davis@edgedesksports\.com>/.test(c1) && /Toowner-test@edgedesk\.test \(test: not pat@cfbnumbers\.test\)/.test(c1)
      && /SubjectYour CFB ratings/.test(c1) && /Not for you\? Reply "stop"/.test(c1), c1.slice(0, 300));
    chk('18 … marked TEST', /^TEST/.test((await text(t.page, '[data-draft="d1"] .rqh .pill'))));
    chk('18 … what it says about them, with the evidence, source and words behind it', /“your CFB power ratings against the market” rests on #9 · Project · Their own site · cfbnumbers\.test · confidence 0\.91/.test(c1)
      && /Week 5 power ratings against the closing line/.test(c1));
    const x = await t.page.evaluate(() => ({ pwned: window.__pwned2 === 1, script: !!document.querySelector('#rqCards script') }));
    chk('18 text in a draft is shown as text: no markup in it runs', !x.pwned && !x.script && c1.indexOf('<script>') >= 0, x);
    const c2 = await text(t.page, '[data-draft="d2"]');
    chk('18 a blocked draft says why: the gates, the content rules, the claim no longer in its words, the claim with no evidence',
      /Not approvable yet\. fit 0 < 80 · identity 0\.2500 < 0\.90 · the email no longer says "your show"/.test(c2)
      && /Breaks the content rules: promises winnings, a lock or a guarantee/.test(c2) && /cites no evidence/.test(c2), c2.slice(0, 400));
    chk('18 … and cannot be selected or approved', await t.page.evaluate(() => document.querySelector('[data-pick="d2"]').disabled && document.querySelector('[data-approve="d2"]').disabled));
    chk('18 the batch button starts empty and disabled', /Approve selected \(0\)/.test(await text(t.page, '#rqBatch')) && await t.page.evaluate(() => document.querySelector('#rqBatch').disabled));
    if (SHOTS) await (await t.page.$('#rqCards')).screenshot({ path: path.join(SHOTS, 'outbound-queue.png') });

    /* 19. approve one */
    t.setAnswers([false]);
    await t.page.click('[data-approve="d1"]'); await settle(t.page);
    const dlg = t.dialogs.slice(-1)[0].msg;
    chk('19 approving asks first, saying it sends nothing and that it is a test', /Approve this message to owner-test@edgedesk\.test\?/.test(dlg)
      && /Approving sends nothing/.test(dlg) && /TEST/.test(dlg) && countOf('growth_outbound_draft_approve') === 0, dlg);
    t.setAnswers([true]);
    await t.page.click('[data-approve="d1"]'); await settle(t.page, 600);
    const ap = last('growth_outbound_draft_approve');
    chk('19 accepted, it approves exactly the content on screen', ap && ap[1].p_draft_id === 'd1' && ap[1].p_content_hash === 'h-d1', ap);
    chk('19 … and says nothing was sent', /Approved\. Nothing was sent\./.test(await text(t.page, '#rqMsg')));

    /* 20. batch */
    await t.page.check('[data-pick="d1"]'); await t.page.check('[data-pick="dt"]');
    chk('20 two approvable drafts selected', /Approve selected \(2\)/.test(await text(t.page, '#rqBatch')));
    await t.page.evaluate(() => { const b = document.querySelector('[data-pick="d2"]'); b.disabled = false; b.checked = true; b.dispatchEvent(new Event('change', { bubbles: true })); });
    chk('20 a blocked draft cannot be forced into the batch from the page', /Approve selected \(2\)/.test(await text(t.page, '#rqBatch')));
    t.setAnswers(['3']);
    await t.page.click('#rqBatch'); await settle(t.page);
    chk('20 the count must be typed; a wrong number sends nothing', countOf('growth_outbound_drafts_approve_batch') === 0 && /you typed "3" for 2 selected/.test(await text(t.page, '#rqMsg'))
      && /Type the number 2 to confirm/.test(t.dialogs.slice(-1)[0].msg) && /If any one of them cannot be approved, none is/.test(t.dialogs.slice(-1)[0].msg));
    t.setAnswers([false]);
    await t.page.click('#rqBatch'); await settle(t.page);
    chk('20 cancelling sends nothing', countOf('growth_outbound_drafts_approve_batch') === 0);
    t.state.batchRefuse = true;
    t.setAnswers([' 2 ']);
    await t.page.click('#rqBatch'); await settle(t.page, 600);
    const b1 = last('growth_outbound_drafts_approve_batch');
    chk('20 the typed number goes to the database with exactly the selected drafts and the content on screen', b1 && b1[1].p_confirm_count === 2
      && JSON.stringify(b1[1].p_items.map((i) => i.draft_id + ':' + i.content_hash).sort()) === JSON.stringify(['d1:h-d1', 'dt:h-dt']), b1 && b1[1]);
    chk('20 a refusal says nothing was approved, and why', /Nothing was approved: Pat Analyst — fit score below minimum/.test(await text(t.page, '#rqMsg')));
    t.state.batchRefuse = false;
    t.setAnswers(['2']);
    await t.page.click('#rqBatch'); await settle(t.page, 600);
    chk('20 accepted: "Approved 2 drafts. Nothing was sent."', /Approved 2 drafts\. Nothing was sent\./.test(await text(t.page, '#rqMsg')));
    chk('20 the selection is cleared after the queue reloads', /Approve selected \(0\)/.test(await text(t.page, '#rqBatch')));

    /* 21. edit */
    chk('21 the editor starts hidden', !(await visible(t.page, '#rqe_d1')));
    await t.page.click('[data-edit="d1"]'); await settle(t.page, 200);
    chk('21 Edit opens it with the current words', await visible(t.page, '#rqe_d1') && (await t.page.inputValue('[data-esubj="d1"]')) === 'Your CFB ratings');
    await t.page.fill('[data-ebody="d1"]', 'Hi Pat, I read your CFB power ratings against the market. Edited.');
    await t.page.click('[data-esave="d1"]'); await settle(t.page, 600);
    const ed = last('growth_outbound_draft_edit');
    chk('21 saving sends the new words against the version on screen', ed && ed[1].p_draft_id === 'd1' && ed[1].p_expected_hash === 'h-d1'
      && ed[1].p_body_text === 'Hi Pat, I read your CFB power ratings against the market. Edited.' && ed[1].p_subject === 'Your CFB ratings', ed && ed[1]);

    /* 22. reject */
    t.setAnswers([false]);
    await t.page.click('[data-reject="d2"]'); await settle(t.page);
    chk('22 reject asks first; cancelling sends nothing', countOf('growth_outbound_draft_reject') === 0);
    t.setAnswers(['not a fit']);
    await t.page.click('[data-reject="d2"]'); await settle(t.page, 600);
    chk('22 … with a reason, it is rejected', last('growth_outbound_draft_reject')[1].p_draft_id === 'd2' && last('growth_outbound_draft_reject')[1].p_reason === 'not a fit');

    /* 23. approved, not sent */
    await t.page.click('#rqSeg [data-q="approved"]'); await settle(t.page, 600);
    chk('23 the approved list is asked for', last('growth_outbound_review_queue')[1].p_status === 'approved' && /1 approved, not sent/.test(await text(t.page, '#rqTotal')));
    chk('23 an approved card can be withdrawn, cannot be selected, and there is no batch here', await visible(t.page, '[data-unapprove="d9"]')
      && !(await t.page.$('[data-pick="d9"]')) && !(await visible(t.page, '#rqBatch')) && /Not sent yet/.test(await text(t.page, '[data-draft="d9"]')));
    t.setAnswers([true]);
    await t.page.click('[data-unapprove="d9"]'); await settle(t.page, 600);
    chk('23 withdrawing asks, then takes the approval back', /Withdraw this approval\?/.test(t.dialogs.slice(-1)[0].msg) && last('growth_outbound_draft_unapprove')[1].p_draft_id === 'd9');

    /* 24. the test fixture */
    await t.page.click('#rqFixture'); await settle(t.page, 600);
    chk('24 the test-draft button makes one for the owner\'s own inbox, and goes back to the waiting list', countOf('growth_outbound_test_fixture') === 1
      && /A test draft for your own inbox is in the queue/.test(await text(t.page, '#rqMsg')) && last('growth_outbound_review_queue')[1].p_status === 'pending_review');
    t.state.noInbox = true;
    await t.page.click('#rqFixture'); await settle(t.page, 400);
    chk('24 … and says to set a test inbox when there is none', /Set a test inbox in the outbound settings first/.test(await text(t.page, '#rqMsg')));

    /* 25. write a draft */
    await t.page.click('#obProspects [data-open="p1"]'); await settle(t.page, 600);
    chk('25 a prospect offers to write a draft, citing its current evidence (never the email)', await visible(t.page, '#wdCreate')
      && !!(await t.page.$('#wdEv1 option[value="9"]')) && !(await t.page.$('#wdEv1 option[value="5"]')));
    await t.page.click('#wdCreate'); await settle(t.page);
    chk('25 a subject and the email are needed; nothing is sent without', countOf('growth_outbound_draft_create') === 0 && /both needed/.test(await text(t.page, '#wdMsg')));
    await t.page.fill('#wdSubject', 'Your CFB ratings'); await t.page.fill('#wdBody', 'Hi Pat, I read your ratings. Guaranteed edge.');
    await t.page.selectOption('#wdEv1', '9'); await t.page.fill('#wdTxt1', 'your ratings');
    await t.page.click('#wdCreate'); await settle(t.page, 500);
    const wd = last('growth_outbound_draft_create');
    chk('25 the draft is sent with its claims and the evidence each rests on', wd && wd[1].p_prospect === 'p1' && JSON.stringify(wd[1].p) === JSON.stringify({ sequence_number: 1,
      subject: 'Your CFB ratings', body_text: 'Hi Pat, I read your ratings. Guaranteed edge.', claims: [{ text: 'your ratings', evidence_id: 9 }] }), wd && wd[1]);
    chk('25 a broken content rule is said in words', /Not queued: promises winnings, a lock or a guarantee/.test(await text(t.page, '#wdMsg')));
    await t.page.fill('#wdBody', 'Hi Pat, I read your ratings.');
    await t.page.click('#wdCreate'); await settle(t.page, 700);
    chk('25 accepted, it is in the review queue', countOf('growth_outbound_draft_create') === 2 && /Your draft is in the review queue/.test(await text(t.page, '#rqMsg')));
    chk('18-25 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 26–30. sending ─────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    const fnCalls = () => t.calls.filter((c) => c[0] === 'fn:growth_outbound_send');
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    const sends = await text(t.page, '#obSends');
    chk('26 the Sends table: test sends to the test inbox, for whom, with their status and why', /owner-test@edgedesk\.testfor pat@cfbnumbers\.test/.test(sends)
      && /delivered/.test(sends) && /Resend answered 503/.test(sends) && /refused by Resend \(422\): Invalid `to` field/.test(sends), sends.slice(0, 400));
    chk('26 … text from a subject stays text', await t.page.evaluate(() => !document.querySelector('#obSends b')) && /<b>bold<\/b>/.test(sends));
    chk('26 "Try again" only for a send still waiting for an answer', await visible(t.page, '[data-resend="d8"]') && !(await t.page.$('[data-resend="d7"]')) && !(await t.page.$('[data-resend="d6"]')));
    chk('26 in test mode, what live sending still needs is said', /Before going live, sending to real people also needs: no postal address is configured.*the opt-out endpoint is not configured yet/.test(await text(t.page, '#obLiveNote')));
    chk('26 nothing is sent by opening the page', fnCalls().length === 0);

    await t.page.click('#rqSeg [data-q="approved"]'); await settle(t.page, 600);
    chk('27 an approved TEST card offers "Send test"', /Send test/.test(await text(t.page, '[data-send="d9"]')));
    t.setAnswers([false]);
    await t.page.click('[data-send="d9"]'); await settle(t.page);
    chk('27 Send asks first, naming the test inbox; declining sends nothing', /Send this TEST email to your test inbox, owner-test@edgedesk\.test\?/.test(t.dialogs.slice(-1)[0].msg) && fnCalls().length === 0);
    t.setAnswers([true]);
    await t.page.click('[data-send="d9"]'); await settle(t.page, 700);
    const f1 = fnCalls()[0];
    chk('27 accepted, the send function is asked for exactly that draft, with the owner\'s own session', f1 && JSON.stringify(f1[1]) === JSON.stringify({ draft_ids: ['d9'] })
      && /^Bearer /.test(f1[2] || ''), f1);
    chk('27 … and the answer is said', /Sent 1 email to your test inbox\./.test(await text(t.page, '#rqMsg')));

    await t.page.click('#rqSeg [data-q="approved"]'); await settle(t.page, 600);
    chk('28 "Send all shown" counts what is shown', /Send all shown \(1\)/.test(await text(t.page, '#rqSendAll')) && await visible(t.page, '#rqSendAll'));
    t.setAnswers(['2']);
    await t.page.click('#rqSendAll'); await settle(t.page);
    chk('28 the count must be typed; a wrong number sends nothing', fnCalls().length === 1 && /Nothing was sent: you typed "2" for 1/.test(await text(t.page, '#rqMsg'))
      && /all to your test inbox/.test(t.dialogs.slice(-1)[0].msg));
    t.setAnswers(['1']);
    await t.page.click('#rqSendAll'); await settle(t.page, 700);
    chk('28 typed right, it sends exactly those', fnCalls().length === 2 && JSON.stringify(fnCalls()[1][1]) === JSON.stringify({ draft_ids: ['d9'] }));

    t.state.fn = 'refused';
    await t.page.click('#rqSeg [data-q="approved"]'); await settle(t.page, 600);
    t.setAnswers([true]); await t.page.click('[data-send="d9"]'); await settle(t.page, 700);
    chk('29 the database\'s refusal is said in its words', /Nothing was sent\. Pat Analyst — the daily send cap \(20\) is reached/.test(await text(t.page, '#rqMsg')), await text(t.page, '#rqMsg'));
    t.state.fn = 'missing';
    t.setAnswers([true]); await t.page.click('[data-send="d9"]'); await settle(t.page, 700);
    chk('29 a send function that is not deployed says so — and the tab stays', /The send function is not deployed yet/.test(await text(t.page, '#rqMsg')) && await visible(t.page, '#tabOutbound'));
    t.state.fn = 'nokey';
    t.setAnswers([true]); await t.page.click('[data-send="d9"]'); await settle(t.page, 700);
    chk('29 no Resend key says so', /RESEND_API_KEY is not set/.test(await text(t.page, '#rqMsg')));

    t.state.fn = 'ok';
    t.setAnswers([false]);
    const before = fnCalls().length;
    await t.page.click('[data-resend="d8"]'); await settle(t.page);
    chk('30 "Try again" asks first, saying it can never go out twice; declining sends nothing', fnCalls().length === before && /can never go out twice/.test(t.dialogs.slice(-1)[0].msg));
    t.setAnswers([true]);
    await t.page.click('[data-resend="d8"]'); await settle(t.page, 700);
    chk('30 … accepted, the same draft is sent again (the same key, server-side)', JSON.stringify(fnCalls().slice(-1)[0][1]) === JSON.stringify({ draft_ids: ['d8'] }));
    chk('26-30 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 31–34. what comes back (Phase 6) ───────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    chk('31 no webhook secret: the header says Resend\'s events cannot arrive', /Resend events: signing secret not set/.test(await text(t.page, '#obChips')));
    chk('31 … and going live is said to need it, with the line to run', /webhook signing secret is not set.*set_webhook_secret/.test(await text(t.page, '#obLiveNote')), await text(t.page, '#obLiveNote'));
    const sends = await text(t.page, '#obSends');
    chk('32 a send Resend reported opened and clicked says so, with when', /delivered/.test(sends) && /opened 2026-10-07 10:30Z · clicked 2026-10-07 10:31Z/.test(sends), sends.slice(0, 300));
    chk('32 … only on that send', (await t.page.$$('[data-seen]')).length === 1);

    await t.page.evaluate(() => window.EDOutbound.open('p1')); await settle(t.page, 600);
    chk('33 a prospect never emailed offers no "replied"', !(await t.page.$('#pdReplied')) && !(await t.page.$('#pdReplyStop')));
    await t.page.evaluate(() => window.EDOutbound.open('pc')); await settle(t.page, 600);
    chk('33 a contacted prospect offers "They replied" and "They replied: stop emailing them"', await visible(t.page, '#pdReplied') && await visible(t.page, '#pdReplyStop'));
    const repl = () => t.calls.filter((c) => c[0] === 'growth_outbound_prospect_replied');
    t.setAnswers([false]);
    await t.page.click('#pdReplied'); await settle(t.page);
    chk('33 "They replied" asks first, saying follow-ups stop; declining changes nothing', /follow-up still waiting is cancelled/.test(t.dialogs.slice(-1)[0].msg) && repl().length === 0);
    t.setAnswers(['Wants a demo']);
    await t.page.click('#pdReplied'); await settle(t.page, 700);
    chk('33 accepted: the reply is recorded with the note, and does NOT suppress', repl().length === 1 && JSON.stringify(repl()[0][1]) === JSON.stringify({ p_id: 'pc', p_note: 'Wants a demo', p_stop: false }), repl());
    chk('33 … and the answer is said', /Marked replied; 1 follow-up\(s\) cancelled\./.test(await text(t.page, '#obDetailMsg')), await text(t.page, '#obDetailMsg'));
    t.setAnswers([false]);
    await t.page.click('#pdReplyStop'); await settle(t.page);
    chk('34 "stop emailing them" asks first, naming the address and that it is for good; declining changes nothing',
      /cam@contacted\.test is suppressed for good/.test(t.dialogs.slice(-1)[0].msg) && repl().length === 1);
    t.setAnswers(['']);
    await t.page.click('#pdReplyStop'); await settle(t.page, 700);
    chk('34 accepted: recorded as a stop, which suppresses', repl().length === 2 && repl()[1][1].p_stop === true && repl()[1][1].p_note === null
      && /the address is suppressed/.test(await text(t.page, '#obDetailMsg')));
    chk('31-34 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner', settings: { webhook: { secret_set: true, last_event_at: '2026-10-07T10:00:00Z', events_24h: 3 } }, pcSuppressed: true, pcStatus: 'replied', noReplied: true });
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    chk('31 with the secret set, the header counts the events and says when the last arrived', /Resend events: 3 in 24 h · last 2026-10-07 10:00Z/.test(await text(t.page, '#obChips')), await text(t.page, '#obChips'));
    await t.page.evaluate(() => window.EDOutbound.open('pc')); await settle(t.page, 600);
    chk('34 already replied and suppressed: neither button is offered again', !(await t.page.$('#pdReplied')) && !(await t.page.$('#pdReplyStop')));
    chk('31-34 no page errors (second view)', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner', pcStatus: 'replied', noReplied: true });
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    await t.page.evaluate(() => window.EDOutbound.open('pc')); await settle(t.page, 600);
    chk('34 replied but not suppressed: only "stop emailing them" remains', !(await t.page.$('#pdReplied')) && await visible(t.page, '#pdReplyStop'));
    t.setAnswers(['']);
    await t.page.click('#pdReplyStop'); await settle(t.page, 700);
    chk('34 before the Phase 6 SQL, it says what to run', /arrive with the Phase 6 SQL/.test(await text(t.page, '#obDetailMsg')) && await visible(t.page, '#tabOutbound'));
    chk('31-34 no page errors (third view)', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 35–40. discover and research (Phase 7) ───────────────────────── */
  {
    const t = await open({ role: 'owner' });
    const rcalls = () => t.calls.filter((c) => c[0] === 'fn:growth_outbound_research');
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    const prov = await text(t.page, '#dvProviders');
    chk('35 which providers are set up, and today\'s use of each', /Search: Brave · 3 \/ 20 today/.test(prov) && /Reading: Claude · 2 \/ 30 today/.test(prov)
      && /Email: not set up \(HUNTER_API_KEY\)/.test(prov) && /pages read today 40 \/ 150/.test(prov), prov);
    chk('35 the saved searches and the budget fill the form', (await t.page.inputValue('#dvQueries')) === RESEARCH_OV.queries.join('\n')
      && (await t.page.inputValue('#dvB_llm')) === '30' && (await t.page.inputValue('#dvB_search')) === '20');
    chk('35 the runs: what each did, what it spent, why one failed', /search\s*cfb models/.test(await text(t.page, '#dvRuns')) && /5 new of 18/.test(await text(t.page, '#dvRuns'))
      && /robots\.txt disallows it/.test(await text(t.page, '#dvRuns')) && /fetch 2/.test(await text(t.page, '#dvRuns')));
    chk('35 the queue counts by status', /New \(2\)/.test(await text(t.page, '#dvSeg')) && /Researched \(4\)/.test(await text(t.page, '#dvSeg')));
    chk('35 opening the page researches nothing and searches nothing', !rcalls().some((c) => c[1].action !== 'status'));
    const cands = await text(t.page, '#dvCands');
    chk('36 candidates: text from the web stays text, and only an https: address is a link', await t.page.evaluate(() => !document.querySelector('#dvCands img') && !window.__pwned)
      && cands.includes('<img src=x') && await t.page.evaluate(() => [...document.querySelectorAll('#dvCands a')].every((a) => a.href.startsWith('https:') && /noopener/.test(a.rel) && /nofollow/.test(a.rel)))
      && await t.page.evaluate(() => !document.querySelector('#dvCands a[href^="javascript"]')));
    await t.page.fill('#dvQuery', 'cf'); await t.page.click('#dvSearch'); await settle(t.page);
    chk('36 a search too short is refused here, without a call', /at least 3 characters/.test(await text(t.page, '#dvMsg')) && !rcalls().some((c) => c[1].action === 'discover'));
    await t.page.fill('#dvQuery', '  college   football models '); await t.page.click('#dvSearch'); await settle(t.page, 700);
    const dc = rcalls().find((c) => c[1].action === 'discover');
    chk('36 a search goes to the research function, tidied', !!dc && dc[1].query === 'college football models', dc);
    chk('36 … and what it found is said: candidates, not prospects', /Searched 1 time: 18 results, 5 new candidates, 3 seen before, 1 already prospects\./.test(await text(t.page, '#dvMsg')), await text(t.page, '#dvMsg'));
    await t.page.click('#dvSaved'); await settle(t.page, 700);
    chk('36 "Run saved searches" sends no query (the server uses the saved ones)', rcalls().filter((c) => c[1].action === 'discover').slice(-1)[0][1].query === undefined);
    t.state.research = 'nobrave';
    await t.page.fill('#dvQuery', 'cfb models'); await t.page.click('#dvSearch'); await settle(t.page, 700);
    chk('36 no search key: said, naming the secret to set', /BRAVE_SEARCH_API_KEY/.test(await text(t.page, '#dvMsg')));
    t.state.research = 'ok';
    await t.page.click('[data-research="71"]'); await settle(t.page, 700);
    const rc = rcalls().find((c) => c[1].action === 'research');
    chk('37 Research reads exactly that candidate', !!rc && rc[1].candidate_id === 71 && !('prospect_id' in rc[1]), rc);
    const rm = await text(t.page, '#dvMsg');
    chk('37 … and says what it recorded, what it dropped (could not be quoted), the address and the status',
      /New prospect: 7 facts recorded from 3 pages; 2 dropped because they could not be quoted; address pat@cfbnumbers\.test \(their own page, verifier: valid\)\. Status: Needs research\./.test(rm), rm);
    chk('37 … with a way to open them', await visible(t.page, '#dvMsg [data-open="p1"]'));
    await t.page.click('[data-research="72"]'); await settle(t.page, 700);
    chk('37 not a fit: said, and nothing recorded', /Not a fit: a tout selling picks\. Nothing was recorded about them\./.test(await text(t.page, '#dvMsg')));
    await t.page.click('#dvNext'); await settle(t.page, 700);
    const lastResearch = () => rcalls().filter((c) => c[1].action === 'research').slice(-1)[0][1];
    chk('37 "Research the next one": the server picks; an empty queue is said', lastResearch().next === true && /No new candidates are waiting/.test(await text(t.page, '#dvMsg')));
    const before = t.calls.filter((c) => c[0] === 'growth_outbound_candidate_set').length;
    t.setAnswers([false]);
    await t.page.click('[data-cdismiss="71"]'); await settle(t.page);
    chk('38 Dismiss asks first; declining changes nothing', t.calls.filter((c) => c[0] === 'growth_outbound_candidate_set').length === before);
    t.setAnswers(['a listicle']);
    await t.page.click('[data-cdismiss="71"]'); await settle(t.page, 600);
    const cs = t.calls.filter((c) => c[0] === 'growth_outbound_candidate_set').slice(-1)[0];
    chk('38 … accepted, it is dismissed with the reason', !!cs && JSON.stringify(cs[1]) === JSON.stringify({ p_id: 71, p_status: 'dismissed', p_reason: 'a listicle' }), cs);
    await t.page.evaluate(() => window.EDOutbound.open('p1')); await settle(t.page, 700);
    await t.page.click('#pdResearchAgain'); await settle(t.page, 900);
    chk('39 "Research again" reads the prospect again, and the answer stays above the refreshed prospect', lastResearch().prospect_id === 'p1'
      && /Added to the prospect: 7 facts/.test(await text(t.page, '#obDetailMsg')), await text(t.page, '#obDetailMsg'));
    await t.page.fill('#dvQueries', 'cfb totals model\n\n  nfl ratings newsletter  ');
    await t.page.fill('#dvB_llm', '45');
    await t.page.click('#dvSave'); await settle(t.page, 600);
    const su = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').slice(-1)[0];
    chk('40 saving sends the searches (tidied) and the budget, in the discovery settings', !!su && JSON.stringify(su[1].p.discovery_config.queries) === JSON.stringify(['cfb totals model', 'nfl ratings newsletter'])
      && su[1].p.discovery_config.budget.llm === 45 && su[1].p.discovery_config.budget.search === 20, su && su[1]);
    await t.page.fill('#dvB_llm', 'lots'); await t.page.click('#dvSave'); await settle(t.page, 600);
    chk('40 a refused budget is said in the database\'s words', /Not saved: budget: llm must be a whole number/.test(await text(t.page, '#dvMsg')));
    chk('35-40 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.research = 'missing';
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    chk('41 the research function not deployed: said, and the queue still shows from the database', /not deployed/.test(await text(t.page, '#dvProviders'))
      && /CFB Numbers/.test(await text(t.page, '#dvCands')) && await visible(t.page, '#tabOutbound'));
    await t.page.click('[data-research="71"]'); await settle(t.page, 700);
    chk('41 … and Research says so too', /The research function is not deployed yet/.test(await text(t.page, '#dvMsg')));
    chk('41 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 42–47. the drafting engine (Phase 8) ───────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    t.state.queue8 = true;
    const dcalls = () => t.calls.filter((c) => c[0] === 'fn:growth_outbound_draft');
    const cardText = (id) => text(t.page, '[data-draft="' + id + '"]');
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    const info = await text(t.page, '#rqDrafting');
    chk('42 the queue says Claude writes and today\'s use, who is due, and how the engine\'s drafts fare', /Writing: Claude · 4 \/ 30 today/.test(info)
      && /Due: 3 first emails, 1 follow-up/.test(info) && /Engine drafts, 90 days: 8 written · 3 approved as written · 1 after your edit · 1 rejected/.test(info), info);
    chk('42 opening the page drafts nothing', dcalls().length >= 1 && dcalls().every((c) => c[1].action === 'status'));
    chk('42 the button offers the next ones due', (await text(t.page, '#rqWrite')) === 'Write the next 4 drafts' && !(await t.page.isDisabled('#rqWrite')));
    chk('42 the runs table names a drafting run and what it did', /drafting/.test(await text(t.page, '#dvRuns')) && /2 drafted, 1 not/.test(await text(t.page, '#dvRuns')));
    chk('44 each card says who wrote it', /by the engine/.test(await cardText('d81')) && /by the template, edited by you/.test(await cardText('d82')) && /by you/.test(await cardText('d83')));
    chk('44 a greeting the evidence no longer supports: said, and it cannot be approved or selected', /The greeting: the greeting names "Pat", but their established first name is "Patricia"/.test(await cardText('d82'))
      && await t.page.isDisabled('[data-approve="d82"]') && await t.page.isDisabled('[data-pick="d82"]'));
    chk('44 the engine\'s draft that passes can be approved', !(await t.page.isDisabled('[data-approve="d81"]')));
    chk('44 a follow-up for a contacted prospect can be approved', !(await t.page.isDisabled('[data-approve="d83"]')) && !(await t.page.isDisabled('[data-pick="d83"]')));
    t.setAnswers([false]);
    await t.page.click('[data-reject="d81"]'); await settle(t.page);
    chk('45 rejecting an engine draft says the engine reads the reason; declining sends nothing', /The drafting engine reads your reason/.test(t.dialogs[t.dialogs.length - 1].msg)
      && !t.calls.some((c) => c[0] === 'growth_outbound_draft_reject'), t.dialogs.slice(-1));
    const queued = t.calls.filter((c) => c[0] === 'growth_outbound_review_queue').length;
    await t.page.click('#rqWrite'); await settle(t.page, 900);
    const w = dcalls().filter((c) => c[1].action === 'draft');
    chk('43 "Write the next 4 drafts" asks the function for exactly 4', w.length === 1 && JSON.stringify(w[0][1]) === JSON.stringify({ action: 'draft', next: 4 }), w);
    const wm = await text(t.page, '#rqMsg');
    chk('43 … and says what was drafted, by whom, and why one was not', /Drafted 2 of 3 \(1 by Claude, 1 by the template\)\. They wait below for your review; nothing is sent until you approve and press Send\./.test(wm)
      && /Not drafted: no fact about them is sure enough to cite on its own; research them further\./.test(wm), wm);
    chk('43 … and the queue is reloaded', t.calls.filter((c) => c[0] === 'growth_outbound_review_queue').length > queued);
    await t.page.evaluate(() => window.EDOutbound.open('p1')); await settle(t.page, 700);
    chk('46 a prospect offers "Let the engine write it"', await visible(t.page, '#wdEngine'));
    await t.page.selectOption('#wdSeq', '2'); await t.page.click('#wdEngine'); await settle(t.page, 900);
    const e1 = dcalls().filter((c) => c[1].action === 'draft').slice(-1)[0];
    chk('46 … for the chosen step', !!e1 && JSON.stringify(e1[1]) === JSON.stringify({ action: 'draft', prospect_id: 'p1', sequence_number: 2 }), e1);
    chk('46 a step not due is said in the database\'s words', /Not drafted: not due: not due until 2026-10-12 09:00 UTC\./.test(await text(t.page, '#wdMsg')), await text(t.page, '#wdMsg'));
    await t.page.selectOption('#wdSeq', '1'); await t.page.click('#wdEngine'); await settle(t.page, 900);
    chk('46 drafted: said, and that nothing is sent until you approve it', /Drafted by Claude\. It is in the review queue: nothing is sent until you approve it and press Send\./.test(await text(t.page, '#wdMsg')), await text(t.page, '#wdMsg'));
    chk('42 the settings say when the final follow-up goes', /Days after follow-up 1 before the final one/.test(await text(t.page, '#tabOutbound')));
    chk('42-46 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.draft = 'missing';
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    const info = await text(t.page, '#rqDrafting');
    chk('47 the drafting function not deployed: said; who is due still shown from the database; the button off', /drafting function is not deployed/.test(info)
      && /Due: 3 first emails, 1 follow-up/.test(info) && await t.page.isDisabled('#rqWrite') && !(await visible(t.page, '#obMsg')), info);
    chk('47 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 48–52. the morning run (Phase 9) ──────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    const chips = await text(t.page, '#amChips');
    chk('48 the morning run: on, its window in the owner\'s zone, the clock ticking, the next step', /Morning run: on · 06:00–10:00 America\/New_York/.test(chips)
      && /Clock: last tick/.test(chips) && /Next: research the next new candidate/.test(chips), chips);
    const today = await text(t.page, '#amToday');
    chk('48 … today\'s progress', /Searched todayyes/.test(today) && /Researched today2 of 15/.test(today) && /Drafted today1 of 20/.test(today)
      && /New candidates5/.test(today) && /Due a draft4/.test(today), today);
    const runs = await text(t.page, '#amRuns');
    chk('48 … the steps: what each did, and why one failed', /search the saved searches/.test(runs) && /5 new of 18/.test(runs)
      && /never finished \(the function stopped\)/.test(runs) && /running/.test(runs), runs);
    chk('48 opening the page starts nothing (no function is asked to do anything)', !t.calls.some((c) => /^fn:/.test(c[0]) && c[1].action && c[1].action !== 'status'));
    chk('48 the runs table marks the morning run\'s steps', /drafting\s*\(morning run\)/.test(await text(t.page, '#dvRuns')), await text(t.page, '#dvRuns'));
    chk('50 the window and the zone are settings', (await t.page.inputValue('#obf_automation_timezone')) === 'America/New_York'
      && (await t.page.inputValue('#obf_automation_start_hour')) === '6' && (await t.page.inputValue('#obf_automation_hours')) === '4');
    await t.page.fill('#obf_automation_timezone', 'America/Chicago'); await t.page.fill('#obf_automation_start_hour', '7');
    await t.page.click('#obSave'); await settle(t.page, 600);
    let up = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').slice(-1)[0];
    chk('50 … saved like any other: exactly what changed', !!up && JSON.stringify(up[1].p) === JSON.stringify({ automation_timezone: 'America/Chicago', automation_start_hour: 7 }), up && up[1]);
    chk('50 … and the panel is read again', t.calls.filter((c) => c[0] === 'growth_outbound_automation_overview').length >= 2);
    const n0 = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').length;
    await t.page.check('#obf_automation_enabled');
    t.setAnswers([false]);
    await t.page.click('#obSave'); await settle(t.page, 500);
    const d = t.dialogs.slice(-1)[0];
    chk('49 turning automation on says what it does, and that it never approves or sends, and asks', !!d && /Turn on the morning run\?/.test(d.msg)
      && /never approves and never sends/.test(d.msg) && /daily provider budget/.test(d.msg), d);
    chk('49 … declining saves nothing', t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').length === n0 && /the morning run stays off/.test(await text(t.page, '#obSetMsg')));
    t.setAnswers([true]);
    await t.page.click('#obSave'); await settle(t.page, 500);
    up = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').slice(-1)[0];
    chk('49 … accepting turns it on', !!up && up[1].p.automation_enabled === true, up && up[1]);
    chk('48-50 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.am = { enabled: false, pg_net: false, scheduler: { last_tick_at: null, ticking: false, ticks: 0 }, plan: { step: null, reason: 'automation is off', today: {} }, runs: [] };
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    const chips = await text(t.page, '#amChips');
    chk('51 off, no clock, no pg_net: each said, with what to do', /Morning run: off/.test(chips) && /The clock is not running: run supabase\/growth_outbound_cron\.sql/.test(chips)
      && /pg_net is not installed/.test(chips) && /Now: automation is off/.test(chips), chips);
    chk('51 … and the steps table says nothing has run', /has not run yet/.test(await text(t.page, '#amRuns')));
    chk('51 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.am = 'missing';
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 700);
    chk('52 before the Phase 9 SQL: said, and nothing else fails', /arrives with the Phase 9 SQL/.test(await text(t.page, '#amChips')) && !(await visible(t.page, '#obMsg')));
    chk('52 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 53–56. results (Phase 10) ─────────────────────────────────────── */
  {
    const t = await open({ role: 'owner' });
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 800);
    const a = t.calls.filter((c) => c[0] === 'growth_outbound_analytics');
    chk('53 opening the page reads the last 90 days of results', a.length === 1 && JSON.stringify(a[0][1]) === JSON.stringify({ p_days: 90 }), a);
    const chips = await text(t.page, '#rsChips');
    chk('53 whether links are tagged, when results were matched, and the provider calls', /Links tagged/.test(chips) && /Matched 2026-10-08 01:00Z/.test(chips)
      && /Provider calls: llm 5 · search 3/.test(chips), chips);
    const people = await text(t.page, '#rsPeople');
    chk('53 the people written to, and what they did, as rates of them', /Written to24first email in the last 90 days/.test(people) && /Replied1354\.2% of 24 written to/.test(people)
      && /Made an account416\.7% of 24 written to/.test(people) && /Paid14\.2% of 24 written to/.test(people) && /Opted out1/.test(people) && /Visited5/.test(people), people);
    const mails = await text(t.page, '#rsSends');
    chk('53 the emails: sent, delivered, bounced, complaints; opens only a hint', /Emails sent3426 approved · 30 drafted · 31 new prospects/.test(mails) && /Delivered3294\.1%/.test(mails)
      && /Bounced12\.9%/.test(mails) && /Opened12a hint only/.test(mails), mails);
    const sig = await text(t.page, '#rsSignals');
    chk('53 what stands out, with the numbers behind it', /Prospect type: podcast replies more often than everyone: 12 of 12 \(100%\) against 54\.2% overall\./.test(sig), sig);
    const steps = await t.page.$$eval('#rsSteps tr', (trs) => trs.slice(1).map((tr) => Array.from(tr.cells).map((c) => c.textContent)));
    chk('53 by step: sent, delivered, bounced, opened, clicked, and the replies and signups that followed each', JSON.stringify(steps)
      === JSON.stringify([['First email', '24', '23', '1', '10', '5', '12', '3'], ['Follow-up', '10', '9', '0', '2', '1', '1', '1']]), steps);
    const groups = await text(t.page, '#rsGroups');
    chk('53 by group (prospect type first), each rate with its 95% range', /Prospect type/.test(groups) && /podcast/.test(groups) && /100% 75\.7%–100%/.test(groups)
      && /cfb analyst/.test(groups) && /25% 8\.9%–53\.2%/.test(groups), groups);
    const latest = await text(t.page, '#rsLatest');
    chk('53 the latest results: who, what, matched how — text from anywhere stays text', /Pat Analyst/.test(latest) && /Paid/.test(latest) && /the email's link/.test(latest)
      && /the address we wrote to/.test(latest) && /<img/.test(latest), latest);
    const daily = await text(t.page, '#rsDaily');
    chk('53 by day: only days with activity, newest first', /2026-10-08.*2026-10-07/.test(daily.replace(/\n/g, ' ')) && !/2026-10-06/.test(daily), daily);
    chk('53 nothing from the web runs as code', !(await t.page.evaluate(() => window.__pwned)));
    await t.page.click('#rsLatest [data-open="p1"]'); await settle(t.page, 700);
    chk('53 a result opens its prospect', /Pat Analyst/.test(await text(t.page, '#obDetail')));
    const n0 = t.calls.filter((c) => c[0] === 'growth_outbound_analytics').length;
    await t.page.click('#rsDim [data-rdim="query"]'); await settle(t.page, 300);
    const g2 = await text(t.page, '#rsGroups');
    chk('54 another grouping is only redrawn (no new read)', /Search that found them/.test(g2) && /added by hand/.test(g2) && /few/.test(g2)
      && t.calls.filter((c) => c[0] === 'growth_outbound_analytics').length === n0, g2);
    chk('54 … a group below the sample is marked "few", and web text stays text', (await t.page.$$('#rsGroups .pill')).length === 1 && /<img/.test(g2) && !(await t.page.evaluate(() => window.__pwned)));
    await t.page.click('#rsDays [data-rdays="30"]'); await settle(t.page, 500);
    const a2 = t.calls.filter((c) => c[0] === 'growth_outbound_analytics').slice(-1)[0];
    chk('54 another window is read again, for exactly that many days', !!a2 && JSON.stringify(a2[1]) === JSON.stringify({ p_days: 30 })
      && /first email in the last 30 days/.test(await text(t.page, '#rsPeople'))
      && await t.page.evaluate(() => document.querySelector('#rsDays [data-rdays="30"]').classList.contains('on')), a2);
    chk('53-54 no page errors', t.errors.length === 0, t.errors);
    if (SHOTS) await t.page.locator('.card:has(#rsDays)').screenshot({ path: path.join(SHOTS, 'outbound-results.png') });
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.queue10 = true;
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 800);
    const c1 = await text(t.page, '[data-draft="d101"]');
    chk('55 a card shows the words exactly as sent: its link carries the prospect\'s code', /edgedesksports\.com\/\?utm_source=outbound&utm_medium=email&utm_campaign=ob_0123456789abcdef0123456789abcdef/.test(c1)
      && /carry this prospect's campaign code/.test(c1), c1);
    const c2 = await text(t.page, '[data-draft="d102"]');
    chk('55 an address that already has an EdgeDesk account: said, and the card cannot be selected or approved', /already has an EdgeDesk account/.test(c2) && /never cold-emailed/.test(c2)
      && await t.page.isDisabled('[data-approve="d102"]') && await t.page.isDisabled('[data-pick="d102"]') && !(await t.page.isDisabled('[data-approve="d101"]')), c2);
    chk('55 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner', results10: true });
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 800);
    await t.page.evaluate(() => window.EDOutbound.open('p1')); await settle(t.page, 700);
    const r = await text(t.page, '#pdResults');
    chk('56 a prospect lists its results, and how each was matched', /Visited EdgeDesk from the email/.test(r) && /Made an account/.test(r) && /Paid/.test(r) && /the email's link/.test(r), r);
    chk('56 link tagging is a setting, on by default', await t.page.isChecked('#obf_attribution_links'));
    await t.page.uncheck('#obf_attribution_links');
    await t.page.click('#obSave'); await settle(t.page, 700);
    const up = t.calls.filter((c) => c[0] === 'growth_outbound_settings_update').slice(-1)[0];
    chk('56 … turning it off saves exactly that', !!up && JSON.stringify(up[1].p) === JSON.stringify({ attribution_links: false }), up && up[1]);
    chk('56 … and the results say so', /Link tagging is off/.test(await text(t.page, '#rsChips')), await text(t.page, '#rsChips'));
    chk('56 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.results = { sync_error: 'the Stripe ledger is unreachable', signals: [], latest: [] };
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 800);
    const chips = await text(t.page, '#rsChips');
    chk('56 a matching failure is said, and the rest still shows', /Matching failed: the Stripe ledger is unreachable/.test(chips) && /Written to24/.test(await text(t.page, '#rsPeople')), chips);
    chk('56 with nothing standing out, it says why (the minimum sample, the 95% range)', /Nothing stands out yet\. A group is compared only once it has 10 people/.test(await text(t.page, '#rsSignals')));
    chk('56 no result yet: said', /No result yet/.test(await text(t.page, '#rsLatest')));
    await t.ctx.close();
  }
  {
    const t = await open({ role: 'owner' });
    t.state.results = 'missing';
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 800);
    chk('56 before the Phase 10 SQL: said, and nothing else fails', /arrive with the Phase 10 SQL/.test(await text(t.page, '#rsChips')) && !(await visible(t.page, '#obMsg')));
    chk('56 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 17. the page ahead of its migration ─────────────────────────────── */
  {
    const t = await open({ role: 'owner', noCatalog: true, noQueue: true });
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    chk('17 before the Phase 4 SQL, the queue says what to run instead of failing', /arrives with the Phase 4 SQL/.test(await text(t.page, '#rqCards'))
      && !(await visible(t.page, '#obMsg')));
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    chk('17 without the Phase 3 fit catalogue, a prospect still opens', /Pat Analyst/.test(await text(t.page, '#obDetail')) && !/not installed/.test(await text(t.page, '#obDetailMsg')));
    chk('17 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 5. an affiliate admin who is NOT an owner ─────────────────────── */
  {
    const t = await open({ role: 'admin' });
    chk('5 a non-owner admin gets the growth console', await visible(t.page, '#actKpis'));
    chk('5 … with no Outbound tab and no mode tag', !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#tabBtnOutbound')) && !(await visible(t.page, '#obModeTag')));
    await t.page.evaluate(() => { window.EDOutbound.show('outbound'); window.EDOutbound.open('p1'); }); await settle(t.page);
    chk('5 even forcing the tab, or a prospect, from the console shows nothing', !(await visible(t.page, '#tabOutbound')) && !(await visible(t.page, '#obDetailWrap')));
    const ob = outboundCalls(t.calls);
    chk('5 the ONLY outbound call ever made is the owner question', ob.length === 1 && ob[0] === 'growth_outbound_is_owner', ob);
    chk('5 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 6. demoted mid-session ─────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner', demoteAfter: 1 });   // the header's settings read passes, then the database refuses
    await t.page.click('#tabBtnOutbound'); await settle(t.page, 600);
    chk('6 a demoted owner is told so and the tab disappears', /no longer an outbound owner/.test(await text(t.page, '#appMsg')) && !(await visible(t.page, '#tabs')) && !(await visible(t.page, '#tabOutbound')));
    chk('6 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  /* ── 8. a phone ─────────────────────────────────────────────────────── */
  {
    const t = await open({ role: 'owner', viewport: { width: 390, height: 844 } });
    await t.page.click('#tabBtnOutbound'); await settle(t.page);
    const sw = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('8 at 390 px the Outbound tab is not wider than the screen', sw <= 391, sw);
    await t.page.click('[data-open="p1"]'); await settle(t.page, 600);
    const sw2 = await t.page.evaluate(() => document.documentElement.scrollWidth);
    chk('8 … nor is an open prospect (its tables scroll inside their card)', sw2 <= 391, sw2);
    if (SHOTS) await t.page.screenshot({ path: path.join(SHOTS, 'outbound-phone.png'), fullPage: false });
    chk('8 no page errors', t.errors.length === 0, t.errors);
    await t.ctx.close();
  }

  await browser.close(); site.srv.close();
  console.log((fail ? 'FAIL' : 'PASS') + ' — outbound console (browser): ' + pass + '/' + (pass + fail) + ' checks');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('FAIL — crashed: ' + (e && e.stack || e)); process.exit(1); });
