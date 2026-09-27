/* Fixtures for the desk kernel tests: realistic CFB and NFL game inputs in the
   shape the host (edgedesk_ai/index.ts deskGameInput) hands to EDDESK.evidence.
   Every value is chosen for the test; none is a claim about a real game. */
'use strict';

const H = 3600000;

function contractRow(field, side, state, detail, asOf) {
  return { field, side, state, detail, source: 'fixture', as_of: asOf || null, priced: state === 'USABLE' };
}

/** UCLA at Maryland: projection Maryland -0.2, market Maryland -3.5 (UCLA +3.5). */
function cfbGame(now, o) {
  o = o || {};
  const kick = new Date(now + (o.kick_h != null ? o.kick_h : 30) * H).toISOString();
  const cap = new Date(now - (o.market_age_min != null ? o.market_age_min : 20) * 60000).toISOString();
  return {
    sport: 'americanfootball_ncaaf', now,
    game: { game_id: o.game_id || 'cfb-ucla-md', home: o.home || 'Maryland', away: o.away || 'UCLA', kickoff: kick, venue: 'SECU Stadium', neutral_site: false, status: 'scheduled', season: 2026, week: 4 },
    projection: {
      home_line: o.proj_home_line != null ? o.proj_home_line : -0.2, total: o.proj_total != null ? o.proj_total : 51.5,
      home_win_prob: o.proj_wp != null ? o.proj_wp : 0.505, version: 'edgedesk_cfb_p4_v1.0.0',
      generated_at: new Date(now - 6 * H).toISOString(),
      completeness: 0.8, information_confidence: o.info != null ? o.info : 88, priced_confidence: 55
    },
    market: o.no_market ? {} : {
      spread: { home_line: o.market_home_line != null ? o.market_home_line : -3.5, book: 'DraftKings', price_home: -110, price_away: o.away_price != null ? o.away_price : -110,
        captured_at: o.market_captured_at === null ? null : cap, executable: o.executable !== false, source: 'signals (EdgeDesk capture)', freshness: o.freshness },
      total: { line: o.market_total != null ? o.market_total : 51.5, book: 'DraftKings', price_over: -110, price_under: -110, captured_at: cap, executable: true, freshness: o.freshness },
      moneyline: { home: o.ml_home != null ? o.ml_home : -160, away: o.ml_away != null ? o.ml_away : 135, book: 'DraftKings', captured_at: cap, freshness: o.freshness },
      open: { home_line: o.open_home_line != null ? o.open_home_line : -2.5, captured_at: new Date(now - 72 * H).toISOString() }
    },
    contract: o.contract || [
      contractRow('team_rating', 'home', 'USABLE', 'rated 4.10, blended with the trained prior'),
      contractRow('team_rating', 'away', 'USABLE', 'rated 7.90, blended with the trained prior'),
      contractRow('roster_talent', 'home', 'USABLE', 'composite 61.2 at confidence 0.6'),
      contractRow('roster_talent', 'away', 'USABLE', 'composite 66.0 at confidence 0.6'),
      contractRow('qb_starter', 'home', 'RESEARCH_ONLY', 'started the last game'),
      contractRow('qb_starter', 'away', 'RESEARCH_ONLY', 'started the last game'),
      contractRow('availability', 'home', 'USABLE', 'Big Ten availability report filed', new Date(now - 10 * H).toISOString()),
      contractRow('availability', 'away', 'USABLE', 'Big Ten availability report filed', new Date(now - 10 * H).toISOString()),
      contractRow('coaching_continuity', 'home', 'RESEARCH_ONLY', 'Mike Locksley since 2019'),
      contractRow('coaching_continuity', 'away', 'RESEARCH_ONLY', 'FIRST SEASON: new head coach'),
      contractRow('schedule_context', 'home', 'USABLE', 'rest 7d'),
      contractRow('schedule_context', 'away', 'USABLE', 'rest 7d'),
      contractRow('venue_geography', 'home', 'USABLE', 'SECU Stadium'),
      contractRow('weather', null, 'RESEARCH_ONLY', 'forecast retrieved', new Date(now - 2 * H).toISOString())
    ],
    cfb: {
      home_starter: { player_name: 'Home QB', status: 'PREVIOUS_GAME', confirmed: false },
      away_starter: { player_name: 'Away QB', status: 'PREVIOUS_GAME', confirmed: false },
      home_qb_epa: { state: 'MEASURED', season: { state: 'MEASURED', epa_per_dropback: 0.05, dropbacks: 110 } },
      away_qb_epa: { state: 'MEASURED', season: { state: 'MEASURED', epa_per_dropback: 0.19, dropbacks: 120 } }
    }
  };
}

