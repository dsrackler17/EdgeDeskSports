#!/usr/bin/env node
/* ===========================================================================
   THE UPGRADE'S BROWSER HALF, WITHOUT A BROWSER — Compare My Number, research
   cards, personas, creator offers, trial actions, acquisition and public
   samples, as the pages and the libraries state them.

     1  COMPARE MY NUMBER (EDPersonal.compareNumber): the three numbers and the
        three differences, agreement and difference in words, the measured
        inputs a difference runs through (and honesty when there are none),
        what EdgeDesk knew, and never a verdict on either number.
     2  RESEARCH CARDS (EDShareCard): real current data only, 2-3 drivers,
        "Research, not picks.", edgedesksports.com, a timestamp, no tout
        words; both formats laid out inside the canvas with nothing on the
        footer.
     3  PERSONAS: the five answers are the database's five; every plan keeps
        every section.
     4  THE ONE SOURCE FOR THE OFFER: a creator discount is worded from
        Stripe's record only.
     5  THE AI DESK: "how do my numbers compare" is read from the journal.
     6  WIRING: the app loads the card library in order and carries the new
        actions and hooks; every trial action the page sends is one the
        server accepts; the landing page tracks visits and carries a campaign
        code to checkout; the public sample page and the growth console call
        only their own doors; no tout language anywhere new.

   Run: node tools/personal/growth.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
global.EDResearch = require(path.join(ROOT, 'lib', 'research_core.js'));
const P = require(path.join(ROOT, 'lib', 'edgedesk_personal.js'));
const SC = require(path.join(ROOT, 'lib', 'edgedesk_share_card.js'));
const X = require(path.join(ROOT, 'lib', 'edgedesk_pricing.js'));
const MINE = require(path.join(ROOT, 'supabase', 'functions', 'edgedesk_ai', '_mine.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) pass++; else { fail++; failures.push({ name, detail }); } }

const NOW = Date.now();
function st(o) {
  return P.normalizeState(Object.assign({
    game_key: 'cfb|9001', sport: 'cfb', game_id: '9001', home: 'Florida', away: 'Ole Miss', kickoff_at: new Date(NOW + 864e5).toISOString(),
    projected: true, status: 'RESEARCH', computed_at: new Date(NOW - 20 * 60000).toISOString(),
    fair: { home_line: 1.7, text: 'Ole Miss -1.7', total: 51.5, model_version: 'edgedesk_cfb_p4_v1.0.0' },
    market: { home_line: -2.5, text: 'Florida -2.5', total: 49.5, kind: 'live', book: 'DraftKings', books: 4, captured_at: new Date(NOW - 30 * 60000).toISOString(), stale: false },
    gap: { points: 4.2, toward: 'away' }, win_prob_home: 0.46,
    reliability: { score: 88, grade: 'STRONG', scored: true, main_deduction: 'one QB not confirmed' },
    qb: { home: { name: 'Home QB', confirmed: true }, away: { name: 'Away QB', confirmed: false }, confirmed_both: false },
    injuries: { home: { known: true, out: ['WR One (WR)'], doubtful: [], questionable: [] }, away: { known: false } },
    drivers: [{ text: 'team-strength edge (opponent-adjusted results)', points: 3.1 }, { text: 'quarterback matchup', points: 1.4 }, { text: 'home-field advantage', points: 0.9 }],
    movement: { toward_model: 1.2 }, priority: { eligible: true, rank: 1, score: 71, why_text: 'Model flips the market favorite.' }
  }, o || {}));
}
const VERDICT = /\b(correct|incorrect|wrong|you are right|edgedesk is right|better number|worse number|sharper than|beats edgedesk|smarter)\b/i;
const TOUT = /\b(bet this|locks?|lock of|guaranteed?|smash|must[- ]bet|can'?t lose|best bets?|winning plays?|free money|sure thing|hammer)\b/i;
function allText(r) { return [].concat(r.agrees, r.differs, r.context, r.inputs.map((x) => x.text), r.spread ? r.spread.lines : [], r.total ? r.total.lines : [], [r.note]).join('\n'); }

/* ══ 1. COMPARE MY NUMBER ═════════════════════════════════════════════════ */
const S = st();
chk('a team line becomes a home line: Florida -3.5 is -3.5, Ole Miss -3.5 is +3.5', P.parseTeamLine(S, 'home', '-3.5') === -3.5 && P.parseTeamLine(S, 'away', '-3.5') === 3.5);
chk('PK and a unicode minus are read', P.parseTeamLine(S, 'home', 'PK') === 0 && P.parseTeamLine(S, 'home', '−7') === -7);
chk('nonsense is NaN, not a number', Number.isNaN(P.parseTeamLine(S, 'home', 'minus three')) && Number.isNaN(P.parseLine('3.5.5')));
let r = P.compareNumber(S, { home_line: -3.5, total: 47 });
chk('the three spreads are the reader\'s, EdgeDesk\'s and the market\'s', r.ok && r.spread.mine_text === 'Florida -3.5' && r.spread.edgedesk_text === 'Ole Miss -1.7' && r.spread.market_text === 'Florida -2.5', r.spread);
chk('the three differences, each with its direction', r.spread.mine_vs_edgedesk.pts === 5.2 && r.spread.mine_vs_edgedesk.team === 'Florida'
  && r.spread.mine_vs_market.pts === 1 && r.spread.edgedesk_vs_market.pts === 4.2 && r.spread.edgedesk_vs_market.team === 'Ole Miss', r.spread);
