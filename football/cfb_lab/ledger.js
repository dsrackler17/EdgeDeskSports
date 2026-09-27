/* ============================================================================
   CFB Model Lab — the append-only ledger in the repository.

   football/cfb_lab/ledger/<season>/
     predictions/week_NN.jsonl   one immutable snapshot per model x game x checkpoint
     quotes/week_NN.jsonl        market history (de-duplicated change points + heartbeats)
     lines.jsonl                 write-once openers and closes
     event_map.jsonl             provider event -> game
     results.jsonl               settlement facts (corrections supersede, never edit)
     evaluations.jsonl           grading of each snapshot (append-only, versioned)
     miss_reviews.jsonl          miss-review records
   football/cfb_lab/governance/  model roles, experiments, audit log, partitions, research queue

   Rules (docs/cfb-lab/SCHEMA.md):
   - A line, once written, is never changed or removed. `verify` checks every
     tracked file against a git base: the base content must be a prefix of
     the working content.
   - Ids are deterministic (h() = the same pipe-joined SHA-256 Postgres uses),
     so writing the same fact twice is a no-op, never a second row.

     node football/cfb_lab/ledger.js verify [--base origin/main] [--season 2026]
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const L = require('./lab_core.js');

const LAB = __dirname;
const REPO = path.resolve(LAB, '..', '..');

/* ------------------------------------------------------------------ ids */
function h(...parts) {
  return crypto.createHash('sha256').update(L.util.idParts(parts)).digest('hex').slice(0, 24);
}
const ts = (t) => (t == null ? null : new Date(L.util.ms(t)));
const ids = {
  prediction: (p) => 'cfbp_' + h(p.model_version, p.game_id, p.checkpoint_type, ts(p.prediction_ts)),
  /* a provider-declared row gets a sixth part, so a declared opener or close
     never shares an id with the ordinary quote observed at the same moment */
  quote: (q) => 'cfbq_' + h(...[q.source, q.book, q.game_id || q.provider_event_id, q.market_type, ts(q.observed_at)]
    .concat(q.is_provider_open ? ['provider_open'] : q.is_provider_close ? ['provider_close'] : [])),
  fingerprint: (q) => h(num(q.home_line), num(q.total_points), num(q.price_home), num(q.price_away), num(q.price_over), num(q.price_under)),
  line: (l) => 'cfbl_' + h(l.game_id, l.kind, l.book, l.market_type, l.rule_version),
  map: (x) => 'cfbx_' + h(x.source, x.provider_event_id, x.game_id),
  result: (x) => 'cfbr_' + h(x.game_id, x.status, num(x.home_points), num(x.away_points), x.supersedes || null),
  evaluation: (e) => 'cfbe_' + h(e.prediction_id, e.eval_version, e.result_id, e.close_line_id || null),
  review: (m) => 'cfbm_' + h(m.prediction_id, m.classification, m.classified_by, m.supersedes || null),
  event: (kind, ...parts) => 'cfbg_' + h(kind, ...parts),
};
function num(x) { const n = L.util.num(x); return n === null ? null : n; }

/* canonical JSON (sorted keys) for row hashes */
function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
}
function rowHash(row) {
  const o = Object.assign({}, row); delete o.row_hash;
  return crypto.createHash('sha256').update(canonical(o)).digest('hex');
}
function fileHash(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch (e) { return null; }
}

