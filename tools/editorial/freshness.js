#!/usr/bin/env node
/* ============================================================================
   THE FRESHNESS LAYER — a narrow, named re-verification of the few facts that
   actually move in the hour before kickoff.

   WHAT THIS REPLACES. The late-window refresh used to re-run the whole
   research terminal and diff the market block out of the result. That works,
   but it is the wrong shape: it pays for a full model run to learn whether a
   line moved half a point, it gives no per-field provenance, and it cannot
   tell a material change from a cosmetic one because it only ever sees the
   whole payload.

   THIS ASKS NARROW QUESTIONS OF NAMED SOURCES:

     fixture.status     ESPN scoreboard      is the game still happening?
     fixture.kickoff    ESPN scoreboard      at the same time?
     fixture.venue      ESPN scoreboard      in the same place?
     market.line        research market      has the number moved?
     market.total       research market
     market.book        research market      and from which book?
     availability.out   nflverse / EdgeDesk  who has been ruled out?
     availability.qb    nflverse / EdgeDesk  is the starting quarterback out?

   EVERY FIELD CARRIES ITS OWN PROVENANCE: value, provider, retrieved_at and a
   status of ok / unavailable / unsupported. A source that cannot be reached
   produces `unavailable` — never a guess, never a silent null that reads like
   "nothing changed". The difference matters: "the line did not move" and "we
   could not find out whether the line moved" must not look alike to the thing
   deciding whether to publish.

   MATERIALITY IS THE SECOND JOB. Not every movement deserves a regenerated
   article. A line drifting a tenth of a point is noise; a starting
   quarterback being ruled out is not. The thresholds are configuration, the
   rules are named, and the decision is reported rather than implied.

   WHAT IT MUST NEVER DO. Touch the original research snapshot, or revise the
   original thesis. The snapshot is the analytical commitment the postgame
   audit grades. This layer describes CURRENT CONDITIONS at publication; it
   does not get to rewrite what EdgeDesk believed beforehand because the news
   changed. Those are two different claims and the system keeps them apart.
   ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

const STATUS = { OK: 'ok', UNAVAILABLE: 'unavailable', UNSUPPORTED: 'unsupported' };

/* The thresholds that decide material from cosmetic. Configurable; these are
   the defaults, and every one of them is a judgement worth arguing with. */
const DEFAULT_RULES = {
  material_spread_points: 1.0,    /* a full point of line movement */
  material_total_points: 2.0,     /* two points on a total */
  material_kickoff_minutes: 15,   /* a quarter hour is a schedule change */
};

