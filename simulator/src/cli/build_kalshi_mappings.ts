/* ===========================================================================
   edgedesk-sim build-kalshi-mappings — write simulator/config/kalshi_futures.json
   from the markets the source check read (kalshi_candidates.json, the
   artifact of .github/workflows/simulator-sources.yml).

     node simulator/src/cli/build_kalshi_mappings.ts --candidates <kalshi_candidates.json> --run <actions run id> [--check]

   A market is mapped ONLY when every check passes:
     - its series is one of SERIES below, whose settlement wording names
       exactly one simulated outcome;
     - its rules text matches that series' template word for word, and the
       club it names is the market's own label;
     - its secondary rules are nothing but Kalshi's standard disclaimer;
     - its ticker names a club of the configured alignment, in the conference
       or division the series (or the rules) names;
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
import type { FuturesConfig, Mapping, OutcomeSet } from '../markets/compare.ts';
import { FUTURES_CONFIG } from './markets.ts';

export const DISCLAIMER = 'Kalshi is not affiliated, associated, authorized, endorsed by, or in any way officially connected with the Governing League. All trademarks, logos, and brand names are the property of their respective owners.';
/** Kalshi ticker suffix -> nflverse code (the simulator's entity id); every other suffix is the same */
export const KALSHI_TO_NFLVERSE: Record<string, string> = { JAC: 'JAX', LAR: 'LA' };

interface SeriesRule { outcome: string; conf?: 'AFC' | 'NFC'; div?: string; re: RegExp; basis: string }
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
  KXNFL1SEED: { outcome: 'seed_1', re: /^If (.+) is the #1 seed in the (American|National) Football Conference at the conclusion of the 2026-2027 Pro Football regular season ?, then the market resolves to Yes\.$/,
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

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const a = process.argv.slice(2), get = (k: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
  const file = get('--candidates'), runId = get('--run');
  if (!file || !fs.existsSync(file) || !/^\d+$/.test(runId || '')) { console.error('usage: --candidates <kalshi_candidates.json> --run <actions run id> [--check]'); process.exit(2); }
  const cand = JSON.parse(fs.readFileSync(file, 'utf8'));
  const at = String(cand.fetched_at || '').slice(0, 10);
  const by = 'Claude Code (EdgeDesk simulator session), at the repository owner\'s request, from the settlement rules Kalshi\'s API returned to GitHub Actions run ' + runId + ' (Simulator source check), matched by simulator/src/cli/build_kalshi_mappings.ts';
  const { mappings, sets, left } = buildMappings(cand.markets, cand.series, { by, at });
  const cfg = JSON.parse(fs.readFileSync(FUTURES_CONFIG, 'utf8')) as FuturesConfig & Record<string, unknown>;
  cfg.mapping_version = at + '.run' + runId;
  cfg.outcome_sets = sets; cfg.mappings = mappings;
  const text = JSON.stringify(cfg, null, 2) + '\n';
  if (a.includes('--check')) { const cur = fs.readFileSync(FUTURES_CONFIG, 'utf8'); console.log(cur === text ? 'kalshi_futures.json is current' : 'kalshi_futures.json differs'); process.exit(cur === text ? 0 : 1); }
  fs.writeFileSync(FUTURES_CONFIG, text);
  console.log(mappings.length + ' markets mapped, ' + sets.length + ' complete outcome sets, ' + left.length + ' left out' + (left.length ? ':\n' + left.map((l) => '  ' + l.market_ticker + ': ' + l.why.join('; ')).join('\n') : ''));
}
