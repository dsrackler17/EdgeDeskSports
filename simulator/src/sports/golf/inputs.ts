/* ===========================================================================
   THE GOLF INPUT SNAPSHOT — everything one tournament simulation reads,
   captured once, validated, frozen and hashed BEFORE the first simulated
   round. One snapshot per tour event (PGA Tour, LPGA, DP World Tour).

   Where every number comes from:
     field, rounds, status   ESPN's leaderboard (espn.ts): read live on
                             GitHub's runners (site.web.api.espn.com), or
                             from the committed simulator/data/feeds/
                             golf_current.json with --offline or when the
                             live read fails (recorded in meta.source; a feed
                             older than config.max_feed_age_hours never
                             publishes: run.ts results.current). Completed
                             rounds and the strokes of a round in progress
                             are Observed; a round counts as complete only
                             if its strokes minus its score to par is an
                             18-hole par
     skill                   model.ts fitSkills on the history feed (rounds
                             before the event's start only), with the
                             study's hyperparameters (golf_skill_study.json)
     tournament variance     the study's c2, W1, W2 and round noise, times
                             the uncertainty scale the backtest chose on its
                             tuning season (golf_backtest.json production)
     round levels            each round complete or in progress: the field's
                             mean of (strokes to par - skill), holes-weighted
     course level            the event's rounds so far; before any, its
                             previous editions (else the tour's), with the
                             between-event and day-to-day sd measured on the
                             tour's last two seasons
     cut, rounds             rules.ts (measured; how, in cut.source)
   The snapshot's `data` is canonical and content-hashed (input_hash); `meta`
   carries what does not change a result. No network or database call
   happens after this returns.
   =========================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { hashCanonical, sha256Hex } from '../../core/canonical.ts';
import { REPO, HISTORY_FILE, CURRENT_FILE, STUDY_FILE, BACKTEST_FILE, DAY, TOUR_LABEL, loadHistory, roundTable, fitSkills, skillOf, toPar, fullPars,
  type Tour, type HistEvent, type Status, type SkillParams, type SkillFit, type RoundTable } from './model.ts';
import { eventRule, scheduledRounds, tourFrequencies, editions } from './rules.ts';
import { golfEvent, eventFromDocument, leaderboardUrl, ESPN, type EspnEvent, type EspnCompetitor } from './espn.ts';
import { GOLF_2026 } from './config.ts';
import type { GolfInputData, GolfPlayer, RoundLevel, GolfSnapshot } from './types.ts';

export const GOLF_INPUT_SCHEMA = 'edgedesk_sim_golf_input_v1';
export const GOLF_CODE_FILES = ['simulator/src/sports/golf/model.ts', 'simulator/src/sports/golf/rules.ts', 'simulator/src/sports/golf/module.ts', 'simulator/src/sports/golf/inputs.ts',
  'simulator/src/sports/golf/espn.ts', 'simulator/src/sports/golf/types.ts', 'simulator/src/sports/golf/config.ts', 'simulator/data/golf_skill_study.json', 'simulator/data/golf_backtest.json'];
export function codeIdentity(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of GOLF_CODE_FILES) { const p = path.join(REPO, f); out[f] = fs.existsSync(p) ? sha256Hex(fs.readFileSync(p)) : 'missing'; }
  return out;
}
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/* ------------------------------------------------------------ the study's model, per tour */
export interface TourModel { tour: Tour; fit_tours: Tour[]; params: SkillParams; c2: number; W1: number; W2: number; sigma_eps: number; sigma_eps_weekend: number; scale: number; scale_source: string }
export function readJson(file: string): any | null { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null; }
export function tourModel(study: any, tour: Tour, backtest: any | null): TourModel {
  const t = study && study.tours && study.tours[tour];
  if (!t) throw new Error('the golf skill study has no ' + tour + ' entry (simulator/data/golf_skill_study.json)');
  const p = t.params;
  const bs = backtest && backtest.production && backtest.production.scale_by_tour ? backtest.production.scale_by_tour[tour] : null;
  const sc = Number.isFinite(bs) ? bs : 1;
  return { tour, fit_tours: t.fit_tours, params: { half_life_days: p.half_life_days, kappa: p.kappa, nu0: p.nu0 == null ? Infinity : p.nu0, window_days: p.window_days,
    prior_shift_few: p.prior_shift_few, prior_shift_new: p.prior_shift_new, few_max: p.few_max }, c2: t.tournament_variance.c2, W1: t.tournament_variance.W1, W2: t.tournament_variance.W2,
    sigma_eps: t.round_noise.sigma_eps, sigma_eps_weekend: t.round_noise.sigma_eps_weekend ?? t.round_noise.sigma_eps, scale: sc, scale_source: Number.isFinite(bs) ? 'golf_backtest.json production.scale_by_tour (' + backtest.production.method + ')' : 'no backtest: the study\'s measured variances unscaled' };
}