/* --------------------------------------------------------------- paths */
const pad = (w) => String(w).padStart(2, '0');
function seasonDir(season, root) { return path.join(root || path.join(LAB, 'ledger'), String(season)); }
function files(season, root) {
  const d = seasonDir(season, root);
  return {
    dir: d,
    predictions: (week) => path.join(d, 'predictions', 'week_' + pad(week) + '.jsonl'),
    quotes: (week) => path.join(d, 'quotes', 'week_' + pad(week) + '.jsonl'),
    lines: path.join(d, 'lines.jsonl'), event_map: path.join(d, 'event_map.jsonl'),
    results: path.join(d, 'results.jsonl'), evaluations: path.join(d, 'evaluations.jsonl'),
    miss_reviews: path.join(d, 'miss_reviews.jsonl'),
  };
}
function govFiles(root) {
  const d = root || path.join(LAB, 'governance');
  return { dir: d, model_roles: path.join(d, 'model_roles.jsonl'), experiments: path.join(d, 'experiments.jsonl'),
    audit_log: path.join(d, 'audit_log.jsonl'), partitions: path.join(d, 'partitions.jsonl'),
    research_queue: path.join(d, 'research_queue.jsonl') };
}

/* ----------------------------------------------------------------- io */
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { throw new Error(file + ':' + (i + 1) + ' is not valid JSON'); }
  });
  return out;
}
function listJsonl(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
}
/* Append rows whose id is new. Existing ids are skipped (a duplicate write is a
   no-op); a row whose id exists with DIFFERENT content is refused loudly. */
function appendJsonl(file, rows, idField, existing) {
  const have = existing || new Map(readJsonl(file).map((r) => [r[idField], r]));
  const fresh = [];
  const conflicts = [];
  for (const row of rows) {
    const id = row[idField];
    if (!id) throw new Error('row without ' + idField + ' for ' + file);
    if (have.has(id)) {
      if (canonical(have.get(id)) !== canonical(row)) conflicts.push(id);
      continue;
    }
    have.set(id, row); fresh.push(row);
  }
  if (fresh.length) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let prefix = '';
    if (fs.existsSync(file)) { const cur = fs.readFileSync(file, 'utf8'); if (cur.length && !cur.endsWith('\n')) prefix = '\n'; }
    fs.appendFileSync(file, prefix + fresh.map((r) => JSON.stringify(r)).join('\n') + '\n');
  }
  return { written: fresh.length, skipped: rows.length - fresh.length - conflicts.length, conflicts };
}

/* The same refusals Postgres makes (supabase/cfb_lab.sql), applied before a
   row reaches the repository ledger. Returns a reason, or null. */
function refusal(r) {
  const U = L.util;
  if (r.row_hash !== rowHash(r)) return 'row_hash does not match its content';
  if (r.prediction_id !== ids.prediction(r)) return 'prediction_id does not match its content';
  const p = U.ms(r.prediction_ts), k = U.ms(r.kickoff_ts);
  if (p === null || k === null) return 'prediction_ts and kickoff_ts are required';
  if (!(p < k)) return 'prediction_ts is not before kickoff (post-kickoff predictions are refused)';
  if (!U.isNum(r.hours_to_kickoff) || Math.abs(r.hours_to_kickoff - (k - p) / 3600000) > 0.01) return 'hours_to_kickoff disagrees with the timestamps';
  if (!U.isNum(r.pure_home_margin) || !U.isNum(r.fair_spread_home_line) || Math.abs(r.fair_spread_home_line + r.pure_home_margin) > 1e-6) return 'fair_spread_home_line must equal -pure_home_margin (sign convention)';
  if (U.isNum(r.home_win_probability) && !(r.home_win_probability > 0 && r.home_win_probability < 1)) return 'home_win_probability outside (0,1)';
  if (U.isNum(r.home_win_probability) && U.isNum(r.away_win_probability) && Math.abs(r.home_win_probability + r.away_win_probability - 1) > 1e-4) return 'win probabilities do not sum to 1';
  const iv = [50, 80, 95].map((k2) => [r['interval_' + k2 + '_low'], r['interval_' + k2 + '_high']]);
  for (const [lo, hi] of iv) if (U.isNum(lo) && U.isNum(hi) && lo > hi) return 'an interval has low > high';
  if (iv.every(([lo, hi]) => U.isNum(lo) && U.isNum(hi)) && !(iv[1][0] <= iv[0][0] && iv[0][1] <= iv[1][1] && iv[2][0] <= iv[1][0] && iv[1][1] <= iv[2][1])) return 'intervals are not nested (50 inside 80 inside 95)';
  if ((r.official_families || []).includes('OFFICIAL') && !(r.checkpoint_type === 'T24' && r.origin === 'LIVE')) return 'OFFICIAL is only the LIVE T24 snapshot';
  if (r.stake_units > 0 && !r.bet_enabled) return 'a stake without BET enabled';
  if (!['LIVE', 'GIT_RECONSTRUCTED', 'REPLAY'].includes(r.origin)) return 'unknown origin';
  return null;
}

