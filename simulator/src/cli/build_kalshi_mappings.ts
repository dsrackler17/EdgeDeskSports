/* ===========================================================================
   edgedesk-sim build-kalshi-mappings — write one sport's part of
   simulator/config/kalshi_futures.json from the markets the source check read
   (kalshi_candidates[_mlb].json, the artifact of
   .github/workflows/simulator-sources.yml, or the job's log itself).

     node simulator/src/cli/build_kalshi_mappings.ts [--sport nfl|mlb|nhl|cfb] --candidates <kalshi_candidates.json> --run <actions run id> [--check]
     node simulator/src/cli/build_kalshi_mappings.ts --sport cfb --log <the fetch (cfb) job's log> --run <actions run id>

   A market is mapped ONLY when every check passes:
     - its series is one of SERIES (NFL), MLB_SERIES, NHL_SERIES or CFB_SERIES below, whose
       settlement wording names exactly one simulated outcome;
     - its rules text matches that series' template word for word, and the
       club it names is the market's own label (MLB: the label Kalshi gives
       the club its ticker names; the season the rules name is the event
       ticker's, and the mapping is that season's; college football: the
       label is a 2026 FBS team's name, read through KALSHI_CFB_NAME, and
       its ticker suffix carries that one label in every market);
     - its secondary rules are nothing but Kalshi's standard disclaimer;
     - its ticker names a club of the configured alignment, in the conference,
       league or division the series (or the rules) names;
     - its series is the quadratic fee type with multiplier 1 (the fee formula
       the comparison applies).
   Anything else is left out and listed. A set of markets becomes an outcome
   set (for normalisation) only when it is complete: one market for every
   club that can win it. The rules sha256 is the hash the comparison checks
   on every quote, so a market whose wording later changes is excluded until
   it is mapped again.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NFL_TEAMS_2026 } from '../sports/nfl/config.ts';
import { DIVISIONS, teamsFor } from '../sports/mlb/config.ts';
import { NHL_TEAMS_2027 } from '../sports/nhl/config.ts';
import { NBA_TEAMS } from '../sports/nba/config.ts';
import { NBA_OUTCOME_SEMANTICS } from '../sports/nba/module.ts';
import type { FuturesConfig, Mapping, OutcomeSet } from '../markets/compare.ts';
import { FUTURES_CONFIG } from './markets.ts';
import { readSnapshot } from '../sports/cfb/inputs.ts';

export const DISCLAIMER = 'Kalshi is not affiliated, associated, authorized, endorsed by, or in any way officially connected with the Governing League. All trademarks, logos, and brand names are the property of their respective owners.';
/** Kalshi ticker suffix -> nflverse code (the simulator's entity id); every other suffix is the same */
export const KALSHI_TO_NFLVERSE: Record<string, string> = { JAC: 'JAX', LAR: 'LA' };

/* The season token in a 2026-season event ticker: Kalshi names the season by the year it ends
   (KXSB-27, KXNFLAFCEAST-27, KXNFLSEED-27AFC2) except the #1-seed series, which uses the year it
   starts (KXNFL1SEED-AFC26). The conference, division and playoff rules name no season, so without
   this check next season's -28 markets would map onto this season's simulation (2026-10-23 audit). */
export const NFL_EVENT_YEAR = '27';
interface SeriesRule { outcome: string; conf?: 'AFC' | 'NFC'; div?: string; re: RegExp; basis: string; event_year?: string }
const DIVS = ['East', 'North', 'South', 'West'];
export const SERIES: Record<string, SeriesRule> = {
  KXSB: { outcome: 'win_super_bowl', re: /^If (.+) wins the 2027 Pro Football Championship, then the market resolves to Yes\.$/,
    basis: 'wins the 2027 Pro Football Championship (Super Bowl LXI, ending the 2026 season) = win_super_bowl' },
  KXNFLAFCCHAMP: { outcome: 'win_conference', conf: 'AFC', re: /^If (.+) wins the Pro Football AFC Championship, then the market resolves to Yes\.$/,
    basis: 'wins the AFC Championship = win_conference (reaches the Super Bowl)' },
  KXNFLNFCCHAMP: { outcome: 'win_conference', conf: 'NFC', re: /^If (.+) wins the Pro Football NFC Championship, then the market resolves to Yes\.$/,
    basis: 'wins the NFC Championship = win_conference (reaches the Super Bowl)' },
  KXNFLPLAYOFF: { outcome: 'make_playoffs', re: /^If (.+) is one of the Pro Football playoff qualifiers, then the market resolves to Yes\.$/,
    basis: 'is one of the playoff qualifiers = make_playoffs' },
  KXNFL1SEED: { outcome: 'seed_1', event_year: '26', re: /^If (.+) is the #1 seed in the (American|National) Football Conference at the conclusion of the 2026-2027 Pro Football regular season ?, then the market resolves to Yes\.$/,
    basis: 'is the #1 seed in its conference at the end of the 2026 regular season = seed_1' },
  KXNFLSEED: { outcome: 'seed_k', re: /^If (.+) is the #([1-7]) seed in the (American|National) Football Conference in the 2026-27 Pro Football playoffs, then the market resolves to Yes\.$/,
    basis: 'is the #k seed in its conference in the 2026-27 playoffs = seed_k' }
};
for (const c of ['AFC', 'NFC'] as const) for (const d of DIVS)
  SERIES['KXNFL' + c + d.toUpperCase()] = { outcome: 'win_division', div: c + ' ' + d, re: new RegExp('^If (.+) wins the Pro Football ' + c + ' ' + d + ' Division, then the market resolves to Yes\\.$'),
    basis: 'wins the ' + c + ' ' + d + ' Division (the league\'s tiebreakers decide a tie) = win_division' };

export interface Candidate { series_ticker: string; event_ticker: string; market_ticker: string; yes_sub_title: string; rules_primary: string; rules_secondary: string | null; rules_sha256: string }
export interface SeriesInfo { ticker: string; fee_type: string; fee_multiplier: number | string }