/* ------------------------------------------------------------ one field entry, from ESPN or from history */
export interface FieldEntry { id: string; name: string; country: string | null; status: Status; position: string | null; score: string | null; sort_order: number | null; thru: number | null; tee_time: string | null;
  rounds: Array<{ r: number; strokes: number | null; to_par: string | null }> }
export const fieldFromEspn = (c: EspnCompetitor): FieldEntry => ({ id: String(c.id), name: String(c.name), country: c.country, status: c.status, position: c.position, score: c.score, sort_order: c.sort_order,
  thru: c.thru, tee_time: c.tee_time, rounds: c.rounds.filter((r) => r.is_playoff !== true).map((r) => ({ r: r.r, strokes: r.strokes, to_par: r.to_par })) });

export interface EventMeta { tour: Tour; id: string; name: string; course: string | null; par: number | null; start: string; end: string | null; status: string; period: number; tournament: Record<string, unknown> | null }

/* fits and tables, cached per tour set (a run builds up to three snapshots; the backtest hundreds) */
const TABLES = new Map<string, RoundTable>();
export function tableFor(hist: HistEvent[], tours: Tour[]): RoundTable {
  const k = tours.join('+') + ':' + hist.length;
  if (!TABLES.has(k)) TABLES.set(k, roundTable(hist.filter((e) => tours.includes(e.league))));
  return TABLES.get(k)!;
}

/** the tour's round levels (strokes to par of a 0-skill player) over the two seasons before day T: the day-to-day sd
    within an event and the sd of event means (the course-to-course spread) */
function tourLevels(hist: HistEvent[], fit: SkillFit, tour: Tour, beforeMs: number) {
  const ev = hist.filter((e) => e.league === tour && e.start < beforeMs && e.start >= beforeMs - 730 * DAY);
  const means: number[] = []; let ss = 0, df = 0;
  const byEvent = new Map<string, number[]>();
  for (const e of ev) {
    const ls: number[] = [];
    for (let r = 1; r <= e.n_rounds; r++) {
      const a = fit.level.get(e.key + ':' + r); if (a == null) continue;
      const pars = e.players.flatMap((p) => p.rounds.filter((x) => x.r === r && x.complete && x.par_played != null).map((x) => x.par_played as number));
      if (pars.length < 10) continue;
      ls.push(a - pars.reduce((s, x) => s + x, 0) / pars.length);
    }
    if (ls.length >= 2) { const m = ls.reduce((s, x) => s + x, 0) / ls.length; means.push(m); for (const x of ls) ss += (x - m) ** 2; df += ls.length - 1; byEvent.set(e.key, ls); }
  }
  const mm = means.length ? means.reduce((s, x) => s + x, 0) / means.length : 0;
  const between = means.length > 1 ? Math.sqrt(means.reduce((s, x) => s + (x - mm) ** 2, 0) / (means.length - 1)) : 1.5;
  return { mean: mm, between_sd: between, day_sd: df ? Math.sqrt(ss / df) : 1, events: means.length, byEvent };
}