/* ------------------------------------------------------------- store */
class Store {
  constructor(season, opts) {
    opts = opts || {};
    this.season = season;
    this.f = files(season, opts.root);
    this.g = govFiles(opts.govRoot);
  }
  predictions() { return listJsonl(path.join(this.f.dir, 'predictions')).flatMap(readJsonl); }
  quotes() { return listJsonl(path.join(this.f.dir, 'quotes')).flatMap(readJsonl); }
  lines() { return readJsonl(this.f.lines); }
  eventMap() { return readJsonl(this.f.event_map); }
  results() { return readJsonl(this.f.results); }
  evaluations() { return readJsonl(this.f.evaluations); }
  missReviews() { return readJsonl(this.f.miss_reviews); }
  gov(kind) { return readJsonl(this.g[kind]); }

  /* predictions: id-unique AND (game, model, checkpoint) unique except ADHOC */
  appendPredictions(rows) {
    const all = this.predictions();
    const byId = new Map(all.map((r) => [r.prediction_id, r]));
    const slotKey = (r) => r.game_id + '|' + r.model_version + '|' + r.checkpoint_type + '|' + r.origin;
    const slot = new Set(all.filter((r) => r.checkpoint_type !== 'ADHOC').map(slotKey));
    const byWeek = new Map();
    const refused = [];
    for (const r of rows) {
      const bad = refusal(r);
      if (bad) throw new Error('prediction ' + r.prediction_id + ' refused: ' + bad);
      const key = slotKey(r);
      if (byId.has(r.prediction_id)) continue;
      if (r.checkpoint_type !== 'ADHOC' && slot.has(key)) { refused.push(key); continue; }
      slot.add(key); byId.set(r.prediction_id, r);
      if (!byWeek.has(r.week)) byWeek.set(r.week, []);
      byWeek.get(r.week).push(r);
    }
    let written = 0;
    for (const [week, rs] of byWeek) written += appendJsonl(this.f.predictions(week), rs, 'prediction_id').written;
    return { written, refused_duplicate_checkpoint: refused };
  }
  appendQuotes(rows) {
    const byWeek = new Map();
    for (const r of rows) { const w = r.week == null ? 0 : r.week; if (!byWeek.has(w)) byWeek.set(w, []); byWeek.get(w).push(r); }
    let written = 0; const conflicts = [];
    for (const [week, rs] of byWeek) { const x = appendJsonl(this.f.quotes(week), rs, 'quote_id'); written += x.written; conflicts.push(...x.conflicts); }
    return { written, conflicts };
  }
  append(kind, rows, idField) {
    const file = this.f[kind] || this.g[kind];
    if (!file || typeof file !== 'string') throw new Error('unknown ledger kind ' + kind);
    return appendJsonl(file, rows, idField);
  }
}

