#!/usr/bin/env node
/* ===========================================================================
   PHASE 3 — WHO A PROSPECT IS, WHAT IS KNOWN, AND HOW SURE
   (supabase/growth_outbound.sql, sections 4b, 5 and the research doors)

   On a real PostgreSQL, through the owner's doors and as the superuser:

     U  URLS        canonical form: tracking parameters, www/m./mobile., case,
                    twitter → x, youtu.be, ports, userinfo, slashes; anything
                    that is not an http(s) page is refused
     K  IDENTITY    which URLs name a person (strong handles), which only a
                    site or a page (weak), reserved platform paths name nobody
     D  DEDUPE      rediscovery through any casing or tagged/mobile URL finds
                    the same row; keys of two prospects → identity_conflict
                    with nothing written; a suppressed address, domain or
                    prospect is never re-added or re-researched; a shared site
                    is flagged; a wrongly attached key can be released
     E  EVIDENCE    unknown fields, unknown kinds, email-only kinds elsewhere,
                    forged verifier/owner attestations, missing quotes, non-web
                    sources, future dates, an employer from an email domain, a
                    handle as a name — all refused; the collector's own
                    confidence is discarded; a bad item rolls the request back
     M  CONFIDENCE  one site counts once however often it repeats; independent
                    sources combine; a rival claim halves it; old roles and old
                    content weigh less; superseding restores it and keeps the
                    history ("previously … currently …")
     G  COMPUTED    no statement writes a computed column — not the superuser;
                    a faked evaluate door only yields the true values
     N  NAMES       a first name only when identity clears the gate and the
                    name plainly has one
     F  FIT         a positive reason counts only with current evidence of its
                    own prospect; negatives count unproven; clamped to 0..100
     S  STATUS      discovered → needs_research → qualified → ready_for_review
                    and back; a draft's research confidence is its weakest
                    cited claim; an approval the prospect no longer earns is
                    taken back; the approve door reads a fresh assessment
     W  SENDING     the same person under another address (name+organization)
                    does not get the same step twice
     L  LOOKUP      have we seen this email or URL?

   Run: node tools/growth/outbound_research_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));
const SEED = require(path.join(__dirname, '_outbound_seed.js'));

const T = PG.kit('growth outbound research SQL');
const chk = T.chk;
const lit = PG.lit;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');
const SRC = fs.readFileSync(FILE, 'utf8');

/* ── STATIC ─────────────────────────────────────────────────────────────── */
const COMPUTED = ['full_name', 'first_name', 'last_name', 'organization', 'job_title', 'email_status', 'fit_score', 'fit_reason',
  'identity_confidence', 'role_confidence', 'email_confidence', 'research_confidence', 'fit_confidence', 'duplicate_of'];
{
  const writes = (SRC.match(/update growth_outbound\.prospects\s+set[^;]*;/gi) || [])
    .filter((u) => COMPUTED.some((c) => new RegExp('[\\s,]' + c + '\\s*=').test(u)));
  chk('static: no statement in the file writes a computed prospect column', writes.length === 0, writes);
  const guard = SRC.slice(SRC.indexOf('function growth_outbound.prospects_guard()'), SRC.indexOf('prospects_guard_t before insert'));
  chk('static: the prospects guard covers every computed column', COMPUTED.every((c) => guard.includes('new.' + c) && guard.includes('old.' + c)),
    COMPUTED.filter((c) => !guard.includes('old.' + c)));
  const ins = SRC.slice(SRC.indexOf('insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_title,'));
  chk('static: the intake never passes a confidence through', !/confidence/.test(ins.slice(0, ins.indexOf(';'))));
}

const db = PG.start('gores');
if (db.skip) { console.log('NOTE | ' + db.skip + ' — LIVE layer skipped'); process.exit(T.done()); }

const OWNER = '00000000-0000-0000-0000-0000000000a1';
const ADMIN = '00000000-0000-0000-0000-0000000000a2';
const j = (s) => JSON.parse(s);
const one = (sql) => db.sql(sql);
const up = (o) => j(db.as(OWNER, `select public.growth_outbound_prospect_upsert(${lit(JSON.stringify(o))}::jsonb);`));
const add = (id, o) => j(db.as(OWNER, `select public.growth_outbound_evidence_add(${lit(id)}, ${lit(JSON.stringify(o))}::jsonb);`));
const row = (id) => j(one(`select to_jsonb(p) from growth_outbound.prospects p where id = ${lit(id)};`));
const detail = (id) => j(db.as(OWNER, `select public.growth_outbound_prospect(${lit(id)});`));
const count = (t, where) => +one(`select count(*) from growth_outbound.${t}${where ? ' where ' + where : ''};`);
const E = (field_name, claim, source_url, source_kind, source_excerpt, more) =>
  Object.assign({ field_name, claim, source_url, source_kind, source_excerpt }, more || {});