chk('the totals and their three differences', r.total.mine_vs_edgedesk === -4.5 && r.total.mine_vs_market === -2.5 && r.total.edgedesk_vs_market === 2 && r.total.lines.length === 3, r.total);
chk('a flipped favourite is named as a difference', r.differs.some((t) => /You make Florida the favourite; EdgeDesk makes Ole Miss the favourite/.test(t)));
chk('which side of the market each number sits on', r.differs.some((t) => /Your number sits on the Florida side of the market \(Florida -2\.5\); EdgeDesk’s sits on the Ole Miss side/.test(t)));
chk('a key number between the two numbers is named', r.differs.some((t) => /key number 3/.test(t)));
chk('the difference is traced through EdgeDesk\'s measured drivers, with their points', r.inputs[0].kind === 'drivers' && /\+3\.1 team-strength edge/.test(r.inputs[0].text) && /5\.2 pts more favourable to Ole Miss/.test(r.inputs[0].text), r.inputs);
chk('and says honestly when the listed drivers do not cover it all', r.inputs.some((x) => x.kind === 'drivers_short' && /5\.4 of the 5\.2|of the 5\.2 pts/.test(x.text)) || r.inputs.some((x) => x.kind === 'drivers_sum'), r.inputs);
chk('a total difference is not pinned on an input EdgeDesk does not itemise', r.inputs.some((x) => x.kind === 'total' && /does not itemise its total/.test(x.text)));
chk('what EdgeDesk knew: the unconfirmed QB, the missing report, reliability, movement', /Away QB at quarterback for Ole Miss, not yet confirmed/.test(r.context.join(' '))
  && /no availability report on file for Ole Miss/.test(r.context.join(' ')) && /reliability for this game is 88/.test(r.context.join(' ')) && /toward EdgeDesk’s number/.test(r.context.join(' ')), r.context);
chk('neither number is declared right', !VERDICT.test(allText(r)) && /Neither number is declared right/.test(r.note), allText(r).match(VERDICT));
chk('no tout language in any compare sentence', !TOUT.test(allText(r)));
r = P.compareNumber(S, { home_line: 1.5 });
chk('within half a point: agreement, and nothing to trace', r.agrees.some((t) => /within half a point/.test(t)) && r.agrees.some((t) => /both make Ole Miss the favourite/.test(t)) && r.inputs[0].kind === 'none', r);
chk('both numbers on the same side of the market is agreement', r.agrees.some((t) => /Both numbers sit on the Ole Miss side of the market/.test(t)));
r = P.compareNumber(S, { home_line: 4.5 });
chk('a reader further toward EdgeDesk\'s favourite than EdgeDesk: its inputs do not go that far, and it says so', r.inputs[0].kind === 'beyond'
  && /more favourable to Ole Miss than EdgeDesk’s/.test(r.inputs[0].text) && /total 5\.4 pts/.test(r.inputs[0].text), r.inputs);