export function buildMappings(markets: Candidate[], series: SeriesInfo[], verified: { by: string; at: string }) {
  const mappings: Mapping[] = [], left: Array<{ market_ticker: string; why: string[] }> = [];
  const fee = new Map(series.map((s) => [s.ticker, s]));
  const squash = (x: string | null) => String(x || '').replace(/\s+/g, ' ').trim();
  for (const k of markets) {
    const rule = SERIES[k.series_ticker];
    if (!rule) continue;                                    // a series with no simulated outcome is not a candidate at all
    const why: string[] = [];
    const sf = fee.get(k.series_ticker);
    if (!sf || !/^quadratic/.test(sf.fee_type) || Number(sf.fee_multiplier) !== 1) why.push('series fee is ' + (sf ? sf.fee_type + ' x' + sf.fee_multiplier : 'unknown') + ', not quadratic x1');
    const suffix = k.market_ticker.split('-').pop() as string, code = KALSHI_TO_NFLVERSE[suffix] || suffix;
    const team = NFL_TEAMS_2026.find((t) => t.code === code);
    if (!team) why.push('ticker suffix ' + suffix + ' is not a club');
    const m = squash(k.rules_primary).match(rule.re);
    if (!m) why.push('rules text does not match the ' + k.series_ticker + ' template');
    else if (m[1] !== squash(k.yes_sub_title)) why.push('rules name "' + m[1] + '" but the market is labelled "' + k.yes_sub_title + '"');
    if (squash(k.rules_secondary) !== DISCLAIMER) why.push('secondary rules carry more than the standard disclaimer');
    if (!/^[0-9a-f]{64}$/.test(k.rules_sha256 || '')) why.push('no rules sha256');
    const yy = rule.event_year || NFL_EVENT_YEAR;
    if (!new RegExp('^' + k.series_ticker + '-(?:AFC|NFC)?' + yy + '(?![0-9])').test(k.event_ticker)) why.push('event ' + k.event_ticker + ' is not the 2026 season (expected season token ' + yy + ')');
    let outcome = rule.outcome;
    if (team && rule.conf && team.conference !== rule.conf) why.push(team.code + ' is not in the ' + rule.conf);
    if (team && rule.div && team.division !== rule.div) why.push(team.code + ' is not in the ' + rule.div);
    if (m && (k.series_ticker === 'KXNFL1SEED' || k.series_ticker === 'KXNFLSEED')) {
      const named = (k.series_ticker === 'KXNFL1SEED' ? m[2] : m[3]) === 'American' ? 'AFC' : 'NFC';
      if (team && team.conference !== named) why.push(team.code + ' is not in the ' + named);
      if (!k.event_ticker.includes(named)) why.push('event ' + k.event_ticker + ' does not name the ' + named);
      if (k.series_ticker === 'KXNFLSEED') outcome = 'seed_' + m[2];
    }
    if (why.length || !team) { left.push({ market_ticker: k.market_ticker, why }); continue; }
    const set = outcome === 'make_playoffs' ? null : outcome === 'win_super_bowl' ? 'nfl2026:win_super_bowl'
      : outcome === 'win_division' ? 'nfl2026:win_division:' + team.division : 'nfl2026:' + outcome + ':' + team.conference;
    mappings.push({ mapping_id: 'nfl2026:' + k.market_ticker, status: 'verified', sport: 'nfl', competition: 'NFL', season: '2026',
      series_ticker: k.series_ticker, event_ticker: k.event_ticker, market_ticker: k.market_ticker, entity_id: team.code, outcome, outcome_set: set,
      settlement: { basis: 'Kalshi ' + k.series_ticker + ': ' + rule.basis.replace('seed_k', outcome), rules_sha256: k.rules_sha256, rules_excerpt: squash(k.rules_primary) },
      verified_by: verified.by, verified_at: verified.at });
  }
  mappings.sort((a, b) => a.market_ticker.localeCompare(b.market_ticker));
  /* complete sets only: every club that can win the outcome has its market */
  const members = new Map<string, Mapping[]>();
  for (const x of mappings) if (x.outcome_set) members.set(x.outcome_set, [...(members.get(x.outcome_set) || []), x]);
  const sets: OutcomeSet[] = [];
  for (const [id, ms] of [...members].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = id.split(':'), scope = parts[2];
    const eligible = NFL_TEAMS_2026.filter((t) => !scope || t.conference === scope || t.division === scope).map((t) => t.code);
    const have = new Set(ms.map((x) => x.entity_id)), outcomes = new Set(ms.map((x) => x.outcome));
    if (outcomes.size !== 1 || have.size !== ms.length || eligible.some((e) => !have.has(e)) || ms.length !== eligible.length) {
      for (const x of ms) x.outcome_set = null;   // incomplete: compared one market at a time, never normalised
      continue;
    }
    sets.push({ id, outcome: ms[0].outcome, entities: eligible.slice().sort(), mutually_exclusive: true, exhaustive: true,
      note: 'exactly one of these clubs ' + (ms[0].outcome === 'win_super_bowl' ? 'wins the Super Bowl' : ms[0].outcome === 'win_conference' ? 'wins the ' + scope : ms[0].outcome === 'win_division' ? 'wins the ' + scope : 'is the ' + scope + ' #' + ms[0].outcome.split('_')[1] + ' seed') });
  }
  return { mappings, sets, left };
}

/* ---------------------------------------------------------------- MLB and the NHL: one season-keyed builder */
interface LeagueTeam { code: string; name: string; group: string; division: string }
/** A series' template. It captures the club and the season: named groups `club` and `season`, or groups 1 and 2.
    outcome, group (the league or conference the series names) and basis may read the match (an NBA seed's number,
    its conference); secondary: the only secondary rules texts the series may carry (default: Kalshi's standard
    disclaimer alone), or a test of the text against the match; season: the season key when the rules write it
    otherwise (the NBA Finals' "2027"); check: any further agreement between the rules and the market ('' or why
    not); noSet: never one of a normalised set (several clubs reach it, or the simulator's set is not Kalshi's) */
interface LeagueSeriesRule {
  outcome: string | ((m: RegExpMatchArray) => string); group?: string | ((m: RegExpMatchArray) => string); div?: string;
  re: RegExp; basis: string | ((m: RegExpMatchArray) => string); secondary?: string[] | ((text: string, m: RegExpMatchArray) => boolean);
  season?: (m: RegExpMatchArray) => string; check?: (m: RegExpMatchArray, k: Candidate) => string; noSet?: boolean;
}
interface LeagueSpec {
  sport: string; competition: string; series: Record<string, LeagueSeriesRule>;
  /** Kalshi ticker suffix -> the simulator's entity id; every other suffix is the same */
  suffix: Record<string, string>;
  /** the clubs of a season (null: no alignment configured, so nothing of that season maps) */
  teams(season: string): LeagueTeam[] | null;
  /** '' when the label is the club's own, else why not */
  label(team: LeagueTeam, label: string): string;
  /** the note of a complete outcome set */
  note(outcome: string, scope: string): string;
  /** what the outcome settles on, for a run that declares outcome_semantics (the NBA's) */
  semantic?(outcome: string): string;
}

/* Each template captures the club (1) and the season (2); the event ticker must name that season (KXMLB-26: 2026;
   a two-year season by either year, as Kalshi does both: KXNHL-27 and KXNBAPACIFIC-26 are 2026-27), so next
   season's markets map to next season's run as soon as Kalshi lists them. */