/** the snapshot data for one event, from its field as it stands (live, committed, or a history event cut at a stage) */
export function buildData(a: { meta: EventMeta; field: FieldEntry[]; as_of: string; history: HistEvent[]; study: any; backtest: any | null; scaleOverride?: number; historySha: string; historyFetchedAt: string; studySha: string }): GolfInputData {
  const m = a.meta, tour = m.tour, startMs = Date.parse(m.start);
  const hist = a.history.filter((e) => e.start < startMs);
  const tm = tourModel(a.study, tour, a.backtest);
  if (a.scaleOverride != null) tm.scale = a.scaleOverride;
  const fit = fitSkills(tableFor(a.history, tm.fit_tours), startMs / DAY, tm.params);
  const sdScale = tm.sigma_eps / fit.sigma;
  /* the event's par and 18-hole pars, from its own rounds (else the feed's par) */
  const allRounds = a.field.flatMap((f) => f.rounds);
  let pars = fullPars(allRounds);
  const feedPar = m.par != null && m.par >= 54 ? m.par : null;
  if (pars.length === 0 || allRounds.filter((r) => r.strokes != null && r.strokes > 0).length < 20) pars = feedPar != null ? [feedPar] : pars;
  const par = feedPar != null && pars.includes(feedPar) ? feedPar : (pars.length ? pars[0] : (feedPar ?? 72));
  const rounds = scheduledRounds(hist, { league: tour, name: m.name, course: m.course, start: startMs, id: m.id, tournament: m.tournament, period: m.period });
  const R = rounds.n || 0;
  /* players: completed rounds and the round in progress */
  const players: GolfPlayer[] = a.field.map((f) => {
    const sk = skillOf(fit, f.id);
    const done: GolfPlayer['rounds'] = [];
    let partial: GolfPlayer['partial'] = null;
    for (const rd of f.rounds.slice().sort((x, y) => x.r - y.r)) {
      if (rd.strokes == null || rd.strokes <= 0 || (R && rd.r > R)) continue;
      const tp = toPar(rd.to_par), pp = tp == null ? null : rd.strokes - tp;
      if (pp != null && pars.includes(pp)) done.push({ r: rd.r, strokes: rd.strokes, par: pp });
      else if (pp != null && pp < par && f.status === 'active') {
        const holes = f.thru != null && f.thru > 0 && f.thru < 18 ? f.thru : Math.max(1, Math.min(17, Math.round(18 * pp / par)));
        partial = { r: rd.r, holes, strokes: rd.strokes, par_played: pp };
      }
    }
    return { id: f.id, name: f.name, country: f.country, status: f.status, position: f.position, score: f.score, sort_order: f.sort_order, thru: f.thru, tee_time: f.tee_time, rounds: done, partial,
      skill: { theta: r4(sk.theta), var_post: r4(sk.var_post), sd_round: r4(sk.sd_round * sdScale), n_eff: r4(sk.n_eff), n_rounds: sk.n_rounds, on_prior: sk.on_prior } };
  });
  players.sort((x, y) => (x.sort_order ?? 1e9) - (y.sort_order ?? 1e9) || (x.id < y.id ? -1 : 1));
  /* round levels: complete, in progress, or future */
  const levels: RoundLevel[] = [];
  for (let r = 1; r <= R; r++) {
    let s = 0, w = 0, nPart = 0, nDone = 0;
    for (const p of players) {
      const d = p.rounds.find((x) => x.r === r);
      if (d) { s += d.strokes - d.par - p.skill.theta; w += 1; nDone++; }
      else if (p.partial && p.partial.r === r) { const f = p.partial.holes / 18; s += p.partial.strokes - p.partial.par_played - p.skill.theta * f; w += f; nPart++; }
    }
    const expected = players.filter((p) => p.status === 'active').length;
    const owed = players.filter((p) => p.status === 'active' && !p.rounds.some((x) => x.r === r)).length;
    const state: RoundLevel['state'] = w === 0 ? 'future' : (nPart > 0 || (owed > 0 && owed < expected) ? 'partial' : 'complete');
    levels.push({ r, level: w > 0 && nDone + nPart >= 10 ? r4(s / w) : null, state: w > 0 && nDone + nPart >= 10 ? state : 'future', weight: r4(w) });
  }
  /* the course level of a future round */
  const tl = tourLevels(hist, fit, tour, startMs);
  const known = levels.filter((l) => l.level != null);
  let course: GolfInputData['course'];
  if (known.length) course = { level_mean: r4(known.reduce((s, l) => s + (l.level as number) * l.weight, 0) / known.reduce((s, l) => s + l.weight, 0)), level_sd: 0, day_sd: r4(tl.day_sd),
    source: 'the mean of this event\'s rounds so far (' + known.map((l) => 'round ' + l.r + ' ' + (l.level as number).toFixed(2)).join(', ') + '); day-to-day sd from the tour\'s last two seasons' };
  else {
    const eds = editions(hist, { league: tour, name: m.name, course: m.course, start: startMs, id: m.id }).filter((e) => tl.byEvent.has(e.key));
    const em = eds.map((e) => { const ls = tl.byEvent.get(e.key)!; return ls.reduce((s, x) => s + x, 0) / ls.length; });
    course = em.length ? { level_mean: r4(em.reduce((s, x) => s + x, 0) / em.length), level_sd: r4(em.length > 1 ? Math.max(0.3, Math.sqrt(em.reduce((s, x, _, arr) => s + (x - arr.reduce((u, v) => u + v, 0) / arr.length) ** 2, 0) / (em.length - 1))) : tl.between_sd), day_sd: r4(tl.day_sd),
      source: 'the previous editions (' + eds.map((e, i) => e.season + ': ' + em[i].toFixed(2)).join(', ') + ')' }
      : { level_mean: r4(tl.mean), level_sd: r4(tl.between_sd), day_sd: r4(tl.day_sd), source: 'no previous edition: the tour\'s mean level over its last two seasons (' + tl.events + ' events)' };
  }
  const rule = eventRule(hist, { league: tour, name: m.name, course: m.course, start: startMs, id: m.id, field: a.field.length, any_cut: a.field.some((f) => f.status === 'cut'), period: m.period, n_rounds: R,
    tournament: m.tournament, round_complete: (r) => levels.some((l) => l.r === r && l.state === 'complete') });
  /* a cut after the last round could never be applied: the rule and the round count disagree, and nothing is assumed */
  if (rule.mode === 'top_n' && (rule.round as number) >= R) Object.assign(rule, { mode: 'undetermined', provenance: null, source: rule.source + '; but the cut round (' + rule.round + ') is not before the last round (' + R + '): the format cannot be determined' });
  const state = rule.mode === 'observed' ? 'made' : rule.mode === 'none' ? 'none' : rule.mode === 'top_n' ? 'pending' : 'undetermined';
  const freq = tourFrequencies(hist, tour);
  const bt = a.backtest && a.backtest.tours ? a.backtest.tours[tour] : null;
  return {
    sport: 'golf', tour, tour_label: TOUR_LABEL[tour], competition: tour + '-' + m.id, season: new Date(startMs).getUTCFullYear(), as_of: a.as_of,
    event: { id: m.id, name: m.name, course: m.course, par, start: m.start, end: m.end, status: m.status, period: m.period, n_rounds: R, rounds_source: rounds.source, rounds_provenance: rounds.provenance || 'Estimated' },
    players, cut: { ...rule, state }, levels, course,
    model: {
      model_version: 'edgedesk_golf_skill_v1:' + tm.fit_tours.join('+') + '@h' + tm.params.half_life_days + 'k' + tm.params.kappa, fit_tours: tm.fit_tours,
      params: { ...tm.params, nu0: Number.isFinite(tm.params.nu0) ? tm.params.nu0 : null }, as_of_day: Math.round(fit.as_of_day), rounds_used: fit.rounds_used,
      prior_mean: r4(fit.prior_mean), prior_sd: r4(fit.prior_sd), sigma_in_sample: r4(fit.sigma),
      tournament: { c2: tm.c2, W1: tm.W1, W2: tm.W2, sigma_eps: tm.sigma_eps, sigma_eps_weekend: tm.sigma_eps_weekend, scale: tm.scale },
      study_sha256: a.studySha, history_sha256: a.historySha, history_fetched_at: a.historyFetchedAt
    },
    playoff: { mode: 'sudden_death', hole_level: 0, max_holes: 30, note: 'each playoff hole: a rounded normal around the player\'s per-hole skill (skill / 18), variance sd_round^2 / 18 less the rounding\'s 1/12; Estimated (no hole-by-hole history); aggregate playoffs are treated as sudden death' },
    code: codeIdentity(),
    frequencies: { playoff_events: freq.playoffs, events: freq.events, withdrawals_per_round: freq.withdrawals.map((w) => ({ round: w.round, rate: w.starters ? r4(w.withdrew / w.starters) : 0 })) },
    /* the tour's backtest, compact (the reader's Model Health tab): the holdout metrics and calibration, the scale check, the playoff check */
    health: bt ? { tour, label: bt.label, runs_per_event: bt.runs_per_event, generated_at: a.backtest.generated_at, holdout: bt.holdout, scale: bt.scale, playoffs: bt.playoffs,
      skipped: (bt.skipped || []).length, study: { out_of_sample: a.study.tours[tour].out_of_sample, newcomers_holdout: a.study.tours[tour].newcomers.holdout, joint: a.study.joint.chosen } } : null
  };
}