r = P.compareNumber(st({ game_key: 'nfl|2026_05_BUF_MIA', sport: 'nfl', drivers: [], reliability: { score: null, scored: false } }), { home_line: -6 });
chk('with no itemised drivers (the NFL), the difference is not attributed to anything', r.inputs[0].kind === 'unitemised' && /cannot be traced/.test(r.inputs[0].text) && /NFL model publishes no reliability/.test(r.context.join(' ')), r.inputs);
r = P.compareNumber(st({ market: { home_line: -2.5, stale: true } }), { home_line: -3 });
chk('a stale market is left out of the comparison and the reader is told', r.spread.market_home === null && /stale/.test(r.context.join(' ')));
chk('no number at all is refused with a reason', P.compareNumber(S, {}).ok === false && /enter your fair spread/.test(P.compareNumber(S, {}).reasons[0]));
chk('an impossible number is refused', P.compareNumber(S, { home_line: 250 }).ok === false && P.validateJournal({ game_key: 'cfb|1', decision: 'researching', my_total: -5 }).ok === false);
chk('no research state, no comparison', P.compareNumber(null, { home_line: -3 }).ok === false);

/* numbers against the close */
const E = [
  { my_home_line: -3.5, snap_fair_home_line: 1.7, snap_market_home_line: -2.5, close_home_line: -3 },
  { my_home_line: -7, snap_fair_home_line: -6.5, snap_market_home_line: -7, close_home_line: -6.5 },
  { my_total: 47, snap_fair_total: 51.5, close_total: 49.5 },
  { my_home_line: 2 } ];
const vc = P.numbersVsClose(E[0]);
chk('each number is measured from the close as a distance', vc.mine === 0.5 && vc.edgedesk === 4.7 && vc.market_then === 0.5, vc);
const ns = P.numbersSummary(E);
chk('the summary counts numbers, spreads, totals and the ones with a close', ns.n === 4 && ns.spreads === 3 && ns.totals === 1 && ns.graded === 2, ns);
chk('nearer-the-close counts are counts, with a small-sample note', ns.mine_nearer === 1 && ns.edgedesk_nearer === 1 && /Small sample/.test(ns.sample_note), ns);

/* ══ 2. RESEARCH CARDS ════════════════════════════════════════════════════ */
let c = SC.content(S, { now: NOW });
chk('a card is made from a current research state', c.ok === true, c);
const C = c.content;
chk('it carries the matchup, fair line, market line, gap and reliability', C.matchup === 'Ole Miss @ Florida' && C.fair === 'Ole Miss -1.7' && C.market === 'Florida -2.5' && C.gap === '4.2 pts' && C.reliability === '88', C);
chk('2-3 concise research drivers from the engine\'s own terms', C.drivers.length >= 2 && C.drivers.length <= 3 && /^Ole Miss: \+3\.1 pts team-strength edge/.test(C.drivers[0]) && C.drivers.every((d) => d.length <= 110), C.drivers);
chk('a timestamp, "Research, not picks." and edgedesksports.com', /EdgeDesk research state · \w{3} \d+, \d{4} · \d{2}:\d{2} UTC/.test(C.timestamp) && C.tagline === 'Research, not picks.' && C.site === 'edgedesksports.com', C);
chk('the market line names its book and capture time', /DraftKings · captured/.test(C.market_meta));
chk('the gap says which side EdgeDesk\'s number favours, read from the two lines', SC.content(st({ gap: { points: 4.2 } }), { now: NOW }).content.gap_meta === 'EdgeDesk more favourable to Ole Miss'
  && SC.content(st({ fair: { home_line: -2.5, text: 'Florida -2.5' }, gap: { points: 0 } }), { now: NOW }).content.gap_meta === 'EdgeDesk and the market agree');