const evId = (pid, field, claim) => one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid)} and field_name = ${lit(field)}
  ${claim ? 'and claim = ' + lit(claim) : ''} and superseded_at is null order by id desc limit 1;`);
const evAt = (pid, field, claim, url) => one(`select id from growth_outbound.evidence where prospect_id = ${lit(pid)} and field_name = ${lit(field)}
  and claim = ${lit(claim)} and source_url = ${lit(url)} and superseded_at is null;`);
const strongPayload = (o) => ({
  email: o.email, urls: ['https://' + o.d, 'https://x.com/' + o.h], prospect_type: 'cfb_analyst', sports_focus: ['cfb'],
  evidence: [
    E('full_name', o.name, 'https://' + o.d + '/about', 'own_site', 'I am ' + o.name),
    E('full_name', o.name, 'https://x.com/' + o.h, 'own_profile', o.name + ' (@' + o.h + ')'),
    E('organization', o.org, 'https://' + o.d + '/about', 'own_site', 'I run ' + o.org),
    E('organization', o.org, 'https://x.com/' + o.h, 'own_profile', 'founder, ' + o.org),
    E('email', o.email, 'https://' + o.d + '/contact', 'own_site', 'Email me: ' + o.email),
    E('email', o.email, 'https://' + o.d + '/contact', 'owner_verified', null),
    E('project', o.project, 'https://' + o.d + '/work', 'own_site', o.project + ', every week'),
    E('project', o.project, 'https://x.com/' + o.h + '/status/9', 'own_profile', 'New: ' + o.project),
    E('fit_signal', 'prices every game with a market model', 'https://' + o.d + '/method', 'own_site', 'our model prices every game')],
  fit_factors: SEED.FIT_STRONG.map((code) => ({ code, evidence_index: [8] }))
});
const send = (o) => `begin; select set_config('growth_outbound.door', 'claim_send', true);
  insert into growth_outbound.sends (prospect_id, draft_id, sequence_number, is_test, idempotency_key, sender, intended_recipient, recipient, subject, content_hash, claimed_by)
  select d.prospect_id, d.id, d.sequence_number, false, ${lit(o.key)}, 'x', ${lit(o.to)}, ${lit(o.to)}, d.subject, d.content_hash, ${lit(OWNER)}
    from growth_outbound.drafts d where d.id = ${lit(o.draft)}; commit;`;
const hashOf = (d) => one(`select content_hash from growth_outbound.drafts where id = '${d}';`);
const approve = (d) => j(db.as(OWNER, `select public.growth_outbound_draft_approve('${d}', ${lit(hashOf(d))});`));

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql', 'growth_outbound.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  one(`insert into auth.users (id, email, email_confirmed_at) values ('${OWNER}', 'owner@edgedesk.test', now()), ('${ADMIN}', 'admin@edgedesk.test', now());
       insert into public.affiliate_admins (user_id) values ('${OWNER}'), ('${ADMIN}');
       select growth_outbound.grant_owner('owner@edgedesk.test');`);

  /* ══ U. URLS ══════════════════════════════════════════════════════════ */
  const CANON = [
    ['HTTP://WWW.Example.COM/About/?utm_source=x&utm_medium=y#team', 'https://example.com/About'],
    ['example.com/a?b=2&a=1', 'https://example.com/a?a=1&b=2'],
    ['https://example.com:443/', 'https://example.com'],
    ['https://example.com:8443/x', 'https://example.com:8443/x'],
    ['https://user:secret@example.com/x', 'https://example.com/x'],
    ['https://mobile.twitter.com/PatAnalyst?s=20&t=abc', 'https://x.com/PatAnalyst'],
    ['https://twitter.com/patanalyst/status/123?ref_src=twsrc%5Etfw', 'https://x.com/patanalyst/status/123'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc&t=42', 'https://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://m.youtube.com/@PatAnalyst/videos', 'https://youtube.com/@PatAnalyst/videos'],
    ['https://example.com//a///b/', 'https://example.com/a/b'],
    ['https://example.com/?fbclid=1&gclid=2&mc_cid=3&_hsenc=4&igshid=5', 'https://example.com'],
    ['https://example.com/watch?id=7&utm_campaign=z', 'https://example.com/watch?id=7'],
    ['https://m.co/x', 'https://m.co/x'],
    ['javascript:alert(1)', 'NULL'],
    ['mailto:pat@cfbnumbers.test', 'NULL'],
    ['ftp://example.com/file', 'NULL'],
    ['not a url', 'NULL'],
    ['', 'NULL'],
    ['https://localhost/admin', 'NULL'],
    ['https://192.168.0.1/', 'NULL']];
  const canon = one(`select string_agg(coalesce(growth_outbound.canonical_url(u), 'NULL'), E'\\n' order by n)
                       from unnest(${lit('{' + CANON.map((c) => '"' + c[0].replace(/"/g, '\\"') + '"').join(',') + '}')}::text[]) with ordinality t(u, n);`).split('\n');
  CANON.forEach(([u, want], i) => chk('U ' + (u || '(empty)') + ' → ' + want, canon[i] === want, canon[i]));

  /* ══ K. IDENTITY KEYS ═════════════════════════════════════════════════ */
  const ID = [
    ['https://twitter.com/PatAnalyst/status/1', 'handle:x:patanalyst'],
    ['https://x.com/home', 'url:https://x.com/home'],
    ['https://www.youtube.com/@PatAnalyst', 'handle:youtube:@patanalyst'],
    ['https://youtube.com/channel/UCabcdefghijklmnopqrstuv', 'handle:youtube:channel:UCabcdefghijklmnopqrstuv'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'url:https://youtube.com/watch?v=dQw4w9WgXcQ'],
    ['https://patanalyst.substack.com/p/week-5', 'handle:substack:patanalyst'],
    ['https://substack.com/@PatAnalyst', 'handle:substack:@patanalyst'],
    ['https://www.linkedin.com/in/Pat-Analyst/', 'handle:linkedin:in:pat-analyst'],
    ['https://instagram.com/p/Cxyz', 'url:https://instagram.com/p/Cxyz'],
    ['https://www.tiktok.com/@patanalyst', 'handle:tiktok:@patanalyst'],
    ['https://github.com/features', 'url:https://github.com/features'],
    ['https://github.com/PatAnalyst/models', 'handle:github:patanalyst'],
    ['https://podcasts.apple.com/us/podcast/cfb-numbers/id1234567890', 'handle:apple_podcast:1234567890'],
    ['https://open.spotify.com/show/4rOoJ6Egrf8K2IrywzwOMk', 'handle:spotify_show:4rOoJ6Egrf8K2IrywzwOMk'],
    ['https://blog.cfbnumbers.test/post?utm_source=x', 'site:cfbnumbers.test|url:https://blog.cfbnumbers.test/post'],
    ['https://pat.wordpress.com/about', 'site:pat.wordpress.com|url:https://pat.wordpress.com/about'],
    ['https://www.bbc.co.uk/sport', 'site:bbc.co.uk|url:https://bbc.co.uk/sport']];
  for (const [u, want] of ID) {
    const got = one(`select coalesce(string_agg(kind || ':' || value, '|' order by kind, value), '') from growth_outbound.url_identity(${lit(u)});`);
    chk('K ' + u + ' → ' + want, got === want, got);
  }
  chk('K a strong key is a handle; a site or page is weak', one(`select string_agg(distinct kind || '=' || strength, ',' order by kind || '=' || strength)
      from (select * from growth_outbound.url_identity('https://x.com/a') union all select * from growth_outbound.url_identity('https://a.test/b')) k;`)
    === 'handle=strong,site=weak,url=weak');

  /* ══ D. DEDUPE ════════════════════════════════════════════════════════ */
  const pat = strongPayload({ name: 'Pat Analyst', org: 'CFB Numbers', email: 'pat@cfbnumbers.test', d: 'cfbnumbers.test', h: 'patanalyst',
    project: 'CFB power ratings against the market' });
  let r = up(pat);
  const A = r.prospect_id;
  chk('D a new prospect is created from an email, URLs and evidence', r.ok === true && r.created === true && r.evidence_ids.length === 9, r);
  chk('D … and evaluated: every gate clears, so it is qualified', r.status === 'qualified', r);
  const nA = count('evidence', `prospect_id = '${A}'`);
  r = up({ urls: ['https://mobile.twitter.com/PatAnalyst?s=20&utm_source=share'], evidence: [E('topic', 'closing line value', 'https://x.com/patanalyst/status/10', 'own_profile', 'CLV is the only scoreboard')] });
  chk('D rediscovered through a tagged mobile twitter.com URL → the same row', r.ok === true && r.created === false && r.prospect_id === A, r);
  r = up({ email: '  PAT@CFBNumbers.TEST ' });
  chk('D rediscovered through the email in another casing → the same row', r.ok === true && r.created === false && r.prospect_id === A, r);
  chk('D … and nothing duplicated', count('prospects') === 1 && count('identifiers', `kind = 'email' and value = 'pat@cfbnumbers.test'`) === 1);
  r = up({ urls: ['https://www.youtube.com/@PatAnalyst?si=x'] });
  const B = r.prospect_id;
  chk('D an unknown profile is somebody new until shown otherwise', r.ok === true && r.created === true && B !== A, r);
  const before = [count('prospects'), count('evidence'), count('identifiers')];
  r = up({ email: 'pat@cfbnumbers.test', urls: ['https://youtube.com/@patanalyst'], evidence: [E('topic', 'x', 'https://youtube.com/@patanalyst', 'own_profile', 'x')] });
  chk('D keys that belong to two different prospects → identity_conflict', r.ok === false && r.reason === 'identity_conflict' && r.prospects.length === 2, r);
  chk('D … and nothing at all was written', JSON.stringify([count('prospects'), count('evidence'), count('identifiers')]) === JSON.stringify(before));
  r = add(B, { email: 'pat@cfbnumbers.test', set_primary_email: true });
  chk('D another prospect\'s address cannot be attached to a row', r.ok === false && r.reason === 'identity_conflict', r);
  r = up({ evidence: [E('full_name', 'Nobody', 'https://n.test/', 'own_site', 'Nobody')] });
  chk('D a prospect we could never recognise again is refused', r.ok === false && r.reason === 'no_identifier', r);
  r = up({ urls: ['javascript:alert(1)'] });
  chk('D a non-web URL is refused', r.ok === false && r.reason === 'invalid_url', r);
  r = up({ email: 'pat@', evidence: [] });
  chk('D a malformed email is refused', r.ok === false && r.reason === 'invalid_email', r);
  r = up({ email: 'x@y.test', service_role_key: 'x' });
  chk('D an unknown field is refused', r.ok === false && r.reason === 'unknown_field', r);

  /* a row written straight in (as a server-side pipeline might) with an
     address another prospect holds is a duplicate, and that blocks it */
  const DUP = '10000000-0000-0000-0000-0000000000d1';
  one(`insert into growth_outbound.prospects (id, email) values ('${DUP}', 'Pat@cfbnumbers.test'); ${SEED.evaluate(DUP)}`);
  chk('D a second row holding Pat\'s address is marked his duplicate', row(DUP).duplicate_of === A && row(DUP).warnings.includes('duplicate'), row(DUP));
  add(DUP, pat.evidence.length ? { evidence: pat.evidence.filter((x) => x.field_name !== 'email') } : {});
  chk('D … and however well researched, it never qualifies', row(DUP).status === 'needs_research' && /duplicate of another prospect/.test(row(DUP).status_reason), row(DUP).status_reason);

  /* suppressed people stay out */
  db.as(OWNER, `select public.growth_outbound_suppress('gone@optout.test', 'unsubscribe', 'asked', 'address');
                select public.growth_outbound_suppress('blocked.test', 'do_not_contact', 'their legal team asked', 'domain');`);
  const nP = count('prospects');
  r = up({ email: 'GONE@optout.test', evidence: [E('full_name', 'Gone Person', 'https://optout.test/', 'own_site', 'Gone Person')] });
  chk('D a suppressed address is never added again', r.ok === false && r.reason === 'suppressed' && count('prospects') === nP, r);
  r = up({ email: 'anyone@blocked.test' });
  chk('D … nor anyone at a suppressed domain', r.ok === false && r.reason === 'suppressed' && count('prospects') === nP, r);
  r = up({ email: 'cee@cee.test', urls: ['https://x.com/ceeperson'], evidence: [E('full_name', 'Cee Person', 'https://x.com/ceeperson', 'own_profile', 'Cee Person')] });
  const C = r.prospect_id;
  db.as(OWNER, `select public.growth_outbound_suppress('cee@cee.test', 'unsubscribe', 'replied stop', 'address');`);
  const nC = count('evidence', `prospect_id = '${C}'`);
  r = up({ urls: ['https://twitter.com/CeePerson'], evidence: [E('topic', 'more', 'https://x.com/ceeperson/status/2', 'own_profile', 'more')] });
  chk('D a suppressed prospect found again by profile is not re-researched', r.ok === false && r.reason === 'suppressed' && r.prospect_id === C
    && count('evidence', `prospect_id = '${C}'`) === nC, r);
  chk('D … and stays suppressed', row(C).status === 'suppressed');

  /* weak keys flag, never merge */
  r = up({ email: 'editor@cfbnumbers.test', urls: ['https://cfbnumbers.test/team'], evidence: [E('full_name', 'Ed Itor', 'https://cfbnumbers.test/team', 'own_site', 'Ed Itor, editor')] });
  chk('D a colleague on the same site is a separate prospect, flagged as a possible duplicate', r.ok === true && r.created === true
    && r.possible_duplicates.includes(A) && r.warnings.includes('possible_duplicate'), r);
  const ED = r.prospect_id;
  chk('D … the detail view names the related prospect', detail(ED).related.some((x) => x.id === A && x.relation === 'possible_duplicate'));

  /* release a key attached to the wrong person */
  r = up({ email: 'shared@inbox.test', urls: ['https://x.com/wrongperson'], evidence: [E('full_name', 'Wrong Person', 'https://x.com/wrongperson', 'own_profile', 'Wrong Person')] });
  const R1 = r.prospect_id;
  const keyId = one(`select id from growth_outbound.identifiers where prospect_id = '${R1}' and kind = 'email';`);
  r = j(db.as(OWNER, `select public.growth_outbound_identifier_release(${keyId}, null);`));
  chk('D releasing a key needs a reason', r.ok === false && r.reason === 'reason_required', r);
  r = j(db.as(OWNER, `select public.growth_outbound_identifier_release(${keyId}, 'this inbox belongs to someone else');`));
  chk('D a released email is cleared from the row it was wrongly on', r.ok === true && r.cleared.includes('email') && row(R1).email === null, r);
  r = j(db.as(OWNER, `select public.growth_outbound_identifier_release(${keyId}, 'again');`));
  chk('D … once', r.ok === false && r.reason === 'already_released');
  r = up({ email: 'shared@inbox.test', urls: ['https://x.com/rightperson'] });
  chk('D … and can then name somebody else', r.ok === true && r.created === true && r.prospect_id !== R1, r);
  chk('D … the release stays on the record', count('identifiers', `id = ${keyId} and released_at is not null and released_reason is not null`) === 1);
  let e = db.mustFail(() => one(`update growth_outbound.identifiers set prospect_id = '${A}' where id = ${keyId};`));
  chk('D an identifier is never moved to another prospect, even by the superuser', !!e && /never moved/.test(e), e);
  e = db.mustFail(() => one(`delete from growth_outbound.identifiers where id = ${keyId};`));
  chk('D … or deleted', !!e && /never deleted/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.identifiers (prospect_id, kind, value, strength) values ('${B}', 'email', 'pat@cfbnumbers.test', 'strong');`));
  chk('D two prospects can never both hold one email (the strong index)', !!e && /identifiers_strong_uk/.test(e), e);

  /* ══ E. EVIDENCE COMES IN CHECKABLE ═══════════════════════════════════ */
  const bad = (item, re, label) => {
    const n0 = count('evidence');
    const res = add(A, { evidence: [item] });
    chk('E ' + label, res.ok === false && res.reason === 'invalid' && re.test(res.detail || '') && count('evidence') === n0, res);
  };
  bad(E('favorite_color', 'blue', 'https://cfbnumbers.test/', 'own_site', 'blue'), /unknown evidence field/, 'an unknown field is refused');
  bad(E('full_name', 'Pat Analyst', 'https://cfbnumbers.test/', 'blog', 'x'), /unknown source kind/, 'an unknown source kind is refused');
  bad(E('full_name', 'Pat Analyst', 'https://cfbnumbers.test/', 'pattern_guess', null), /can only support an email/, 'a pattern guess cannot support a name');
  bad(E('email', 'pat@cfbnumbers.test', 'https://cfbnumbers.test/', 'provider_verified', null), /only a verification provider/, 'the owner cannot record a provider verification');
  {
    const n0 = count('evidence');
    const res = add(A, { collected_by: 'research_engine', evidence: [E('email', 'pat@cfbnumbers.test', 'https://cfbnumbers.test/contact', 'owner_verified', null)] });
    chk('E the research engine cannot record an owner verification', res.ok === false && /only the owner records/.test(res.detail) && count('evidence') === n0, res);
    const res2 = add(A, { collected_by: 'root', evidence: [] });
    chk('E an unknown collector is refused', res2.ok === false && res2.reason === 'invalid_collector', res2);
  }
  bad(E('project', 'ratings', 'https://cfbnumbers.test/ratings', 'own_site', ''), /quote the words/, 'a page claim without the words that say it is refused');
  bad(E('project', 'ratings', 'javascript:alert(1)', 'own_site', 'x'), /must be a web page/, 'a non-web source is refused');
  bad(E('article', 'a column', 'https://cfbnumbers.test/a', 'own_site', 'x', { source_published_at: '2099-01-01T00:00:00Z' }), /published in the future/, 'a source from the future is refused');
  bad(E('organization', 'cfbnumbers.test', 'https://cfbnumbers.test/contact', 'own_site', 'pat@cfbnumbers.test'), /employer_from_email_domain/, 'an employer read off an email domain is refused');
  bad(E('organization', '@CFBNumbers.test', 'https://x.com/patanalyst', 'own_profile', 'x'), /employer_from_email_domain/, '… in any spelling');
  bad(E('full_name', '@patanalyst', 'https://x.com/patanalyst', 'own_profile', '@patanalyst'), /not an address or a handle/, 'a handle is not a name');
  bad(E('email', 'not-an-email', 'https://cfbnumbers.test/', 'own_site', 'x'), /is not an email address/, 'an email claim must be an address');
  bad(E('audience_size', 'lots', 'https://cfbnumbers.test/', 'own_site', 'lots of readers'), /audience size is a number/, 'an audience must be a number');
  bad(E('project', 'ratings', 'https://cfbnumbers.test/', 'own_site', 'x', { confidence: 0.99 }), /unknown evidence key confidence/, 'a collector cannot hand in a confidence');
  bad(E('project', 'ratings', 'https://cfbnumbers.test/', 'own_site', 'x', { supersedes: 999999 }), /not current project evidence/, 'superseding evidence that is not this prospect\'s is refused');
  {
    const n0 = count('evidence');
    const res = add(A, { evidence: [E('topic', 'one', 'https://cfbnumbers.test/1', 'own_site', 'one'), E('topic', 'two', 'https://cfbnumbers.test/2', 'own_site', 'two'),
      E('topic', 'three', 'ftp://cfbnumbers.test/3', 'own_site', 'three')] });
    chk('E one bad item rolls back the whole request (all or nothing)', res.ok === false && res.at === 'evidence 3' && count('evidence') === n0, res);
  }
  r = add(A, { evidence: [E('audience_size', '12.5k', 'https://cfbnumbers.test/about', 'own_site', '12.5k subscribers')] });
  chk('E an audience of "12.5k" is recorded as 12500', r.ok === true && one(`select claim_norm from growth_outbound.evidence where id = ${r.evidence_ids[0]};`) === '12500');
  one(`insert into growth_outbound.evidence (prospect_id, field_name, claim, source_url, source_kind, source_excerpt, confidence, collected_by)
       values ('${A}', 'topic', 'win rate', 'https://cfbnumbers.test/x?utm_source=feed', 'own_site', 'win rate', 0.99, 'owner');`);
  chk('E even written directly, the collector\'s confidence is replaced by the server\'s weight, and the URL is cleaned',
    one(`select confidence || '|' || source_url || '|' || source_key from growth_outbound.evidence where claim = 'win rate';`) === '0.70|https://cfbnumbers.test/x|cfbnumbers.test');
  e = db.mustFail(() => one(`update growth_outbound.evidence set claim = 'a better story' where claim = 'win rate';`));
  chk('E evidence is never rewritten', !!e && /never rewritten/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.evidence set superseded_reason = 'sneaky' where claim = 'win rate';`));
  chk('E … not even its supersede reason, on its own', !!e && /never rewritten/.test(e), e);

  /* ══ M. CONFIDENCE ════════════════════════════════════════════════════ */
  r = up({ email: 'mia@mlab.test', urls: ['https://mlab.test'], evidence: [E('full_name', 'Mia Model', 'https://mlab.test/about', 'own_site', 'I am Mia Model')] });
  const M = r.prospect_id;
  const fa = (id, f) => (row(id).assessment.fields || {})[f] || {};
  chk('M one first-party source: identity 0.70', +row(M).identity_confidence === 0.7);
  add(M, { evidence: [E('full_name', 'Mia Model', 'https://mlab.test/team', 'own_site', 'Mia Model, founder'),
    E('full_name', 'Mia  Model.', 'https://blog.mlab.test/hello', 'own_site', 'Hi, Mia Model here')] });
  chk('M the same publisher saying it three times (two pages, a subdomain, another spelling) is still 0.70', +row(M).identity_confidence === 0.7
    && fa(M, 'full_name').sources === 1 && fa(M, 'full_name').reasons.includes('single_source'), fa(M, 'full_name'));
  chk('M … and below the identity gate, no first name is used', row(M).first_name === null && row(M).warnings.includes('first_name_withheld'));
  add(M, { urls: ['https://x.com/miamodel'], evidence: [E('full_name', 'Mia Model', 'https://x.com/miamodel', 'own_profile', 'Mia Model')] });
  chk('M an independent first-party source: 1 − 0.3 × 0.3 = 0.91', +row(M).identity_confidence === 0.91 && fa(M, 'full_name').sources === 2);
  chk('M … which clears the gate, so the first name is used', row(M).first_name === 'Mia' && row(M).last_name === 'Model');
  r = add(M, { evidence: [E('full_name', 'Maya Model', 'https://people-directory.test/m', 'directory', 'Maya Model, analyst')] });
  const dirId = r.evidence_ids[0];
  chk('M a rival name, even from a weak source, halves the confidence: 0.455', +row(M).identity_confidence === 0.455
    && fa(M, 'full_name').conflict === true && row(M).warnings.includes('conflict:full_name'), row(M).identity_confidence);
  chk('M … and the first name is withheld again', row(M).first_name === null);
  chk('M … the rival is shown as an alternative', fa(M, 'full_name').alternatives.some((a) => a.claim === 'Maya Model'));
  r = j(db.as(OWNER, `select public.growth_outbound_evidence_supersede(${dirId}, 'directory confused her with someone else');`));
  chk('M superseding the wrong observation restores 0.91', r.ok === true && +row(M).identity_confidence === 0.91 && row(M).first_name === 'Mia');
  const md = detail(M).evidence.find((x) => +x.id === +dirId);
  chk('M … and history keeps it: previously "Maya Model", superseded, with the reason', md && md.current === false && md.claim === 'Maya Model'
    && /confused/.test(md.superseded_reason) && md.claim_confidence === null, md);
  r = j(db.as(OWNER, `select public.growth_outbound_evidence_supersede(${dirId}, 'again');`));
  chk('M an observation is superseded once', r.ok === false && r.reason === 'already_superseded');
  r = j(db.as(OWNER, `select public.growth_outbound_evidence_supersede(${evId(M, 'full_name', 'Mia Model')}, '  ');`));
  chk('M superseding needs a reason', r.ok === false && r.reason === 'reason_required');

  const old = new Date(Date.now() - 800 * 864e5).toISOString();
  add(M, { evidence: [E('job_title', 'Head of Data', 'https://mlab.test/about', 'own_site', 'Head of Data', { source_published_at: old }),
    E('job_title', 'Head of Data', 'https://x.com/miamodel', 'own_profile', 'Head of Data at M Lab', { source_published_at: old })] });
  chk('M a role more than two years old counts half per source: 1 − 0.65² ≈ 0.5775, flagged stale', +fa(M, 'job_title').confidence === 0.5775
    && fa(M, 'job_title').reasons.includes('stale_role') && row(M).warnings.includes('stale:job_title'), fa(M, 'job_title'));
  r = add(M, { evidence: [E('job_title', 'Founder', 'https://mlab.test/about', 'own_site', 'Founder of M Lab', { supersedes: +evAt(M, 'job_title', 'Head of Data', 'https://mlab.test/about') })] });
  chk('M a new title superseding the site\'s old one, while the old profile still says otherwise, is a conflict: currently "Founder" at 0.35',
    r.ok === true && row(M).job_title === 'Founder' && +fa(M, 'job_title').confidence === 0.35 && fa(M, 'job_title').conflict === true, fa(M, 'job_title'));
  r = add(M, { evidence: [E('job_title', 'Founder', 'https://x.com/miamodel', 'own_profile', 'Founder, M Lab', { supersedes: +evAt(M, 'job_title', 'Head of Data', 'https://x.com/miamodel') })] });
  chk('M … once both are current, 0.91 and no conflict', r.ok === true && +fa(M, 'job_title').confidence === 0.91 && fa(M, 'job_title').conflict === false, fa(M, 'job_title'));
  const tl = detail(M).evidence.filter((x) => x.field_name === 'job_title');
  chk('M the title\'s history reads previously "Head of Data" (superseded twice), currently "Founder"', tl.length === 4
    && tl.filter((x) => x.current).every((x) => x.claim === 'Founder') && tl.filter((x) => !x.current).every((x) => x.claim === 'Head of Data'));
  const oldc = new Date(Date.now() - 600 * 864e5).toISOString();
  r = add(M, { evidence: [E('article', 'Why totals move', 'https://mlab.test/totals', 'own_site', 'Why totals move', { source_published_at: oldc }),
    E('article', 'Why totals move', 'https://x.com/miamodel/status/3', 'own_profile', 'Why totals move', { source_published_at: oldc })] });
  chk('M content older than eighteen months weighs 0.7 per source (≈ 0.7399) and is marked old, never "recent"',
    +one(`select growth_outbound.evidence_confidence(${r.evidence_ids[0]}, '${M}');`) === 0.7399
    && one(`select stale from growth_outbound.claim_stats('${M}', 'article');`) === 't');

  /* ══ G. COMPUTED COLUMNS ══════════════════════════════════════════════ */
  for (const [label, set] of [['identity confidence', 'identity_confidence = 0.99'], ['fit score', 'fit_score = 100'],
    ['email status', `email_status = 'verified'`], ['first name', `first_name = 'Bob'`], ['research confidence', 'research_confidence = 1'],
    ['organization', `organization = 'Big Co'`], ['duplicate flag', `duplicate_of = '${A}'`]]) {
    e = db.mustFail(() => one(`update growth_outbound.prospects set ${set} where id = '${M}';`));
    chk('G the superuser cannot write the ' + label, !!e && /computed from evidence/.test(e), e);
  }
  e = db.mustFail(() => one(`update growth_outbound.prospects set status = 'qualified' where id = '${ED}';`));
  chk('G … or declare a prospect qualified', !!e && /only evaluate\(\) decides/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.prospects set status = 'ready_for_review' where id = '${ED}';`));
  chk('G … or ready for review', !!e && /only evaluate\(\) decides/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.prospects (email, fit_score, identity_confidence) values ('new@new.test', 95, 0.99);`));
  chk('G a prospect cannot be born scored', !!e && /starts as discovered/.test(e), e);
  e = db.mustFail(() => one(`insert into growth_outbound.prospects (email, status) values ('new@new.test', 'ready_for_review');`));
  chk('G … or born ready', !!e && /starts as discovered/.test(e), e);
  one(`begin; select set_config('growth_outbound.door', 'evaluate', true);
       update growth_outbound.prospects set identity_confidence = 1, fit_score = 100, email_status = 'verified', status = 'ready_for_review',
              first_name = 'Bob' where id = '${ED}'; commit;`);
  const ed = row(ED);
  chk('G faking the evaluate door yields only the true, recomputed values', +ed.identity_confidence === 0.7 && ed.fit_score === null
    && ed.email_status === 'unverified' && ed.status === 'needs_research' && ed.first_name === null, ed);
  e = db.mustFail(() => one(`update growth_outbound.prospects set is_test = true where id = '${A}';`));
  chk('G the test flag never changes', !!e && /never change/.test(e), e);
  e = db.mustFail(() => one(`update growth_outbound.prospects set attribution_token = 'x' where id = '${A}';`));
  chk('G … nor the attribution token', !!e && /never change/.test(e), e);

  /* ══ N. NAMES ═════════════════════════════════════════════════════════ */
  for (const [nm, slug] of [['Madonna', 'madonna'], ['J. Smith', 'jsmith'], ['Dr. Ann Lee', 'annlee']]) {
    r = up({ urls: ['https://' + slug + '.test', 'https://x.com/' + slug], evidence: [E('full_name', nm, 'https://' + slug + '.test/about', 'own_site', nm),
      E('full_name', nm, 'https://x.com/' + slug, 'own_profile', nm)] });
    const p = row(r.prospect_id);
    chk('N "' + nm + '" at identity 0.91: no first name is guessed', +p.identity_confidence === 0.91 && p.first_name === null && p.full_name === nm, p.first_name);
  }

  /* ══ F. FIT ═══════════════════════════════════════════════════════════ */
  r = up({ email: 'fay@fitlab.test', urls: ['https://fitlab.test'], evidence: [E('fit_signal', 'publishes a CLV tracker', 'https://fitlab.test/clv', 'own_site', 'our CLV tracker')],
    fit_factors: [{ code: 'discusses_clv', evidence_index: [0] }, { code: 'quant_analysis' }] });
  const FA = r.prospect_id;
  chk('F a positive reason with current evidence counts; one without evidence does not', row(FA).fit_score === 12
    && row(FA).warnings.includes('unsupported_fit_factor:quant_analysis'), [row(FA).fit_score, row(FA).warnings]);
  r = add(FA, { fit_factors: [{ code: 'quant_analysis', evidence: [+evId(FA, 'fit_signal')] }, { code: 'entertainment_only' }] });
  chk('F citing the evidence makes it count; a negative counts unproven: 12 + 18 − 20 = 10', row(FA).fit_score === 10, row(FA).fit_reason);
  r = add(FA, { fit_factors: [{ code: 'publishes_models', evidence: [+evId(A, 'fit_signal')] }] });
  chk('F a reason citing ANOTHER prospect\'s evidence is refused', r.ok === false && /not this prospect/.test(r.detail), r);
  r = add(FA, { fit_factors: [{ code: 'world_class' }] });
  chk('F an unknown reason is refused', r.ok === false && /unknown fit factor/.test(r.detail), r);
  r = add(FA, { evidence: [E('email', 'fay@fitlab.test', 'https://fitlab.test/contact', 'own_site', 'fay@fitlab.test')], fit_factors: [{ code: 'publishes_models', evidence_index: [0] }] });
  chk('F an email address is no evidence of fit', r.ok === true && row(FA).fit_score === 10 && row(FA).warnings.includes('unsupported_fit_factor:publishes_models'));
  r = j(db.as(OWNER, `select public.growth_outbound_evidence_supersede(${evId(FA, 'fit_signal')}, 'tracker taken down');`));
  chk('F when the cited evidence is superseded, the reasons resting on it stop counting: 0 after −20', r.ok === true && row(FA).fit_score === 0, row(FA).fit_score);
  add(FA, { fit_factors: [{ code: 'entertainment_only', remove: true }, { code: 'spam' }] });
  chk('F a reason can be removed; the score never goes below 0', row(FA).fit_score === 0 && !/entertainment/.test(row(FA).fit_reason) && /spam/.test(row(FA).fit_reason));
  chk('F the catalogue is readable by the owner', j(db.as(OWNER, `select public.growth_outbound_fit_catalog();`)).length >= 21);

  /* ══ S. STATUS ════════════════════════════════════════════════════════ */
  r = up({ email: 'quinn@qlab.test', urls: ['https://x.com/quinnq'] });
  const Q = r.prospect_id;
  chk('S found, nothing known yet: discovered', r.status === 'discovered', r);
  add(Q, { evidence: [E('full_name', 'Quinn Q', 'https://some-directory.test/q', 'directory', 'Quinn Q')] });
  chk('S something known, not enough: needs_research, with every unmet gate named', row(Q).status === 'needs_research'
    && /fit unscored < 80/.test(row(Q).status_reason) && /identity 0.2500 < 0.90/.test(row(Q).status_reason), row(Q).status_reason);
  const qp = strongPayload({ name: 'Quinn Q', org: 'Q Lab', email: 'quinn@qlab.test', d: 'qlab.test', h: 'quinnq', project: 'NFL totals model' });
  delete qp.email; delete qp.urls;
  add(Q, qp);
  chk('S every gate clears: qualified', row(Q).status === 'qualified', row(Q).status_reason);
  const DQ = '30000000-0000-0000-0000-000000000001';
  one(SEED.draft({ id: DQ, prospect: Q, subject: 'Your NFL totals model', body: 'Hi Quinn' }));
  chk('S a draft whose claims cite strong evidence: ready_for_review', row(Q).status === 'ready_for_review' && +row(Q).research_confidence === 0.91, row(Q));
  r = j(db.as(OWNER, `select public.growth_outbound_draft_reject('${DQ}', 'too long');`));
  chk('S the draft rejected: back to qualified', r.ok === true && row(Q).status === 'qualified');
  r = j(db.as(OWNER, `select public.growth_outbound_prospect_set_status('${Q}', 'needs_research', 'check the title');`));
  j(db.as(OWNER, `select public.growth_outbound_prospect_evaluate('${Q}');`));
  chk('S the owner asks for more research: it stays needs_research until something new is found', row(Q).status === 'needs_research'
    && row(Q).status_reason === 'check the title');
  add(Q, { evidence: [E('job_title', 'Founder', 'https://qlab.test/about', 'own_site', 'Founder')] });
  chk('S … new evidence, and it is assessed afresh', row(Q).status === 'qualified', row(Q).status_reason);

  /* research confidence is the WEAKEST claim a draft makes */
  one(`insert into growth_outbound.drafts (id, prospect_id, subject, body_text, claims) values ('30000000-0000-0000-0000-000000000003', '${Q}', 'Hi', 'Hi Quinn',
        jsonb_build_array(jsonb_build_object('text', 'your totals model', 'evidence_id', ${evId(Q, 'project')}),
                          jsonb_build_object('text', 'your title', 'evidence_id', ${evId(Q, 'job_title')})));
       ${SEED.evaluate(Q)}`);
  chk('S a draft citing one strong claim and one single-source claim is only as sure as the weaker (0.70): needs_research',
    +row(Q).research_confidence === 0.7 && row(Q).status === 'needs_research' && /research 0.7000 < 0.85/.test(row(Q).status_reason), row(Q));
  one(`update growth_outbound.drafts set claims = jsonb_build_array(jsonb_build_object('text', 'their ratings', 'evidence_id', ${evId(A, 'project')}))
        where id = '30000000-0000-0000-0000-000000000003'; ${SEED.evaluate(Q)}`);
  chk('S a claim citing someone else\'s evidence supports nothing', +row(Q).research_confidence === 0 && row(Q).warnings.includes('unsupported_claim'));
  one(`update growth_outbound.drafts set claims = '[]' where id = '30000000-0000-0000-0000-000000000003'; ${SEED.evaluate(Q)}`);
  chk('S a draft that cites nothing is not personalised research', +row(Q).research_confidence === 0 && row(Q).warnings.includes('draft_cites_no_evidence'));
  one(`update growth_outbound.drafts set status = 'cancelled' where id = '30000000-0000-0000-0000-000000000003';`);

  /* an approval the prospect no longer earns is taken back */
  const DQ4 = '30000000-0000-0000-0000-000000000004';
  one(SEED.draft({ id: DQ4, prospect: Q, subject: 'Your NFL totals model', body: 'Hi Quinn' }));
  r = approve(DQ4);
  chk('S (setup) Quinn\'s draft is approved', r.ok === true, r);
  add(Q, { evidence: [E('full_name', 'Quincy Q', 'https://other-directory.test/qq', 'directory', 'Quincy Q')] });
  chk('S a rival name turns up: the prospect needs research again and the approval is withdrawn', row(Q).status === 'needs_research'
    && one(`select status || '|' || coalesce(approved_by::text, 'none') from growth_outbound.drafts where id = '${DQ4}';`) === 'pending_review|none');
  chk('S … and that is on the record', j(db.as(OWNER, `select public.growth_outbound_activity(20, '${Q}');`))
    .some((a) => a.action === 'prospect_evaluated' && a.detail.approvals_revoked === 1));
  db.as(OWNER, `select public.growth_outbound_evidence_supersede(${evId(Q, 'full_name', 'Quincy Q')}, 'not him');`);
  chk('S (setup) cleared again: ready for review', row(Q).status === 'ready_for_review');
  db.as(OWNER, `select public.growth_outbound_settings_update('{"min_fit_score": 95}'::jsonb);`);
  r = approve(DQ4);
  chk('S the approve door reads a FRESH assessment: a raised bar applies at once', r.ok === false && r.reason === 'below_gate'
    && r.gates.some((g) => /fit/.test(g)) && row(Q).status === 'needs_research', r);
  db.as(OWNER, `select public.growth_outbound_settings_update('{"min_fit_score": 80}'::jsonb);`);

  /* ══ W. ONE PERSON, ONE STEP ══════════════════════════════════════════ */
  one(`select growth_outbound.set_webhook_secret('whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw');`);
  r = j(db.as(OWNER, `select public.growth_outbound_settings_update(${lit(JSON.stringify({ postal_address: 'EdgeDesk Sports, 100 Example St, Springfield, IL 62701',
    unsubscribe_url_base: 'https://iattxbkbufslbauoumga.supabase.co/functions/v1/', test_inbox: 'owner-test@edgedesk.test', test_mode: false, confirm_live: true }))}::jsonb);`));
  one(SEED.liveReady());   // (Phase 13) the opt-out endpoint checked, the webhook proven
  r = Object.assign({}, r, { settings: j(db.as(OWNER, `select public.growth_outbound_settings();`)) });
  chk('W (setup) live, compliance configured', r.ok === true && r.settings.test_mode === false && r.settings.send_blockers.length === 0, r);
  const w1 = up(strongPayload({ name: 'Riley Stone', org: 'Stone Analytics', email: 'riley@stone.test', d: 'stone.test', h: 'rileystone', project: 'CFB win totals' }));
  const w2 = up(strongPayload({ name: 'Riley Stone', org: 'Stone Analytics', email: 'riley.stone@mailbox.test', d: 'rileystone-personal.test', h: 'rstone2', project: 'CFB win totals' }));
  chk('W the same name and organization at another address is flagged, not merged', w2.ok && w2.created && w2.possible_duplicates.includes(w1.prospect_id), w2);
  one(SEED.draft({ id: '40000000-0000-0000-0000-000000000001', prospect: w1.prospect_id, subject: 'CFB win totals', body: 'Hi Riley' })
    + SEED.draft({ id: '40000000-0000-0000-0000-000000000002', prospect: w2.prospect_id, subject: 'CFB win totals', body: 'Hi Riley' }));
  r = approve('40000000-0000-0000-0000-000000000001');
  one(send({ draft: '40000000-0000-0000-0000-000000000001', to: 'riley@stone.test', key: 'w-1' }));
  chk('W (setup) the first Riley receives step 1', r.ok === true && count('sends', `idempotency_key = 'w-1'`) === 1);
  r = approve('40000000-0000-0000-0000-000000000002');
  e = db.mustFail(() => one(send({ draft: '40000000-0000-0000-0000-000000000002', to: 'riley.stone@mailbox.test', key: 'w-2' })));
  chk('W the same person at another address does not get step 1 again', r.ok === true && !!e && /same name and organization already received step 1/.test(e), e);
  const DA = '40000000-0000-0000-0000-000000000003';
  one(SEED.draft({ id: DA, prospect: A, subject: 'Your ratings', body: 'Hi Pat' }));
  r = approve(DA);
  db.as(OWNER, `select public.growth_outbound_prospect_set_status('${A}', 'needs_research', 'double-check');`);
  e = db.mustFail(() => one(send({ draft: DA, to: 'pat@cfbnumbers.test', key: 'w-3' })));
  chk('W a prospect sent back for research is not sent to (its approval was cancelled)', r.ok === true && !!e && /approved draft/.test(e), e);

  /* ══ L. LOOKUP ════════════════════════════════════════════════════════ */
  r = j(db.as(OWNER, `select public.growth_outbound_identity_lookup('https://m.twitter.com/PatAnalyst?ref=abc');`));
  chk('L a tagged mobile URL finds Pat', r.ok && r.canonical === 'https://x.com/PatAnalyst' && r.keys[0].matches[0].prospect_id === A, r);
  r = j(db.as(OWNER, `select public.growth_outbound_identity_lookup(' Pat@CFBNumbers.test ');`));
  chk('L … so does the address in any casing', r.ok && r.keys[0].value === 'pat@cfbnumbers.test' && r.keys[0].matches.length === 1);
  r = j(db.as(OWNER, `select public.growth_outbound_identity_lookup('anyone@blocked.test');`));
  chk('L a suppressed address says so before anyone researches it', r.ok && r.suppressed === true && r.keys[0].matches.length === 0, r);
  r = j(db.as(OWNER, `select public.growth_outbound_identity_lookup('hello');`));
  chk('L anything else is refused', r.ok === false && r.reason === 'not_an_email_or_url');
  e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_identity_lookup('pat@cfbnumbers.test');`));
  chk('L an affiliate admin who is not an owner cannot ask', !!e && /outbound owner only/.test(e), e);
  e = db.mustFail(() => db.as(ADMIN, `select public.growth_outbound_prospect_upsert('{"email": "x@y.test"}'::jsonb);`));
  chk('L … or add anyone', !!e && /outbound owner only/.test(e), e);

  /* ══ the record ═══════════════════════════════════════════════════════ */
  const acts = new Set(j(db.as(OWNER, `select public.growth_outbound_activity(500, null);`)).map((a) => a.action));
  chk('every research action is on the record', ['prospect_created', 'prospect_researched', 'evidence_superseded', 'identifier_released', 'prospect_evaluated']
    .every((a) => acts.has(a)), [...acts]);
  const rep = db.applyFileAtomic(FILE);
  chk('the file re-runs over all of this data, every report row ok', !/CHECK THIS/.test(rep), rep.split('\n').filter((l) => /CHECK THIS/.test(l)));
  chk('… and re-evaluating everything changes no settled answer', row(M).first_name === 'Mia' && +row(M).identity_confidence === 0.91 && row(C).status === 'suppressed');
} catch (err) {
  chk('the suite ran without an unexpected error', false, String(err.sqlMessage || err.message).slice(0, 1500));
} finally {
  db.stop();
}
process.exit(T.done());