function buildLeagueMappings(spec: LeagueSpec, markets: Candidate[], series: SeriesInfo[], verified: { by: string; at: string }) {
  const mappings: Mapping[] = [], left: Array<{ market_ticker: string; why: string[] }> = [];
  const fee = new Map(series.map((s) => [s.ticker, s]));
  const squash = (x: string | null) => String(x || '').replace(/\s+/g, ' ').trim();
  for (const k of markets) {
    const rule = spec.series[k.series_ticker];
    if (!rule) continue;                                    // a series with no simulated outcome is not a candidate at all
    const why: string[] = [];
    const sf = fee.get(k.series_ticker);
    if (!sf || !/^quadratic/.test(sf.fee_type) || Number(sf.fee_multiplier) !== 1) why.push('series fee is ' + (sf ? sf.fee_type + ' x' + sf.fee_multiplier : 'unknown') + ', not quadratic x1');
    const m = squash(k.rules_primary).match(rule.re);
    const club = m ? (m.groups?.club ?? m[1]) : '';
    if (!m) why.push('rules text does not match the ' + k.series_ticker + ' template');
    else if (club !== squash(k.yes_sub_title)) why.push('rules name "' + club + '" but the market is labelled "' + k.yes_sub_title + '"');
    const season = m ? (rule.season ? rule.season(m) : m.groups?.season ?? m[2]) : '';
    const extra = m && rule.check ? rule.check(m, k) : '';
    if (extra) why.push(extra);
    const years = season.length === 4 ? season.slice(2) : season.slice(2, 4) + '|' + season.slice(-2);
    if (m && !new RegExp('^' + k.series_ticker + '-(' + years + ')(?![0-9])').test(k.event_ticker)) why.push('event ' + k.event_ticker + ' is not the ' + season + ' season');
    const teams = m ? spec.teams(season) : null;
    if (m && !teams) why.push('no ' + spec.competition + ' alignment is configured for ' + season);
    const suffix = k.market_ticker.split('-').pop() as string, code = spec.suffix[suffix] || suffix;
    const team = teams ? teams.find((t) => t.code === code) : undefined;
    if (teams && !team) why.push('ticker suffix ' + suffix + ' is not a club');
    const lab = team ? spec.label(team, squash(k.yes_sub_title)) : '';
    if (lab) why.push(lab);
    const sec = squash(k.rules_secondary), allowed = rule.secondary || [DISCLAIMER];
    if (!(typeof allowed === 'function' ? !!m && allowed(sec, m) : allowed.includes(sec))) why.push('secondary rules are not the series\' own (' + (rule.secondary ? 'its stated text' : 'the standard disclaimer alone') + ')');
    if (!/^[0-9a-f]{64}$/.test(k.rules_sha256 || '')) why.push('no rules sha256');
    const group = m && rule.group ? (typeof rule.group === 'function' ? rule.group(m) : rule.group) : undefined;
    if (team && group && team.group !== group) why.push(team.code + ' is not in the ' + group);
    if (team && rule.div && team.division !== rule.div) why.push(team.code + ' is not in the ' + rule.div);
    if (why.length || !team || !m) { left.push({ market_ticker: k.market_ticker, why }); continue; }
    const o = typeof rule.outcome === 'function' ? rule.outcome(m) : rule.outcome, id = spec.sport + season;
    const set = rule.noSet || o === 'make_playoffs' ? null : rule.div ? id + ':' + o + ':' + team.division : group ? id + ':' + o + ':' + team.group : id + ':' + o;
    mappings.push({ mapping_id: id + ':' + k.market_ticker, status: 'verified', sport: spec.sport, competition: spec.competition, season,
      series_ticker: k.series_ticker, event_ticker: k.event_ticker, market_ticker: k.market_ticker, entity_id: team.code, outcome: o, outcome_set: set,
      settlement: { basis: 'Kalshi ' + k.series_ticker + ': ' + (typeof rule.basis === 'function' ? rule.basis(m) : rule.basis), rules_sha256: k.rules_sha256, rules_excerpt: squash(k.rules_primary), ...(spec.semantic ? { semantic: spec.semantic(o) } : {}) },
      verified_by: verified.by, verified_at: verified.at });
  }
  mappings.sort((a, b) => a.market_ticker.localeCompare(b.market_ticker));
  /* complete sets only: every club that can win the outcome has its market (a finished season's eliminated clubs
     have none, so a final down to two clubs is compared one market at a time) */
  const members = new Map<string, Mapping[]>();
  for (const x of mappings) if (x.outcome_set) members.set(x.outcome_set, [...(members.get(x.outcome_set) || []), x]);
  const sets: OutcomeSet[] = [];
  for (const [id, ms] of [...members].sort((a, b) => a[0].localeCompare(b[0]))) {
    const scope = id.split(':')[2];
    const eligible = (spec.teams(ms[0].season) || []).filter((t) => !scope || t.group === scope || t.division === scope).map((t) => t.code);
    const have = new Set(ms.map((x) => x.entity_id));
    if (have.size !== ms.length || ms.length !== eligible.length || eligible.some((e) => !have.has(e))) {
      for (const x of ms) x.outcome_set = null;   // incomplete: compared one market at a time, never normalised
      continue;
    }
    sets.push({ id, outcome: ms[0].outcome, entities: eligible.slice().sort(), mutually_exclusive: true, exhaustive: true, note: spec.note(ms[0].outcome, scope) });
  }
  return { mappings, sets, left };
}

/* ---------------------------------------------------------------- MLB */
/** Kalshi ticker suffix -> Retrosheet franchise key (the simulator's MLB entity id); every other suffix is the same */
export const KALSHI_TO_RETRO: Record<string, string> = { ATH: 'OAK', AZ: 'ARI', CHC: 'CHN', CWS: 'CHA', KC: 'KCA', LAA: 'ANA', LAD: 'LAN', NYM: 'NYN', NYY: 'NYA',
  SD: 'SDN', SF: 'SFN', STL: 'SLN', TB: 'TBA', WSH: 'WAS' };
/** the label (yes_sub_title) Kalshi gives each club, by Retrosheet key: the ticker and the label must name the same
    club. One label per club across every MLB futures market Kalshi listed, open or settled (run 40019030435). */
export const KALSHI_LABEL: Record<string, string> = {
  BAL: 'Baltimore', BOS: 'Boston', NYA: 'New York Y', TBA: 'Tampa Bay', TOR: 'Toronto',
  CHA: 'Chicago WS', CLE: 'Cleveland', DET: 'Detroit', KCA: 'Kansas City', MIN: 'Minnesota',
  ANA: 'Los Angeles A', HOU: 'Houston', OAK: 'A\'s', SEA: 'Seattle', TEX: 'Texas',
  ATL: 'Atlanta', MIA: 'Miami', NYN: 'New York M', PHI: 'Philadelphia', WAS: 'Washington',
  CHN: 'Chicago C', CIN: 'Cincinnati', MIL: 'Milwaukee', PIT: 'Pittsburgh', SLN: 'St. Louis',
  ARI: 'Arizona', COL: 'Colorado', LAN: 'Los Angeles D', SDN: 'San Diego', SFN: 'San Francisco'
};

/* Kalshi's wording, from the 2026 markets (run 40019030435: the World Series open, every other series settled).
   Not mapped: the league or division of the champion, exact World Series matchups, the champion's seed, win
   totals, awards and props (no club's simulated outcome settles on them), and Kalshi's older series under other
   tickers (KXMLBWS, KXWSAL, KXWSNL, KXMLBDIVWINNER, KXMBLNLEAST), which listed no market in 2026. */
