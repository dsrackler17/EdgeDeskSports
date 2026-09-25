/* ============================================================================
   OFFICIAL AVAILABILITY REPORTS — one ingestion path, whatever the format.

   WHAT THIS EXISTS TO END. `football/availability/current.json` graded all 138
   FBS programmes LIMITED with zero records, and the sentence everything
   downstream printed was "college football files no injury report". That
   stopped being true in 2025: every Power Four conference and several others
   now require player availability reports for conference games and publish
   them. football/availability/policy.js carries which conference publishes
   what, for which fixtures, on what cadence, and in which status vocabulary.
   This is the path that turns one of those published documents into evidence.

   WHAT AN INGESTED REPORT CARRIES, all of it required:

     named player      resolved to an athlete id on the CURRENT roster; a name
                       that does not resolve is QUARANTINED, never invented
     position          from the roster, not from the document
     status            mapped into EdgeDesk's designations, and refused if the
                       document uses a word outside the policy's vocabulary
     affected game     the fixture the report is filed for. A report is
                       evidence about THAT game and is never carried onto
                       another one
     source scope      whether the policy's report is COMPREHENSIVE (every
                       player designated, so silence about a player is a
                       statement he is available) or SELECTED (only absences
                       filed, so silence says nothing)
     timestamps        when the conference PUBLISHED it and when EdgeDesk
                       RETRIEVED it, as two separate fields, because
                       re-reading an unchanged document does not make it new
     conflicts         a prior record for the same player and game with a
                       different status, kept with both sources rather than
                       overwritten

   THE THREE THINGS THAT ARE NOT EVIDENCE OF HEALTH, and the reason this file
   is careful: an empty response, a blocked request, and a roster listing. A
   read that produced nothing is recorded with `ok:false` and a reason, and no
   code path turns it into a team with no absences. Only a COMPREHENSIVE
   report that was actually read and parsed may say nobody is out.

   Node (it uses the PDF reader). The HTML stripper is shared with collectors.
   ========================================================================== */
'use strict';
const path = require('path');
const A = require(path.join(__dirname, 'availability.js'));
const POLICY = require(path.join(__dirname, 'policy.js'));
const PDF = require(path.join(__dirname, 'pdf_text.js'));

const SCHEMA = 'edgedesk_availability_report_v1';

/* EdgeDesk designations, and which of them each policy vocabulary may
   produce. A word outside the conference's own published vocabulary is a word
   this parser did not understand, not a status to be guessed at. */
const DESIGNATIONS = ['AVAILABLE', 'PROBABLE', 'QUESTIONABLE', 'DOUBTFUL', 'OUT', 'OUT_FIRST_HALF',
  'GAME_TIME_DECISION', 'DAY_TO_DAY', 'LIMITED'];

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(tr|p|div|li|h[1-6]|table)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n')
    .replace(/<td[^>]*>/gi, ' │ ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;?/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n');
}

/* THE DOCUMENT -> LINES, whatever it arrived as. A format this cannot read
   returns ok:false with a reason, and the caller records a failed read. */
function toLines(body, contentType) {
  const ct = String(contentType || '').toLowerCase();
  if (Buffer.isBuffer(body) && (ct.indexOf('pdf') >= 0 || body.slice(0, 5).toString('latin1') === '%PDF-')) {
    const r = PDF.extract(body);
    if (!r.ok) return { ok: false, lines: [], format: 'pdf', why: r.why };
    return { ok: true, lines: r.lines, format: 'pdf', why: null };
  }
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!text.trim()) return { ok: false, lines: [], format: 'text', why: 'the source returned an empty body' };
  const looksHtml = /<\/?[a-z][\s\S]*>/i.test(text);
  const lines = (looksHtml ? stripHtml(text) : text).split('\n').map(s => s.trim()).filter(Boolean);
  if (!lines.length) return { ok: false, lines: [], format: looksHtml ? 'html' : 'text',
    why: 'the document carried no readable lines after markup was stripped' };
  return { ok: true, lines, format: looksHtml ? 'html' : 'text', why: null };
}

/* Does this line name a player on the supplied roster, and does it carry a
   designation the policy's own vocabulary allows? Roster-anchored, so a
   stray string can never become a player. */
