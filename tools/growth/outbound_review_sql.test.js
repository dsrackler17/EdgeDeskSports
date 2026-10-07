#!/usr/bin/env node
/* ===========================================================================
   PHASE 4 — THE REVIEW QUEUE (supabase/growth_outbound.sql, the review doors)

   Software may draft and queue; only the owner approves, and approving sends
   nothing. On a real PostgreSQL, through the owner's doors:

     Q  QUEUE      each card carries the draft, who it is for and how sure,
                   every claim with the evidence it rests on, the content
                   rules, and the message exactly as it would be sent; each
                   prospect is re-evaluated before it is shown
     C  CONTENT    no promised winnings, locks or guarantees; $49.99/month
                   only; a 7-day free trial only; EdgeDesk links only;
                   nothing unfilled; no fake "RE:" — enforced at approval for
                   every draft, test or not
     M  WORDS      a claim the draft cites must be in the email; an edit that
                   drops it cannot be approved
     W  WRITE      the owner's own draft: every claim cites current evidence
                   of THIS prospect (not an email address, not superseded),
                   appears in the words, at least one for a real prospect;
                   content rules at once; one live draft per step
     B  BATCH      the confirmed count must equal the selection; all or
                   nothing; at most 25; each item approved exactly as one
     U  WITHDRAW   an approval can be taken back before it is sent
     F  FIXTURE    a test prospect at the owner's own test inbox, with a
                   draft, idempotently; never a real person
     P  PREVIEW    sender, recipient (the test inbox in test mode), subject,
                   the words and the footer with the postal address
     X  PRIVATE    the one approve implementation is not callable by any
                   client, and refuses anyone but the signed-in owner

   Run: node tools/growth/outbound_review_sql.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound review SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');

const db = PG.start('gorev');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const own = (sql) => j(db.as(OWNER, sql));
const pid = (n) => '10000000-0000-0000-0000-' + String(n).padStart(12, '0');
const did = (n) => '20000000-0000-0000-0000-' + String(n).padStart(12, '0');
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = '${d}';`);
const statusOf = (d) => one(`select status from growth_outbound.drafts where id = '${d}';`);
const pstatus = (p) => one(`select status from growth_outbound.prospects where id = '${p}';`);
const approve = (d, h) => own(`select public.growth_outbound_draft_approve('${d}', ${lit(h === undefined ? hashOf(d) : h)});`);
const edit = (d, subj, body) => own(`select public.growth_outbound_draft_edit('${d}', ${lit(subj)}, ${lit(body)}, ${lit(hashOf(d))});`);
const create = (p, o) => own(`select public.growth_outbound_draft_create(${lit(p)}, ${lit(JSON.stringify(o))}::jsonb);`);
const batch = (items, n) => own(`select public.growth_outbound_drafts_approve_batch(${lit(JSON.stringify(items))}::jsonb, ${n == null ? 'null' : n});`);
const queue = (st) => own(`select public.growth_outbound_review_queue(${lit(st)}, 50);`);
const evId = (p, field) => one(`select id from growth_outbound.evidence where prospect_id = '${p}' and field_name = '${field}' and superseded_at is null order by id limit 1;`);
const lint = (subj, body) => j(one(`select to_jsonb(growth_outbound.draft_lint(${lit(subj)}, ${lit(body)}));`));

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);
  const people = [
    [1, 'Pat Analyst', 'CFB Numbers', 'pat@cfbnumbers.test', 'cfbnumbers.test', 'patanalyst'],
    [2, 'Sam Spare', 'Props Lab', 'sam@propslab.test', 'propslab.test', 'samspare'],
    [3, 'Lee Live', 'Lee Lab', 'lee@leelab.test', 'leelab.test', 'leelab'],
    [4, 'Ana Bell', 'Bell Ratings', 'ana@bellratings.test', 'bellratings.test', 'anabell'],
    [5, 'Kai Moss', 'Moss Models', 'kai@mossmodels.test', 'mossmodels.test', 'kaimoss'],
    [6, 'Ola Reed', 'Reed Report', 'ola@reedreport.test', 'reedreport.test', 'olareed']];
  one(people.map(([n, name, org, email, domain, handle]) => SEED.strong({ id: pid(n), name, org, email, domain, handle })).join('\n')
    + people.slice(0, 5).map(([n, name]) => SEED.draft({ id: did(n), prospect: pid(n), subject: 'Your work, ' + name.split(' ')[0], body: 'Hi ' + name.split(' ')[0] + ',' })).join('\n'));
  chk('(seed) five evidence-backed prospects with drafts are ready for review', [1, 2, 3, 4, 5].every((n) => pstatus(pid(n)) === 'ready_for_review'));

  /* ══ Q. THE QUEUE ═════════════════════════════════════════════════════ */
  let q = queue('pending_review');
  chk('Q the queue lists every draft waiting', q.ok === true && q.total === 5 && q.rows.length === 5, q.total);
  const c1 = q.rows.find((r) => r.draft.id === did(1));
  chk('Q a card carries the draft and its content hash', c1 && c1.draft.content_hash === hashOf(did(1)) && c1.draft.status === 'pending_review');
  chk('Q … who it is for, with the email (owner only), confidences and the bars', c1.prospect.full_name === 'Pat Analyst' && c1.prospect.email === 'pat@cfbnumbers.test'
    && +c1.prospect.identity_confidence === 0.91 && c1.prospect.thresholds && c1.prospect.thresholds.identity === 0.9 && Array.isArray(c1.prospect.gates));
  chk('Q … each claim with the evidence it rests on, the source and the words', c1.claims.length === 1 && c1.claims[0].text === 'your CFB power ratings against the market'
    && c1.claims[0].evidence.source_url === 'https://cfbnumbers.test/ratings' && /closing line/.test(c1.claims[0].evidence.source_excerpt)
    && c1.claims[0].evidence.current === true && c1.claims[0].evidence.own === true && +c1.claims[0].confidence === 0.91, c1.claims);
  chk('Q … the content rules and the words check, both clean', c1.lint.length === 0 && c1.claims_missing.length === 0);
  chk('Q … and the message as it would be sent: from Davis, in test mode to the test inbox (not set yet)', c1.preview.from === 'Davis <davis@edgedesksports.com>'
    && c1.preview.test === true && c1.preview.to === null && c1.preview.intended_recipient === 'pat@cfbnumbers.test', c1.preview);
  chk('Q … the footer says sending is blocked without a postal address', /no postal address is set: sending is blocked/.test(c1.preview.footer)
    && c1.preview.text.indexOf(c1.preview.body) === 0 && /opt out/.test(c1.preview.footer));
  chk('Q nothing is waiting as approved yet', queue('approved').total === 0);
  chk('Q any other queue is refused', queue('sent').ok === false);
  own(`select public.growth_outbound_settings_update('{"min_fit_score": 95}'::jsonb);`);
  q = queue('pending_review');
  chk('Q each prospect is re-evaluated before it is shown: a raised bar shows at once', q.rows.every((r) => r.prospect.status === 'needs_research'
    && r.prospect.gates.some((g) => /^fit 89 < 95/.test(g))), q.rows.map((r) => r.prospect.gates));
  own(`select public.growth_outbound_settings_update('{"min_fit_score": 80}'::jsonb);`);
  q = queue('pending_review');
  chk('Q … and lowered again, they are ready again', q.rows.every((r) => r.prospect.status === 'ready_for_review'));

  /* ══ C. CONTENT RULES ═════════════════════════════════════════════════ */
  const CASES = [
    ['A lock for Saturday', 'Hi', /promises winnings/],
    ['Hi', 'This is guaranteed to work.', /promises winnings/],
    ['Hi', 'You can\'t lose with our numbers.', /promises winnings/],
    ['Hi', 'Risk-free edges every week.', /promises winnings/],
    ['Hi', 'Grow your winnings.', /promises winnings/],
    ['Hi', 'Only $29 a month.', /price is \$49\.99\/month, not \$29/],
    ['Hi', 'It is $49.99/month after a 14-day free trial.', /free trial is 7 days/],
    ['Hi', 'Try a 30 day trial.', /free trial is 7 days/],
    ['Hi', 'See https://bit.ly/x for more.', /edgedesksports\.com only, not bit\.ly/],
    ['Hi', 'Visit www.competitor.test today.', /not competitor\.test/],
    ['Hi {{first_name}}', 'Hello', /left unfilled/],
    ['Hi', 'Hello [First Name], I loved your work.', /left unfilled/],
    ['RE: your model', 'Hi', /pretends to be a reply/],
    ['Fwd: ratings', 'Hi', /pretends to be a reply/]];
  for (const [s, b, re] of CASES) {
    const got = lint(s, b);
    chk('C "' + (s + ' / ' + b).slice(0, 60) + '" is refused: ' + re.source.slice(0, 40), got.length >= 1 && got.some((x) => re.test(x)), got);
  }
  const CLEAN = [
    ['Your CFB power ratings', 'Hi Pat, I read your CFB power ratings. EdgeDesk is a research platform, not picks: a 7-day free trial, then $49.99/month. https://edgedesksports.com/research/sample'],
    ['A question about your totals model', 'Hi Ana, a one-week free trial is there if useful: https://www.edgedesksports.com/?ref=x'],
    ['Unlocked a thought on CLV', 'Locked-in thinking is the enemy of good modeling; your post said so well.']];
  for (const [s, b] of CLEAN) chk('C a clean message passes: "' + s + '"', lint(s, b).length === 0, lint(s, b));
  edit(did(2), 'Your props work, Sam', 'Hi Sam, I read your CFB power ratings against the market. Our numbers are a lock: $19 a month.');
  let r = approve(did(2));
  chk('C a draft breaking the rules cannot be approved, and every broken rule is named', r.ok === false && r.reason === 'below_gate'
    && r.gates.some((g) => /content: promises winnings/.test(g)) && r.gates.some((g) => /content: the price is \$49\.99/.test(g)), r);
  edit(did(2), 'Your props work, Sam', 'Hi Sam, I read your CFB power ratings against the market. EdgeDesk is research, not picks: $49.99/month after a 7-day free trial.');
  r = approve(did(2));
  chk('C … fixed, it can be', r.ok === true, r);

  /* ══ M. A CITED CLAIM IS IN THE WORDS ═════════════════════════════════ */
  edit(did(3), 'Hello Lee', 'Hi Lee, just wanted to say hello.');
  r = approve(did(3));
  chk('M an edit that drops the cited claim\'s words cannot be approved', r.ok === false && r.gates.some((g) => /a cited claim is not in the email: "your CFB power ratings/.test(g)), r);
  q = queue('pending_review');
  chk('M … and the card says which claim is missing', q.rows.find((x) => x.draft.id === did(3)).claims_missing[0] === 'your CFB power ratings against the market');
  edit(did(3), 'Hello Lee', 'Hi Lee, I read Your CFB Power Ratings — against the market!');
  r = approve(did(3));
  chk('M … said again (any casing or punctuation), it can be', r.ok === true, r);

  /* ══ W. WRITING A DRAFT ═══════════════════════════════════════════════ */
  const P6 = pid(6), proj6 = evId(P6, 'project');
  const good = { subject: 'Your CFB power ratings', body_text: 'Hi Ola, I read your CFB power ratings against the market. EdgeDesk might help.',
    claims: [{ text: 'your CFB power ratings against the market', evidence_id: +proj6 }] };
  r = create(P6, Object.assign({}, good, { service_role: 'x' }));
  chk('W an unknown field is refused', r.ok === false && r.reason === 'unknown_field');
  r = create('10000000-0000-0000-0000-00000000ffff', good);
  chk('W an unknown prospect is refused', r.ok === false && r.reason === 'not_found');
  r = create(P6, Object.assign({}, good, { sequence_number: 4 }));
  chk('W only steps 1 to 3', r.ok === false && r.reason === 'invalid_sequence');
  r = create(P6, Object.assign({}, good, { subject: '  ' }));
  chk('W a subject is needed', r.ok === false && r.reason === 'invalid_content');
  r = create(P6, Object.assign({}, good, { claims: [] }));
  chk('W a real prospect\'s email says at least one thing about them, with evidence', r.ok === false && r.reason === 'no_claims');
  r = create(P6, Object.assign({}, good, { claims: [{ text: 'your CFB power ratings against the market', evidence_id: +evId(pid(1), 'project') }] }));
  chk('W a claim citing ANOTHER prospect\'s evidence is refused', r.ok === false && r.reason === 'claim_without_evidence', r);
  r = create(P6, Object.assign({}, good, { claims: [{ text: 'ola@reedreport.test', evidence_id: +evId(P6, 'email') }], body_text: 'Hi, ola@reedreport.test' }));
  chk('W an email address is no claim about the person', r.ok === false && r.reason === 'claim_without_evidence', r);
  r = create(P6, Object.assign({}, good, { claims: [{ text: 'your CFB power ratings against the market', evidence_id: 'x' }] }));
  chk('W a claim without an evidence id is refused', r.ok === false && r.reason === 'invalid_claims');
  r = create(P6, Object.assign({}, good, { body_text: 'Hi Ola, EdgeDesk might help you.' }));
  chk('W a cited claim the email does not say is refused', r.ok === false && r.reason === 'claim_not_in_email', r);
  r = create(P6, Object.assign({}, good, { body_text: good.body_text + ' Guaranteed winners, only $9!' }));
  chk('W the content rules apply at once, every problem named', r.ok === false && r.reason === 'content' && r.problems.length === 2, r);
  r = create(P6, good);
  chk('W a good draft goes into the queue for review', r.ok === true && r.status === 'ready_for_review' && statusOf(r.draft_id) === 'pending_review', r);
  const D6 = r.draft_id;
  chk('W … written by the owner, real (not test), claims stored as cited', one(`select generator_version || '|' || is_test || '|' || (claims->0->>'evidence_id') from growth_outbound.drafts where id = '${D6}';`)
    === 'owner|false|' + proj6);
  r = create(P6, good);
  chk('W one live draft per step', r.ok === false && r.reason === 'draft_exists' && r.draft_id === D6, r);
  db.as(OWNER, `select public.growth_outbound_evidence_supersede(${proj6}, 'project closed');`);
  r = create(P6, Object.assign({}, good, { sequence_number: 2 }));
  chk('W superseded evidence supports nothing', r.ok === false && r.reason === 'claim_without_evidence', r);
  chk('W … and the waiting draft that cited it falls below the research bar', pstatus(P6) === 'needs_research');
  db.as(OWNER, `select public.growth_outbound_suppress('ola@reedreport.test', 'unsubscribe', 'asked', 'address');`);
  r = create(P6, Object.assign({}, good, { sequence_number: 3 }));
  chk('W no draft for a suppressed prospect', r.ok === false && r.reason === 'prospect_suppressed', r);

  /* ══ B. BATCH ═════════════════════════════════════════════════════════ */
  const items = (ns) => ns.map((n) => ({ draft_id: did(n), content_hash: hashOf(did(n)) }));
  r = batch(items([1, 4]), 3);
  chk('B the confirmed count must equal the selection; otherwise nothing is approved', r.ok === false && r.reason === 'count_mismatch'
    && statusOf(did(1)) === 'pending_review' && statusOf(did(4)) === 'pending_review', r);
  r = batch(items([1, 4]), null);
  chk('B … no count, no approval', r.ok === false && r.reason === 'count_mismatch');
  r = batch([items([1])[0], items([1])[0]], 2);
  chk('B each draft once', r.ok === false && r.reason === 'invalid_items');
  r = batch([{ draft_id: 'not-a-uuid', content_hash: 'x' }], 1);
  chk('B a malformed item is refused', r.ok === false && r.reason === 'invalid_items');
  r = batch(Array.from({ length: 26 }, (_, i) => ({ draft_id: did(1000 + i), content_hash: 'x' })), 26);
  chk('B at most 25 at a time', r.ok === false && r.reason === 'batch_size');
  r = batch([], 0);
  chk('B … and at least one', r.ok === false && r.reason === 'batch_size');
  const nApproved0 = +one(`select count(*) from growth_outbound.activity where action = 'draft_approved';`);
  const stale = items([1, 4, 5]); stale[2].content_hash = 'stale';
  r = batch(stale, 3);
  chk('B one draft that cannot be approved stops the whole batch: none is approved', r.ok === false && r.reason === 'not_all_approvable'
    && r.refused.length === 1 && r.refused[0].draft_id === did(5) && r.refused[0].reason === 'content_changed'
    && [1, 4, 5].every((n) => statusOf(did(n)) === 'pending_review'), r);
  chk('B … and no approval from it reached the record', +one(`select count(*) from growth_outbound.activity where action = 'draft_approved';`) === nApproved0);
  edit(did(5), 'Your work, Kai', 'Hi Kai, I read your CFB power ratings against the market. A sure thing.');
  r = batch(items([1, 4, 5]), 3);
  chk('B … a broken content rule too, with the reason', r.ok === false && r.refused[0].draft_id === did(5) && r.refused[0].gates.some((g) => /promises winnings/.test(g)), r);
  edit(did(5), 'Your work, Kai', 'Hi Kai, I read your CFB power ratings against the market.');
  r = batch(items([1, 4, 5]), 3);
  chk('B the confirmed batch approves exactly those drafts', r.ok === true && r.approved === 3 && [1, 4, 5].every((n) => statusOf(did(n)) === 'approved'), r);
  chk('B … each recorded as the owner\'s, for its own hash and recipient', one(`select count(*) from growth_outbound.drafts where id in ('${did(1)}', '${did(4)}', '${did(5)}')
      and approved_by = '${OWNER}' and approved_hash = content_hash and approved_recipient is not null;`) === '3');
  chk('B … and logged once as a batch, and once per draft', one(`select count(*) from growth_outbound.activity where action = 'drafts_batch_approved' and (detail->>'count')::int = 3;`) === '1'
    && +one(`select count(*) from growth_outbound.activity where action = 'draft_approved';`) === nApproved0 + 3);
  chk('B approving sent nothing', one(`select count(*) from growth_outbound.sends;`) === '0');
  let e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_drafts_approve_batch('[]'::jsonb, 0);`));
  chk('B an affiliate admin who is not an owner cannot batch-approve', !!e && /outbound owner only/.test(e), e);
  chk('B the approved queue now lists them', queue('approved').total === 5);

  /* ══ U. WITHDRAW ══════════════════════════════════════════════════════ */
  r = own(`select public.growth_outbound_draft_unapprove('${did(4)}', 'want to re-read it');`);
  chk('U an approval can be withdrawn before sending: back to review, approval cleared', r.ok === true && statusOf(did(4)) === 'pending_review'
    && one(`select coalesce(approved_by::text, 'none') from growth_outbound.drafts where id = '${did(4)}';`) === 'none');
  r = own(`select public.growth_outbound_draft_unapprove('${did(4)}', null);`);
  chk('U … only from approved', r.ok === false && r.reason === 'not_approved');
  chk('U … and that is on the record', one(`select count(*) from growth_outbound.activity where action = 'draft_unapproved';`) === '1');

  /* ══ F. THE TEST FIXTURE ══════════════════════════════════════════════ */
  r = own(`select public.growth_outbound_test_fixture();`);
  chk('F without a test inbox there is no test prospect', r.ok === false && r.reason === 'test_inbox_missing');
  own(`select public.growth_outbound_settings_update('{"test_inbox": "Owner-Test@EdgeDesk.test"}'::jsonb);`);
  r = own(`select public.growth_outbound_test_fixture();`);
  const FX = r;
  chk('F a test prospect at the owner\'s own test inbox, with a draft', r.ok === true && r.created === true
    && one(`select is_test || '|' || email from growth_outbound.prospects where id = '${r.prospect_id}';`) === 'true|owner-test@edgedesk.test'
    && one(`select is_test || '|' || status from growth_outbound.drafts where id = '${r.draft_id}';`) === 'true|pending_review', r);
  r = own(`select public.growth_outbound_test_fixture();`);
  chk('F … idempotent: the same one again', r.ok === true && r.created === false && r.draft_id === FX.draft_id && r.prospect_id === FX.prospect_id);
  q = queue('pending_review');
  const fc = q.rows[0];
  chk('F test cards come first, marked test, addressed to the test inbox', fc.draft.id === FX.draft_id && fc.preview.test === true && fc.preview.to === 'owner-test@edgedesk.test', fc && fc.preview);
  chk('F the fixture keeps the content rules', fc.lint.length === 0 && fc.claims_missing.length === 0);
  r = approve(FX.draft_id);
  chk('F … and can be approved', r.ok === true, r);

  /* ══ P. PREVIEW ═══════════════════════════════════════════════════════ */
  r = own(`select public.growth_outbound_settings_update(${lit(JSON.stringify({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', reply_to_email: 'hello@edgedesksports.com' }))}::jsonb);`);
  let pv = queue('approved').rows.find((x) => x.draft.id === did(1)).preview;
  chk('P in test mode a real prospect\'s message would still go to the test inbox', pv.test === true && pv.to === 'owner-test@edgedesk.test' && pv.intended_recipient === 'pat@cfbnumbers.test', pv);
  chk('P the footer carries the sender, the business, the postal address and the way to stop', /Davis, EdgeDesk Sports/.test(pv.footer)
    && /100 Example St, Springfield, IL 62701/.test(pv.footer) && /Reply "stop"/.test(pv.footer) && pv.reply_to === 'hello@edgedesksports.com', pv.footer);
  own(`select public.growth_outbound_settings_update('{"test_mode": false, "confirm_live": true}'::jsonb);`);
  pv = queue('approved').rows.find((x) => x.draft.id === did(1)).preview;
  chk('P live, it goes to the prospect', pv.test === false && pv.to === 'pat@cfbnumbers.test');
  pv = queue('approved').rows.find((x) => x.draft.id === FX.draft_id).preview;
  chk('P … but a test prospect\'s message never leaves the test inbox', pv.test === true && pv.to === 'owner-test@edgedesk.test');

  /* ══ X. THE ONE APPROVE IMPLEMENTATION IS PRIVATE ════════════════════ */
  e = db.mustFail(() => db.as(OWNER, `select growth_outbound.approve_one('${OWNER}', '${did(4)}', 'x');`));
  chk('X no client may call the approve implementation directly, not even the owner', !!e && /permission denied/.test(e), e);
  e = db.mustFail(() => one(`select growth_outbound.approve_one('${OWNER}', '${did(4)}', ${lit(hashOf(did(4)))});`));
  chk('X … and it refuses any session that is not the signed-in owner, the superuser\'s included', !!e && /outbound owner only/.test(e), e);
  e = db.mustFail(() => one(`begin; select set_config('request.jwt.claim.sub', '${ADMIN}', true);
      select growth_outbound.approve_one('${ADMIN}', '${did(4)}', ${lit(hashOf(did(4)))}); commit;`));
  chk('X … or a signed-in non-owner', !!e && /outbound owner only/.test(e), e);
  e = db.mustFail(() => one(`begin; select set_config('request.jwt.claim.sub', '${ADMIN}', true);
      select growth_outbound.approve_one('${OWNER}', '${did(4)}', ${lit(hashOf(did(4)))}); commit;`));
  chk('X … or one naming the owner while signed in as someone else', !!e && /outbound owner only/.test(e), e);
  chk('X … so the draft is still waiting', statusOf(did(4)) === 'pending_review');

  const rep = db.applyFileAtomic(FILE);
  chk('the file re-runs over all of this, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… and the queue counts are reported', /review queue: \d+ waiting, \d+ approved and not sent/.test(rep));
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