export const MLB_SERIES: Record<string, LeagueSeriesRule> = {
  KXMLB: { outcome: 'win_world_series', re: /^If (.+) wins the (\d{4}) Pro Baseball Championship, then the market resolves to Yes\.$/,
    basis: 'wins the season\'s Pro Baseball Championship (the World Series) = win_world_series' },
  KXMLBAL: { outcome: 'win_pennant', group: 'AL', re: /^If (.+) win the (\d{4}) Pro Baseball American League Championship, then the market resolves to Yes\.$/,
    basis: 'wins the American League Championship (the pennant: reaches the World Series) = win_pennant' },
  KXMLBNL: { outcome: 'win_pennant', group: 'NL', re: /^If (.+) win the (\d{4}) Pro Baseball National League Championship, then the market resolves to Yes\.$/,
    basis: 'wins the National League Championship (the pennant: reaches the World Series) = win_pennant' },
  KXMLBPLAYOFFS: { outcome: 'make_playoffs', re: /^If (.+) is one of the (\d{4}) Pro Baseball Playoff Qualifiers, then the market resolves to Yes\.$/,
    basis: 'is one of the season\'s playoff qualifiers = make_playoffs' }
};
for (const d of DIVISIONS)
  MLB_SERIES['KXMLB' + d.replace(' ', '').replace('Central', 'Cent').toUpperCase()] = { outcome: 'win_division', div: d,
    re: new RegExp('^If (.+) is the (\\d{4}) Pro Baseball ' + d + ' Division Winner, then the market resolves to Yes\\.$'),
    basis: 'is the ' + d + ' Division Winner (the season\'s tiebreak procedure decides a tie) = win_division' };

const MLB_SPEC: LeagueSpec = {
  sport: 'mlb', competition: 'MLB', series: MLB_SERIES, suffix: KALSHI_TO_RETRO,
  teams: (season) => { try { return teamsFor(Number(season)).map((t) => ({ code: t.code, name: t.name, group: t.league, division: t.division })); } catch (_) { return null; } },
  label: (team, label) => KALSHI_LABEL[team.code] === label ? '' : 'labelled "' + label + '", not ' + team.code + '\'s "' + KALSHI_LABEL[team.code] + '"',
  note: (o, scope) => 'exactly one of these clubs ' + (o === 'win_world_series' ? 'wins the World Series' : o === 'win_pennant' ? 'wins the ' + scope + ' pennant' : 'wins the ' + scope)
};
export function buildMlbMappings(markets: Candidate[], series: SeriesInfo[], verified: { by: string; at: string }) { return buildLeagueMappings(MLB_SPEC, markets, series, verified); }

/* ---------------------------------------------------------------- the NHL */
/** Kalshi ticker suffix -> the NHL's own three-letter code (the simulator's entity id); every other suffix is the same */
export const KALSHI_TO_NHL: Record<string, string> = { LA: 'LAK', NJ: 'NJD', SJ: 'SJS', TB: 'TBL' };
/** KXNHLPRES's secondary rules: the Presidents' Trophy tiebreakers, which are the simulator's NHL-TB-2019 steps
    after points (every club plays 84 games, so points percentage separates no club that points do not) */
export const NHL_PRES_TIEBREAK = 'If teams finish tied in points, the Presidents’ Trophy tiebreakers are: 1) Regulation wins 2) Regulation and overtime wins 3) Total wins 4) Head-to-head points 5) Goal differential 6) Goals scored';

/* Kalshi's wording, from the 2026-27 markets (run 40019030435, every one open). Its labels are the clubs' full names.
   Not mapped: the Stanley Cup Final matchups (KXTEAMSINSC), a Canadian club winning the Cup (KXCANADACUP: any of
   seven clubs), the NBA + NHL champion combination (KXNBANHL), point totals, awards and props. */
export const NHL_SERIES: Record<string, LeagueSeriesRule> = {
  KXNHL: { outcome: 'win_stanley_cup', re: /^If (.+) wins the (\d{4}-\d{2}) Stanley Cup® Finals, then the market resolves to Yes\.$/,
    basis: 'wins the season\'s Stanley Cup Final = win_stanley_cup' },
  KXNHLEAST: { outcome: 'win_conference', group: 'Eastern', re: /^If the (.+) win the (\d{4}-\d{2}) NHL Eastern Conference Finals, then the market resolves to Yes\.$/,
    basis: 'wins the Eastern Conference Final (the playoff conference title: reaches the Stanley Cup Final) = win_conference' },
  KXNHLWEST: { outcome: 'win_conference', group: 'Western', re: /^If the (.+) win the (\d{4}-\d{2}) NHL Western Conference Finals, then the market resolves to Yes\.$/,
    basis: 'wins the Western Conference Final (the playoff conference title: reaches the Stanley Cup Final) = win_conference' },
  KXNHLPRES: { outcome: 'presidents_trophy', re: /^If the (.+) win the (\d{4}-\d{2}) NHL Presidents' Trophy, then the market resolves to Yes\.$/, secondary: [NHL_PRES_TIEBREAK],
    basis: 'wins the Presidents\' Trophy (best regular-season record; its stated tiebreakers are the simulator\'s) = presidents_trophy' },
  KXNHLPLAYOFF: { outcome: 'make_playoffs', re: /^If the (.+) qualify for the playoffs in the (\d{4}-\d{2}) NHL season, then the market resolves to Yes\.$/, secondary: [''],
    basis: 'qualifies for the playoffs = make_playoffs' }
};
for (const d of ['Atlantic', 'Metropolitan', 'Central', 'Pacific'])
  NHL_SERIES['KXNHL' + d.toUpperCase()] = { outcome: 'win_division', div: d, secondary: [''],
    re: new RegExp('^If the (.+) win the (\\d{4}-\\d{2}) NHL ' + d + ' Division, then the market resolves to Yes\\.$'),
    basis: 'wins the ' + d + ' Division (the regular-season division title, D1; the NHL\'s tiebreakers decide a tie) = win_division' };

const deaccent = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '');
const NHL_SPEC: LeagueSpec = {
  sport: 'nhl', competition: 'NHL', series: NHL_SERIES, suffix: KALSHI_TO_NHL,
  /* the 2026-27 clubs and alignment (unchanged since Utah joined in 2024-25); no earlier season maps */
  teams: (season) => Number(season.slice(0, 4)) >= 2026 ? NHL_TEAMS_2027.map((t) => ({ code: t.code, name: t.name, group: t.conference, division: t.division })) : null,
  /* Kalshi writes the club's full name, with or without its accent (Montréal / Montreal) */
  label: (team, label) => deaccent(label) === deaccent(team.name) ? '' : 'labelled "' + label + '", not ' + team.code + '\'s "' + team.name + '"',
  note: (o, scope) => 'exactly one of these clubs ' + (o === 'win_stanley_cup' ? 'wins the Stanley Cup' : o === 'presidents_trophy' ? 'wins the Presidents\' Trophy' : o === 'win_conference' ? 'wins the ' + scope + ' Conference playoffs' : 'wins the ' + scope + ' Division')
};
export function buildNhlMappings(markets: Candidate[], series: SeriesInfo[], verified: { by: string; at: string }) { return buildLeagueMappings(NHL_SPEC, markets, series, verified); }