/* ------------------------------------------------------------ the current events: committed or live */
export interface TourFeed { tour: Tour; events: EspnEvent[]; upcoming: EspnEvent[]; fetched_at: string; source: 'live' | 'committed'; sha256: string; note?: string }
export function committedFeeds(file: string = CURRENT_FILE): TourFeed[] {
  const text = fs.readFileSync(file, 'utf8'), doc = JSON.parse(text);
  if (doc.schema !== 'edgedesk_feed_golf_current_v1') throw new Error('not a golf current feed: ' + doc.schema);
  const sha = sha256Hex(text);
  return GOLF_2026.tours.map((t) => { const c = doc.current[t] || {}; return { tour: t, events: c.events || [], upcoming: c.upcoming || [], fetched_at: doc.fetched_at, source: 'committed' as const, sha256: sha }; });
}
async function getJson(url: string): Promise<any> {
  let last: unknown = null;
  for (let i = 0; i < 3; i++) {
    try {
      const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 30000);
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctl.signal });
      const text = await res.text(); clearTimeout(timer);
      if (res.ok) return JSON.parse(text);
      last = 'HTTP ' + res.status;
      if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
    } catch (e) { last = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
  }
  throw new Error(url + ': ' + String(last));
}
/** a tour's current events read live: the scoreboard names them, each leaderboard carries the field and statuses */
export async function liveFeed(tour: Tour): Promise<TourFeed> {
  const sb = await getJson(ESPN + '/' + tour + '/scoreboard');
  const events: EspnEvent[] = [];
  for (const ev of sb.events || []) {
    const lb = await getJson(leaderboardUrl(tour, String(ev.id)));
    const lev = eventFromDocument(lb, String(ev.id));
    events.push(golfEvent(lev || ev, tour, lev ? 'leaderboard' : 'scoreboard'));
  }
  const cal = (sb.leagues || [])[0] && Array.isArray(sb.leagues[0].calendar) ? sb.leagues[0].calendar : [];
  const have = new Set(events.map((e) => e.id)), now = Date.now();
  const upcoming: EspnEvent[] = [];
  for (const c of cal.filter((c: any) => c.startDate && Date.parse(c.startDate) > now && !have.has(String(c.id))).slice(0, 2)) {
    try { const lb = await getJson(leaderboardUrl(tour, String(c.id))); const lev = eventFromDocument(lb, String(c.id)); if (lev) upcoming.push(golfEvent(lev, tour, 'leaderboard')); } catch (_) { /* an upcoming field not listed yet */ }
  }
  const text = JSON.stringify({ events, upcoming });
  return { tour, events, upcoming, fetched_at: new Date().toISOString(), source: 'live', sha256: sha256Hex(text) };
}

