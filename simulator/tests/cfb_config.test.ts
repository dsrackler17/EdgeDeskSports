/* The CFB season configuration (config.ts) and what the registry does with it:
   every rule names its source and verification status, a VERIFIED rule has a
   verifier and a date, every conference in the 2026 feed has a procedure, the
   Sun Belt divisions are the schedule's own, and the sport stays BLOCKED for
   exactly the facts that are not verified. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kit } from './_kit.ts';
import { cfbFixture, clone } from './_cfb.ts';
import { CFB_2026, cfbFacts, isCfbVerified } from '../src/sports/cfb/config.ts';
import { validateCfbInputs, cfbRunGates } from '../src/sports/cfb/validate.ts';
import { PROCEDURES } from '../src/sports/cfb/rules.ts';
import { CFP_RULES } from '../src/sports/cfb/cfp.ts';
import { sportRegistry } from '../src/sports/registry.ts';
import { loadCfbEngine, priceBare } from '../src/sports/cfb/engine_adapter.ts';

const T = kit('CFB season configuration');
const SIM = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const snap = cfbFixture(), D = snap.data;
/** the committed snapshot with the current config in place (the snapshot embeds the config it was built with) */
const fixtureWith = (c: typeof CFB_2026) => { const x = clone(snap); x.data.config = c as any; return x; };
const VERIFIED_TODAY = ['ACC', 'American Athletic', 'Big 12', 'Big Ten', 'CFP', 'Conference USA', 'Mid-American', 'Mountain West', 'North Dakota State', 'Pac-12', 'SEC', 'Sun Belt'];

