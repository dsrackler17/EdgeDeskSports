#!/usr/bin/env node
/* ===========================================================================
   THE STRUCTURED ANSWER, AS THE PANEL RENDERS IT.

   The chat panel's structured-answer renderers are sliced out of the real
   app.html and run in a VM with the same helpers the page gives them. Every
   assertion is about the HTML a subscriber would see: the label chip, the
   model-versus-market cells with both timestamps and freshness badges, the
   price discipline line, the confidence split, the sources table, the
   critic's findings, the feedback controls — and that a five-section answer
   from the function is promoted the same way a four-section one was.

   Run: node tools/intelligence/structured_ui.test.js
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..', '..');
const APP = fs.readFileSync(path.join(ROOT, 'app.html'), 'utf8');

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function has(name, hay, needle) { chk(name, String(hay).indexOf(needle) >= 0, 'missing: ' + needle); }
function lacks(name, hay, needle) { chk(name, String(hay).indexOf(needle) < 0, 'present: ' + needle); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 300)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

/* ---- slice the real code out of the page ---------------------------------- */
const a = APP.indexOf('  var DESK_SECTIONS = [');
const b = APP.indexOf('  /* WHICH READ THE PANEL LEADS WITH.');
chk('the structured renderers are in app.html', a > 0 && b > a, { a, b });
const src = APP.slice(a, b);
has('the fifth Desk heading is registered', src, "key:'sides'");
has('a label chip renderer exists', src, 'function structuredLabelHTML');
has('a panels renderer exists', src, 'function structuredPanelsHTML');
has('freshness badges exist', src, 'function freshBadge');
has('the feedback recorder exists', src, 'function recordFeedback');
has('the label chip is rendered in the matchup turn', APP, 'var lede=structuredLabelHTML(d)+');
has('the panels are rendered under the research card', APP, '+structuredPanelsHTML(d)\n');
has('feedback is exposed on EDAI', APP, 'feedback: recordFeedback');
has('the CSS for the structured answer exists', APP, '.dk-structured{');
has('the grid stacks at phone width', APP, '@media (max-width:640px){.dk-grid{grid-template-columns:repeat(2,minmax(0,1fr))}}');

