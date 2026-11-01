'use strict';
/* ===========================================================================
   NCAAM-EARLY — the hand-entered T0 observations, and their validators.

   CBBD 1.30.1 has no coaches endpoint and no source feeds injuries, so both
   are entered by a person, each record with its source URL and when it was
   entered. They are observations (T0) with provenance, never estimates:

     manual/coaches.json        head coach per team per season: first season at
                                the school, prior job and its level, career
     manual/availability.json   player availability for a game, as published
                                (status, source URL, published_at). APPEND-ONLY:
                                a correction is a new entry that `supersedes`
                                the old id; nothing is edited or removed
     manual/school_levels.json  the level of a non-D-I school a transfer came
                                from (D2, D3, NAIA, JUCO, INTERNATIONAL, PREP)

   A team with no coach record is UNKNOWN (null), never "same coach": the
   coach-change flag is derived only from a record (coachFacts).

   validate*(doc, now) -> { ok, errors[], entries[] }. The scheduled job and
   tests refuse a file that does not validate.
   =========================================================================== */
const fs = require('fs');
const C = require('./config');

const COACH_LEVELS = ['D1', 'D2', 'D3', 'NAIA', 'JUCO', 'NBA', 'G_LEAGUE', 'INTERNATIONAL', 'HIGH_SCHOOL', 'NONE'];
const COACH_ROLES = ['HEAD', 'ASSOCIATE_HEAD', 'ASSISTANT', 'OTHER'];
const STATUSES = ['OUT', 'DOUBTFUL', 'QUESTIONABLE', 'PROBABLE', 'AVAILABLE', 'SUSPENDED', 'SEASON_ENDING'];
const SCHOOL_LEVELS = ['D2', 'D3', 'NAIA', 'JUCO', 'INTERNATIONAL', 'PREP'];
const CONFIDENCE = ['confirmed', 'reported'];

const isUrl = (u) => typeof u === 'string' && /^https:\/\/[^\s/]+\.[^\s]+$/.test(u);
const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z'));
const isTime = (t) => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?Z$/.test(t) && Number.isFinite(Date.parse(t));
const isSeason = (s) => Number.isInteger(s) && s >= 1990 && s <= 2100;
const nonEmpty = (s) => typeof s === 'string' && s.trim().length > 0;

function base(doc, schema, errors) {
  if (!doc || typeof doc !== 'object') { errors.push('not a JSON object'); return []; }
  if (doc.schema !== schema) errors.push('schema must be ' + schema);
  if (!Array.isArray(doc.entries)) { errors.push('entries must be a list'); return []; }
  return doc.entries;
}

function validateCoaches(doc, now) {
  const errors = []; const t = now == null ? Date.now() : Date.parse(now);
  const entries = base(doc, 'edgedesk_ncaam_early_coaches_v1', errors);
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = 'coaches[' + i + ']';
    if (!isSeason(e.season)) errors.push(at + ': season (END year) is required');
    if (!Number.isInteger(e.team_id)) errors.push(at + ': team_id (CBBD team id) is required');
    if (!nonEmpty(e.team_name)) errors.push(at + ': team_name is required');
    if (!nonEmpty(e.coach)) errors.push(at + ': coach is required');
    if (!isSeason(e.first_season_at_school) || (isSeason(e.season) && e.first_season_at_school > e.season)) errors.push(at + ': first_season_at_school must be a season no later than season');
    if (!e.prior_job || !COACH_LEVELS.includes(e.prior_job.level) || !COACH_ROLES.includes(e.prior_job.role) || !nonEmpty(e.prior_job.team_name)) errors.push(at + ': prior_job needs team_name, level (' + COACH_LEVELS.join('|') + ') and role (' + COACH_ROLES.join('|') + ')');
    if (e.prior_job && typeof e.prior_job.internal_promotion !== 'boolean') errors.push(at + ': prior_job.internal_promotion must be true or false');
    if (e.career != null) {
      if (!Array.isArray(e.career)) errors.push(at + ': career must be a list');
      else e.career.forEach((c, j) => {
        if (!nonEmpty(c.team_name) || !COACH_LEVELS.includes(c.level) || !COACH_ROLES.includes(c.role) || !isSeason(c.from_season) || !(c.to_season == null || (isSeason(c.to_season) && c.to_season >= c.from_season)))
          errors.push(at + '.career[' + j + ']: team_name, level, role, from_season (and to_season >= from_season, or null) are required');
        if (c.team_id != null && !Number.isInteger(c.team_id)) errors.push(at + '.career[' + j + ']: team_id must be a CBBD team id or absent');
      });
    }
    if (!Array.isArray(e.source_urls) || !e.source_urls.length || !e.source_urls.every(isUrl)) errors.push(at + ': source_urls must list at least one https URL');
    if (!CONFIDENCE.includes(e.confidence)) errors.push(at + ': confidence must be ' + CONFIDENCE.join(' or '));
    if (!isTime(e.entered_at) || Date.parse(e.entered_at) > t + 60e3) errors.push(at + ': entered_at must be a UTC time, not in the future');
    if (!nonEmpty(e.entered_by)) errors.push(at + ': entered_by is required');
    const k = e.season + ':' + e.team_id;
    if (seen.has(k)) errors.push(at + ': a second record for team ' + e.team_id + ' in ' + e.season);
    seen.add(k);
  });
  return { ok: errors.length === 0, errors, entries };
}