/* ---------------------------------------------------------------- the NBA */
/** Kalshi ticker suffix -> the ESPN code the NBA module uses (the simulator's entity id); every other suffix is the same */
export const KALSHI_TO_NBA: Record<string, string> = { GSW: 'GS', NOP: 'NO', NYK: 'NY', SAS: 'SA', UTA: 'UTAH', WAS: 'WSH' };
/** the label Kalshi gives each club, by the simulator's code: one per club across all 480 club markets (run 40043908953) */
export const KALSHI_NBA_LABEL: Record<string, string> = {
  BOS: 'Boston', BKN: 'Brooklyn', NY: 'New York', PHI: 'Philadelphia', TOR: 'Toronto',
  CHI: 'Chicago', CLE: 'Cleveland', DET: 'Detroit', IND: 'Indiana', MIL: 'Milwaukee',
  ATL: 'Atlanta', CHA: 'Charlotte', MIA: 'Miami', ORL: 'Orlando', WSH: 'Washington',
  DEN: 'Denver', MIN: 'Minnesota', OKC: 'Oklahoma City', POR: 'Portland', UTAH: 'Utah',
  GS: 'Golden State', LAC: 'Los Angeles C', LAL: 'Los Angeles L', PHX: 'Phoenix', SAC: 'Sacramento',
  DAL: 'Dallas', HOU: 'Houston', MEM: 'Memphis', NO: 'New Orleans', SA: 'San Antonio'
};
const CONF: Record<string, string> = { Eastern: 'East', Western: 'West' };
const NBA_DIVISION_NOTE = 'Division winners are based on the standings at the end of the regular season. If teams are tied for the best record within the division, the winner is determined using the governing league\'s official tie-breaking rules. ';
const NBA_PLAYOFF_NOTE = 'Note: Qualifying for the Pro Basketball play-in tournament does not count as playoff qualification. ';
const g = (m: RegExpMatchArray, k: string) => (m.groups as Record<string, string>)[k];
const eventNames = (k: Candidate, tag: string, what: string) => k.event_ticker.endsWith(tag) ? '' : 'event ' + k.event_ticker + ' does not name ' + what;

/* Kalshi's wording, from the 2026-27 markets (run 40043908953, every one open). Each maps to the outcome whose
   settlement semantic is the market's (NBA_OUTCOME_SEMANTICS): a seed in the conference PLAYOFFS, with seeds 7
   and 8 from the play-in, is seed_k; the #1 seed "at the conclusion of the regular season" is first place in the
   conference standings, finish_1. Not mapped: the Finals matchups, the champion's conference, a group's or a
   first-time champion, seed over/unders, the All-Cup team, a club changing conference, awards and props. */
export const NBA_SERIES: Record<string, LeagueSeriesRule> = {
  KXNBA: { outcome: 'win_title', re: /^If (?<club>.+) wins the (?<year>\d{4}) Pro Basketball Finals, then the market resolves to Yes\.$/,
    season: (m) => (Number(g(m, 'year')) - 1) + '-' + g(m, 'year').slice(2), basis: 'wins the season\'s Pro Basketball Finals (the NBA championship) = win_title' },
  KXNBAPLAYOFF: { outcome: 'make_playoffs', secondary: [NBA_PLAYOFF_NOTE + DISCLAIMER],
    re: /^If (?<club>.+) qualifies for the Pro Basketball Playoffs in the (?<season>\d{4}-\d{2}) season, then the market resolves to Yes\.$/,
    basis: 'qualifies for the playoffs (the play-in alone does not count) = make_playoffs' },
  KXNBAPLAYIN: { outcome: 'play_in', noSet: true, group: (m) => CONF[g(m, 'conf')],
    re: /^If (?<club>.+) qualifies for the Pro Basketball (?<conf>Eastern|Western) Conference Play-In Tournament in the (?<season>\d{4}-\d{2}) season, then the market resolves to Yes\.$/,
    check: (m, k) => eventNames(k, CONF[g(m, 'conf')].toUpperCase(), 'the ' + g(m, 'conf') + ' Conference'),
    basis: (m) => 'qualifies for the ' + g(m, 'conf') + ' Conference play-in tournament (places 7-10) = play_in' },
  KXNBASEED: { outcome: (m) => 'seed_' + g(m, 'k'), group: (m) => CONF[g(m, 'conf')],
    re: /^If (?<club>.+) is the #(?<k>[1-8]) seed in the (?<conf>Eastern|Western) Conference Playoffs in the (?<season>\d{4}-\d{2}) Pro Basketball season, then the market resolves to Yes\.$/,
    secondary: (t, m) => t === 'Important Information: Seeds #1–6 are awarded based on conference standings at the end of the ' + g(m, 'season') + ' regular season. Seeds #7 and #8 are determined by the results of the ' + g(m, 'conf') + ' Conference Play-In Tournament. ' + DISCLAIMER,
    check: (m, k) => eventNames(k, CONF[g(m, 'conf')].toUpperCase() + g(m, 'k'), 'the ' + g(m, 'conf') + ' #' + g(m, 'k') + ' seed'),
    basis: (m) => 'is the #' + g(m, 'k') + ' seed of the ' + g(m, 'conf') + ' Conference playoffs (seeds 7 and 8 from the play-in) = seed_' + g(m, 'k') },
  KXNBACUP: { outcome: 'cup_champion', re: /^If (?<club>.+) is the Emirates (?<cup>\d{4}) Pro Basketball Cup champion in the (?<season>\d{4}-\d{2}) season, then the market resolves to Yes\.$/,
    check: (m) => g(m, 'cup') === g(m, 'season').slice(0, 4) ? '' : 'the ' + g(m, 'cup') + ' Cup is not the ' + g(m, 'season') + ' season\'s',
    basis: 'wins the season\'s Emirates NBA Cup = cup_champion' },
  KXNBACUPGROUP: { outcome: 'cup_win_group', noSet: true, group: (m) => g(m, 'conf'),
    re: /^If (?<club>.+) wins (?<conf>East|West) Group (?<letter>[A-C]) in the Pro Basketball Cup in the (?<season>\d{4}-\d{2}) Pro Basketball season, then the market resolves to Yes\.$/,
    check: (m, k) => eventNames(k, g(m, 'conf').toUpperCase() + g(m, 'letter'), g(m, 'conf') + ' Group ' + g(m, 'letter')),
    basis: (m) => 'wins its NBA Cup group (' + g(m, 'conf') + ' Group ' + g(m, 'letter') + '; the simulator numbers the groups it reads off the schedule, so a group\'s markets are never normalised as a set) = cup_win_group' }
};
for (const c of ['East', 'West']) {
  const conf = c + 'ern';
  NBA_SERIES['KXNBA' + c.toUpperCase()] = { outcome: 'win_conference', group: c,
    re: new RegExp('^If (?<club>.+) wins the Pro Basketball ' + conf + ' Conference Finals in the (?<season>\\d{4}-\\d{2}) season, then the market resolves to Yes\\.$'),
    basis: 'wins the ' + conf + ' Conference Finals (the conference playoff title: reaches the NBA Finals) = win_conference' };
  NBA_SERIES['KXNBA' + c[0] + 'CFQUAL'] = { outcome: 'reach_conference_finals', group: c, noSet: true,
    re: new RegExp('^If (?<club>.+) qualifies for the ' + conf + ' Conference Finals in the (?<season>\\d{4}-\\d{2}) Pro Basketball season, then the market resolves to Yes\\.$'),
    basis: 'reaches the ' + conf + ' Conference Finals (wins its conference semifinal series) = reach_conference_finals' };
  NBA_SERIES['KXNBA' + c.toUpperCase() + '1SEED'] = { outcome: 'finish_1', group: c,
    re: new RegExp('^If (?<club>.+) is the #1 seed in the ' + conf + ' Conference at the conclusion of the (?<season>\\d{4}-\\d{2}) Pro Basketball regular season, then the market resolves to Yes\\.$'),
    basis: 'is the #1 seed of the ' + conf + ' Conference at the end of the regular season (first in its standings) = finish_1' };
}
for (const d of ['Atlantic', 'Central', 'Southeast', 'Northwest', 'Pacific', 'Southwest'])
  NBA_SERIES['KXNBA' + d.toUpperCase()] = { outcome: 'win_division', div: d, secondary: [NBA_DIVISION_NOTE + DISCLAIMER],
    re: new RegExp('^If (?<club>.+) is the ' + d + ' Division winner in the (?<season>\\d{4}-\\d{2}) Pro Basketball season, then the market resolves to Yes\\.$'),
    basis: 'is the ' + d + ' Division winner (regular season; the league\'s tiebreakers decide a tie) = win_division' };