const ctx = {
  esc: (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
  mdToHtml: (s) => '<p>' + String(s) + '</p>',
  document: { querySelector: () => null },
  localStorage: { setItem: () => {} },
  console,
};
vm.createContext(ctx);
vm.runInContext(src + '\nthis.DESK_SECTIONS=DESK_SECTIONS;this.structuredLabelHTML=structuredLabelHTML;this.structuredPanelsHTML=structuredPanelsHTML;this.deskProseHTML=deskProseHTML;this.freshBadge=freshBadge;', ctx);

const S = {
  schema: 'edgedesk_structured_answer_v1', prose_status: 'MODEL', packet_id: '401858900:ca8396f3',
  bottom_line: { label: 'PRICE DEPENDENT', decision: 'BET CANDIDATE', sentence: 'PRICE DEPENDENT — the case rests on the price, and ends when the price does.', read: { text: 'x', author: 'model' } },
  model_vs_market: {
    model_line: { home_line: 2.4, total: 58.1, favourite: 'North Texas', version: 'edgedesk_cfb_p4', generated_at: '2026-09-15T22:38:53Z', age: '3 h ago', freshness: 'LIVE', tier: 'RESEARCH' },
    market_line: { market: 'spreads', selection: 'North Texas', handicap: -2.5, price: '-105', book: 'DraftKings', captured_at: '2026-09-16T01:27:20Z', age: '14 min ago', freshness: 'LIVE', actionable: true, fair: 'Pinnacle de-vig fair' },
    consensus: null, gap_points: -0.1, orientation: { favourite_model: 'North Texas', favourite_market: 'North Texas', faults: [] },
    best_price: { american: '-105', book: 'DraftKings', freshness: 'LIVE' },
    movement: { opener_american: '-110', current_american: '-105', price_move_cents: 5, point_move: null, cause: 'UNKNOWN', cause_note: 'EdgeDesk records prices, not handle.' },
  },
  price_discipline: { current_price: '-105 at DraftKings', playable_to: '-112', price_needed: null, break_even_probability: 0.5128, ev_per_unit: 0.0374, ev_basis: 'Expected value measured against the market fair price, NOT produced by EdgeDesk’s model.' },
  confidence: { data: { band: 'LOW', score: 0.36, missing: ['availability for both sides', 'matchup drivers'] }, conclusion: { band: 'MEDIUM', score: 0.6, missing: ['validated probability in this market'] } },
  what_could_break_it: { unknowns: ['Availability for the home side is UNKNOWN.', 'Weather is not on file for this game.'] },
  sources: [
    { source: 'football/fbs/slate.json', kind: 'edgedesk_artifact', observed_at: null, freshness: 'LIVE' },
    { source: 'signals (DraftKings, spreads)', kind: 'market_capture', observed_at: '2026-09-16T01:27:20Z', freshness: 'LIVE' },
    { source: 'cfb.lines (consensus, no book, no timestamp)', kind: 'reference_number', observed_at: null, freshness: 'UNKNOWN' },
  ],
};
const critic = { verdict: 'WARN', findings: [{ code: 'NUMBER_NOT_IN_EVIDENCE', severity: 'WARN', detail: 'numbers with no source in the packet: 37' }] };

const label = ctx.structuredLabelHTML({ structured: S });
has('the label chip names the label', label, 'PRICE DEPENDENT');
has('and its sentence', label, 'ends when the price does');
lacks('an accepted answer is not marked rejected', label, 'rejected');
const rej = ctx.structuredLabelHTML({ structured: Object.assign({}, S, { prose_status: 'REJECTED' }) });
has('a rejected answer says so', rej, 'rejected by EdgeDesk');

const panels = ctx.structuredPanelsHTML({ structured: S, critic });
has('the model cell carries the home line', panels, 'home +2.4');
has('and the total', panels, 'total 58.1');
has('and the model version and age', panels, 'edgedesk_cfb_p4 &middot; 3 h ago'.replace('&middot;', '·'));
has('the market cell carries the price and book', panels, 'North Texas -2.5 at -105');
has('and the capture age', panels, 'captured 14 min ago');
has('with a LIVE badge', panels, 'dk-fresh live">LIVE');
has('the gap cell states both favourites', panels, 'model North Texas · market North Texas');
has('the best captured price is labelled as captured, not best anywhere', panels, 'among the books EdgeDesk captured');
has('price discipline carries playable-to', panels, 'Playable to <b>-112</b>');
has('and break-even', panels, 'Break-even 51.3%');
has('and expected return', panels, 'Expected return 3.74% per unit');
has('and says whose probability it is', panels, 'NOT produced by EdgeDesk');
has('movement is shown with its cause UNKNOWN', panels, 'Cause: <b>UNKNOWN</b>');
has('data confidence is shown', panels, 'Data confidence');
has('conclusion confidence is shown separately', panels, 'Conclusion confidence');
has('and names what is missing', panels, 'missing: availability for both sides');
has('unknowns are listed', panels, 'What EdgeDesk cannot see (2)');
has('sources are listed with observed times', panels, '2026-09-16 01:27Z');
has('an unknown-freshness source gets an UNKNOWN badge', panels, 'dk-fresh unknown">UNKNOWN');
has('the critic findings are disclosed', panels, 'checks on the written read: WARN (1)');
has('with the finding code', panels, 'NUMBER_NOT_IN_EVIDENCE');
has('feedback: helpful', panels, "EDAI.feedback('helpful'");
has('feedback: wrong data', panels, "EDAI.feedback('wrong_data'");
has('the packet id travels with feedback', panels, '401858900:ca8396f3');
chk('no panel is rendered without a structured answer', ctx.structuredPanelsHTML({}) === '' && ctx.structuredLabelHTML({}) === '');

const noMarket = ctx.structuredPanelsHTML({ structured: Object.assign({}, S, { model_vs_market: Object.assign({}, S.model_vs_market, { market_line: null, best_price: null, consensus: { spread_home: 2.5, total: 57.5 } }) }) });
has('with no book price the consensus number is shown as a consensus', noMarket, 'consensus home +2.5');
has('and labelled as having no book and no capture time', noMarket, 'no book, no capture time');

/* ---- Slice 2: the football evidence ---------------------------------------- */
has('the football evidence renderer exists', src, 'function footballEvidenceHTML');
has('and is rendered inside the panels', src, 'h+=footballEvidenceHTML(S);');
has('the CSS for the evidence exists', APP, '.dk-drv{');
has('and for the availability state chip', APP, '.dk-state.official{');
const CFB = Object.assign({}, S, {
  matchup: { home: { team: 'Texas State' }, away: { team: 'North Texas' }, source: 'football/fbs/slate.json',
    ratings: { home: { team: 'Texas State', etsr: 3.7, rank: 22, confidence: 0.405, games_used: 2, freshness: 'LIVE', basis: 'ETSR is a neutral-field rating in points against the league mean.' }, away: { team: 'North Texas', etsr: 6.1, rank: 14, confidence: 0.41, games_used: 2, freshness: 'LIVE' } },
    coaching: { home: { hc: 'G.J. Kinne', tenure_seasons: 4, new_hc: false, unknown: ['oc', 'dc'], freshness: 'LIVE' }, away: { value: null, missing: true, reason: 'coaching continuity not on file' } },
    profiles: { home: { plays_per_game: 75.5, pass_rate: 0.4041, points_for_per_game: 16.5, points_against_per_game: 45, freshness: 'LIVE' }, away: null } },
  why_the_number: { prose: null, model_drivers: { positive: [], negative: [], source: null }, drivers: [
    { id: 'explosive_pass_rate', label: 'Explosive pass rate', attacker: 'North Texas', defender: 'Texas State', favoured: 'North Texas', advantage_z: 1.7, gap_word: 'a wide gap',
      attacker_value: { show: '28.3%', league: '10.4%', show_basis: 'opponent-adjusted' }, defender_value: { show: '7.5%', league: '10.4%' }, reliability: 0.76,
      sentence: 'North Texas explosive pass rate 28.3% (league 10.4%) against Texas State explosive passes allowed 7.5% (league 10.4%) — a wide gap in North Texas’s favour.',
      source: 'football/matchup/metrics.json (from football/rankings/current.json)', observed_at: '2026-09-16T04:04:38.630Z', freshness: 'LIVE' },
    { id: 'pressure_rate', label: 'Pressure rate', attacker: 'Texas State', defender: 'North Texas', favoured: 'Texas State', gap_word: 'a narrow gap', attacker_value: { show: '9.1%', league: '8.0%' }, defender_value: { show: '7.2%', league: '8.0%' }, reliability: 0.5, sentence: 'x', source: 'football/matchup/metrics.json', observed_at: '2026-09-16T04:04:38.630Z', freshness: 'LIVE' },
  ] },
  availability: { home: { state: 'UNKNOWN', sentence: 'No availability record is on file for Texas State. THIS IS UNKNOWN, NOT HEALTHY.', source: 'football/availability/current.json', observed_at: '2026-09-15T21:15:29.273Z', freshness: 'LIVE' },
    away: { value: null, missing: true, reason: 'no availability record for the away side' }, states_note: 'UNKNOWN is not healthy. Only NO_REPORTED_INJURIES means an official report was read and listed nobody.' },
  starters: { home: { position: 'QB', player_name: 'Brad Jackson', status: 'PREVIOUS_GAME', confirmed: false, availability: { state: 'UNKNOWN' }, source: 'cfbfastR-data player_stats — play attribution', retrieved_at: '2026-09-16T01:39:32.535Z', freshness: 'LIVE' },
    away: { value: null, missing: true, reason: 'no projected starter on file for the away side' }, note: 'Only ANNOUNCED with confirmed:true is a confirmed starter.' },
  injuries: { home: null, away: null },
  situation: { rest_days: { home: 14, away: 14 }, weather: { value: { temp_f: 84.2, wind_mph: 11.6, wind_from: 'S', precip_pct: 20, text: 'partly cloudy' }, source: 'football/venues/forecasts.json (open-meteo)', observed_at: '2026-09-16T00:10:00Z', freshness: 'LIVE' }, travel: { value: null, missing: true, reason: 'travel distance and time zone are not computed' }, surface: null, roof: null, division_game: null },
});
const fb = ctx.structuredPanelsHTML({ structured: CFB });
has('the drivers section counts the drivers', fb, 'Matchup drivers (2)');
has('a driver names the side it favours', fb, '<span class="fav">North Texas</span>');
has('and the width of the gap', fb, 'a wide gap');
has('and carries its sentence with both league means', fb, 'league 10.4%');
has('and both unit values', fb, 'Texas State allows 7.5%');
has('and its reliability', fb, 'reliability 76%');
has('and says the figure is opponent-adjusted', fb, 'opponent-adjusted');
has('and its source and observed time', fb, 'football/matchup/metrics.json (from football/rankings/current.json) · observed 2026-09-16 04:04Z');
has('availability UNKNOWN is a warning chip, not a clean sheet', fb, 'dk-state unknown">UNKNOWN');
has('and its sentence is shown', fb, 'THIS IS UNKNOWN, NOT HEALTHY');
has('a missing availability side names the reason', fb, 'no availability record for the away side');
has('the states note is shown', fb, 'Only NO_REPORTED_INJURIES means an official report was read');
has('the projected starter is named', fb, 'Brad Jackson');
has('and is marked not confirmed', fb, '<b>not confirmed</b> · previous game');
has('with its source', fb, 'cfbfastR-data player_stats');
has('a missing starter side says so', fb, 'no projected starter on file for the away side');
has('rest days are shown for both sides', fb, '14d · 14d');
has('the forecast carries temperature, wind and precipitation', fb, '84°F · wind 12 mph S · precip 20%');
has('and its source and observed time', fb, 'football/venues/forecasts.json (open-meteo) · 2026-09-16 00:10Z');
has('travel that is not computed says so', fb, 'travel distance and time zone are not computed');
has('the ratings disclosure carries ETSR with the rank', fb, 'ETSR +3.7 (#22)');
has('and the rating confidence', fb, 'confidence 41%');
has('and the head coach with what is unknown', fb, 'HC G.J. Kinne · season 4 · oc/dc unknown');
has('and the play profile', fb, '75.5 plays/g · pass 40%');
has('and the neutral-field basis', fb, 'neutral-field rating');
lacks('no engine contributions are shown when none are published', fb, 'What carries the projection');

const NFL = Object.assign({}, CFB, {
  matchup: { home: { team: 'Buffalo Bills' }, away: { team: 'Detroit Lions' }, source: 'football/nfl/slate.json', profiles: { home: null, away: null }, ratings: { home: null, away: null }, coaching: { home: { missing: true }, away: { missing: true } } },
  why_the_number: { prose: null, drivers: [], model_drivers: { positive: ['net passing EPA per dropback: +1.59 points toward Buffalo Bills'], negative: ['quarterback adjustment: -0.05 points toward Detroit Lions'], source: 'football/nfl/slate.json (engine contributions)' } },
  availability: { home: { state: 'OFFICIAL_REPORT', source: 'nflverse-data injuries_2026.csv (public, keyless)', observed_at: '2026-09-13T16:20:24.079Z', freshness: 'STALE', week: 1, out: 0, doubtful: 0, questionable: 3,
      players: [{ name: 'Jordan Hancock', position: 'CB', status: 'Questionable', injury: 'Quadricep', practice: 'Full Participation in Practice' }] },
    away: { state: 'OFFICIAL_REPORT', source: 'nflverse-data injuries_2026.csv (public, keyless)', observed_at: '2026-09-13T16:20:24.079Z', freshness: 'STALE', week: 1, out: 1, doubtful: 0, questionable: 2, players: [] } },
  injuries: { home: { players: [{ name: 'Jordan Hancock', position: 'CB', status: 'Questionable', injury: 'Quadricep', practice: 'Full Participation in Practice' }] }, away: { players: [{ name: 'Taylor Decker', position: 'OT', status: 'Out', injury: 'Shoulder', practice: 'Did Not Participate In Practice' }] } },
  starters: { home: { position: 'QB', player_name: 'Josh Allen', status: 'SCHEDULE_FEED', confirmed: false, source: 'nflverse games.csv', freshness: 'LIVE' }, away: { position: 'QB', player_name: 'Jared Goff', status: 'SCHEDULE_FEED', confirmed: false, source: 'nflverse games.csv', freshness: 'LIVE' } },
  situation: { rest_days: { home: 7, away: 7 }, weather: { value: null, missing: true, reason: 'no weather forecast was retrieved for this game' }, travel: { missing: true, reason: 'not computed' }, surface: 'a_turf', roof: 'outdoors', division_game: false },
});
const nf = ctx.structuredPanelsHTML({ structured: NFL });
has('the engine contributions lead when there are no unit pairs', nf, 'What carries the projection');
has('with the positive contribution', nf, 'net passing EPA per dropback: +1.59 points toward Buffalo Bills');
has('and the negative one', nf, 'quarterback adjustment: -0.05 points toward Detroit Lions');
has('and their source', nf, 'football/nfl/slate.json (engine contributions)');
lacks('no matchup drivers section is drawn without drivers', nf, 'Matchup drivers (');
has('an official report is a green chip', nf, 'dk-state official">OFFICIAL REPORT');
has('with its counts and week', nf, '0 out · 0 doubtful · 3 questionable · week 1');
has('and the listed players with practice status', nf, '<span class="st">Questionable</span> Jordan Hancock (CB) — Quadricep <span class="pr">Full Participation in Practice</span>');
has('the away report lists the player from the injuries layer', nf, 'Taylor Decker (OT) — Shoulder');
has('a stale report wears a STALE badge', nf, 'nflverse-data injuries_2026.csv (public, keyless) · 2026-09-13 16:20Z <span class="dk-fresh stale">STALE</span>');
has('the schedule-feed starter is not confirmed', nf, 'Josh Allen</div><div class="s"><b>not confirmed</b> · schedule feed');
has('roof and surface are shown', nf, 'outdoors</div><div class="s">surface a_turf · non-division');
has('a missing forecast says so with an UNKNOWN badge', nf, 'no weather forecast was retrieved for this game <span class="dk-fresh unknown">UNKNOWN</span>');
chk('no ratings disclosure is drawn when nothing is on file', nf.indexOf('Ratings, coaching and play profile') < 0);
chk('football evidence is not drawn for a packet without those layers', ctx.structuredPanelsHTML({ structured: S }).indexOf('dk-state') < 0 && ctx.structuredPanelsHTML({ structured: S }).indexOf('Projected starting quarterbacks') < 0);

const five = ['**The Desk’s read**', 'a', '**Why**', '- b', '**The case for each side**', '- c', '**What could make it wrong**', '- d', '**Price and data limitations**', '- e'].join('\n');
const prose = ctx.deskProseHTML(five);
has('a five-section answer promotes the fifth heading', prose, 'The case for each side');
has('as its own section', prose, 'dk-sec sides');
const four = ['**The Desk’s read**', 'a', '**Why**', '- b', '**What could make it wrong**', '- d', '**Price and data limitations**', '- e'].join('\n');
chk('a four-section answer from an older build still parses', ctx.deskProseHTML(four).indexOf('dk-read') >= 0);
chk('sections come out in answer order', (() => { const h = prose; return h.indexOf('dk-sec why') < h.indexOf('dk-sec sides') && h.indexOf('dk-sec sides') < h.indexOf('dk-sec wrong'); })());
done();