/* the derived facts the model may read; a team without a record is absent */
function coachFacts(entries, season, teamId) {
  const e = entries.find((x) => x.season === season && x.team_id === teamId);
  if (!e) return null;
  return { coach: e.coach, coach_change: e.first_season_at_school === season, tenure_years: season - e.first_season_at_school + 1,
    prior_level: e.prior_job.internal_promotion ? 'INTERNAL_PROMOTION' : e.prior_job.role === 'HEAD' ? e.prior_job.level : (e.prior_job.level === 'NBA' || e.prior_job.level === 'G_LEAGUE' ? e.prior_job.level : 'ASSISTANT'),
    prior_team: e.prior_job.team_name, career: e.career || [], confidence: e.confidence, source_urls: e.source_urls, entered_at: e.entered_at };
}

function validateAvailability(doc, now) {
  const errors = []; const t = now == null ? Date.now() : Date.parse(now);
  const entries = base(doc, 'edgedesk_ncaam_early_availability_v1', errors);
  const ids = new Set();
  entries.forEach((e, i) => {
    const at = 'availability[' + i + ']';
    if (!nonEmpty(e.id) || !/^av_[a-z0-9_-]+$/.test(e.id)) errors.push(at + ': id (av_...) is required');
    else if (ids.has(e.id)) errors.push(at + ': id ' + e.id + ' is used twice');
    if (nonEmpty(e.id)) ids.add(e.id);
    if (!isSeason(e.season)) errors.push(at + ': season (END year) is required');
    if (!Number.isInteger(e.team_id)) errors.push(at + ': team_id (CBBD team id) is required');
    if (!(Number.isInteger(e.game_id) || isDate(e.game_date))) errors.push(at + ': game_id (CBBD) or game_date is required');
    if (!nonEmpty(e.player_name)) errors.push(at + ': player_name is required');
    if (e.player_id != null && !Number.isInteger(e.player_id)) errors.push(at + ': player_id must be a CBBD athlete id or absent');
    if (!STATUSES.includes(e.status)) errors.push(at + ': status must be one of ' + STATUSES.join('|'));
    if (!isUrl(e.source_url)) errors.push(at + ': source_url must be an https URL');
    if (!isTime(e.published_at)) errors.push(at + ': published_at (when the source published it, UTC) is required');
    if (!isTime(e.entered_at) || Date.parse(e.entered_at) > t + 60e3) errors.push(at + ': entered_at must be a UTC time, not in the future');
    if (isTime(e.published_at) && isTime(e.entered_at) && Date.parse(e.published_at) > Date.parse(e.entered_at)) errors.push(at + ': published_at is after entered_at');
    if (!nonEmpty(e.entered_by)) errors.push(at + ': entered_by is required');
    if (!nonEmpty(e.confidence_note)) errors.push(at + ': confidence_note is required (how sure, and why)');
    if (e.supersedes != null && !ids.has(e.supersedes)) errors.push(at + ': supersedes ' + e.supersedes + ', which is not an EARLIER entry');
  });
  return { ok: errors.length === 0, errors, entries };
}

/* the availability a model could know at `asOf`: published and entered by
   then, the latest non-superseded entry per (team, game, player) */
function availabilityAsOf(entries, asOf) {
  const t = Date.parse(asOf);
  const known = entries.filter((e) => Date.parse(e.entered_at) <= t && Date.parse(e.published_at) <= t);
  const dead = new Set(known.map((e) => e.supersedes).filter(Boolean));
  return known.filter((e) => !dead.has(e.id));
}

function validateSchoolLevels(doc, now) {
  const errors = []; const t = now == null ? Date.now() : Date.parse(now);
  const entries = base(doc, 'edgedesk_ncaam_early_school_levels_v1', errors);
  const seen = new Set();
  entries.forEach((e, i) => {
    const at = 'school_levels[' + i + ']';
    if (!nonEmpty(e.name)) errors.push(at + ': name is required');
    if (!SCHOOL_LEVELS.includes(e.level)) errors.push(at + ': level must be one of ' + SCHOOL_LEVELS.join('|'));
    if (!isUrl(e.source_url)) errors.push(at + ': source_url must be an https URL');
    if (!isTime(e.entered_at) || Date.parse(e.entered_at) > t + 60e3) errors.push(at + ': entered_at must be a UTC time, not in the future');
    const k = String(e.name || '').toLowerCase();
    if (seen.has(k)) errors.push(at + ': ' + e.name + ' is listed twice');
    seen.add(k);
  });
  return { ok: errors.length === 0, errors, entries };
}

function loadAll(now) {
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  return { coaches: validateCoaches(read(C.PATHS.coaches), now), availability: validateAvailability(read(C.PATHS.availability), now), school_levels: validateSchoolLevels(read(C.PATHS.schoolLevels), now) };
}

module.exports = { validateCoaches, coachFacts, validateAvailability, availabilityAsOf, validateSchoolLevels, loadAll, COACH_LEVELS, COACH_ROLES, STATUSES, SCHOOL_LEVELS };