chk('no tout or outcome language anywhere on the card', !TOUT.test(JSON.stringify(C)) && !/\b(win(s|ner)?|cover(s)?|profit|units?)\b/i.test(JSON.stringify(C).replace(/"brand":"EdgeDesk"/, '')), JSON.stringify(C).match(TOUT));
chk('the card records the numbers it printed', c.numbers.fair_home_line === 1.7 && c.numbers.market_home_line === -2.5 && c.numbers.gap_pts === 4.2 && c.numbers.reliability_score === 88 && /^sc1-/.test(c.hash));
chk('no card without a research state', SC.content(null).reason === 'no_state');
chk('no card without a projection', SC.content(st({ projected: false }), { now: NOW }).reason === 'no_projection');
chk('no card after kickoff', SC.content(st({ kickoff_at: new Date(NOW - 60000).toISOString() }), { now: NOW }).reason === 'started');
chk('no card from a state older than the freshness limit', SC.content(st({ computed_at: new Date(NOW - 7 * 36e5).toISOString() }), { now: NOW }).reason === 'stale_state');
c = SC.content(st({ market: { home_line: -2.5, stale: true } }), { now: NOW });
chk('a stale market is printed as missing, and no gap is claimed', c.ok && c.content.market === 'No current market quote' && c.content.gap === '—' && c.numbers.market_home_line === null, c.content);
c = SC.content(st({ drivers: [], sport: 'nfl', game_key: 'nfl|x', reliability: { score: null, scored: false } }), { now: NOW });
chk('without itemised drivers, the state\'s own research reasons fill in', c.ok && c.content.drivers.length >= 1 && c.content.reliability === 'Not scored' && /NFL model publishes no reliability/.test(c.content.reliability_meta), c.content);
chk('a tout word in the data refuses the card', SC.content(st({ home: 'Lock City' }), { now: NOW }).reason === 'copy_rule');
chk('two formats sized for sharing: X 1600×900 and square 1080×1080', SC.FORMATS.x_landscape.w === 1600 && SC.FORMATS.x_landscape.h === 900 && SC.FORMATS.square.w === 1080 && SC.FORMATS.square.h === 1080);
const LONG = Object.assign({}, C, { matchup: 'Jacksonville Jaguars @ San Francisco 49ers', drivers: ['Jacksonville Jaguars: +3.1 pts team-strength edge (opponent-adjusted results) and a long tail of words', 'A second rather long driver sentence about the quarterback matchup and home field', 'A third long driver about travel burden, schedule stress and the conference-strength edge'] });
['x_landscape', 'square'].forEach((f) => {
  const L = SC.layout(LONG, f), W = SC.FORMATS[f].w, H = SC.FORMATS[f].h;
  const texts = L.ops.filter((o) => o.type === 'text');
  const inside = texts.every((o) => o.y > 0 && o.y < H && o.x >= 0 && o.x <= W);
  const foot = texts.filter((o) => /Research, not picks|research state ·/.test(o.text));
  const body = texts.filter((o) => foot.indexOf(o) < 0);
  chk(f + ': every piece of text is inside the canvas', inside);
  chk(f + ': the footer carries the tagline, the site and the time', foot.length === 2 && foot.some((o) => /edgedesksports\.com/.test(o.text)));
  chk(f + ': nothing in the body reaches the footer', Math.max.apply(null, body.map((o) => o.y)) < Math.min.apply(null, foot.map((o) => o.y)) - 30, { body: Math.max.apply(null, body.map((o) => o.y)), foot: foot.map((o) => o.y) });
});
chk('the post text carries the same numbers and nothing else', SC.shareText(C) === 'EdgeDesk research — Ole Miss @ Florida: fair Ole Miss -1.7, market Florida -2.5 (4.2 pts gap), reliability 88. Research, not picks. edgedesksports.com', SC.shareText(C));