/** the event to simulate for a tour: the first current or upcoming event with a field, not finished, in the configured
    season. One event per tour per run: a second event in play the same week (an opposite-field event) is skipped and
    said so, never silently dropped */
export function pickEvent(f: TourFeed, season: number): { event: EspnEvent | null; skipped: string[] } {
  const skipped: string[] = [];
  let event: EspnEvent | null = null;
  for (const e of f.events.concat(f.upcoming)) {
    const label = String(e.name || e.id), current = f.events.includes(e);
    if (!e.competitors || e.competitors.length < 10) { skipped.push(label + ': field not listed yet'); continue; }
    if (e.status === 'STATUS_FINAL') { skipped.push(label + ': finished'); continue; }
    if (e.start && new Date(Date.parse(e.start)).getUTCFullYear() !== season) { skipped.push(label + ': starts outside the configured season ' + season); continue; }
    if (!event) { event = e; continue; }
    if (current) skipped.push(label + ': a second event in play on this tour this week; one event per tour is simulated (the scoreboard\'s first, ' + String(event.name || event.id) + ')');
  }
  return { event, skipped };
}

export function snapshotFrom(e: EspnEvent, f: TourFeed, ctx: { history: ReturnType<typeof loadHistory>; study: any; backtest: any | null; studySha: string; backtestSha: string | null; currentNote?: string }): GolfSnapshot {
  const meta: EventMeta = { tour: f.tour, id: String(e.id), name: String(e.name), course: e.course, par: e.par, start: String(e.start), end: e.end, status: String(e.status), period: e.period || 0, tournament: e.tournament || null };
  const data = buildData({ meta, field: e.competitors.map(fieldFromEspn), as_of: f.fetched_at, history: ctx.history.events, study: ctx.study, backtest: ctx.backtest, historySha: ctx.history.sha256, historyFetchedAt: ctx.history.fetched_at, studySha: ctx.studySha });
  const feeds = [{ name: 'simulator/data/feeds/golf_events.json.gz (uncompressed)', sha256: ctx.history.sha256 },
    { name: f.source === 'live' ? 'ESPN leaderboard, read live (' + leaderboardUrl(f.tour, String(e.id)) + ')' : 'simulator/data/feeds/golf_current.json', sha256: f.sha256 },
    { name: 'simulator/data/golf_skill_study.json', sha256: ctx.studySha }];
  if (ctx.backtestSha) feeds.push({ name: 'simulator/data/golf_backtest.json', sha256: ctx.backtestSha });
  return { schema: GOLF_INPUT_SCHEMA, input_hash: hashCanonical(data), data,
    meta: { built_at: new Date().toISOString(), builder: 'simulator/src/sports/golf/inputs.ts', source: { tour: f.tour, kind: f.source, fetched_at: f.fetched_at, note: f.note || null, fetched_by: e.fetched_by }, feeds } };
}