function txt(v) { if (v == null) return null; const s = String(v).replace(/\s+/g, ' ').trim(); return s || null; }
function num(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

/* A field observation, always the same shape so nothing downstream has to
   guess whether a value is missing or merely false. */
function field(value, provider, retrievedAt, status, note) {
  return {
    value: value === undefined ? null : value,
    provider: provider || null,
    retrieved_at: retrievedAt || null,
    status: status || (value == null ? STATUS.UNAVAILABLE : STATUS.OK),
    note: note || null,
  };
}
function unavailable(provider, why) { return field(null, provider, null, STATUS.UNAVAILABLE, why); }

/* ------------------------------------------------------------ the market */
/* Read off the research payload's own market block, which is the shape the
   terminal builds: `market` is the quoted line as text, `total_market` the
   quoted total. Text is the honest comparison — "Vikings -2.5" becoming
   "Packers -1" is a move a bare number would misreport — and a signed number
   is extracted alongside so a threshold can be applied. */
function numberIn(v) {
  const m = /(-?\d+(?:\.\d+)?)/.exec(String(v == null ? '' : v));
  return m ? Number(m[1]) : null;
}
function marketFields(research, opts) {
  opts = opts || {};
  const m = (research && research.market) || {};
  const at = opts.retrieved_at || null;
  if (m.available === false) {
    return {
      'market.line': unavailable('research market', 'no sportsbook quote was captured for this game'),
      'market.total': unavailable('research market', 'no sportsbook quote was captured for this game'),
      'market.book': unavailable('research market', 'no sportsbook quote was captured for this game'),
    };
  }
  const book = txt(m.book || m.source);
  return {
    'market.line': field(txt(m.market), book || 'research market', at),
    'market.total': field(num(m.total_market), book || 'research market', at),
    'market.book': field(book, 'research market', at),
  };
}

/* ----------------------------------------------------------- the fixture */
/* Status, kickoff and venue as a provider reports them now. `live` is whatever
   the caller fetched (an ESPN scoreboard competition, say); with nothing
   supplied every field is `unavailable` rather than assumed unchanged. */
function fixtureFields(live, opts) {
  opts = opts || {};
  const provider = opts.provider || 'espn scoreboard';
  const at = opts.retrieved_at || null;
  if (!live) {
    return {
      'fixture.status': unavailable(provider, 'the fixture feed was not read this run'),
      'fixture.kickoff': unavailable(provider, 'the fixture feed was not read this run'),
      'fixture.venue': unavailable(provider, 'the fixture feed was not read this run'),
    };
  }
  const status = txt(live.status || live.status_name || live.state);
  const kickoff = txt(live.kickoff || live.date || live.game_time);
  return {
    'fixture.status': field(status, provider, at),
    'fixture.kickoff': field(kickoff && Number.isFinite(Date.parse(kickoff))
      ? new Date(Date.parse(kickoff)).toISOString() : null, provider, at),
    'fixture.venue': field(txt(live.venue), provider, at),
  };
}

/* ------------------------------------------------- availability, by sport */
/* STRUCTURED SOURCES ONLY. The NFL report is nflverse's, reduced by
   football/injuries; the college one is EdgeDesk's own availability layer.
   Both carry their own retrieved_at, which is what gets recorded — the
   freshness of the DATA, not the moment we happened to read the file. */
function nflAvailability(teamCode, opts) {
  opts = opts || {};
  const file = opts.injuries_file || path.join(ROOT, 'football', 'injuries', 'nfl_2026.json');
  const j = opts.injuries || readJson(file);
  if (!j || !j.teams) {
    return {
      'availability.out': unavailable('nflverse injury report', 'no injury report on disk'),
      'availability.qb': unavailable('nflverse injury report', 'no injury report on disk'),
    };
  }
  const at = j.retrieved_at || j.published || null;
  const team = j.teams[String(teamCode || '').toUpperCase()];
  if (!team) {
    return {
      'availability.out': unavailable('nflverse injury report',
        'the report carries no row for ' + (teamCode || 'this team')),
      'availability.qb': unavailable('nflverse injury report',
        'the report carries no row for ' + (teamCode || 'this team')),
    };
  }
  const players = (team.players || []);
  const out = players.filter(p => /^(out|injured reserve|doubtful)$/i.test(String(p.status || '')))
    .map(p => txt(p.name) + ' (' + txt(p.position) + ', ' + txt(p.status) + ')')
    .sort();
  const qbOut = players.filter(p => String(p.position || '').toUpperCase() === 'QB'
    && /^(out|injured reserve|doubtful)$/i.test(String(p.status || '')))
    .map(p => txt(p.name)).sort();
  return {
    'availability.out': field(out, 'nflverse injury report', at),
    'availability.qb': field(qbOut, 'nflverse injury report', at),
  };
}

function cfbAvailability(teamName, opts) {
  opts = opts || {};
  const file = opts.availability_file || path.join(ROOT, 'football', 'availability', 'current.json');
  const j = opts.availability || readJson(file);
  if (!j || !Array.isArray(j.teams)) {
    return {
      'availability.out': unavailable('EdgeDesk availability', 'no availability file on disk'),
      'availability.qb': unavailable('EdgeDesk availability', 'no availability file on disk'),
    };
  }
  const at = j.generated_at || null;
  const want = String(teamName || '').toLowerCase();
  const team = j.teams.filter(t => [t.team_name, t.team_display, t.team_abbr]
    .some(n => String(n || '').toLowerCase() === want))[0];
  if (!team) {
    return {
      'availability.out': unavailable('EdgeDesk availability',
        'no availability row for ' + (teamName || 'this team')),
      'availability.qb': unavailable('EdgeDesk availability',
        'no availability row for ' + (teamName || 'this team')),
    };
  }
  /* COLLEGE FOOTBALL HAS NO UNIVERSAL INJURY REPORT, and the availability
     layer says so per team. A team whose data quality is LIMITED is reported
     as unavailable rather than as "nobody is out", because those are very
     different claims and only one of them is true. */
  if (String(team.dataQuality || '').toUpperCase() === 'LIMITED' && !(team.records || []).length) {
    return {
      'availability.out': unavailable('EdgeDesk availability',
        'coverage for ' + (team.team_display || teamName) + ' is LIMITED — absence of a report is not a report of no absences'),
      'availability.qb': unavailable('EdgeDesk availability', 'coverage is LIMITED'),
    };
  }
  const recs = team.records || [];
  const out = recs.filter(r => /^(out|unavailable|suspended)$/i.test(String(r.status || '')))
    .map(r => txt(r.name) + ' (' + txt(r.position || '?') + ', ' + txt(r.status) + ')').sort();
  const qbOut = recs.filter(r => String(r.position || '').toUpperCase() === 'QB'
    && /^(out|unavailable|suspended)$/i.test(String(r.status || '')))
    .map(r => txt(r.name)).sort();
  return {
    'availability.out': field(out, 'EdgeDesk availability', at),
    'availability.qb': field(qbOut, 'EdgeDesk availability', at),
  };
}

/* ----------------------------------------------------------- observation */
/* Everything the freshness layer can see right now, in one object. */
function observe(game, opts) {
  opts = opts || {};
  const sport = String((game && game.sport) || '').toUpperCase();
  const research = opts.research || null;
  const out = {};
  Object.assign(out, marketFields(research, { retrieved_at: opts.market_retrieved_at }));
  Object.assign(out, fixtureFields(opts.fixture, {
    provider: opts.fixture_provider, retrieved_at: opts.fixture_retrieved_at }));
  if (sport === 'NFL') {
    Object.assign(out, nflAvailability(opts.team_code || (game && game.home_code), opts));
  } else if (sport === 'CFB') {
    Object.assign(out, cfbAvailability(opts.team_name || (game && game.home), opts));
  } else {
    out['availability.out'] = field(null, null, null, STATUS.UNSUPPORTED,
      'no availability source is wired for ' + (sport || 'this sport'));
    out['availability.qb'] = field(null, null, null, STATUS.UNSUPPORTED,
      'no availability source is wired for ' + (sport || 'this sport'));
  }
  return out;
}

/* ------------------------------------------------------------ comparison */
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a || []) === JSON.stringify(b || []);
  }
  return a === b;
}