/* ══ 3. PERSONAS ══════════════════════════════════════════════════════════ */
const PR = read('supabase/personal_research.sql');
const sqlPersonas = ((PR.match(/persona in \(([^)]+)\)/) || [])[1] || '').split(',').map((x) => x.trim().replace(/'/g, '')).sort();
chk('the five personas are the database\'s five', JSON.stringify(P.PERSONAS.map((p) => p.key).sort()) === JSON.stringify(sqlPersonas), sqlPersonas);
chk('the five labels are the brief\'s', ['I build my own numbers', 'I research games before betting', 'I compare markets and prices', 'I create betting content', 'I want to improve my process']
  .every((l) => P.PERSONAS.some((p) => p.label === l)));
[null, 'model_builder', 'researcher', 'market_comparer', 'creator', 'process_improver'].forEach((k) => {
  const plan = P.personaPlan(k), all = plan.top.concat(plan.bottom).sort();
  chk('persona ' + k + ': every section is still on the desk', JSON.stringify(all) === JSON.stringify(P.DESK_SECTIONS.slice().sort()) && new Set(plan.top.concat(plan.bottom)).size === P.DESK_SECTIONS.length, plan);
});
chk('a model builder sees Compare My Number first', P.personaPlan('model_builder').top[0] === 'compare');
chk('a researcher sees the Top 5 first', P.personaPlan('researcher').top[0] === 'top5');
chk('a creator sees research cards first', P.personaPlan('creator').top[0] === 'share');
chk('no persona keeps today\'s order: Top 5, watchlist, then changes and decision quality', JSON.stringify(P.personaPlan(null).top) === '["top5","watchlist"]' && P.personaPlan(null).bottom.slice(0, 2).join() === 'changes,quality');

/* ══ 4. THE OFFER ═════════════════════════════════════════════════════════ */
chk('a creator discount is worded from Stripe\'s record', X.discountLine({ percent_off: 20, duration: 'repeating', duration_in_months: 3 }, 'BIGGSFALL') === 'Code BIGGSFALL: 20% off your first 3 months after the free trial, applied by Stripe at checkout.');
chk('an amount off, once', X.discountLine({ amount_off_cents: 1000, currency: 'USD', duration: 'once' }) === '$10.00 off your first payment after the free trial, applied by Stripe at checkout.');
chk('no Stripe record, no discount line', X.discountLine(null, 'X') === null && X.discountLine({ percent_off: 20 }) === null);
chk('the trial line itself never changes', X.CTA_LINE === '7-day free trial. $79.99/month after trial. Cancel anytime.');

/* ══ 5. THE AI DESK ═══════════════════════════════════════════════════════ */
chk('"how do my numbers compare with EdgeDesk" is the reader\'s own numbers', MINE.classify('How do my numbers compare with EdgeDesk?') === 'MY_NUMBERS' && P.PERSONAL_Q.test('How do my numbers compare with EdgeDesk?'));
chk('a betting question is not', MINE.classify('Is Maryland -2.5 worth betting?') === null);
const J = [{ entry_id: 'a', home: 'Florida', away: 'Ole Miss', created_at: new Date(NOW - 864e5).toISOString(), decision: 'researching', my_home_line: -3.5, snap_fair_home_line: 1.7, snap_market_home_line: -2.5, close_home_line: -3 },
  { entry_id: 'b', home: 'Texas Tech', away: 'Baylor', created_at: new Date(NOW - 2 * 864e5).toISOString(), decision: 'leaned', my_total: 55, my_home_line: null, snap_fair_home_line: -7.1 },
  { entry_id: 'c', home: 'X', away: 'Y', decision: 'wagered', market_type: 'spread', selection: 'home', line: -3 }];
const ans = MINE.answer('MY_NUMBERS', { journal: J }, { now: NOW });
chk('the AI answer counts the reader\'s numbers and sets each beside EdgeDesk\'s and the close', /You have saved 2 numbers of your own \(1 spread, 1 total\)/.test(ans.text) && /yours Florida -3\.5, EdgeDesk then Ole Miss -1\.7/.test(ans.text) && /close Florida -3\.0 \(yours 0\.5 from it, EdgeDesk’s 4\.7\)|close Florida -3 \(yours 0\.5/.test(ans.text), ans.text);
chk('and declares neither number right', ans.missing.some((m) => /Neither number is declared right/.test(m)) && !VERDICT.test(ans.text));
chk('with no saved number it says how to make one', /Compare my number/.test(MINE.answer('MY_NUMBERS', { journal: [J[2]] }, { now: NOW }).text));

/* ══ 6. WIRING ════════════════════════════════════════════════════════════ */
const APP = read('app.html'), UI = read('lib/edgedesk_personal_ui.js'), IDX = read('index.html'), GROWTH = read('supabase/growth.sql');
const SAMPLE = read('research/sample/index.html'), GADMIN = read('admin/growth/index.html'), AADMIN = read('admin/affiliates/index.html');
const at = (s) => APP.indexOf(s);
chk('the card library loads after the personal library and before the UI module', at('/lib/edgedesk_share_card.js') > at('/lib/edgedesk_personal.js') && at('/lib/edgedesk_share_card.js') < at('/lib/edgedesk_personal_ui.js'));
chk('both game cards carry Compare my number and Share card', /function fbMineActs\([\s\S]{0,900}EDMine\.compareOpen[\s\S]{0,300}EDMine\.shareOpen/.test(APP));
chk('opening a game records a matchup view', /window\.fbOpenGame=function\(sport,gid\)\{\s*gid=String\(gid\);\s*try\{if\(window\.EDMine&&window\.EDMine\.trackGame\)/.test(APP) && /window\.EDMine\.trackGame\('p4',gid\)/.test(APP));
chk('a question to the AI desk records AI research used', (APP.match(/window\.EDMine\.track\('ai_research_used'\)/g) || []).length === 2);
const edpKinds = ((GROWTH.match(/p_kind not in \(([^)]+)\)/) || [])[1] || '').split(',').map((x) => x.trim().replace(/'/g, ''));
const sent = [...UI.matchAll(/M\.track\('([a-z_0-9]+)'/g)].map((m) => m[1]).concat([...APP.matchAll(/EDMine\.track\('([a-z_0-9]+)'/g)].map((m) => m[1]), ['matchup_viewed']);
chk('every trial action the page sends is one the server accepts from a client', sent.length >= 5 && sent.every((k) => edpKinds.indexOf(k) >= 0), { sent, edpKinds });
chk('the page never sends an action the database records itself (it cannot be forged)', !sent.some((k) => ['watchlist_save', 'journal_entry_created', 'alert_configured', 'share_card_generated'].indexOf(k) >= 0));
chk('the page never reads activation back', !/user_activation|activation_events|growth_admin/.test(UI + APP.slice(at('function fbMineActs'), at('function fbMineActs') + 2000)));
chk('the desk is ordered by the persona plan', /P\.personaPlan\(S\.prefs && S\.prefs\.persona\)/.test(UI) && /plan\.top\.map\(sectionHTML\)/.test(UI) && /plan\.bottom\.map\(sectionHTML\)/.test(UI));
chk('onboarding asks the persona question first, of six steps', /if \(step === 1\) body = '<h3>What best describes how you research\?<\/h3>/.test(UI) && /var ONB_LAST = 6;/.test(UI));
chk('the persona is saved with the preferences', /var row = \{ persona: ONB\.persona \|\| null,/.test(UI));
chk('the landing page records visits and claims them after signup', /rpc\/acq_track_visit/.test(IDX) && /affTrackClick\(\); acqTrackVisit\(\);/.test(IDX) && /affClaim\(token\); acqClaim\(token\);/.test(IDX));
chk('the landing page keeps the partner credit rule it had', /first\.organic/.test(IDX) && /if\(hasSignal && \(!first \|\| first\.organic\)\)/.test(IDX));
chk('a campaign code travels to Stripe checkout, and a discount is shown only from Stripe\'s record', /prefilled_promo_code=/.test(IDX) && /EDPricing\.discountLine\(o\.discount,o\.code\)/.test(IDX) && /id="edOffer" hidden/.test(IDX));
chk('the public sample page reads only the public door and the visit door', /rpc\('public_sample_research'/.test(SAMPLE) && /rpc\('public_sample_list'/.test(SAMPLE) && /rpc\('acq_track_visit'/.test(SAMPLE)
  && !/game_research_state\?|research_journal|user_preferences/.test(SAMPLE));
chk('it shows the fair line, the market, reliability, the evidence and the method', /EdgeDesk fair line/.test(SAMPLE) && /<i>Market<\/i>/.test(SAMPLE) && /<i>Reliability<\/i>/.test(SAMPLE) && /Key matchup evidence/.test(SAMPLE) && /How EdgeDesk builds this/.test(SAMPLE));
chk('its CTA is "Research the full board" with the whole offer', /Research the full board/.test(SAMPLE) && /data-ed-price="cta"/.test(SAMPLE) && /X\.CTA_LINE/.test(SAMPLE) && /\/lib\/edgedesk_pricing\.js/.test(SAMPLE));
chk('it carries a partner code on to the landing page', /CTA_HREF = '\/' \+ \(\(REF \|\| UTM\.length\)/.test(SAMPLE));
chk('the growth console calls only admin doors', [...GADMIN.matchAll(/rpc\('([a-z_]+)'/g)].every((m) => /^growth_admin_/.test(m[1])));
chk('the partner console creates, edits and switches campaigns', /affiliate_admin_upsert_campaign/.test(AADMIN) && /affiliate_admin_set_campaign_active/.test(AADMIN) && /Stripe is the source of truth for the discount/.test(AADMIN));
function strings(src) {
  const out = [];
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/mg, '');
  const rx = /'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"/g;
  let m; while ((m = rx.exec(code))) out.push(m[1] != null ? m[1] : m[2]);
  return out;
}
const NEW = { 'lib/edgedesk_share_card.js': read('lib/edgedesk_share_card.js'), 'lib/edgedesk_personal_ui.js': UI, 'research/sample/index.html': SAMPLE,
  'admin/growth/index.html': GADMIN, 'supabase/functions/edgedesk_ai/_mine.js': read('supabase/functions/edgedesk_ai/_mine.js') };
Object.keys(NEW).forEach((f) => {
  const bad = strings(NEW[f]).filter((t) => TOUT.test(t) && !/never use the words/.test(t));
  chk('no tout language in ' + f, bad.length === 0, bad);
});
chk('no guaranteed-outcome language on the public sample page', !/guarantee|can'?t lose|sure thing|will win|will cover/i.test(SAMPLE.replace(/promise of any outcome/, '')));

failures.forEach((f) => console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 500) : '')));
console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + 'growth (compare, cards, personas, offers, tracking) — ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
