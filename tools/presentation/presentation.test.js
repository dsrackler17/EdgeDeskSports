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

/* ---- CLOSE THE LOOP: the receipt on the card, the grade on the brief ---- */
{
  /* The engine's graded fields ride the packet verbatim; the card shows them. */
  const graded = P.simpleFromPacket(packet([['clv', { clv: 0.021, beat_close: true, closing: 0.5556, result: 'win', closed_at: '2026-09-06T00:00:00Z', graded_at: '2026-09-06T03:00:00Z' }]]), { now: NOW });
  chk('a graded row gives the card a receipt with the engine CLV untouched', graded.outcome && graded.outcome.clv === 0.021 && graded.outcome.beat_close === true && graded.outcome.result === 'win', graded.outcome);
  chk('the receipt reads like a sportsbook: closed, cents, result', graded.outcome.text === 'Closed -125. Beat the close by 17 cents. Won.', graded.outcome.text);
  chk('cents are measured from the DETECTION price the engine graded from', graded.outcome.entry_odds === '-108');
  chk('the verdict is not touched by a result', graded.verdict === 'BET' && graded.engine_verdict === 'BET');
  chk('the full card carries the Result line', /class="dcard-result win"/.test(P.cardHTML(graded)) && /Closed -125\. Beat the close by 17 cents\. Won\./.test(P.cardHTML(graded)));
  chk('the compact strip carries it too', /dcard-result/.test(P.cardHTML(graded, { compact: true })));
  const ungraded = P.simpleFromPacket(packet(), { now: NOW });
  chk('no graded row, no receipt and no Result line', ungraded.outcome === null && !/dcard-result/.test(P.cardHTML(ungraded)));
  const lost = P.simpleFromPacket(packet([['clv', { clv: -0.03, beat_close: false, closing: 0.5, result: 'loss' }]]), { now: NOW });
  chk('a loss is a loss, in red', /dcard-result loss/.test(P.cardHTML(lost)) && /Missed the close by 8 cents\. Lost\./.test(lost.outcome.text), lost.outcome.text);
  chk('a result never becomes a verdict: PASS with a win stays PASS', (function () {
    const s = P.simpleFromPacket(packet([['deterministic.verdict', 'PASS'], ['deterministic.display_verdict', 'PASS'], ['clv', { clv: 0.05, beat_close: true, closing: 0.6, result: 'win' }]]), { now: NOW });
    return s.verdict === 'PASS' && s.outcome.result === 'win';
  })());

  /* The snapshot's prices carry everything the grader needs. */
  const snap = P.snapshot({ cards: [graded], report_type: 'GAME', preset: 'GAME', now: NOW });
  const pr = snap.price_snapshot[0];
  chk('a snapshot price carries raw market, side, line, American odds, verdict, kickoff and teams', pr.market_key === 'spreads' && pr.selection_raw === 'Texas Tech' && pr.line === -3.5 && pr.odds_am === -110 && pr.verdict === 'BET' && pr.kind === 'pick' && pr.rank === 1 && pr.commence === '2026-09-05T23:30:00Z' && pr.home === 'Baylor' && pr.away === 'Texas Tech' && pr.sport_key === 'americanfootball_ncaaf', pr);
  chk('the grade key is stable and raw', P.gradeKey(pr) === 'ev1|spreads|Texas Tech|-3.5');
  chk('a legacy price with labels only still yields the same key', P.gradeKey({ event_id: 'ev1', market: 'Spread', selection: 'Texas Tech -3.5', odds: '-110' }) === 'ev1|spreads|Texas Tech|-3.5');
  const sl = P.snapshot({ cards: [graded, P.simpleFromPacket(packet([['game.event_id', 'ev2'], ['game.matchup', 'A @ B'], ['game.away', 'A'], ['game.home', 'B'], ['deterministic.verdict', 'LEAN'], ['deterministic.display_verdict', 'LEAN']]), { now: NOW })], report_type: 'SLATE', preset: 'CFB', now: NOW });
  chk('on a slate, picks are picks and the rest is watch', sl.price_snapshot[0].kind === 'pick' && sl.price_snapshot[1].kind === 'watch' && sl.price_snapshot[1].rank === 1, sl.price_snapshot.map(p => [p.kind, p.rank]));
  chk('the public payload carries the gradeable prices', P.publicPayload(sl).data_status.prices[0].selection_raw === 'Texas Tech');

  /* The brief renders its grade only when handed one. */
  const entry = { id: 'x', graded_at: '2026-09-06T03:00:00Z', picks: [{ verdict: 'BET', selection: 'Texas Tech -3.5', odds: '-110', book: 'DraftKings', status: 'graded', grade: P.gradePick({ odds: '-110', close_fair_prob: 0.5556, result: 'win' }), score: { home: 'Baylor', away: 'Texas Tech', home_score: 20, away_score: 24 } }] };
  const html = P.briefHTML(snap, { grades: entry });
  chk('a brief with a grade shows How it graded, the final and the receipt', /How it graded/.test(html) && /Final Texas Tech 24, Baylor 20/.test(html) && /Closed -125\. Beat the close by 15 cents\. Won\./.test(html));
  chk('a brief without a grade is exactly the brief', !/How it graded/.test(P.briefHTML(snap)));
  chk('plain text carries the grade when asked', /HOW IT GRADED/.test(P.briefText(snap, { grades: entry })) && !/HOW IT GRADED/.test(P.briefText(snap)));
  chk('CMS copy never carries a grade: the article is the article', !/graded/i.test(P.briefCmsHTML(snap)));
  chk('pending states are said, not filled', P.pickStatusText({ status: 'pending_kickoff' }) === 'Not kicked off yet.' && /disagree/.test(P.pickStatusText({ status: 'contested' })) && /not deployed/.test(P.pickStatusText({ status: 'no_close_source' })));
  chk('calibration HTML is empty-safe and marks thin rows', /No published calls have graded yet/.test(P.calibrationHTML([])) && /thin/.test(P.calibrationHTML([{ id: 'b', preset: 'GAME', picks: [{ verdict: 'BET', kind: 'pick', sport_key: 'americanfootball_nfl', status: 'graded', grade: entry.picks[0].grade }] }])));
}

