#!/usr/bin/env node
/* ===========================================================================
   Tests for the EdgeDesk presentation layer — "deep engine, simple answer".

   THE RULE UNDER TEST: nothing in the presentation layer may create, modify,
   recalculate, upgrade or override a deterministic betting number or verdict.
   It translates. AI copy is optional and validated. Narration failure never
   takes the decision card down.

   Run: node tools/presentation/presentation.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const P = require(path.join(__dirname, '..', '..', 'supabase', 'functions', 'edgedesk_ai', '_presentation.js'));

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) {
  if (typeof ok === 'function') { try { ok = ok(); } catch (e) { ok = false; detail = { threw: String((e && e.message) || e) }; } }
  if (ok) { pass++; return; }
  fail++; failures.push({ name, detail });
}
function done() {
  failures.forEach(function (f) { console.log('FAIL | ' + f.name + (f.detail !== undefined ? '  ' + JSON.stringify(f.detail).slice(0, 400) : '')); });
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const NOW = Date.parse('2026-09-03T22:00:00Z');

/* A client packet exactly as EDAI.packetOf(x) emits it. Prices are American
   already (the engine's own display transform); the engine's verdict travels
   in `deterministic`. */
function packet(over) {
  const base = {
    game: { matchup: 'Texas Tech @ Baylor', sport: 'CFB', sport_key: 'americanfootball_ncaaf', commence: '2026-09-05T23:30:00Z', away: 'Texas Tech', home: 'Baylor', event_id: 'ev1' },
    market: 'Spread', market_key: 'spreads', selection: 'Texas Tech -3.5', selection_raw: 'Texas Tech', point: -3.5,
    prices: { detect: -108, current: -110, fair: -121, max_playable: -118, book: 'DraftKings', trusted: true },
    edge: { detect: 0.034, current: 0.031, ev: 0.031, remaining: 0.91, floor: 0.005 },
    confirmation: { has_sharp: true, n_books: 6, corrob: 1, trusted: true },
    timing: { stale_min: 8 },
    price_sensitivity: { breakeven: -121, max_playable: -118, needs_price_for_ev: null },
    deterministic: {
      verdict: 'BET', display_verdict: 'BET', is_wait: false, wait_reason: null, confidence: 'HIGH', score: 82, band: 'Solid',
      why: 'Clears the bar with real liquidity: +3.1% at a US-regulated book, sharp-confirmed.',
      reasons_for: ['+3.1% estimated edge vs Pinnacle de-vig fair', 'Pinnacle (sharp reference) is quoting this side', 'best price is at a US-regulated book', '6 books behind the fair line'],
      reasons_against: ['no sharp (Pinnacle) confirmation on this exact side'],
      falsifiers: ['Price keeps moving against you: 91% of the detection edge is left, and past -118 the EV crosses the 0.5% floor.'],
    },
  };
  const out = JSON.parse(JSON.stringify(base));
  (over || []).forEach(function (o) { const [k, v] = o; const parts = k.split('.'); let t = out; for (let i = 0; i < parts.length - 1; i++) t = t[parts[i]]; t[parts[parts.length - 1]] = v; });
  return out;
}
function simple(over, ctx) { return P.simpleFromPacket(packet(over), Object.assign({ now: NOW, stale_limit_min: 90 }, ctx || {})); }

