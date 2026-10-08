#!/usr/bin/env node
/* ===========================================================================
   THE PAGE AN OUTBOUND EMAIL LINKS TO (growth_outbound.landing_for, 2026-10),
   on a real PostgreSQL after the whole outbound chain.

     A  each kind of prospect gets the page that fits what their record says,
        with the reason in words; nothing specific → the owner's default
     B  the owner's switch: landing_by_interest off → cta_url for everyone,
        and the settings door accepts the switch
     C  the draft context hands the engine the landing and its reason
     D  the words the template writes around each landing pass the database's
        own content checks (draft_lint, uncited_details) — a free calculator
        is described as one, and only EdgeDesk links appear
     E  at send time tag_links stamps the campaign on every landing page

   Run: node tools/growth/outbound_landing_sql.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const PG = require(path.join(__dirname, '..', 'personal', '_pg.js'));

const T = PG.kit('outbound landing SQL');
const chk = T.chk;
const FILE = path.join(PG.ROOT, 'supabase', 'growth_outbound.sql');
const SRC = fs.readFileSync(FILE, 'utf8');

chk('static: the settings door lists the switch', /'attribution_links',\s*'landing_by_interest'\]/.test(SRC));
chk('static: landing_for is not a client door', /revoke all on function growth_outbound\.landing_for\(uuid\) from public;/.test(SRC));

const db = PG.start('oblanding');
if (db.skip) { console.log('SKIP | outbound landing SQL | ' + db.skip); process.exit(T.done()); }
const J = (s) => JSON.parse(s);
const P = {
  cfb: '00000000-0000-0000-0000-0000000001a1', nfl: '00000000-0000-0000-0000-0000000001a2', both: '00000000-0000-0000-0000-0000000001a3',
  quant: '00000000-0000-0000-0000-0000000001a4', props: '00000000-0000-0000-0000-0000000001a5', nl: '00000000-0000-0000-0000-0000000001a6',
  part: '00000000-0000-0000-0000-0000000001a7', other: '00000000-0000-0000-0000-0000000001a8', fan: '00000000-0000-0000-0000-0000000001a9'
};
const land = (id) => J(db.sql(`select growth_outbound.landing_for('${id}');`));

try {
  ['billing.sql', 'stripe_webhook.sql', 'referral_codes.sql', 'personal_research.sql', 'affiliates.sql', 'growth.sql']
    .forEach((f) => db.applyFileAtomic(path.join(PG.ROOT, 'supabase', f)));
  let rep = db.applyFileAtomic(FILE);
  chk('the outbound migration applies', true);
  rep = db.applyFileAtomic(FILE);
  chk('…and again', !/CHECK THIS/.test(rep.split('\n').filter((l) => /landing/i.test(l)).join('\n')));
  db.sql(`insert into growth_outbound.prospects (id, email, prospect_type, campaign_type, sports_focus) values
    ('${P.cfb}', 'cfb@example.com', 'cfb_analyst', 'customer', '{CFB}'),
    ('${P.nfl}', 'nfl@example.com', 'nfl_analyst', 'customer', '{NFL}'),
    ('${P.both}', 'both@example.com', 'football_analyst', 'customer', '{CFB,NFL}'),
    ('${P.quant}', 'quant@example.com', 'quant_researcher', 'customer', '{NFL}'),
    ('${P.props}', 'props@example.com', 'props_analyst', 'customer', '{NFL}'),
    ('${P.nl}', 'nl@example.com', 'newsletter_writer', 'customer', '{CFB}'),
    ('${P.part}', 'part@example.com', 'other', 'partnership', '{}'),
    ('${P.other}', 'other@example.com', 'other', 'customer', '{}'),
    ('${P.fan}', 'fan@example.com', 'other', 'customer', '{"COLLEGE FOOTBALL"}');`);

  /* ══ A ══ */
  const want = {
    cfb: ['https://edgedesksports.com/articles/college-football/', 'cfb_research'],
    nfl: ['https://edgedesksports.com/articles/nfl/', 'nfl_research'],
    both: ['https://edgedesksports.com/articles/', 'football_research'],
    quant: ['https://edgedesksports.com/tools/fair-odds-calculator/', 'fair_odds_tool'],
    props: ['https://edgedesksports.com/tools/no-vig-calculator/', 'no_vig_tool'],
    nl: ['https://edgedesksports.com/partners/', 'partnership'],
    part: ['https://edgedesksports.com/partners/', 'partnership'],
    fan: ['https://edgedesksports.com/articles/college-football/', 'cfb_research'],
    other: ['https://edgedesksports.com/', 'default']
  };
  Object.keys(want).forEach((k) => {
    const l = land(P[k]);
    chk('A ' + k + ' → ' + want[k][0].replace('https://edgedesksports.com', ''), l.url === want[k][0] && l.key === want[k][1] && typeof l.reason === 'string' && l.reason.length > 10, l);
  });
  chk('A a modeller who covers the NFL still gets the calculator: the type outranks the sport', land(P.quant).key === 'fair_odds_tool');
  chk('A a newsletter writer is a partnership, whatever they cover', land(P.nl).key === 'partnership');

  /* ══ B ══ */
  db.sql(`update growth_outbound.settings set landing_by_interest = false, cta_url = 'https://edgedesksports.com/?from=default' where id = 1;`);
  chk('B off: every prospect gets the owner\'s default link', Object.keys(P).every((k) => land(P[k]).url === 'https://edgedesksports.com/?from=default' && land(P[k]).key === 'default'));
  db.sql(`update growth_outbound.settings set landing_by_interest = true, cta_url = 'https://edgedesksports.com/' where id = 1;`);
  chk('B on again', land(P.cfb).key === 'cfb_research');

  /* ══ C ══ the context the engine drafts from (the engine's own door) */
  const ctxSrc = SRC.slice(SRC.indexOf('create or replace function public.growth_outbound_draft_context'), SRC.indexOf('create or replace function public.growth_outbound_draft_propose'));
  chk('C the draft context carries landing_for(p.id)', /'landing', growth_outbound\.landing_for\(p\.id\)/.test(ctxSrc));

  /* ══ D ══ the template's words around each landing, through the database's checks */
  const DRAFT = fs.readFileSync(path.join(PG.ROOT, 'supabase', 'functions', 'growth_outbound_draft', 'index.ts'), 'utf8');
  const whatMap = {};
  (DRAFT.match(/(\w+): '([^']+)'/g) || []).forEach((m) => { const x = /(\w+): '([^']+)'/.exec(m); whatMap[x[1]] = x[2]; });
  ['fair_odds_tool', 'no_vig_tool', 'cfb_research', 'nfl_research', 'football_research', 'partnership'].forEach((k) => {
    const what = whatMap[k];
    const url = want[{ fair_odds_tool: 'quant', no_vig_tool: 'props', cfb_research: 'cfb', nfl_research: 'nfl', football_research: 'both', partnership: 'part' }[k]][0];
    const body = 'Hi there,\n\nI\'m Davis, and I\'m building EdgeDesk Sports: research for NFL and college football. It\'s research, not picks.\n\n'
      + 'If it would be useful, ' + what + ' is at ' + url + '. The full research has a 7-day free trial, then $49.99/month.\n\nWould it be worth a look?';
    const lint = db.sql(`select coalesce(array_to_string(growth_outbound.draft_lint('EdgeDesk Sports, for your research', ${PG.lit(body)}), ' | '), '');`);
    const unc = db.sql(`select coalesce(array_to_string(growth_outbound.uncited_details(${PG.lit(body)}, 'Davis EdgeDesk Sports'), ' | '), '');`);
    chk('D ' + k + ': the template words pass draft_lint and name nothing from nowhere', what && lint === '' && unc === '', { what, lint, unc });
  });

  /* ══ E ══ */
  const tagged = db.sql(`select growth_outbound.tag_links('see https://edgedesksports.com/tools/no-vig-calculator/.', 'ob_abc123');`);
  chk('E the campaign rides on a tool page, punctuation outside the link',
    tagged === 'see https://edgedesksports.com/tools/no-vig-calculator/?utm_source=outbound&utm_medium=email&utm_campaign=ob_abc123.', tagged);
  const cls = db.sql(`select public.acq_classify(null, 'outbound', 'email', null);`);
  chk('E …and the site classifies that visit as outbound email', cls === 'outbound_email', cls);
} catch (e) {
  chk('the suite reached its end — ' + String(e.message || e).split('\n').slice(0, 4).join(' | '), false);
} finally {
  db.stop();
}
process.exit(T.done());