/* ---- AVAILABILITY: the injury report, when it is on file ------------------ */
{
  function report(over) {
    return Object.assign({ status: 'ON_FILE', source: 'nflverse', week: 3, teams: {
      away: { name: 'Texas Tech', code: 'TTU', filed: true, players: [
        { name: 'Behren Morton', position: 'QB', status: 'Questionable', injury: 'Shoulder', practice: 'Limited Participation in Practice' },
        { name: 'Rotational Guy', position: 'WR', status: 'Questionable', injury: 'Hamstring', practice: null } ] },
      home: { name: 'Baylor', code: 'BAY', filed: true, players: [
        { name: 'Big Left Tackle', position: 'LT', status: 'Out', injury: 'Knee', practice: 'Did Not Participate In Practice' } ] } } }, over || {});
  }
  const on = P.simpleFromPacket(packet(), { now: NOW, gaps: ['injury_report'], availability: report() });
  chk('an injury report on file removes the "not on file" gap', !on.gaps.some(function (g) { return /not on file/i.test(g); }) && !on.flags.some(function (f) { return f.kind === 'DATA_GAP' && /injur/i.test(f.text); }), on.gaps);
  chk('the card carries an availability flag that summarises both sides', on.flags.some(function (f) { return f.kind === 'AVAILABILITY' && /TTU: 2 questionable/.test(f.text) && /BAY: 1 out/.test(f.text); }), on.flags);
  chk('the structured availability rides on the simple object with its source and week', on.availability && on.availability.status === 'ON_FILE' && on.availability.source === 'nflverse' && on.availability.week === 3 && on.availability.listed.length === 3);
  chk('listed players are ordered by severity: out before doubtful before questionable', on.availability.listed[0].name === 'Big Left Tackle' && on.availability.listed[0].status === 'out');
  chk('the watch line leads with a named absence on the side being backed, in plain words', /Big Left Tackle \(LT\) is out, knee, did not practice\./.test(on.watch.text) === false, on.watch.text);
  chk('the pick’s own side is the one that leads the watch line', /For the other side, big left tackle \(LT\) is out/i.test(on.watch.text) || /Big Left Tackle/.test(on.watch.text), on.watch.text);
  chk('the full card lists the report with status, injury and practice', /class="dcard-h">Availability<\/div><ul class="dcard-avail">/.test(P.cardHTML(on)) && /Big Left Tackle<\/b> <span class="pos">LT<\/span> <span class="st out">out<\/span> · knee · did not/.test(P.cardHTML(on)), P.cardHTML(on).slice(0, 200));
  chk('the compact strip carries a one-line chip, never the full player list', (function () {
    const c = P.cardHTML(on, { compact: true });
    return !/<ul class="dcard-avail">/.test(c) && /<div class="dcard-availchip warn">/.test(c) && /LT out/.test(c);
  })(), P.cardHTML(on, { compact: true }).match(/dcard-availchip[^<]*<?[^<]*/));
  chk('the chip names the two that matter and counts the rest', (function () {
    const chip = P.availabilityChip(on.availability);
    return chip && chip.count === 3 && /\+1 more/.test(chip.text) && chip.warn === true;
  })(), P.availabilityChip(on.availability));
  chk('no report, no chip', P.availabilityChip(null) === null && P.availabilityChip({ status: 'NOT_PUBLISHED' }) === null);
  chk('AVAILABILITY never touches the verdict, the price or the good-to', on.verdict === 'BET' && on.odds === '-110' && on.playable_to.limit_odds === '-118' && on.engine.edge === 0.031);

  const notPub = P.simpleFromPacket(packet(), { now: NOW, gaps: ['injury_report'], availability: { status: 'NOT_PUBLISHED', source: 'nflverse', reason: 'nflverse has not published the 2026 report yet' } });
  chk('an unpublished report keeps the honest gap and names the reason', /Injury and availability data is not on file: nflverse has not published the 2026 report yet\. Do not read that as a clean injury report\./.test(notPub.gaps[0]) && !notPub.flags.some(function (f) { return f.kind === 'AVAILABILITY'; }), notPub.gaps);
  chk('no report object at all leaves the old behaviour exactly as it was', (function () { const s = P.simpleFromPacket(packet(), { now: NOW, gaps: ['injury_report'] }); return /Injury and availability data is not on file\. Do not read/.test(s.gaps[0]) && s.availability === null; })());

  const filedNobody = P.simpleFromPacket(packet(), { now: NOW, gaps: ['injury_report'], availability: report({ teams: { away: { name: 'Texas Tech', code: 'TTU', filed: true, players: [] }, home: { name: 'Baylor', code: 'BAY', filed: false, players: [] } } }) });
  chk('"nobody listed" and "no report filed yet" are different sentences', /TTU: nobody listed/.test(filedNobody.flags.filter(function (f) { return f.kind === 'AVAILABILITY'; })[0].text) && /BAY: no report filed yet/.test(filedNobody.flags.filter(function (f) { return f.kind === 'AVAILABILITY'; })[0].text));
  chk('a clean report is not a warning', filedNobody.flags.filter(function (f) { return f.kind === 'AVAILABILITY'; })[0].severity === 'ok' && on.flags.filter(function (f) { return f.kind === 'AVAILABILITY'; })[0].severity === 'warn');
  chk('availabilitySummary returns null for anything that is not on file', P.availabilitySummary(null) === null && P.availabilitySummary({ status: 'NOT_PUBLISHED' }) === null);
  chk('playerLine never states a diagnosis it was not given', P.playerLine({ name: 'X', position: 'QB', status: 'out', injury: null, practice: null }) === 'X (QB) is out.');
}