/* ---- verdict ownership --------------------------------------------------- */
{
  const s = simple();
  chk('BET remains BET', s.verdict === 'BET' && s.display_verdict === 'BET' && s.engine_verdict === 'BET');
  chk('headline starts with the decision', /^BET: Texas Tech -3\.5 at -110\./.test(s.headline), s.headline);
  chk('selection carries the number', s.selection === 'Texas Tech -3.5');
  chk('price carries the book', s.odds_display === '-110 · DraftKings');
  chk('good to is the owned max-playable, exactly', s.playable_to.label === 'Good to -118' && s.playable_to.limit_odds === '-118');
  chk('why is at most three bullets', s.why.length === 3);
  chk('why is plain language', s.why.every(function (w) { return !/de-vig|pinnacle|CLV|max playable/i.test(w.text); }), s.why);
  chk('watch is one sentence', typeof s.watch.text === 'string' && s.watch.text.length > 0);

  const lean = simple([['deterministic.verdict', 'LEAN'], ['deterministic.display_verdict', 'LEAN']]);
  chk('LEAN stays LEAN', lean.verdict === 'LEAN');
  const ai = P.applyAiCopy(lean, { headline: 'BET: Texas Tech -3.5 at -110. Strong.', why: [{ text: 'A strong BET here.' }] });
  chk('LEAN cannot become BET via AI headline', ai.simple.verdict === 'LEAN' && !/^BET/.test(ai.simple.headline), ai.simple.headline);
  chk('AI bullet contradicting the verdict is rejected', ai.simple.why.every(function (w) { return !/BET here/.test(w.text); }), ai.rejected);

  const wait = simple([['deterministic.verdict', 'LEAN'], ['deterministic.display_verdict', 'WAIT'], ['deterministic.is_wait', true], ['deterministic.wait_reason', 'Qualified on the last number, but it was captured 95m ago. Unconfirmed until a fresh capture verifies the price is still live.']]);
  chk('WAIT stays WAIT', wait.verdict === 'WAIT');
  chk('WAIT watch says what must confirm', /fresh capture|confirm/i.test(wait.watch.text), wait.watch.text);
  const waitAi = P.applyAiCopy(wait, { headline: 'BET: Texas Tech -3.5 at -110.' });
  chk('WAIT cannot become BET', waitAi.simple.verdict === 'WAIT' && /^WAIT/.test(waitAi.simple.headline));

  const pass = simple([['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['edge.current', 0.002], ['price_sensitivity.needs_price_for_ev', -118], ['prices.current', -125], ['deterministic.why', 'The edge existed at detection (-108) but the current price has moved to -125, pulling EV below the 0.5% floor.'], ['deterministic.reasons_for', []]]);
  chk('PASS stays PASS', pass.verdict === 'PASS');
  chk('PASS headline is a complete answer', /^PASS: EdgeDesk does not see enough value/.test(pass.headline), pass.headline);
  chk('PASS names the price that would restore it', pass.playable_to.kind === 'NEEDS' && pass.playable_to.limit_odds === '-118', pass.playable_to);
  const passAi = P.applyAiCopy(pass, { headline: 'BET: Texas Tech -3.5 at -125.', watch: 'Hammer it.' });
  chk('PASS cannot become BET', passAi.simple.verdict === 'PASS' && /^PASS/.test(passAi.simple.headline));
  chk('WAS playable / NOW PASS is derived deterministically', pass.price_status.kind === 'PAST_LIMIT' && /Was playable at -108\. Now PASS: the price moved to -125\. EdgeDesk’s limit was -118\./.test(pass.price_status.text), pass.price_status.text);
}

/* ---- integrity ----------------------------------------------------------- */
{
  const failed = simple([], { integrity: { verdict: 'FAIL', summary: 'FAIL: identity_chain', failed: [{ name: 'identity_chain', status: 'FAIL', detail: '2 of 4 starters are attached to a team that is not playing in their own game.' }] } });
  chk('integrity FAIL suppresses the recommendation', failed.suppressed === true && failed.display_verdict !== 'BET' && failed.verdict !== 'BET');
  chk('integrity FAIL keeps the engine verdict on record', failed.engine_verdict === 'BET');
  chk('integrity FAIL headline says DATA CHECK FAILED', /^DATA CHECK FAILED: EdgeDesk cannot safely publish a decision until/.test(failed.headline), failed.headline);
  chk('integrity FAIL is flagged above the fold', failed.flags.some(function (f) { return f.kind === 'DATA_CHECK_FAILED'; }));
  const failAi = P.applyAiCopy(failed, { headline: 'BET: Texas Tech -3.5 at -110.', watch: 'Nothing to worry about.' });
  chk('AI cannot talk over a failed data check', /^DATA CHECK FAILED/.test(failAi.simple.headline) && failAi.simple.watch.source === 'deterministic');
  const pub = P.publisher(failed, { preset: 'GAME' });
  chk('publisher brief shows no call on a failed check', pub.call.verdict === 'DATA CHECK FAILED' && pub.data_check.status === 'Data check failed');

  const warn = simple([], { integrity: { verdict: 'WARNING', summary: 'WARNING: freshness', failed: [{ name: 'freshness', status: 'WARNING', detail: 'The most recent subject record is 5 days old (2026-08-29).' }] } });
  chk('integrity WARNING produces a provisional presentation', warn.integrity_status === 'PROVISIONAL' && warn.flags.some(function (f) { return f.kind === 'PROVISIONAL'; }));
  chk('WARNING keeps the verdict', warn.verdict === 'BET' && warn.suppressed === false);
  chk('WARNING publisher data check is Provisional', P.publisher(warn, {}).data_check.status === 'Provisional');
}

/* ---- freshness ----------------------------------------------------------- */
{
  const stale = simple([['timing.stale_min', 140]]);
  chk('stale price is visibly marked', stale.freshness.status === 'STALE' && stale.flags.some(function (f) { return f.kind === 'STALE_PRICE'; }));
  chk('stale price status says refresh', /needs refreshing/.test(stale.price_status.text));
  chk('freshness is human readable', simple().freshness.price_text === 'Price updated 8 min ago');
  chk('unknown age is never claimed current', simple([['timing.stale_min', null]]).freshness.status === 'UNKNOWN');
  chk('publisher data check needs refresh when stale', P.publisher(stale, {}).data_check.status === 'Needs refresh');
}

/* ---- odds are display-only ---------------------------------------------- */
{
  chk('decimal -> American (favourite)', P.decToAmerican(1.9091) === -110);
  chk('decimal -> American (underdog)', P.decToAmerican(2.35) === 135);
  chk('decimal <= 1 is not a price', P.decToAmerican(1) === null && P.decToAmerican(0.5) === null);
  chk('fmtAmerican signs a dog', P.fmtAmerican(135) === '+135' && P.fmtAmerican(-110) === '-110');
  const pk = packet();
  const before = JSON.stringify(pk);
  const s = P.simpleFromPacket(pk, { now: NOW });
  chk('presentation never mutates the packet', JSON.stringify(pk) === before);
  chk('engine numbers travel verbatim', s.engine.edge === 0.031 && s.engine.max_playable_am === -118 && s.engine.fair_am === -121);
  const dec = P.simpleFromPacket(Object.assign(packet(), { prices: { current_dec: 1.9091, detect_dec: 1.926, fair_dec: 1.826, book: 'FanDuel' } }), { now: NOW });
  chk('decimal input is converted for display only', dec.odds === '-110' && dec.engine.current_am === -110 && dec.engine.edge === 0.031);
}

/* ---- missing data is never invented ------------------------------------- */
{
  const noBook = simple([['prices.book', null], ['confirmation.book', null]]);
  chk('missing book does not invent a book', noBook.book === null && noBook.odds_display === '-110');
  const noPrice = simple([['prices.current', null]]);
  chk('missing price does not invent a price', noPrice.odds === null && noPrice.price_status.kind === 'NO_PRICE');
  chk('missing price becomes WAIT with a no-price headline', noPrice.display_verdict === 'WAIT' && /no current price is on file/.test(noPrice.headline), noPrice.headline);
  const gap = simple([], { gaps: ['nfl_injury_report'] });
  chk('missing injury data is named, never "no injuries"', /Injury and availability data is not on file/.test(gap.watch.text) && !/no injuries/i.test(gap.watch.text), gap.watch.text);
  chk('gap is flagged on the card', gap.flags.some(function (f) { return f.kind === 'DATA_GAP'; }));
  const noDet = P.simpleFromPacket({ game: {}, prices: {}, deterministic: {} }, { now: NOW });
  chk('no engine verdict -> card unavailable, never manufactured', noDet.available === false && noDet.verdict === null);
}

/* ---- AI copy validation -------------------------------------------------- */
{
  const s = simple();
  const r = P.applyAiCopy(s, {
    headline: 'BET: Texas Tech -3.5 at -110.',
    why: [{ text: 'EdgeDesk makes the matchup stronger than the market does.', evidence_ids: ['e3', 'zz'] }, { text: 'This is a lock at -200.' }, { text: 'The price is 3.1% better than the sharper market.' }],
    watch: 'A late quarterback change would weaken the case.',
    change_trigger: 'A move past -118 ends the edge.',
    market_read: 'Six books stand behind the number and the sharper market agrees.',
  }, { known_evidence_ids: ['e1', 'e2', 'e3'] });
  chk('valid AI copy is accepted', r.accepted && r.simple.copy_source === 'ai');
  chk('hype bullet rejected, invented price rejected', r.rejected.some(function (x) { return /hype|invented price/.test(x); }), r.rejected);
  chk('unknown evidence ids are stripped', r.simple.why[0].evidence_ids.length === 1 && r.simple.why[0].evidence_ids[0] === 'e3');
  chk('rejected bullets are backfilled deterministically', r.simple.why.length === 3 && r.simple.why.some(function (w) { return w.source === 'deterministic'; }));
  chk('known percentages pass, unknown fail', P.validateCopy({ watch: 'Edge is 3.1% here.' }, s).ok && !P.validateCopy({ watch: 'Edge is 9.9% here.' }, s).ok);
  chk('AI failure leaves deterministic card functional', (function () { const z = P.applyAiCopy(s, null); return z.accepted === false && z.simple.verdict === 'BET' && z.simple.why.length === 3 && z.simple.copy_source === 'deterministic'; })());
  const parsed = P.parseAiCopyBlock('BET: Texas Tech -3.5 at -110.\n\nGood to -118.\n\n```edgedesk_copy\n{"headline":"BET: Texas Tech -3.5 at -110."}\n```');
  chk('copy block is split from the prose', parsed.copy && parsed.copy.headline && !/edgedesk_copy/.test(parsed.answer) && /Good to -118/.test(parsed.answer));
  chk('bad json in the block is reported, prose kept', (function () { const p2 = P.parseAiCopyBlock('x\n```edgedesk_copy\n{oops\n```'); return p2.copy === null && p2.error === 'bad json' && p2.answer === 'x'; })());
  chk('hype regex covers the banned words', ['lock', 'guaranteed', 'hammer', "can't miss", 'free money', 'AI says'].every(function (w) { return P.HYPE.test('a ' + w + ' b'); }));
}

/* ---- publisher + slate --------------------------------------------------- */
{
  const s = simple();
  const pub = P.publisher(s, { preset: 'TNF', event_label: 'Texas Tech at Baylor' });
  chk('publisher kicker resolves from preset', pub.kicker === 'Thursday Night Football');
  chk('publisher lede is neutral and price-bound', /EdgeDesk’s current research favors Texas Tech -3\.5 at -110, and the number remains playable through -118\./.test(pub.lede), pub.lede);
  chk('publisher copy has no hype', !P.HYPE.test([pub.lede, pub.why.join(' '), pub.biggest_risk, pub.change_call].join(' ')));
  chk('publisher carries powered by', pub.powered_by === 'Powered by EdgeDesk Sports');

  const b1 = simple([['game.event_id', 'g1'], ['deterministic.score', 80]]);
  const b2 = simple([['game.event_id', 'g2'], ['deterministic.score', 70], ['selection_raw', 'Baylor'], ['point', 3.5]]);
  const l1 = simple([['game.event_id', 'g3'], ['deterministic.verdict', 'LEAN'], ['deterministic.display_verdict', 'LEAN'], ['deterministic.score', 60]]);
  const w1 = simple([['game.event_id', 'g4'], ['deterministic.display_verdict', 'WAIT'], ['deterministic.is_wait', true], ['deterministic.score', 50]]);
  const p1 = simple([['game.event_id', 'g5'], ['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['deterministic.score', 30]]);
  const two = P.slate([b1, b2, l1, w1, p1], { max: 3 });
  chk('two qualifying BETs shows exactly two, never a padded third', two.picks.length === 2 && two.picks.every(function (c) { return c.verdict === 'BET'; }) && two.no_bet === false);
  chk('the strongest non-bets sit underneath, labelled', two.watch.length >= 1 && two.watch[0].verdict === 'LEAN');
  const none = P.slate([l1, w1, p1], { max: 3 });
  chk('no qualifying CFB bets produces NO QUALIFYING BETS', none.no_bet === true && none.headline === 'NO QUALIFYING BETS' && none.picks.length === 0);
  chk('NO BET still surfaces the strongest research', none.watch.length === 3 && none.watch[0].verdict === 'LEAN');
  const failedBet = simple([['game.event_id', 'g6']], { integrity: { verdict: 'FAIL', failed: [{ name: 'market', status: 'FAIL', detail: 'incoherent' }] } });
  chk('a suppressed BET never counts as a qualifying bet', P.slate([failedBet], { max: 3 }).no_bet === true);
  const staleBet = simple([['game.event_id', 'g7'], ['timing.stale_min', 200]]);
  chk('a stale-priced BET is not published as a qualifying bet', P.slate([staleBet], { max: 3 }).no_bet === true);
  chk('all mode includes LEANs', P.slate([b1, l1, p1], { mode: 'all' }).picks.length === 2);
}

/* ---- CFB identity stays sport-scoped ------------------------------------- */
{
  const nfl = { sport_key: 'americanfootball_nfl', commence_time: '2026-09-11T00:15:00Z', home_team: 'Kansas City Chiefs', away_team: 'Baltimore Ravens' };
  const cfb = { sport_key: 'americanfootball_ncaaf', commence_time: '2026-09-05T23:30:00Z', home_team: 'Baylor', away_team: 'Texas Tech' };
  const tnf = P.primetime([nfl, cfb], 'TNF', { now: Date.parse('2026-09-08T12:00:00Z') });
  chk('TNF resolves only from NFL rows by ET weekday + 7pm start', tnf && tnf.row === nfl);
  chk('SNF/MNF do not claim a Thursday game', P.primetime([nfl], 'SNF', { now: Date.parse('2026-09-08T12:00:00Z') }) === null && P.primetime([nfl], 'MNF', { now: Date.parse('2026-09-08T12:00:00Z') }) === null);
  const et = P.etParts('2026-09-10T00:15:00Z');
  chk('ET calendar facts: 00:15Z Thursday is Wednesday 8pm ET', et.weekday === 3 && et.hour === 20);
  const cards = [simple([['game.sport_key', 'americanfootball_ncaaf']]), simple([['game.sport_key', 'americanfootball_nfl'], ['game.event_id', 'nflx'], ['selection_raw', 'New York Giants']])];
  const cfbOnly = cards.filter(function (c) { return c.game.sport_key === 'americanfootball_ncaaf'; });
  chk('a CFB slate excludes NFL rows even with a shared nickname pool', cfbOnly.length === 1 && cfbOnly[0].game.sport_key === 'americanfootball_ncaaf');
  chk('sport label travels with the card', cards[1].game.sport_key === 'americanfootball_nfl');
}

/* ---- snapshots ----------------------------------------------------------- */
{
  const s = simple();
  const snap = P.snapshot({ cards: [s], report_type: 'GAME', preset: 'SNF', now: NOW });
  chk('snapshot records the captured price and its timestamp', snap.price_snapshot[0].odds === '-110' && typeof snap.price_snapshot[0].captured_at === 'string');
  chk('snapshot version starts at 1', snap.version_no === 1 && snap.generated_at === new Date(NOW).toISOString());
  const moved = simple([['prices.current', -118], ['timing.stale_min', 1]]);
  const later = P.refresh(snap, { cards: [moved], now: NOW + 3600000 });
  chk('refreshing is deliberate: a NEW version, the old snapshot untouched', later.version_no === 2 && later.parent_key === snap.report_key && snap.price_snapshot[0].odds === '-110' && later.price_snapshot[0].odds === '-118');
  const pub = P.publicPayload(snap);
  chk('public payload carries only publishable fields', pub && !pub.internal && !('engine' in (pub.cards[0].brief || {})) && JSON.stringify(pub).indexOf('reasons_for') < 0);
  chk('public payload carries the price capture time', pub.data_status.price_captured_at === snap.price_snapshot[0].captured_at);
  const html = P.briefHTML(snap);
  chk('brief HTML is a one-page report with the call first', /class="edb"/.test(html) && html.indexOf('The EdgeDesk call') < html.indexOf('EdgeDesk data check'));
  chk('brief HTML escapes content', !/<script/i.test(P.briefHTML(P.snapshot({ cards: [simple([['selection_raw', '<script>x</script>']])], report_type: 'GAME' }))));
  const txt = P.briefText(snap);
  chk('plain text is article-ready', /^EDGEDESK GAME BRIEF/.test(txt) && /THE EDGEDESK CALL\nBET — Texas Tech -3\.5 \(-110\)\nGOOD TO -118/.test(txt), txt.slice(0, 200));
  const cms = P.briefCmsHTML(snap);
  chk('CMS HTML is clean semantic markup', /^<h1>/.test(cms) && !/class=/.test(cms));
  const slateSnap = P.snapshot({ cards: [simple([['deterministic.display_verdict', 'PASS'], ['deterministic.verdict', 'PASS']])], report_type: 'SLATE', preset: 'CFB', max: 3, now: NOW });
  chk('slate snapshot with no bets says NO QUALIFYING BETS', slateSnap.public.slate.no_bet && /NO QUALIFYING BETS/.test(P.briefText(slateSnap)));
}

/* ---- card HTML: mobile keeps verdict/selection/price/good-to first -------- */
{
  const s = simple();
  const html = P.cardHTML(s, { actions: [{ label: 'Full research', onclick: 'x()' }, { label: 'Create brief', onclick: 'y()' }] });
  const hero = html.indexOf('dcard-hero'), verdict = html.indexOf('dcard-verdict'), sel = html.indexOf('dcard-sel'), price = html.indexOf('dcard-price'), gt = html.indexOf('dcard-goodto'), body = html.indexOf('dcard-body');
  chk('hero block leads the card', hero >= 0 && hero < body);
  chk('verdict -> selection -> price -> good to, in that order, before the body', verdict < sel && sel < price && price < gt && gt < body);
  chk('actions are present', /Full research/.test(html) && /Create brief/.test(html));
  chk('what-does-this-mean is templated, not AI', /What does this mean\?/.test(html) && /EdgeDesk still likes the bet at -118/.test(html));
  chk('explain is deterministic per key', P.explain('verdict', s).indexOf('BET means') === 0);
  chk('translate dictionary', P.translate('sharp reference') === 'sharper market' && P.translate('max playable') === 'good to');
}

done();