/* What moved between two observations. A field that is UNAVAILABLE on either
   side is not a change — we did not learn that it moved, we failed to look,
   and those are reported separately so a caller can refuse to publish on a
   blind spot rather than mistaking it for stability. */
function compare(before, after) {
  const changes = [], blind = [];
  Object.keys(after || {}).forEach(k => {
    const a = (before || {})[k], b = after[k];
    if (!b) return;
    if (b.status !== STATUS.OK) {
      if (b.status === STATUS.UNAVAILABLE) blind.push({ field: k, why: b.note, provider: b.provider });
      return;
    }
    if (!a || a.status !== STATUS.OK) return;   /* nothing to compare against */
    if (!sameValue(a.value, b.value)) {
      changes.push({ field: k, from: a.value, to: b.value,
        provider: b.provider, retrieved_at: b.retrieved_at });
    }
  });
  return { changes, blind };
}

/* ----------------------------------------------------------- materiality */
/* Which changes are worth regenerating the article for. Every rule is named,
   so a run log says "the line moved 1.5 points, over the 1-point threshold"
   rather than "material change detected". */
function materiality(changes, opts) {
  opts = opts || {};
  const rules = Object.assign({}, DEFAULT_RULES, opts.rules || {});
  const hits = [], minor = [];

  (changes || []).forEach(c => {
    switch (c.field) {
      case 'fixture.status': {
        const s = String(c.to || '').toLowerCase();
        if (/postpon|cancel|suspend/.test(s)) {
          hits.push({ rule: 'fixture_postponed', field: c.field,
            why: 'the fixture is ' + c.to + ' — no pregame article is published for it',
            blocking: true });
        } else {
          hits.push({ rule: 'fixture_status_changed', field: c.field,
            why: 'the fixture status moved from ' + c.from + ' to ' + c.to });
        }
        break;
      }
      case 'fixture.kickoff': {
        const mins = Math.abs((Date.parse(c.to) - Date.parse(c.from)) / 60000);
        if (Number.isFinite(mins) && mins >= rules.material_kickoff_minutes) {
          hits.push({ rule: 'kickoff_moved', field: c.field,
            why: 'kickoff moved ' + Math.round(mins) + ' minutes, at or over the '
              + rules.material_kickoff_minutes + '-minute threshold' });
        } else {
          minor.push({ rule: 'kickoff_nudged', field: c.field,
            why: 'kickoff moved ' + Math.round(mins || 0) + ' minutes, under the threshold' });
        }
        break;
      }
      case 'fixture.venue':
        hits.push({ rule: 'venue_changed', field: c.field,
          why: 'the venue moved from ' + c.from + ' to ' + c.to });
        break;
      case 'market.line': {
        const a = numberIn(c.from), b = numberIn(c.to);
        const moved = (a != null && b != null) ? Math.abs(b - a) : null;
        if (moved == null || moved >= rules.material_spread_points) {
          hits.push({ rule: 'spread_moved', field: c.field,
            why: moved == null
              ? 'the quoted side changed: ' + c.from + ' → ' + c.to
              : 'the line moved ' + moved.toFixed(1) + ' points, at or over the '
                + rules.material_spread_points + '-point threshold' });
        } else {
          minor.push({ rule: 'spread_drifted', field: c.field,
            why: 'the line moved ' + moved.toFixed(1) + ' points, under the '
              + rules.material_spread_points + '-point threshold' });
        }
        break;
      }
      case 'market.total': {
        const moved = (num(c.from) != null && num(c.to) != null)
          ? Math.abs(num(c.to) - num(c.from)) : null;
        if (moved == null || moved >= rules.material_total_points) {
          hits.push({ rule: 'total_moved', field: c.field,
            why: 'the total moved ' + (moved == null ? '' : moved.toFixed(1) + ' points, ')
              + 'at or over the ' + rules.material_total_points + '-point threshold' });
        } else {
          minor.push({ rule: 'total_drifted', field: c.field,
            why: 'the total moved ' + moved.toFixed(1) + ' points, under the threshold' });
        }
        break;
      }
      case 'market.book':
        minor.push({ rule: 'book_changed', field: c.field,
          why: 'the quoting book changed from ' + c.from + ' to ' + c.to });
        break;
      case 'availability.qb':
        hits.push({ rule: 'starting_qb_changed', field: c.field,
          why: 'the quarterback availability changed: '
            + JSON.stringify(c.from) + ' → ' + JSON.stringify(c.to) });
        break;
      case 'availability.out': {
        const before = new Set(c.from || []);
        const added = (c.to || []).filter(x => !before.has(x));
        if (added.length) {
          hits.push({ rule: 'player_ruled_out', field: c.field,
            why: added.length + ' newly unavailable: ' + added.slice(0, 3).join('; ') });
        } else {
          minor.push({ rule: 'availability_eased', field: c.field,
            why: 'the unavailable list shortened' });
        }
        break;
      }
      default:
        minor.push({ rule: 'other_change', field: c.field, why: 'changed' });
    }
  });

  const blocking = hits.filter(h => h.blocking);
  return {
    material: hits.length > 0,
    blocking: blocking.length > 0,
    hits, minor, rules,
    summary: hits.length
      ? hits.map(h => h.rule).join(', ')
      : (minor.length ? 'only immaterial movement (' + minor.map(m => m.rule).join(', ') + ')'
                      : 'nothing moved'),
  };
}

module.exports = {
  STATUS, DEFAULT_RULES, field, unavailable, numberIn,
  marketFields, fixtureFields, nflAvailability, cfbAvailability,
  observe, compare, materiality, sameValue,
};