const NBA_SPEC: LeagueSpec = {
  sport: 'nba', competition: 'NBA', series: NBA_SERIES, suffix: KALSHI_TO_NBA,
  /* the alignment, unchanged since 2004-05 (simulator/tests/nba_config.test.ts derives it from the schedules); no earlier season maps */
  teams: (season) => Number(season.slice(0, 4)) >= 2026 ? NBA_TEAMS.map((t) => ({ code: t.code, name: t.name, group: t.conference, division: t.division })) : null,
  label: (team, label) => KALSHI_NBA_LABEL[team.code] === label ? '' : 'labelled "' + label + '", not ' + team.code + '\'s "' + KALSHI_NBA_LABEL[team.code] + '"',
  note: (o, scope) => 'exactly one of these clubs ' + (o === 'win_title' ? 'wins the NBA Finals' : o === 'cup_champion' ? 'wins the NBA Cup' : o === 'win_conference' ? 'wins the ' + scope + ' playoffs'
    : o === 'finish_1' ? 'finishes first in the ' + scope + ' standings' : /^seed_/.test(o) ? 'is the ' + scope + ' #' + o.slice(5) + ' playoff seed' : 'wins the ' + scope + ' Division'),
  semantic: (o) => NBA_OUTCOME_SEMANTICS[o]
};
export function buildNbaMappings(markets: Candidate[], series: SeriesInfo[], verified: { by: string; at: string }) { return buildLeagueMappings(NBA_SPEC, markets, series, verified); }

/* ---------------------------------------------------------------- college football */
/* Kalshi's wording, from the 2026 markets (run 40043881690, job fetch (cfb), 2026-10-24, every one open). Each series
   names one season by its event ticker (KXNCAAF-27 and the playoff-round series by the year the season ends, the
   playoff field and the conferences by the year it starts); the templates that name no season (the title, the field)
   rest on that check. Not mapped:
     - KXNCAAFSEED (seed k, 600 markets: every one Estimated, so never flagged, and any rules change would fail the night's comparison);
     - the one KXNCAAF market worded "the 2026 College Football Playoff National Championship Game" (KXNCAAF-27-UCLA:
       read literally, the game of January 2026, already played);
     - undefeated regular seasons (no simulated outcome), regular-season top finishers, win totals, polls, awards,
       stat leaders, coaches, realignment, the champion's conference, and the older series KXNCAAFBSEC, KXNCAAFBB10,
       KXNCAAFBB12, KXNCAAFBACC, KXNCAAPLAYOFF and KXCFPSEED, which listed no open market. */
const NCAA_DISCLAIMER = 'Kalshi is not affiliated, associated, authorized, endorsed by, or in any way officially connected with the NCAA. All trademarks, logos, and brand names are the property of their respective owners.';
/** the only secondary rules a CFB series carries: the NCAA disclaimer, alone or followed by the standard one */
export const CFB_SECONDARY = [NCAA_DISCLAIMER, NCAA_DISCLAIMER + ' ' + DISCLAIMER];
/** Kalshi labels that are not the 2026 feed's team name once "St." is read "State" (one label per ticker suffix
    across every mapped market of run 40043881690) */
export const KALSHI_CFB_NAME: Record<string, string> = { 'Appalachian St.': 'App State', 'Louisiana-Monroe': 'UL Monroe', 'Miami (FL)': 'Miami',
  'North Carolina St.': 'NC State', 'San Jose St.': 'San José State', 'UMass': 'Massachusetts' };
