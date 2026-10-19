/* ============================================================================
   THE DESK'S SOURCES — every file a desk article may read, and nothing else.

   Each source is a COMMITTED file the existing pipelines write (record-pnl,
   football-model-record, the CFB Lab, the editorial audits). Loading one
   records what a reader needs to trace a number back to it years later:

     file          the path in the repository
     sha256        of the bytes read (for a directory: of its files, in order)
     generated_at  the time the file says it was built, where it says one
     commit        the last commit that changed it (git), so `git show
                   <commit>:<file>` returns exactly what the draft read

   No source is fetched from the network and no source is written. The desk
   reads the record; it never edits it.
   ========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/* id -> how to load it. `season` is substituted into the path. */
const CATALOG = {
  record_summary:    { file: 'record/football/summary.json', what: 'Football model record summary: per-week and season CLV, ATS and O/U, NFL and CFB' },
  record_nfl:        { file: 'record/football/nfl_{season}.json', what: 'Football model record, every NFL game: my first and last numbers, the market at each, the close, the grade' },
  record_cfb:        { file: 'record/football/cfb_{season}.json', what: 'Football model record, every CFB game' },
  pnl_ledger:        { file: 'record/pnl/ledger_{season}.json', what: 'Verified P&L ledger: every decision at the price recorded, settled' },
  pnl_summary:       { file: 'record/pnl/summary.json', what: 'Verified P&L summary by view' },
  nfl_slate:         { file: 'football/nfl/slate.json', what: 'NFL slate: my projection per game and the ranked model-vs-market rows' },
  game_research:     { file: 'football/game_research/current.json', what: 'Game research snapshots: the drivers inside each number' },
  openers_nfl:       { file: 'football/pricing/openers_nfl.json', what: 'NFL opener ledger: open, latest and close per game' },
  key_numbers:       { file: 'football/validation/key_numbers.json', what: 'Key margins per league, from final margins' },
  cfb_lines:         { file: 'football/cfb_lab/ledger/{season}/lines.jsonl', kind: 'jsonl', what: 'CFB Lab open and close lines' },
  cfb_predictions:   { file: 'football/cfb_lab/ledger/{season}/predictions', kind: 'jsonl_dir', what: 'CFB Lab frozen checkpoints by week' },
  editorial_audits:  { file: 'articles/data/editorial/audits', kind: 'json_dir', what: 'Postgame thesis audits' },
  editorial_memory:  { file: 'articles/data/editorial/memory.json', what: 'Research memory: what my audited claims got right and wrong' },
  cfb_miss_reviews:  { file: 'football/cfb_lab/ledger/{season}/miss_reviews.jsonl', kind: 'jsonl', what: 'CFB Lab miss reviews: each big miss classified with its rationale' },
  cfb_experiments:   { file: 'football/cfb_lab/governance/experiments.jsonl', kind: 'jsonl', what: 'CFB Lab experiment registry' },
  cfb_promotion:     { file: 'football/cfb_lab/reports/{season}/promotion.json', what: 'CFB Lab promotion evaluations' },
  cfb_maturity:      { file: 'football/cfb_validation/maturity.json', what: 'CFB model module maturity' }
};

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function git(args, cwd) {
  const r = cp.spawnSync('git', args, { cwd: cwd || ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}
function stampOf(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  return doc.generated_at || doc.updated_at || doc.built_at || null;
}
function parseJsonl(text) {
  return text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
}

/* A reader that can be pointed at the working tree or at a commit, so the
   verifier can re-read exactly what a draft read. */
function reader(atCommit, root) {
  root = root || ROOT;
  if (!atCommit) {
    return {
      exists: (f) => fs.existsSync(path.join(root, f)),
      read: (f) => fs.readFileSync(path.join(root, f)),
      list: (d) => fs.readdirSync(path.join(root, d)).sort()
    };
  }
  return {
    exists: (f) => git(['cat-file', '-e', atCommit + ':' + f], root) !== null,
    read: (f) => cp.execFileSync('git', ['show', atCommit + ':' + f], { cwd: root, maxBuffer: 1 << 30 }),
    list: (d) => (git(['ls-tree', '--name-only', atCommit + ':' + d], root) || '').split('\n').filter(Boolean).sort()
  };
}

function load(id, opts) {
  opts = opts || {};
  const spec = CATALOG[id];
  if (!spec) throw new Error('desk: unknown source ' + id);
  const season = opts.season || 2026;
  const file = spec.file.replace('{season}', String(season));
  const rd = reader(opts.commit, opts.root);
  if (!rd.exists(file)) return null;
  let doc, digest, stamp = null;
  if (spec.kind === 'json_dir' || spec.kind === 'jsonl_dir') {
    const names = rd.list(file).filter(n => spec.kind === 'json_dir' ? n.endsWith('.json') : n.endsWith('.jsonl'));
    const h = crypto.createHash('sha256');
    doc = { files: {} };
    names.forEach(n => {
      const buf = rd.read(file + '/' + n);
      h.update(n + '\0' + sha(buf) + '\n');
      doc.files[n] = spec.kind === 'json_dir' ? JSON.parse(buf.toString('utf8')) : parseJsonl(buf.toString('utf8'));
    });
    digest = h.digest('hex');
  } else {
    const buf = rd.read(file);
    digest = sha(buf);
    doc = spec.kind === 'jsonl' ? { rows: parseJsonl(buf.toString('utf8')) } : JSON.parse(buf.toString('utf8'));
    stamp = stampOf(doc);
  }
  /* THE COMMIT IS ONLY RECORDED WHEN IT HOLDS THE BYTES THAT WERE READ. The
     last commit to touch a path is not that when the working tree differs
     (an uncommitted refresh, a merge in progress): a draft then records no
     commit and says it was read from an uncommitted file, rather than naming
     one whose content it never saw. */
  let commit = opts.commit || null, uncommitted = false;
  if (!opts.commit) {
    const last = git(['log', '-1', '--format=%H', '--', file], opts.root);
    const clean = last && git(['status', '--porcelain', '--', file], opts.root) === '';
    commit = clean ? last : null;
    uncommitted = !clean;
  }
  return { id, file, what: spec.what, sha256: digest, generated_at: stamp, commit, uncommitted, doc };
}

/* Load several, lazily: a generator asks for what it needs. */
function loader(opts) {
  const cache = Object.create(null);
  const S = new Proxy(cache, {
    get(t, k) {
      if (typeof k !== 'string') return undefined;
      if (!(k in t)) t[k] = CATALOG[k] ? load(k, opts) : undefined;
      return t[k];
    },
    has(t, k) { return !!S[k]; }
  });
  return S;
}

/* The provenance block a draft stores: no document bodies, just enough to
   find and re-read each file. */
function provenance(sources, used) {
  return used.filter(id => sources[id]).map(id => {
    const s = sources[id];
    return { id, file: s.file, what: s.what, sha256: s.sha256, generated_at: s.generated_at, commit: s.commit, uncommitted: !!s.uncommitted };
  });
}

module.exports = { ROOT, CATALOG, load, loader, provenance, reader, git };
