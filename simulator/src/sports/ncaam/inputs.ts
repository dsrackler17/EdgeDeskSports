/* ===========================================================================
   The NCAAM tournament snapshot: built and frozen BEFORE any simulation (no
   network, no database inside a run), hashed, replayable.

   Inputs, all owned and versioned:
   - the dataset (basketball/ncaam_forecast/data, sha256-checked per season)
   - the model: the CHAMPION (basketball/ncaam_forecast/registry) for anything
     that may be published; the frozen development selection
     (config/selection_v1.json) for dry runs and historical backtests
   - the bracket: the official file config/brackets/<season>.json for the
     season in progress (written from the Selection Sunday release, results
     fixed from observed games), or the exact reconstruction of a past season
   - the persistent strength variance: validation/strength_uncertainty.json
   The model artifact is built as of `asOf` from data available by then only.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import type { NcaamInputData } from './module.ts';

export const NCAAM_INPUT_SCHEMA = 'edgedesk_ncaam_sim_snapshot_v1';
export const REPO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const req = createRequire(import.meta.url);
const FC = (m: string) => req(path.join(REPO, 'basketball', 'ncaam_forecast', m));

export interface NcaamSnapshot {
  schema: string;
  input_hash: string;
  data: NcaamInputData;
  meta: { built_at: string; feeds: Array<{ url: string; sha256: string; bytes: number }>; offline: boolean; builder: string; mode: 'official' | 'historical'; model_source: 'champion' | 'selection'; as_of: string; notes: string[] };
}

/** the model configuration a run uses */
export function modelConfig(source: 'champion' | 'selection'): { key: string; cfg: any } {
  if (source === 'selection') {
    const W = FC('weekly.js');
    const c = W.selectionConfig();
    return { key: c.model_id + '@' + c.version + '(selection)', cfg: c };
  }
  const RG = FC('registry.js');
  const ptr = RG.readPointer();
  if (!ptr) throw new Error('no NCAAM champion pointer (basketball/ncaam_forecast/registry/champion.json)');
  const m = RG.readModel(ptr.current.key);
  if (!m || m.engine !== 'research_team_model') throw new Error('the champion ' + ptr.current.key + ' cannot drive a tournament simulation (engine ' + (m && m.engine) + '); promote a research_team_model through the weekly gates first');
  return { key: ptr.current.key, cfg: m.config };
}

export function strengthStudy(): { variance: number; method: string; source: string; ci95: [number, number] | null; file_sha256: string } {
  const f = path.join(REPO, 'basketball', 'ncaam_forecast', 'validation', 'strength_uncertainty.json');
  if (!fs.existsSync(f)) throw new Error('no strength-uncertainty study (node basketball/ncaam_forecast/strength.js)');
  const buf = fs.readFileSync(f); const s = JSON.parse(buf.toString('utf8'));
  return { variance: s.estimate.variance_margin_pts2, method: s.method, source: 'basketball/ncaam_forecast/validation/strength_uncertainty.json', ci95: s.estimate.ci95, file_sha256: sha256Hex(buf) };
}

export interface BuildOptions { season: number; mode: 'official' | 'historical'; modelSource: 'champion' | 'selection'; asOf?: string; bracketFile?: string; cacheWalk?: unknown; games?: unknown[] }

export function buildNcaamSnapshot(o: BuildOptions): NcaamSnapshot {
  const DS = FC('dataset.js'), MD = FC('model.js'), TT = FC('tournament.js');
  const games = (o.games as any[]) || DS.load();
  const notes: string[] = [];
  let bracket: any;
  if (o.mode === 'historical') {
    bracket = TT.reconstructBracket(games, o.season);
    if (!bracket) throw new Error('no NCAA tournament games for season ' + o.season);
    if (bracket.incomplete) notes.push(bracket.incomplete);
  } else {
    const f = o.bracketFile || path.join(REPO, 'basketball', 'ncaam_forecast', 'config', 'brackets', o.season + '.json');
    if (!fs.existsSync(f)) throw Object.assign(new Error('no official bracket for ' + o.season + ' (' + path.relative(REPO, f) + '): the field is announced on Selection Sunday; pre-selection forecasts are disabled'), { exitCode: 2, noInputs: true });
    bracket = TT.officialBracket(f, games, o.asOf ? Date.parse(o.asOf) : Date.now());
    if (bracket.fixed_from_results.length) notes.push(bracket.fixed_from_results.length + ' completed games fixed from observed results');
  }
  const asOfMs = o.asOf ? Date.parse(o.asOf) : o.mode === 'historical' ? bracket.first_tip_ms - 30 * 60e3 : Date.now();
  if (!Number.isFinite(asOfMs)) throw Object.assign(new Error('--as-of is not a valid time: ' + o.asOf), { exitCode: 2 });
  const { key, cfg } = modelConfig(o.modelSource);
  const art = MD.buildArtifact(games, cfg, asOfMs, { season: o.season, cache: o.cacheWalk });
  const st = strengthStudy();
  const teams = JSON.parse(fs.readFileSync(path.join(REPO, 'basketball', 'ncaam_forecast', 'data', 'teams.json'), 'utf8')).teams;
  const data = TT.simInputs(art, bracket, st, { names: teams });
  data.model.key = key;
  const man = DS.manifest();
  const feeds = [{ url: 'repo:basketball/ncaam_forecast/data/games_' + o.season + '.csv.gz', sha256: man.seasons[o.season].sha256, bytes: 0 },
    { url: 'repo:' + st.source, sha256: st.file_sha256, bytes: 0 },
    { url: 'repo:model-code', sha256: art.code_sha256, bytes: 0 }];
  const clean = JSON.parse(JSON.stringify(data));
  return { schema: NCAAM_INPUT_SCHEMA, input_hash: hashCanonical(clean), data: clean,
    meta: { built_at: new Date(asOfMs).toISOString(), feeds, offline: true, builder: 'simulator/src/sports/ncaam/inputs.ts', mode: o.mode, model_source: o.modelSource, as_of: new Date(asOfMs).toISOString(), notes } };
}

export function writeNcaamSnapshot(file: string, snap: NcaamSnapshot): void { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(snap)); }
export function readNcaamSnapshot(file: string): NcaamSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as NcaamSnapshot;
  if (snap.schema !== NCAAM_INPUT_SCHEMA) throw new Error('not an NCAAM input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