/** A margin cover curve from a normal (fixture only; the NFL build publishes the real one). */
function curve(projHome, sigma) {
  const out = [];
  function cdf(x) { const t = 1 / (1 + 0.3275911 * Math.abs(x / Math.SQRT2)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x / 2); return 0.5 * (1 + (x >= 0 ? y : -y)); }
  for (let L = -20; L <= 20; L += 0.5) {
    const m = -projHome; /* projected home margin */
    const whole = Math.abs(L - Math.round(L)) < 1e-9;
    const push = whole ? 0.03 : 0;
    const win = 1 - cdf((-L - m) / sigma) - push / 2;
    out.push({ home_line: L, win: Math.round(win * 10000) / 10000, push, lose: Math.round((1 - win - push) * 10000) / 10000 });
  }
  return out;
}

/** Giants at Rams: projection Rams -6.9, market Rams -6.5 unless overridden. */
function nflGame(now, o) {
  o = o || {};
  const kick = new Date(now + (o.kick_h != null ? o.kick_h : 40) * H).toISOString();
  const cap = new Date(now - (o.market_age_min != null ? o.market_age_min : 15) * 60000).toISOString();
  const proj = o.proj_home_line != null ? o.proj_home_line : -6.9;
  return {
    sport: 'americanfootball_nfl', now,
    game: { game_id: o.game_id || '2026_03_NYG_LA', home: o.home || 'Los Angeles Rams', away: o.away || 'New York Giants', kickoff: kick, venue: 'SoFi Stadium', status: 'scheduled', season: 2026, week: 3 },
    projection: {
      home_line: proj, total: o.proj_total != null ? o.proj_total : 49.25, home_win_prob: o.proj_wp != null ? o.proj_wp : 0.7406,
      version: 'edgedesk_football_v1.0.0', generated_at: new Date(now - 20 * H).toISOString(),
      cover_curve: o.no_curve ? null : curve(proj, 13),
      contributions: [{ key: 'baseline', points: 2.48 }, { key: 'net_pass', points: 1.25 }, { key: 'net_epa', points: 0.95 }, { key: 'qb_adj_diff', points: 0.8 }, { key: 'net_rush', points: -0.5 }]
    },
    market: {
      spread: { home_line: o.market_home_line != null ? o.market_home_line : -6.5, book: 'FanDuel', price_home: -110, price_away: -110, captured_at: cap, executable: true, freshness: o.freshness },
      total: { line: 47.5, book: 'FanDuel', price_over: -110, price_under: -110, captured_at: cap, executable: true, freshness: o.freshness },
      moneyline: { home: -298, away: 240, book: 'FanDuel', captured_at: cap, freshness: o.freshness }
    },
    nfl: {
      home_starter: o.no_qb ? null : { player_name: 'Matthew Stafford', status: 'SCHEDULE_FEED', source: 'nflverse games.csv' },
      away_starter: o.no_qb ? null : { player_name: 'Jaxson Dart', status: 'SCHEDULE_FEED', source: 'nflverse games.csv' },
      home_rest: 7, away_rest: 7, roof: 'dome', surface: 'matrixturf', div_game: false,
      data_quality: { status: 'OK', missing: [], warnings: [] },
      injuries: o.no_injuries ? null : { home: [], away: [{ player: 'WR One', position: 'WR', status: 'Questionable' }], as_of: new Date(now - 5 * H).toISOString(), source: 'official NFL injury report' }
    }
  };
}

module.exports = { cfbGame, nflGame, curve };