export const cfbNameOf = (label: string) => KALSHI_CFB_NAME[label] || label.replace(/ St\.$/, ' State');
interface CfbSeriesRule { outcome: string; conf?: string; event: RegExp; re: RegExp; basis: string }
const ifThen = (body: string) => new RegExp('^If (.+) ' + body + ', then the market resolves to Yes\\.$');
export const CFB_SERIES: Record<string, CfbSeriesRule> = {
  KXNCAAF: { outcome: 'national_champion', event: /^KXNCAAF-27$/, re: ifThen('wins the College Football Playoff National Championship Game'),
    basis: 'wins the College Football Playoff National Championship Game of the 2026 season (event KXNCAAF-27) = national_champion' },
  KXNCAAFPLAYOFF: { outcome: 'cfp_field', event: /^KXNCAAFPLAYOFF-26$/, re: ifThen('is one of the teams to qualify for the College Football Playoffs'),
    basis: 'qualifies for the 2026 season\'s College Football Playoff (event KXNCAAFPLAYOFF-26) = cfp_field' },
  KXNCAAFSF: { outcome: 'reach_sf', event: /^KXNCAAFSF-27$/, re: ifThen('qualifies for the College Football Playoff Semifinals in the 2026-27 season'),
    basis: 'qualifies for the 2026-27 College Football Playoff semifinals = reach_sf' },
  KXNCAAFTOPSEED: { outcome: 'cfp_bye', event: /^KXNCAAFTOPSEED-27T4$/, re: ifThen('is selected as a top 4 seed in the 2026-27 College Football Playoff'),
    basis: 'is selected as a top 4 seed in the 2026-27 College Football Playoff (seeds 1-4, the first-round byes) = cfp_bye' }
};
/* the conferences: Kalshi's ticker, the feed's conference, and the name each wording uses */
const CFB_CONFS: Array<[string, string, string, string, string]> = [
  ['KXNCAAFSEC', 'KXNCAAFSECQ', 'SEC', 'SEC', 'SEC'], ['KXNCAAFB10', 'KXNCAAFB10QUAL', 'Big Ten', 'Big Ten', 'Big Ten'], ['KXNCAAFB12', 'KXNCAAFB12QUAL', 'Big 12', 'Big 12', 'Big 12'],
  ['KXNCAAFACC', 'KXNCAAFACCQUAL', 'ACC', 'ACC', 'Atlantic Coast Conference'], ['KXNCAAFAAC', 'KXNCAAFAACQUAL', 'American Athletic', 'American Athletic Conference', 'American Athletic Conference'],
  ['KXNCAAFMWC', 'KXNCAAFMWCQUAL', 'Mountain West', 'Mountain West', 'Mountain West Conference'], ['KXNCAAFCUSA', 'KXNCAAFCUSAQUAL', 'Conference USA', 'Conference USA', 'Conference USA'],
  ['KXNCAAFMAC', 'KXNCAAFMACQUAL', 'Mid-American', 'Mid-American Conference', 'Mid-American Conference'], ['KXNCAAFSBELT', 'KXNCAAFSBELTQUAL', 'Sun Belt', 'Sun Belt', 'Sun Belt'],
  ['KXNCAAFPAC12', 'KXNCAAFPAC12QUAL', 'Pac-12', 'Pac-12', 'Pac-12']];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [champ, qual, conf, wins, quals] of CFB_CONFS) {
  CFB_SERIES[champ] = { outcome: 'conf_champion', conf, event: new RegExp('^' + champ + '-26$'), re: ifThen('wins the 2026 College Football ' + esc(wins) + ' Championship Game'),
    basis: 'wins the 2026 ' + wins + ' Championship Game = conf_champion' };
  CFB_SERIES[qual] = { outcome: 'ccg_appearance', conf, event: new RegExp('^' + qual + '-26$'), re: ifThen('qualifies for the 2026 College Football ' + esc(quals) + ' Championship Game'),
    basis: 'qualifies for the 2026 ' + quals + ' Championship Game (either side of it) = ccg_appearance' };
}
export interface CfbTeamRef { id: string; name: string; conference: string }
/** the 2026 FBS teams and conferences, as the committed week-7 snapshot holds them (from the 2026 schedule feed; ids are the run's entity ids) */
export function cfbTeams2026(): CfbTeamRef[] {
  const s = readSnapshot(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'fixtures', 'cfb_2026_wk7_snapshot.json.gz'));
  return s.data.teams.map((t) => ({ id: t.id, name: t.name, conference: t.conference }));
}
export function buildCfbMappings(markets: Candidate[], series: SeriesInfo[], verified: { by: string; at: string }, teams: CfbTeamRef[] = cfbTeams2026()) {
  const mappings: Mapping[] = [], left: Array<{ market_ticker: string; why: string[] }> = [];
  const fee = new Map(series.map((s) => [s.ticker, s]));
  const squash = (x: string | null) => String(x || '').replace(/\s+/g, ' ').trim();
  const byName = new Map(teams.map((t) => [t.name, t]));
  /* a ticker suffix must carry one label across every candidate market, and a label one suffix */
  const labs = new Map<string, Set<string>>(), sufs = new Map<string, Set<string>>();
  for (const k of markets) if (CFB_SERIES[k.series_ticker]) {
    const sfx = k.market_ticker.split('-').pop() as string, lab = squash(k.yes_sub_title);
    labs.set(sfx, (labs.get(sfx) || new Set()).add(lab)); sufs.set(lab, (sufs.get(lab) || new Set()).add(sfx));
  }
  for (const k of markets) {
    const rule = CFB_SERIES[k.series_ticker];
    if (!rule) continue;                                    // a series with no simulated outcome is not a candidate at all
    const why: string[] = [];
    const sf = fee.get(k.series_ticker);
    if (!sf || !/^quadratic/.test(sf.fee_type) || Number(sf.fee_multiplier) !== 1) why.push('series fee is ' + (sf ? sf.fee_type + ' x' + sf.fee_multiplier : 'unknown') + ', not quadratic x1');
    if (!rule.event.test(k.event_ticker)) why.push('event ' + k.event_ticker + ' is not the 2026 season\'s (' + rule.event.source + ')');
    const lab = squash(k.yes_sub_title), sfx = k.market_ticker.split('-').pop() as string;
    const m = squash(k.rules_primary).match(rule.re);
    if (!m) why.push('rules text does not match the ' + k.series_ticker + ' template');
    else if (m[1] !== lab) why.push('rules name "' + m[1] + '" but the market is labelled "' + lab + '"');
    if ((labs.get(sfx) || new Set()).size !== 1 || (sufs.get(lab) || new Set()).size !== 1) why.push('ticker suffix ' + sfx + ' and label "' + lab + '" do not name each other one to one across Kalshi\'s markets');
    const team = byName.get(cfbNameOf(lab));
    if (!team) why.push('label "' + lab + '" is no 2026 FBS team (read as "' + cfbNameOf(lab) + '")');
    if (team && rule.conf && team.conference !== rule.conf) why.push(team.name + ' is not in the ' + rule.conf);
    if (!CFB_SECONDARY.includes(squash(k.rules_secondary))) why.push('secondary rules are not the NCAA disclaimer (alone or with the standard one)');
    if (!/^[0-9a-f]{64}$/.test(k.rules_sha256 || '')) why.push('no rules sha256');
    if (why.length || !team) { left.push({ market_ticker: k.market_ticker, why }); continue; }
    const set = rule.outcome === 'conf_champion' ? 'cfb2026:conf_champion:' + rule.conf : null;
    mappings.push({ mapping_id: 'cfb2026:' + k.market_ticker, status: 'verified', sport: 'cfb', competition: 'NCAA FBS', season: '2026',
      series_ticker: k.series_ticker, event_ticker: k.event_ticker, market_ticker: k.market_ticker, entity_id: team.id, outcome: rule.outcome, outcome_set: set,
      settlement: { basis: 'Kalshi ' + k.series_ticker + ': ' + rule.basis, rules_sha256: k.rules_sha256, rules_excerpt: squash(k.rules_primary) },
      verified_by: verified.by, verified_at: verified.at });
  }
  /* two markets that read as the same team and outcome: neither is trusted */
  const dup = new Map<string, number>(); for (const x of mappings) dup.set(x.entity_id + '|' + x.outcome, (dup.get(x.entity_id + '|' + x.outcome) || 0) + 1);
  for (let i = mappings.length - 1; i >= 0; i--) if ((dup.get(mappings[i].entity_id + '|' + mappings[i].outcome) || 0) > 1) {
    left.push({ market_ticker: mappings[i].market_ticker, why: ['another market of the series reads as the same team (' + mappings[i].entity_id + ')'] }); mappings.splice(i, 1);
  }
  mappings.sort((a, b) => a.market_ticker.localeCompare(b.market_ticker));
  /* a conference title is a complete set when every member has its market */
  const members = new Map<string, Mapping[]>();
  for (const x of mappings) if (x.outcome_set) members.set(x.outcome_set, [...(members.get(x.outcome_set) || []), x]);
  const sets: OutcomeSet[] = [];
  for (const [id, ms] of [...members].sort((a, b) => a[0].localeCompare(b[0]))) {
    const conf = id.split(':')[2], eligible = teams.filter((t) => t.conference === conf).map((t) => t.id);
    const have = new Set(ms.map((x) => x.entity_id));
    if (have.size !== ms.length || ms.length !== eligible.length || eligible.some((e) => !have.has(e))) { for (const x of ms) x.outcome_set = null; continue; }
    sets.push({ id, outcome: 'conf_champion', entities: eligible.slice().sort(), mutually_exclusive: true, exhaustive: true, note: 'exactly one of these teams wins the ' + conf + ' championship game' });
  }
  return { mappings, sets, left };
}