T.chk('every conference rule names a procedure that exists', CFB_2026.conferences.every((c) => !!PROCEDURES[c.procedure]));
T.chk('the CFP rules id exists', !!CFP_RULES[CFB_2026.cfp.rules]);
const feedConfs = [...new Set(D.teams.map((t) => t.conference))].filter((c) => c !== 'FBS Independents').sort();
T.eq('every conference in the 2026 feed has a rules entry, and no entry is for a conference the feed lacks', CFB_2026.conferences.map((c) => c.conference).sort(), feedConfs);
T.eq('membership is the feed\'s: 138 FBS teams, two independents', [D.teams.length, D.teams.filter((t) => t.conference === 'FBS Independents').map((t) => t.name).sort()], [138, ['Notre Dame', 'UConn']]);
for (const [label, f] of cfbFacts()) {
  T.chk(label + ': has at least one source URL and a note', f.sources.length > 0 && f.sources.every((s) => /^https:\/\//.test(s.url)) && f.note.length > 40, f);
  if (f.verification === 'VERIFIED') T.chk(label + ': VERIFIED has a primary source, a verifier and a date', f.sources.some((s) => s.kind === 'primary') && isCfbVerified(f), f);
  else T.chk(label + ': not verified, so not counted as verified', !isCfbVerified(f));
}
T.chk('a fact marked VERIFIED without a verifier is not verified', !isCfbVerified({ ...CFB_2026.cfp.fact, verified_by: null }));
T.chk('a fact marked VERIFIED without a date is not verified', !isCfbVerified({ ...CFB_2026.cfp.fact, verified_at: 'soon' }));
T.eq('the 2026 CFP format is VERIFIED from the CFP\'s own protocol', CFB_2026.cfp.fact.verification, 'VERIFIED');
const verified = cfbFacts().filter(([, f]) => isCfbVerified(f)).map(([l]) => l).sort();
T.eq('verified today: the CFP, every conference procedure and North Dakota State\'s eligibility', verified, VERIFIED_TODAY);
const reg = sportRegistry().find((s) => s.key === 'cfb')!;
const standing = cfbFacts().filter(([, f]) => f.affects_results && !f.measured && !isCfbVerified(f)).map(([l]) => l);
T.eq('the registry status follows the standing (unmeasured, unverified) facts', [reg.status, reg.blockers.map((b) => b.split(':')[0]).sort()], [standing.length ? 'BLOCKED' : 'ACTIVE', standing.sort()]);
T.eq('Sacramento State\'s eligibility is the one MEASURED assumption: no standing blocker, decided run by run', cfbFacts().filter(([, f]) => f.measured).map(([l, f]) => [l, isCfbVerified(f)]), [['Sacramento State', false]]);
{
  /* a measured fact never passes silently: its input gate warns, and the run gate holds publication when any run depended on it */
  const g = validateCfbInputs(fixtureWith(CFB_2026)).find((x) => x.id === 'rules.Sacramento_State')!;
  T.eq('... its input gate is a WARN that names the run gate, blocking nothing by itself', [g.status, g.blocks, /MEASURED/.test(g.detail)], ['WARN', 'none', true]);
  const run = (sens: number) => cfbRunGates(fixtureWith(CFB_2026).data, { 'eligibility_sensitive:Sacramento State': sens }, 100000).find((x) => x.id === 'run.eligibility_sensitive:Sacramento State')!;
  T.eq('... and the run gate passes at 0 dependent runs, holds publication at 1', [run(0).blocks, run(1).blocks], ['none', 'publication']);
}
T.chk('the reader\'s limitations say the CFP outputs are Estimated', reg.limitations.some((l) => /CFP/.test(l) && /Estimated/.test(l)));
/* Sun Belt divisions: the schedule's unique round-robin split, the same East the official page lists */
const east = D.teams.filter((t) => t.division === 'East').map((t) => t.name).sort();
T.eq('Sun Belt East from the 2026 schedule', east, ['App State', 'Coastal Carolina', 'Georgia Southern', 'Georgia State', 'James Madison', 'Marshall', 'Old Dominion']);
T.chk('the official page\'s East list (before its text was truncated) is the same first six', ['App State', 'Coastal Carolina', 'Georgia Southern', 'Georgia State', 'James Madison', 'Marshall'].every((n) => east.includes(n)));
T.eq('only the Sun Belt has divisions', [...new Set(D.teams.filter((t) => t.division).map((t) => t.conference))], ['Sun Belt']);
/* eligibility */
T.chk('every eligibility entry is a 2026 FBS team', CFB_2026.eligibility.every((e) => D.teams.some((t) => t.name === e.team)));
T.eq('Sacramento State and North Dakota State are both title-game eligible in the snapshot (the NCAA removed the transition restriction)', [D.teams.find((t) => t.name === 'Sacramento State')!.ccg_eligible, D.teams.find((t) => t.name === 'North Dakota State')!.ccg_eligible], [true, true]);
/* the two config files the snapshot reads */
const av = JSON.parse(fs.readFileSync(path.join(SIM, 'config', 'cfb_availability.json'), 'utf8'));
T.chk('availability config: no entry without a source (none today)', Array.isArray(av.entries) && av.entries.every((e: any) => /^https?:\/\//.test(e.source_url)));
const br = JSON.parse(fs.readFileSync(path.join(SIM, 'config', 'cfb_cfp_bracket.json'), 'utf8'));
T.eq('bracket config: none before Selection Day', [br.season, br.status, br.seeds.length], [2026, 'none', 0]);
T.eq('Selection Day is the protocol\'s', CFB_2026.selection_day, '2026-12-06');
T.chk('Army-Navy (after the American title game and Selection Day) counts neither for qualification nor for the committee', D.games.filter((g) => D.teams[g.home]?.name === 'Army' && D.teams[g.away]?.name === 'Navy').every((g) => !g.ccg_counts && !g.before_selection));
/* QB availability: a sourced primary-QB absence moves a price by the engine's trained coefficient, and nothing else does */
{
  const eng = loadCfbEngine(), st = eng.E.newState(), W = eng.P.injury;
  const game = { home: 'Alabama', away: 'Auburn', home_fbs: true, away_fbs: true, neutral: false, home_conference: 'SEC', away_conference: 'SEC' };
  const base = priceBare(eng, st, 2026, 8, game);
  const out = priceBare(eng, st, 2026, 8, game, { home: [{ player: 'QB1', athlete_id: '1', position: 'QB', starter: true, status: 'out', source: 'https://example.org/report' }] });
  T.near('a primary QB ruled OUT moves the home margin by exactly the trained absence coefficient (' + W.position_weight.QB + ' points)', base.fair - out.fair, W.position_weight.QB, 1e-9);
  const backup = priceBare(eng, st, 2026, 8, game, { home: [{ player: 'QB2', athlete_id: '2', position: 'QB', starter: false, status: 'out', source: 'https://example.org/report' }] });
  T.near('a backup QB OUT moves nothing', backup.fair, base.fair, 1e-9);
  const wr = priceBare(eng, st, 2026, 8, game, { home: [{ player: 'WR1', athlete_id: '3', position: 'WR', starter: true, status: 'out', source: 'https://example.org/report' }] });
  T.near('an untrained position OUT moves nothing (the engine\'s missing-input rule)', wr.fair, base.fair, 1e-9);
  T.eq('the snapshot applied no absence (the availability config is empty and the live layer had no report)', [D.availability.entries.length, D.games.filter((g) => g.model && g.model.availability.length).length], [0, 0]);
}
process.exitCode = T.done();