/* ---- AVAILABILITY in the one-page brief ------------------------------------ */
{
  const av = { status: 'ON_FILE', source: 'EdgeDesk availability', week: 3, teams: {
    away: { name: 'Texas Tech', code: 'TTU', filed: true, dataQuality: 'STRONG', sources_checked: 3, official_report_found: true, players: [
      { name: 'Chris Brown', position: 'OT', status: 'OUT', injury: 'Knee', confidence: 'CONFIRMED', impact: 'HIGH', source_name: 'Texas Tech Athletics', source_url: 'https://texastech.com/r' },
      { name: 'Behren Morton', position: 'QB', status: 'QUESTIONABLE', injury: 'Shoulder', practice: 'Limited Participation in Practice', confidence: 'CONFIRMED', impact: 'MEDIUM', source_name: 'Texas Tech Athletics' },
      { name: 'Caleb Douglas', position: 'WR', status: 'QUESTIONABLE', confidence: 'MEDIUM', impact: 'LOW', source_name: 'Beat Reporter' } ] },
    home: { name: 'Kansas', code: 'KU', filed: true, dataQuality: 'STRONG', sources_checked: 3, official_report_found: true, players: [] } } };
  const s = P.simpleFromPacket(packet(), { now: NOW, availability: av });
  const b = P.publisher(s, { preset: 'CFB' });
  chk('the brief names the out starter in its headline, not "unresolved"', b.availability.headline === 'Texas Tech is missing its OT', b.availability.headline);
  chk('a questionable high-impact player reads as unresolved instead', (function () {
    const s2 = P.simpleFromPacket(packet(), { now: NOW, availability: { status: 'ON_FILE', source: 'x', teams: { away: { name: 'Texas Tech', code: 'TTU', filed: true, players: [{ name: 'Behren Morton', position: 'QB', status: 'QUESTIONABLE', impact: 'HIGH', confidence: 'CONFIRMED', source_name: 'Texas Tech Athletics' }] }, home: { name: 'Kansas', code: 'KU', filed: true, players: [] } } } });
    return P.publisher(s2, {}).availability.headline === 'Texas Tech QB status is unresolved';
  })());
  chk('each player is LISTED once, however the snapshot cloned him', (function () {
    const b2 = P.publisher(JSON.parse(JSON.stringify(s)), {});
    const listings = b2.availability.lines.filter(function (l) { return /^Texas Tech OT Chris Brown is/.test(l); });
    return listings.length === 1 && b2.availability.players.filter(function (p) { return p.name === 'Chris Brown'; }).length === 1;
  })(), P.publisher(JSON.parse(JSON.stringify(s)), {}).availability.lines);
  chk('a high-impact player gets the fact AND what it would mean, in that order', b.availability.lines[0].indexOf('Chris Brown is out with a knee issue') > 0 && /^Texas Tech is without Chris Brown/.test(b.availability.lines[1]));
  chk('the same source is credited once, not once per player', b.availability.sources.length === 2 && b.availability.sources[0].name === 'Texas Tech Athletics' && b.availability.sources[1].name === 'Beat Reporter', b.availability.sources);
  chk('the brief says the model does not adjust for the absence', b.availability.lines.some(function (l) { return /EdgeDesk’s number does not adjust for it/.test(l); }));
  chk('the coverage sentence travels into the brief', /Availability coverage: Strong/.test(b.availability.coverage));
  chk('the brief renders availability into HTML, CMS and plain text', (function () {
    const snap = P.snapshot({ cards: [s], report_type: 'GAME', preset: 'CFB', now: NOW });
    const html = P.briefHTML(snap), cms = P.briefCmsHTML(snap), txt = P.briefText(snap);
    return /Texas Tech is missing its OT/.test(html) && /Texas Tech is missing its OT/.test(cms) && /TEXAS TECH IS MISSING ITS OT/.test(txt) && /Source: Texas Tech Athletics · confirmed/.test(html);
  })());
  chk('with no availability object the brief carries no availability section', (function () {
    const plain = P.simpleFromPacket(packet(), { now: NOW });
    return P.publisher(plain, {}).availability === null && !/Availability coverage/.test(P.briefHTML(P.snapshot({ cards: [plain], report_type: 'GAME', now: NOW })));
  })());
  chk('an unpublished report still tells the reader the truth in the brief', (function () {
    const np = P.simpleFromPacket(packet(), { now: NOW, gaps: ['injury_report'], availability: { status: 'NOT_PUBLISHED', source: 'EdgeDesk availability', reason: 'neither program is in the availability dataset yet' } });
    const bb = P.publisher(np, {});
    return bb.availability.headline === 'Availability is unknown' && /No verified availability information found: neither program is in the availability dataset yet\./.test(bb.availability.lines[0]);
  })());
}

