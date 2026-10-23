/* The NFL 2026 season configuration against the repository's own records.
   node simulator/tests/nfl_config.test.ts */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { kit } from './_kit.ts';
import { REPO } from '../src/sports/nfl/model_adapter.ts';
import { NFL_TEAMS_2026, NFL_2026, type SeasonFact } from '../src/sports/nfl/config.ts';
import { sportRegistry, factStatus } from '../src/sports/registry.ts';

const T = kit('NFL 2026 configuration');
/* 1 the alignment equals supabase/nfl_market_structure.sql's seeded table (nflverse codes: the Rams are LA) */
{
  const sql = fs.readFileSync(path.join(REPO, 'supabase', 'nfl_market_structure.sql'), 'utf8');
  const rows = [...sql.matchAll(/\('([A-Z]{2,3})','([A-Z]{2,3})','([^']+)','(AFC|NFC)','((?:AFC|NFC) (?:East|North|South|West))'\)/g)].map((m) => ({ code: m[2], name: m[3], conference: m[4], division: m[5] }));
  T.eq('the seeded table has 32 clubs', rows.length, 32);
  const mine = NFL_TEAMS_2026.map((t) => t.code + '|' + t.name + '|' + t.conference + '|' + t.division).sort();
  T.eq('every club, name, conference and division equals public.nfl_team_divisions', mine, rows.map((r) => r.code + '|' + r.name + '|' + r.conference + '|' + r.division).sort());
}
/* 2 ... and the 2025 alignment in the real standings */
const FX = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(REPO, 'simulator', 'fixtures', 'nfl_history.json.gz'))).toString('utf8'));
{
  const s25 = FX.seasons['2025'].teams as Array<{ code: string; conference: string; division: string }>;
  T.eq('the alignment equals the 2025 standings (unchanged since 2002)', NFL_TEAMS_2026.map((t) => t.code + t.division).sort(), s25.map((t) => t.code + t.division).sort());
}
/* 3 the Super Bowl's designated home conference: odd-numbered -> NFC, even -> AFC, in every season of the fixture */
{
  let n = 0, ok = 0;
  for (const season of Object.keys(FX.seasons)) {
    const S = FX.seasons[season], sb = (S.postseason as any[]).find((g) => g[1] === 'SB');
    if (!sb) continue;
    const conf = (S.teams as any[]).find((t) => t.code === sb[2]).conference, number = Number(season) - 1965;
    n++; if (conf === (number % 2 ? 'NFC' : 'AFC')) ok++;
  }
  T.chk('the alternation holds in every Super Bowl 2002-2025 (24 of 24)', n === 24 && ok === 24, { n, ok });
  T.eq('Super Bowl LXI (the 2026 season) is odd-numbered, so the NFC club is the designated home', NFL_2026.super_bowl.value.designated_home, (2026 - 1965) % 2 ? 'NFC' : 'AFC');
  const stad = JSON.parse(fs.readFileSync(path.join(REPO, 'football', 'venues', 'nfl_stadiums.json'), 'utf8')).stadiums as any[];
  const v = stad.find((s) => s.name === NFL_2026.super_bowl.value.venue);
  T.chk('the Super Bowl venue is in the verified stadium table, with its roof', !!v && v.roof === NFL_2026.super_bowl.value.roof);
}
/* 4 facts and status agree */
{
  const facts = [NFL_2026.rules, NFL_2026.playoff_format, NFL_2026.super_bowl];
  const unverified = facts.filter((f) => f.affects_results && f.verification !== 'VERIFIED').length;
  const nfl = sportRegistry().find((s) => s.key === 'nfl')!;
  T.chk('any unverified result-affecting fact keeps the NFL BLOCKED (and none keeps it ACTIVE)', (unverified > 0) === (nfl.status === 'BLOCKED') && nfl.blockers.length === unverified);
  const f = (v: Partial<SeasonFact<string>>): [string, SeasonFact<string>] => ['fact', { ...NFL_2026.rules, verification: 'UNVERIFIED', verified_by: null, verified_at: null, ...v }];
  T.eq('VERIFIED without a verifier or a date still blocks', [factStatus([f({ verification: 'VERIFIED' })]).status, factStatus([f({ verification: 'VERIFIED', verified_by: 'a person' })]).status, factStatus([f({ verification: 'VERIFIED', verified_at: '2026-10-24' })]).status], ['BLOCKED', 'BLOCKED', 'BLOCKED']);
  T.eq('VERIFIED with a verifier and a date unblocks; a fact that moves no number never blocks', [factStatus([f({ verification: 'VERIFIED', verified_by: 'a person', verified_at: '2026-10-24' })]).status, factStatus([f({ affects_results: false })]).status], ['ACTIVE', 'ACTIVE']);
  T.chk('every VERIFIED fact names its verifier, a date and an https source', facts.filter((x) => x.verification === 'VERIFIED').every((x) => !!x.verified_by && /^\d{4}-\d{2}-\d{2}$/.test(x.verified_at || '') && /https:\/\//.test(x.source)));
  T.chk('an unverified fact claims no verifier', facts.filter((x) => x.verification !== 'VERIFIED').every((x) => x.verified_by === null && x.verified_at === null));
  T.eq('the Super Bowl date is not asserted (the NFL text says February 2027; no price depends on it)', NFL_2026.super_bowl.value.date, null);
  T.chk('every fact names its source, its retrieval date and what a person must check', facts.every((f) => f.source.length > 20 && /^\d{4}-\d{2}-\d{2}$/.test(f.retrieved) && f.verify_by.length > 20));
  T.eq('drift is off and availability sampling is off', [NFL_2026.drift.mode, NFL_2026.availability.mode], ['off', 'off']);
  T.chk('the fixed availability assumption is stated', /No injury return is sampled/.test(NFL_2026.availability.fixed_assumption));
}
process.exit(T.done());