/** the candidates file read back from the source check's job log, for when its artifact cannot be downloaded:
    every series row (with its fee fields) and every open market line, each with the rules sha256 the runner
    computed on the raw text. The log prints the rules with whitespace squashed, which is how the templates read
    them anyway. SETTLED lines (a series' wording between seasons) are read apart and are never candidates. A
   byte-order mark is stripped from every line, not only the first. */
export function candidatesFromLog(text: string): { fetched_at: string; series: SeriesInfo[]; markets: Candidate[]; settled: Candidate[] } {
  const series: SeriesInfo[] = [], markets: Candidate[] = [], settled: Candidate[] = [];
  let at = '', current = '';
  /* the log API starts each chunk it joins with a byte-order mark, mid-file too: a line that kept one was skipped (2026-10-24: KXNCAAF-27-CLEM) */
  for (const raw0 of text.split(/\r?\n/)) {
    const raw = raw0.replace(/^\uFEFF/, '');
    const ts = raw.match(/^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /);
    if (ts && !at) at = ts[1];
    const line = ts ? raw.slice(ts[0].length) : raw;
    let m = line.match(/^## SERIES (\S+) \|/);
    if (m) { current = m[1]; continue; }
    m = line.match(/^ {2}(KX[A-Z0-9-]+) \| .* \| (\S+) \| (\S+?)(?: {3}<- futures)?$/);
    if (m) { series.push({ ticker: m[1], fee_type: m[2], fee_multiplier: m[3] }); continue; }
    m = line.match(/^ {2}(-|~ SETTLED) (\S+) \| event (\S+) \| (.*?) \| close \S+ \| .*? \| rules_sha256 (\S+) \| RULES: (.*?)(?: \| RULES2: (.*))?$/);
    if (m && current) (m[1] === '-' ? markets : settled).push({ series_ticker: current, event_ticker: m[3], market_ticker: m[2], yes_sub_title: m[4],
      rules_primary: m[6], rules_secondary: m[7] ?? null, rules_sha256: m[5] });
  }
  return { fetched_at: at, series, markets, settled };
}

/** the config's mapping_version names the source check each sport's mappings came from ('nfl <date>.run<id>; mlb ...');
    a version without a sport is the NFL's, the only sport built before */
export function versionWith(cur: string, sport: string, v: string): string {
  const parts = new Map<string, string>();
  for (const p of String(cur || '').split('; ').filter(Boolean)) { const i = p.indexOf(' '); if (i < 0) parts.set('nfl', p); else parts.set(p.slice(0, i), p.slice(i + 1)); }
  parts.set(sport, v);
  return [...parts].sort((x, y) => x[0].localeCompare(y[0])).map(([s, x]) => s + ' ' + x).join('; ');
}

const BUILDERS: Record<string, typeof buildMappings> = { nfl: buildMappings, mlb: buildMlbMappings, nhl: buildNhlMappings, nba: buildNbaMappings, cfb: (m, s, v) => buildCfbMappings(m, s, v) };

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const sport = get('--sport') || 'nfl', file = get('--candidates') || get('--log'), runId = get('--run');
  if (!BUILDERS[sport] || !file || !fs.existsSync(file) || !/^\d+$/.test(runId || '')) {
    console.error('usage: [--sport nfl|mlb|nhl|nba|cfb] --candidates <kalshi_candidates[_<sport>].json> | --log <the source check job\'s log> --run <actions run id> [--check]'); process.exit(2);
  }
  const cand = get('--log') ? candidatesFromLog(fs.readFileSync(file, 'utf8')) : JSON.parse(fs.readFileSync(file, 'utf8'));
  const at = String(cand.fetched_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(at)) { console.error('error: the candidates carry no fetch date (a log must keep its timestamps)'); process.exit(2); }
  const by = 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request, from the settlement rules Kalshi\'s API returned to GitHub Actions run ' + runId + ' (Simulator source check), matched by simulator/src/cli/build_kalshi_mappings.ts';
  const { mappings, sets, left } = BUILDERS[sport](cand.markets, cand.series, { by, at });
  const cfg = JSON.parse(fs.readFileSync(FUTURES_CONFIG, 'utf8')) as FuturesConfig & Record<string, unknown>;
  /* only this sport's mappings and outcome sets are rebuilt; every other sport's stay as they are */
  cfg.mapping_version = versionWith(cfg.mapping_version, sport, at + '.run' + runId);
  cfg.outcome_sets = cfg.outcome_sets.filter((s) => !s.id.startsWith(sport)).concat(sets).sort((x, y) => x.id.localeCompare(y.id));
  cfg.mappings = cfg.mappings.filter((m) => m.sport !== sport).concat(mappings).sort((x, y) => x.sport.localeCompare(y.sport));   // stable: each sport keeps its own order
  const text = JSON.stringify(cfg, null, 2) + '\n';
  if (a.includes('--check')) { const cur = fs.readFileSync(FUTURES_CONFIG, 'utf8'); console.log(cur === text ? 'kalshi_futures.json is current' : 'kalshi_futures.json differs'); process.exit(cur === text ? 0 : 1); }
  fs.writeFileSync(FUTURES_CONFIG, text);
  console.log(mappings.length + ' markets mapped, ' + sets.length + ' complete outcome sets, ' + left.length + ' left out' + (left.length ? ':\n' + left.map((l) => '  ' + l.market_ticker + ': ' + l.why.join('; ')).join('\n') : ''));
}