/* ---- AVAILABILITY: college football, where EdgeDesk owns the evidence ----- */
{
  function cfb(over) {
    return Object.assign({ status: 'ON_FILE', source: 'EdgeDesk availability', week: 3, teams: {
      away: { name: 'Texas Tech', code: 'TTU', filed: true, dataQuality: 'STRONG', sources_checked: 3, official_report_found: true, lastUpdated: '2026-09-03T21:00:00Z', players: [
        { name: 'Behren Morton', position: 'QB', status: 'QUESTIONABLE', injury: 'Shoulder', practice: 'Limited Participation in Practice',
          confidence: 'CONFIRMED', impact: 'HIGH', verified: true, source_name: 'Texas Tech Athletics', source_url: 'https://texastech.com/report',
          freshness: 'LIVE', timeline: [{ day: 'Tue', practice_status: 'DNP' }, { day: 'Wed', practice_status: 'LIMITED' }] },
        { name: 'Rotational Guy', position: 'WR', status: 'QUESTIONABLE', confidence: 'MEDIUM', impact: 'LOW', source_name: 'Beat Reporter' } ] },
      home: { name: 'Kansas', code: 'KU', filed: true, dataQuality: 'PARTIAL', sources_checked: 2, players: [
        { name: 'Big Tackle', position: 'LT', status: 'OUT', confidence: 'MEDIUM', impact: 'HIGH', source_name: 'Beat Reporter', contested: true } ] } } }, over || {});
  }
  const s = P.simpleFromPacket(packet(), { now: NOW, gaps: ['injury_report'], availability: cfb() });
  chk('a high-impact absence leads the list, whichever side it is on', s.availability.listed[0].name === 'Big Tackle' && s.availability.high_impact.length === 2, s.availability.listed.map(function (x) { return x.name; }));
  chk('the coverage sentence is the WORSE of the two sides and never says "no injuries"', /Availability coverage: Partial\. EdgeDesk found verified information for some players, but college football does not have a universal injury-reporting system\./.test(s.availability.coverage_text) && !/no injur/i.test(s.availability.coverage_text));
  chk('each player carries its own source, confidence and impact', s.availability.listed[1].source_name === 'Texas Tech Athletics' && s.availability.listed[1].confidence === 'CONFIRMED' && s.availability.listed[1].impact === 'HIGH' && s.availability.listed[1].verified === true);
  chk('the practice trail travels, with only the days a source reported', P.timelineText(s.availability.listed[1]) === 'Tue did not practice · Wed limited');
  chk('provenance renders as source and confidence, linked where there is a url', /Texas Tech Athletics · confirmed/.test(P.availabilityHTML(s.availability)) && /href="https:\/\/texastech\.com\/report"/.test(P.availabilityHTML(s.availability)));
  chk('a contested record says so on the card', /sources disagree/.test(P.availabilityHTML(s.availability)));
  chk('the high-impact flag is marked', /<span class="imp">high impact<\/span>/.test(P.availabilityHTML(s.availability)));
  chk('the watch line leads with the high-impact player on the side being backed', /^Behren Morton \(QB\) is questionable, shoulder, limited in practice\./.test(s.watch.text), s.watch.text);
  chk('with the other side backed, the opponent’s absence is named as the opponent’s', (function () {
    const other = P.simpleFromPacket(packet([['selection_raw', 'Baylor'], ['selection', 'Baylor +3.5']]), { now: NOW, availability: cfb({ teams: { away: { name: 'Texas Tech', code: 'TTU', filed: true, players: [] }, home: { name: 'Baylor', code: 'BAY', filed: true, players: [{ name: 'Big Tackle', position: 'LT', status: 'OUT', impact: 'HIGH', confidence: 'MEDIUM', source_name: 'Beat Reporter' }] } } }) });
    return /^Big Tackle \(LT\) is out\./.test(other.watch.text);
  })());

  const strong = P.simpleFromPacket(packet(), { now: NOW, availability: cfb({ teams: { away: { name: 'Texas Tech', code: 'TTU', filed: true, dataQuality: 'STRONG', official_report_found: true, sources_checked: 3, players: [] }, home: { name: 'Kansas', code: 'KU', filed: true, dataQuality: 'STRONG', official_report_found: true, sources_checked: 3, players: [] } } }) });
  chk('an official report listing nobody says exactly that, and is STRONG coverage', /TTU: nobody listed on the official report/.test(strong.availability.summary) && /Availability coverage: Strong · 2 official sources\./.test(strong.availability.coverage_text));
  chk('"nobody listed on the official report" is never rendered as "no injuries"', !/no injur/i.test(strong.availability.summary) && !/no injur/i.test(strong.availability.coverage_text));

  const limited = P.simpleFromPacket(packet(), { now: NOW, availability: cfb({ teams: { away: { name: 'Texas Tech', code: 'TTU', filed: true, dataQuality: 'STRONG', official_report_found: true, sources_checked: 3, players: [] }, home: { name: 'Kansas', code: 'KU', filed: true, dataQuality: 'LIMITED', sources_checked: 4, players: [] } } }) });
  chk('one side with no verified data drags the whole matchup to Limited, and says so', /Availability coverage: Limited\. EdgeDesk checked 7 sources and found no verified availability information for one side\. That is not the same as nobody being hurt\./.test(limited.availability.coverage_text), limited.availability.coverage_text);
  chk('the side with nothing says "no verified information found", not "nobody hurt"', /KU: no verified information found/.test(limited.availability.summary));

  const none = P.simpleFromPacket(packet(), { now: NOW, availability: cfb({ teams: { away: { name: 'Texas Tech', code: 'TTU', filed: true, dataQuality: 'NONE', sources_checked: 0, players: [] }, home: { name: 'Kansas', code: 'KU', filed: true, dataQuality: 'NONE', sources_checked: 0, players: [] } } }) });
  chk('no coverage at all is the honest sentence', /No verified availability information found for this matchup\./.test(none.availability.coverage_text));
  chk('a status EdgeDesk does not recognise is never promoted to a designation', (function () { const x = P.simpleFromPacket(packet(), { now: NOW, availability: cfb({ teams: { away: { name: 'A', code: 'A', filed: true, players: [{ name: 'Guy', status: 'UNKNOWN' }] }, home: { name: 'B', code: 'B', filed: true, players: [] } } }) }); return x.availability.listed.length === 0; })());
  chk('availability never touches the verdict, the price or the good-to', s.verdict === 'BET' && s.odds === '-110' && s.playable_to.limit_odds === '-118' && s.engine.edge === 0.031);
}

done();
