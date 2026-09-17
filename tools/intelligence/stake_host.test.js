#!/usr/bin/env node
/* ===========================================================================
   THE HOST ADAPTERS — the join between the edge function and the staking
   kernel, which is where a number gets invented if anywhere does.

   The kernel is pure and tested on its own. What is tested here is the wiring:
   that the forecast the desk reads reaches the candidate, that a football game
   with nothing in the forecast file is marked as CHECKED rather than as calm,
   and that a sport with no forecast source is left alone rather than punished
   for the host's gap.

   Run: node tools/intelligence/stake_host.test.js
   =========================================================================== */
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
globalThis.Deno = { env: { get: () => undefined } };

let pass = 0, fail = 0;
const failures = [];
function chk(name, ok, detail) { if (ok) { pass++; return; } fail++; failures.push({ name, detail }); }
function eq(name, a, b) { chk(name, JSON.stringify(a) === JSON.stringify(b), { got: a, want: b }); }
function done() {
  failures.forEach((f) => console.log('FAIL | ' + f.name + '  ' + String(JSON.stringify(f.detail)).slice(0, 320)));
  console.log((fail === 0 ? 'ALL GREEN ' : 'FAILED ') + pass + ' passed, ' + fail + ' failed');
  process.exit(fail === 0 ? 0 : 1);
}

const FORECASTS = {
  generated_at: '2026-09-17T18:00:00.000Z',
  by_game: {
    '401': { temp_f: 31, wind_mph: 26, gust_mph: 36, precip_in: 0.1, dome: false, as_of: '2026-09-19T12:00:00.000Z', kickoff: '2026-09-19T17:00:00.000Z', source: 'open-meteo forecast' },
    '402': { temp_f: 70, wind_mph: 3, gust_mph: 5, precip_in: 0, dome: true, as_of: '2026-09-19T12:00:00.000Z', kickoff: '2026-09-19T17:00:00.000Z', source: 'open-meteo forecast' },
  },
};
/* 403 is a real football game with NO row in the file; 900 is a baseball game
   the football forecast file was never going to cover. */
const BOARD = {
  scope: { sports: ['americanfootball_ncaaf'] },
  all_candidates: [
    { sport: 'americanfootball_ncaaf', game_id: '401', kickoff: '2026-09-19T17:00:00.000Z' },
    { sport: 'americanfootball_nfl', game_id: '402', kickoff: '2026-09-19T17:00:00.000Z' },
    { sport: 'americanfootball_ncaaf', game_id: '403', kickoff: '2026-09-19T17:00:00.000Z' },
    { sport: 'baseball_mlb', game_id: '900', kickoff: '2026-09-19T23:00:00.000Z' },
  ],
};