/* ------------------------------------------------------------ verify */
function trackedLedgerFiles(base, repo, relRoots) {
  try {
    const out = execFileSync('git', ['-C', repo || REPO, 'ls-tree', '-r', '--name-only', base, '--', ...(relRoots || ['football/cfb_lab/ledger', 'football/cfb_lab/governance'])], { encoding: 'utf8' });
    return out.split('\n').filter((f) => f.endsWith('.jsonl'));
  } catch (e) { return null; }
}
function gitShow(base, rel, repo) {
  try { return execFileSync('git', ['-C', repo || REPO, 'show', base + ':' + rel], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 }); } catch (e) { return null; }
}
/* Returns a list of problems (empty = the ledger is intact). */
function verify(opts) {
  opts = opts || {};
  const problems = [];
  const repo = opts.repo || REPO;
  const roots = opts.roots || [path.join(LAB, 'ledger'), path.join(LAB, 'governance')];
  const idFieldOf = (rel) => {
    if (rel.includes('/predictions/')) return 'prediction_id';
    if (rel.includes('/quotes/')) return 'quote_id';
    const b = path.basename(rel, '.jsonl');
    return { lines: 'line_id', event_map: 'map_id', results: 'result_id', evaluations: 'evaluation_id', miss_reviews: 'review_id' }[b] || 'event_id';
  };
  const walk = (d) => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : (e.name.endsWith('.jsonl') ? [path.join(d, e.name)] : []))) : []);
  const slots = new Set();
  for (const file of roots.flatMap(walk)) {
    const rel = path.relative(repo, file).split(path.sep).join('/');
    let rows;
    try { rows = readJsonl(file); } catch (e) { problems.push(e.message); continue; }
    const idf = idFieldOf(rel), seen = new Set();
    rows.forEach((r, i) => {
      const id = r[idf];
      if (!id) problems.push(rel + ':' + (i + 1) + ' has no ' + idf);
      else if (seen.has(id)) problems.push(rel + ':' + (i + 1) + ' duplicates ' + id);
      seen.add(id);
      if (idf === 'prediction_id') {
        const bad = refusal(r);
        if (bad) problems.push(rel + ':' + (i + 1) + ' ' + bad + (bad.startsWith('row_hash') ? ' (the row was edited)' : ''));
        if (r.checkpoint_type !== 'ADHOC') {
          const k = r.game_id + '|' + r.model_version + '|' + r.checkpoint_type + '|' + r.origin;
          if (slots.has(k)) problems.push(rel + ':' + (i + 1) + ' second ' + r.origin + ' ' + r.checkpoint_type + ' snapshot for ' + r.game_id + ' / ' + r.model_version);
          slots.add(k);
        }
      }
      if (idf === 'quote_id' && id !== ids.quote(r)) problems.push(rel + ':' + (i + 1) + ' quote_id does not match its content');
    });
  }
  if (opts.base) {
    const relRoots = roots.map((r) => path.relative(repo, r).split(path.sep).join('/'));
    const tracked = trackedLedgerFiles(opts.base, repo, relRoots);
    if (tracked === null) problems.push('cannot read git base ' + opts.base);
    else for (const rel of tracked) {
      const before = gitShow(opts.base, rel, repo);
      const abs = path.join(repo, rel);
      if (!fs.existsSync(abs)) { problems.push(rel + ' was deleted (append-only)'); continue; }
      const now = fs.readFileSync(abs, 'utf8');
      if (before !== null && !now.startsWith(before)) problems.push(rel + ' was rewritten: ' + opts.base + ' content is not a prefix of the working file (append-only)');
    }
  }
  return problems;
}

module.exports = { h, ids, canonical, rowHash, refusal, fileHash, files, govFiles, readJsonl, listJsonl, appendJsonl, Store, verify, LAB, REPO, pad };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === 'verify') {
    const bi = args.indexOf('--base');
    const problems = verify({ base: bi >= 0 ? args[bi + 1] : null });
    if (problems.length) { problems.slice(0, 50).forEach((p) => console.log('FAIL ' + p)); console.log(problems.length + ' problem(s)'); process.exit(1); }
    console.log('ledger intact' + (bi >= 0 ? ' and append-only against ' + args[bi + 1] : ''));
  } else {
    console.log('usage: node football/cfb_lab/ledger.js verify [--base <git ref>]');
  }
}