function rowsFrom(lines, roster, allowed) {
  const byNorm = {};
  (roster || []).forEach(p => { const k = A.normName(p.name); if (k) (byNorm[k] = byNorm[k] || []).push(p); });
  /* longest first, so "Jordan Smith Jr" wins over "Jordan Smith" when both
     are on the roster and the line names the longer one */
  const keys = Object.keys(byNorm).sort((a, b) => b.length - a.length);
  const out = [];
  const seen = {};
  const unparsed = [];
  for (const line of lines) {
    if (line.length > 500) continue;
    const norm = ' ' + A.normName(line) + ' ';
    for (const k of keys) {
      if (norm.indexOf(' ' + k + ' ') < 0) continue;
      if (seen[k]) continue;
      const parsed = A.normalizeAvailabilityStatus(line);
      let status = parsed.status;
      /* AN OFFICIAL REPORT IS A TABLE, NOT PROSE, and the prose rules are
         deliberately conservative: a bare "Out" is ambiguous in a sentence
         ("out of the backfield") and is not read as a designation there. In a
         filed report it is a COLUMN, so each cell is tested on its own and a
         cell that IS a designation is read as one. A word inside a longer
         cell still is not: "ruled out last week" is prose and goes back to
         the prose rules. */
      if (status === 'UNKNOWN') {
        const cells = line.split(/\s*\u2502\s*|\t+|\s{3,}/).map(x => x.trim()).filter(Boolean);
        for (const cell of cells) {
          if (cell.length > 24) continue;
          const d = A.normalizeDesignation(cell);
          if (d !== 'UNKNOWN') { status = d; break; }
        }
      }
      /* A PDF LOSES THE COLUMNS. Extracting text from a filed report collapses
         "Beck | QB | Out" into "Carson Beck QB OUT", so the cell split finds
         nothing and a designation that IS in the document goes unread. The
         last one or two tokens of a SHORT line are tested — a report line is a
         name, a position and a status, and a sentence long enough to hide a
         stray "out" in prose is excluded by the length bound. */
      if (status === 'UNKNOWN' && line.length <= 80) {
        const tok = line.split(/\s+/).filter(Boolean);
        for (const tail of [tok.slice(-2).join(' '), tok.slice(-1).join(' ')]) {
          if (!tail) continue;
          const d = A.normalizeDesignation(tail);
          if (d !== 'UNKNOWN') { status = d; break; }
        }
      }
      /* OUT (FIRST HALF) is new in the 2026 Big Ten vocabulary and is NOT
         OUT: it is a player unavailable for two quarters. It is read here
         because flattening it either way misprices the absence. */
      if (/out\s*\(?\s*(1st|first)\s*half/i.test(line)) status = 'OUT_FIRST_HALF';
      if (!status || status === 'UNKNOWN') { unparsed.push({ player: byNorm[k][0].name, line }); seen[k] = 1; break; }
      if (allowed && allowed.length && allowed.indexOf(status) < 0) {
        unparsed.push({ player: byNorm[k][0].name, line,
          why: 'the line reads as ' + status + ', which is not in this conference’s published vocabulary ('
            + allowed.join('/') + '), so it is quarantined rather than mapped onto a status it may not mean' });
        seen[k] = 1; break;
      }
      seen[k] = 1;
      const p = byNorm[k][0];
      out.push({
        player_name: p.name, player_id: p.player_id || p.espn_id || null,
        position: p.position || null, jersey: p.jersey || null,
        status: status, practice_status: parsed.practice_status, body_part: parsed.body_part,
        raw_text: line
      });
      break;
    }
  }
  return { rows: out, unparsed };
}

/* ingest one document.
   o = { body, content_type, conference, source_url, published_at, retrieved_at,
         team, roster, game_id, kickoff, home_conference, away_conference,
         is_conference_game }                                              */
function ingest(o) {
  o = o || {};
  const pol = POLICY.forConference(o.conference);
  const now = o.now || Date.now();
  const applicability = POLICY.forGame({
    home_conference: o.home_conference || o.conference, away_conference: o.away_conference || o.conference,
    is_conference_game: o.is_conference_game !== false, kickoff: o.kickoff
  }, 'home', now);

  const base = {
    schema: SCHEMA, version: 1,
    conference: pol ? pol.name : (o.conference || null),
    conference_id: pol ? pol.id : null,
    team: o.team || null,
    game_id: o.game_id == null ? null : String(o.game_id),
    kickoff: o.kickoff || null,
    source_url: o.source_url || null,
    /* TWO CLOCKS, NEVER ONE. `published_at` is when the conference filed it;
       `retrieved_at` is when EdgeDesk read it. Re-reading an unchanged
       document moves the second and must never move the first. */
    published_at: o.published_at || null,
    retrieved_at: o.retrieved_at || new Date(now).toISOString(),
    scope: pol ? pol.applies_to : null,
    comprehensive: POLICY.silenceMeansAvailable(pol),
    vocabulary: pol ? (pol.statuses || []) : [],
    applicability: { state: applicability.state, why: applicability.why }
  };

  const pub = o.published_at ? Date.parse(o.published_at) : NaN;
  if (isFinite(pub) && pub > now + 3600000) {
    return Object.assign(base, { ok: false, rows: [], unparsed: [],
      why: 'the document is dated ' + o.published_at + ', which is in the future. A publication time EdgeDesk '
        + 'cannot trust is refused rather than used to age the evidence' });
  }
  if (!o.published_at) {
    return Object.assign(base, { ok: false, rows: [], unparsed: [],
      why: 'the document carries no publication date. An availability report without one cannot be aged against '
        + 'its filing deadline or ordered against a conflicting report, so it is refused rather than dated from '
        + 'the moment EdgeDesk happened to read it' });
  }
  if (pol && pol.state !== 'PUBLISHED') {
    return Object.assign(base, { ok: false, rows: [], unparsed: [],
      why: 'no published availability policy is registered for ' + (o.conference || 'this conference')
        + ', so EdgeDesk cannot say what this document’s scope or vocabulary is. Register it in '
        + 'football/availability/policy.js first' });
  }

  const doc = toLines(o.body, o.content_type);
  base.format = doc.format;
  if (!doc.ok) {
    return Object.assign(base, { ok: false, rows: [], unparsed: [],
      /* A FAILED READ, EXPLICITLY. Nothing downstream may read this as a
         report that named nobody. */
      why: 'the document could not be read: ' + doc.why });
  }
  const { rows, unparsed } = rowsFrom(doc.lines, o.roster || [], base.vocabulary);
  base.lines_read = doc.lines.length;
  base.rows = rows;
  base.unparsed = unparsed;
  base.ok = true;
  /* A COMPREHENSIVE REPORT THAT NAMES NOBODY is the only clean bill of health
     in this file, and it still requires that the document was READ. */
  base.names_nobody = rows.length === 0;
  base.silence_means_available = base.comprehensive && base.names_nobody && doc.lines.length > 0;
  base.why = rows.length
    ? rows.length + ' player(s) resolved on the current roster'
    : (base.silence_means_available
      ? 'the report was read in full and designates nobody on this roster, which its policy makes a report of no '
        + 'absences'
      : 'the report was read and named nobody on this roster, and this conference’s policy files only '
        + 'absences, so it is not a statement that the roster is whole');
  return base;
}

/* TWO REPORTS, ONE PLAYER, ONE GAME. The later filing wins and the earlier one
   is KEPT beside it: a conference that moves a player from questionable to out
   on the morning of a game has told you something, and overwriting the first
   record loses it. A conflict between two filings with the SAME timestamp is
   not resolved at all. */
function reconcile(prior, next) {
  const out = [];
  const conflicts = [];
  const key = r => [r.player_id || A.normName(r.player_name), r.game_id || ''].join('|');
  const byKey = new Map();
  (prior || []).concat(next || []).forEach(r => {
    const k = key(r);
    const have = byKey.get(k);
    if (!have) { byKey.set(k, r); return; }
    if (have.status === r.status) { byKey.set(k, newer(have, r)); return; }
    const a = Date.parse(have.published_at || 0), b = Date.parse(r.published_at || 0);
    if (isFinite(a) && isFinite(b) && a !== b) {
      const win = b > a ? r : have, lose = b > a ? have : r;
      conflicts.push({ player: r.player_name, game_id: r.game_id || null,
        resolved_to: win.status, resolved_by: 'the later filing',
        superseded: { status: lose.status, published_at: lose.published_at, source_url: lose.source_url },
        winner: { status: win.status, published_at: win.published_at, source_url: win.source_url } });
      byKey.set(k, Object.assign({}, win, { superseded: lose }));
      return;
    }
    /* same instant, different status: NOT resolved */
    conflicts.push({ player: r.player_name, game_id: r.game_id || null,
      resolved_to: null, resolved_by: null,
      why: 'two filings carry the same publication time and different statuses; EdgeDesk does not pick between '
        + 'them and the field is reported CONFLICTING',
      sides: [{ status: have.status, source_url: have.source_url }, { status: r.status, source_url: r.source_url }] });
    byKey.set(k, Object.assign({}, have, { conflicting: true, other_status: r.status }));
  });
  byKey.forEach(v => out.push(v));
  return { records: out, conflicts };
}
function newer(a, b) {
  const x = Date.parse(a.retrieved_at || 0), y = Date.parse(b.retrieved_at || 0);
  return (isFinite(y) && y > x) ? b : a;
}

/* ---------------------------------------------------------- the bundle
   THE REPORTS ON FILE, AS ONE DOCUMENT THE BOARD CAN READ.

   The published build reads every report in football/availability/reports/
   and merges them into the availability layer (football/availability/
   overlay.js). A browser cannot list a directory, so the board had no way to
   find them: it read the automated collector alone, and for a conference
   game whose filing EdgeDesk had ingested it reported "no report" while the
   published slate reported the filing — a different input contract, and a
   different confidence, for the same game out of the same files.

   So the reports are also published here as ONE file, in the order the
   build reads them (file name), carrying exactly the fields the overlay
   reads. It is derived, never edited: every writer of a report rewrites it,
   and football/availability/reports.test.js fails when it no longer matches
   the directory. The unparsed lines are counted, not copied — the overlay
   reads only how many there were, and the full text stays in each file. */
const BUNDLE_SCHEMA = 'edgedesk_availability_reports_bundle_v1';
const BUNDLE_FILE = path.join(__dirname, 'reports.bundle.json');
function compactReport(r, file) {
  return { file: file, team: r.team, team_id: r.team_id == null ? null : r.team_id,
    conference: r.conference || null, game_id: r.game_id == null ? null : String(r.game_id),
    kickoff: r.kickoff || null, ok: !!r.ok, why: r.why || null, source_url: r.source_url || null,
    published_at: r.published_at || null, retrieved_at: r.retrieved_at || null,
    scope: r.scope || null, comprehensive: !!r.comprehensive, vocabulary: r.vocabulary || [],
    rows: r.rows || [], unparsed_n: (r.unparsed || []).length,
    silence_means_available: !!r.silence_means_available };
}
/* every ingested report in `dir`, in file-name order */
function readAll(dir) {
  const fs = require('fs');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => /\.json$/.test(f)).sort().map(f => {
    let r = null;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { r = null; }
    return (r && r.schema === SCHEMA) ? { file: f, report: r } : null;
  }).filter(Boolean);
}
function bundle(dir) {
  return { schema: BUNDLE_SCHEMA,
    why: 'Every ingested conference availability report in football/availability/reports/, in the order the '
      + 'published build reads them, carrying the fields football/availability/overlay.js reads — so the board '
      + 'merges the same filings the build does. Derived; rewritten by every report writer.',
    reports: readAll(dir).map(x => compactReport(x.report, x.file)) };
}
/* rewrite the bundle when it no longer matches the directory */
function writeBundle(dir, dest) {
  const fs = require('fs');
  dest = dest || BUNDLE_FILE;
  const text = JSON.stringify(bundle(dir || path.join(__dirname, 'reports')), null, 1) + '\n';
  let prev = null;
  try { prev = fs.readFileSync(dest, 'utf8'); } catch (_) { prev = null; }
  if (prev === text) return false;
  fs.writeFileSync(dest, text);
  return true;
}

module.exports = { ingest, reconcile, toLines, rowsFrom, stripHtml, DESIGNATIONS, SCHEMA,
  BUNDLE_SCHEMA, BUNDLE_FILE, compactReport, readAll, bundle, writeBundle };