/** every tour's snapshot: live unless offline (a tour whose live read fails falls back to the committed feed, recorded) */
export async function buildGolfSnapshots(opt: { offline?: boolean; tours?: Tour[]; log?: (s: string) => void } = {}): Promise<{ snapshots: GolfSnapshot[]; skipped: Array<{ tour: Tour; reason: string }> }> {
  const log = opt.log || (() => {});
  const history = loadHistory();
  if (!fs.existsSync(STUDY_FILE)) throw Object.assign(new Error('no golf skill study (run simulator/src/research/golf_skill_study.ts)'), { exitCode: 2 });
  const study = readJson(STUDY_FILE), backtest = readJson(BACKTEST_FILE);
  const studySha = sha256Hex(fs.readFileSync(STUDY_FILE)), backtestSha = fs.existsSync(BACKTEST_FILE) ? sha256Hex(fs.readFileSync(BACKTEST_FILE)) : null;
  const committed = committedFeeds();
  const tours = opt.tours || GOLF_2026.tours;
  const snapshots: GolfSnapshot[] = [], skipped: Array<{ tour: Tour; reason: string }> = [];
  for (const t of tours) {
    let f = committed.find((c) => c.tour === t)!;
    if (!opt.offline) {
      try { f = await liveFeed(t); }
      catch (e) { f = { ...f, note: 'the live read failed (' + String((e as Error).message).slice(0, 160) + '): the committed feed is used' }; log(t + ': ' + f.note); }
    }
    const pick = pickEvent(f, GOLF_2026.season);
    for (const s of pick.skipped) log(t + ': skipped ' + s);
    if (!pick.event) { skipped.push({ tour: t, reason: pick.skipped.join('; ') || 'no current event' }); continue; }
    snapshots.push(snapshotFrom(pick.event, f, { history, study, backtest, studySha, backtestSha }));
  }
  return { snapshots, skipped };
}

export function writeGolfSnapshot(file: string, snap: GolfSnapshot): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(snap));
}
export function readGolfSnapshot(file: string): GolfSnapshot {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8')) as GolfSnapshot;
  if (snap.schema !== GOLF_INPUT_SCHEMA) throw new Error('not a golf input snapshot: ' + snap.schema);
  const h = hashCanonical(snap.data);
  if (h !== snap.input_hash) throw new Error('snapshot content hash mismatch: the file was changed after it was built (' + h + ' != ' + snap.input_hash + ')');
  return snap;
}
export { HISTORY_FILE };