(async () => {
  const m = await import(path.join(ROOT, 'supabase/functions/edgedesk_ai/index.ts'));

  /* ═══ 1. THE SLATE READ ══════════════════════════════════════════════ */
  {
    const dal = { getForecasts: async () => ({ json: FORECASTS, error: null }) };
    const errors = [];
    const fc = await m.stakeForecasts(dal, BOARD, null, errors);
    eq('the read raised no error', errors, []);
    chk('a game with a forecast carries its readings', fc['401'].wind_mph === 26 && fc['401'].gust_mph === 36 && fc['401'].temp_f === 31, fc['401']);
    eq('and is marked as on file', [fc['401'].checked, fc['401'].on_file], [true, true]);
    eq('the dome flag rides through', fc['402'].dome, true);
    /* THE ASSERTION THIS FILE EXISTS FOR. A football game the file has nothing
       for must come back as CHECKED and NOT on file: the kernel reads that as
       a data hole. If it came back absent, the kernel would read it as an
       unwired sport and hold it neutral — the same silence, the wrong answer. */
    eq('a football game with no row is marked checked and empty', [fc['403'].checked, fc['403'].on_file], [true, false]);
    chk('and carries no invented readings', fc['403'].wind_mph === undefined && fc['403'].temp_f === undefined, fc['403']);
    chk('a sport the football forecast file does not cover is simply absent', fc['900'] === undefined, fc['900']);
    chk('every entry names the file it came from', ['401', '402', '403'].every((k) => /forecasts\.json/.test(fc[k].source)), fc);
    /* the observation time is the forecast's own, not the artifact's, where it has one */
    eq('the forecast’s own observation time is used', fc['401'].observed_at, '2026-09-19T12:00:00.000Z');
  }

  /* ═══ 2. A FAILED READ IS A STATED FAILURE ═══════════════════════════ */
  {
    const errors = [];
    const fc = await m.stakeForecasts({ getForecasts: async () => ({ json: null, error: 'HTTP 503' }) }, BOARD, null, errors);
    eq('nothing is fabricated when the file cannot be read', fc, {});
    chk('and the failure is recorded rather than swallowed', errors.length === 1 && /forecasts\.json could not be read \(HTTP 503\)/.test(errors[0]), errors);
    const thrown = [];
    const fc2 = await m.stakeForecasts({ getForecasts: async () => { throw new Error('boom'); } }, BOARD, null, thrown);
    eq('a throw is the same: empty, and said out loud', fc2, {});
    chk('with the reason', /boom/.test(thrown[0]), thrown);
    /* a slate with no football on it never reads the file at all */
    let touched = 0;
    const fc3 = await m.stakeForecasts({ getForecasts: async () => { touched++; return { json: FORECASTS }; } }, { all_candidates: [{ sport: 'baseball_mlb', game_id: '900' }] }, null, []);
    eq('a card with no football game does not read the football forecast file', touched, 0);
    eq('and returns nothing rather than an empty promise of coverage', fc3, {});
  }

  /* ═══ 3. IT REACHES THE CANDIDATE ════════════════════════════════════ */
  {
    const S = globalThis.EDSTAKE;
    chk('the staking kernel is loaded in the edge function', !!S);
    const board = {
      all_candidates: [{
        id: 'americanfootball_ncaaf|401|totals|over', sport: 'americanfootball_ncaaf', sport_label: 'college football',
        game_id: '401', matchup: 'North Texas at Army', home: 'Army', away: 'North Texas',
        kickoff: '2026-09-19T17:00:00.000Z', market: 'totals', side: 'over', selection: 'Over 44.5', line: 44.5,
        quote: { book: 'DraftKings', odds_american: -110, odds_decimal: 1.909, captured_at: '2026-09-19T16:45:00.000Z', freshness: 'CURRENT', executable: true, actionable: true },
        fair: { method: 'MARKET_DEVIG', probability: 0.55, push_probability: 0, fair_line: 42, sigma: 10 },
      }],
    };
    const fc = { 401: { checked: true, on_file: true, dome: false, wind_mph: 26, gust_mph: 36, temp_f: 31, precip_in: 0.1, observed_at: '2026-09-19T12:00:00.000Z', kickoff: '2026-09-19T17:00:00.000Z' } };
    const withWx = m.stakeCandidatesFromBoard(board, { now: Date.parse('2026-09-19T16:50:00.000Z'), forecasts: fc });
    chk('the board candidate carries the forecast', withWx[0].weather && withWx[0].weather.wind_mph === 26, withWx[0] && withWx[0].weather);
    const without = m.stakeCandidatesFromBoard(board, { now: Date.parse('2026-09-19T16:50:00.000Z') });
    eq('and carries null rather than a guess when no map was passed', without[0].weather, null);
    /* the kernel then reads it: same candidate, different reliability */
    const SET = S.settings({ bankroll_amount: 2500, base_unit_amount: 25 }, {});
    const opts = { settings: SET, timezone: 'America/Chicago', now: Date.parse('2026-09-19T16:50:00.000Z') };
    const gale = S.evaluate(withWx[0], opts), quiet = S.evaluate(without[0], opts);
    chk('a gale costs reliability against the same candidate with no forecast wired', gale.reliability_score < quiet.reliability_score, [quiet.reliability_score, gale.reliability_score]);
    chk('and the decision says what it sized under', gale.weather && gale.weather.state === 'SEVERE', gale.weather);
    chk('neither run touched the calibrated probability', gale.calibrated_probability === quiet.calibrated_probability, [gale.calibrated_probability, quiet.calibrated_probability]);
    chk('nor the fair line', gale.fair_line === quiet.fair_line, [gale.fair_line, quiet.fair_line]);
  }

  /* ═══ 4. THE SINGLE-GAME PATH READS THE PACKET'S OWN FORECAST ════════ */
  {
    const packet = {
      game: { sport: 'americanfootball_nfl', game_id: '402', home: 'Bears', away: 'Packers', kickoff: '2026-09-19T17:00:00.000Z' },
      situation: { weather: { value: { wind_mph: 22, gust_mph: 30, temp_f: 28, precip_in: 0, dome: false }, source: 'football/venues/forecasts.json', observed_at: '2026-09-19T12:00:00.000Z' } },
      market: { state: 'LIVE', primary: { market: 'totals', side: 'over', book: 'DraftKings', captured_at: '2026-09-19T16:45:00.000Z' } },
      confidence: { data: { score: 0.8 } }, availability: { state: 'OFFICIAL_REPORT' },
    };
    const pricing = { sides: [{ market: 'total', side: 'over', selection: 'Over 41', market_total: 41, fair_total: 39, sigma: 10, cover_at_market: 0.54, push_at_market: 0, odds_american: -110, tier: 'LEAN' }] };
    const out = m.stakeCandidatesFromPricing(pricing, packet, { now: Date.parse('2026-09-19T16:50:00.000Z') });
    chk('the packet’s own forecast is preferred over the slate read', out[0].weather && out[0].weather.wind_mph === 22, out[0] && out[0].weather);
    eq('and is marked as on file, because the research kernel found it', [out[0].weather.checked, out[0].weather.on_file], [true, true]);
    /* the packet says it looked and found nothing → the slate read stands in */
    const missing = Object.assign({}, packet, { situation: { weather: { missing: true, why: 'no weather forecast was retrieved for this game' } } });
    const fb = m.stakeCandidatesFromPricing(pricing, missing, { now: Date.now(), forecasts: { 402: { checked: true, on_file: false } } });
    eq('a packet with no forecast falls back to the slate read', [fb[0].weather.checked, fb[0].weather.on_file], [true, false]);
    const none = m.stakeCandidatesFromPricing(pricing, missing, { now: Date.now() });
    eq('and to null when there is no slate read either', none[0].weather, null);
  }

  /* ═══ 5. THE REFRESH IS TARGETED, AND ITS OUTCOME IS MEASURED ════════ */
  {
    const NOW = Date.parse('2026-09-19T16:00:00.000Z');
    const HOUR = 3600000;
    const sig = (mk, at, sel) => ({ market: mk, selection: sel || 'home', last_seen_at: new Date(at).toISOString() });
    const index = [
      /* a live game with a price that went stale hours ago: a real target */
      { game_id: 'g1', kickoff: new Date(NOW + 3 * HOUR).toISOString(), signals: [sig('spreads', NOW - 8 * HOUR)] },
      /* the same staleness, but the game already kicked off: NOT a target,
         because no capture pass can make that price bettable */
      { game_id: 'g2', kickoff: new Date(NOW - 2 * HOUR).toISOString(), signals: [sig('spreads', NOW - 8 * HOUR)] },
      /* fresh: not a target */
      { game_id: 'g3', kickoff: new Date(NOW + 3 * HOUR).toISOString(), signals: [sig('totals', NOW - 60000)] },
      /* a market EdgeDesk does not size: not a target either */
      { game_id: 'g4', kickoff: new Date(NOW + 3 * HOUR).toISOString(), signals: [sig('player_props', NOW - 8 * HOUR)] },
    ];
    const t = m.refreshTargets(index, NOW);
    eq('only the stale price on an unstarted, sizeable market is a target', t.map((x) => x.game_id), ['g1']);
    eq('and it carries the market and the capture time that made it one', [t[0].market, t[0].status], ['spreads', 'STALE']);
    eq('a card with nothing aged has no targets at all', m.refreshTargets([index[2]], NOW), []);

    /* THE OUTCOME. A refresh that changed nothing must be recorded as one:
       that is the only way the cost of the capture call ever shows up. */
    const after = m.refreshTargets(index.map((g) => (g.game_id === 'g1'
      ? Object.assign({}, g, { signals: [sig('spreads', NOW - 60000)] }) : g)), NOW);
    const won = m.refreshOutcome(t, after);
    eq('a target that came back current is counted', [won.targets_before, won.made_current, won.still_stale], [1, 1, 0]);
    eq('and the refresh is recorded as having changed an answer', won.changed_an_answer, true);
    chk('in words a reader can check', /no longer refused for staleness/.test(won.note), won.note);

    const lost = m.refreshOutcome(t, m.refreshTargets(index, NOW));
    eq('a refresh that changed nothing is recorded as changing nothing', lost.changed_an_answer, false);
    eq('with the targets still stale', [lost.made_current, lost.still_stale], [0, 1]);
    chk('and says the refusals stand', /the refusals stand/.test(lost.note), lost.note);
    /* a price that MOVED but is still outside the limit is still a refusal,
       and the movement is recorded rather than read as a success */
    const moved = m.refreshOutcome(t, m.refreshTargets(index.map((g) => (g.game_id === 'g1'
      ? Object.assign({}, g, { signals: [sig('spreads', NOW - 6 * HOUR)] }) : g)), NOW));
    eq('a price that moved but is still stale is not a changed answer', moved.changed_an_answer, false);
    eq('though the movement is counted', moved.prices_that_moved, 1);
    eq('nothing to do on an empty card', m.refreshOutcome([], []).targets_before, 0);
    chk('and it says so rather than reporting a success', /nothing was refreshed/.test(m.refreshOutcome([], []).note));
  }

  done();
})().catch((e) => { console.error(e.stack || e); process.exit(2); });
