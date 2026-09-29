/* ===========================================================================
   PLAYER PROPS — the durable player registry (EdgeDesk ids and crosswalk).
   docs/player-props/IDENTITY.md

   One EdgeDesk id per person per league, minted ONCE from the anchor
   provider id (NFL: nflverse GSIS; CFB: ESPN athlete id) by
   EDProps.mintPlayerId, and never recomputed from a name. The registry
   file only grows: a player who leaves the league keeps his id and slug,
   marked inactive; a traded player keeps his id and his team history
   grows; a college player who reaches the NFL is LINKED through the ESPN
   athlete id (ESPN uses one id for a person's college and pro careers).

     ids        every provider id nflverse / ESPN carries for the person
     aliases    names a sportsbook has used for him (learned by capture,
                only after an unambiguous resolution), plus manual
                overrides from football/props/identity_overrides.json
     teams      [{team, first_seen, last_seen}] from his games
     slug       assigned once (collisions get -2, -3 …), never reassigned
   =========================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const P = require('../../lib/edgedesk_props.js');

const SCHEMA = 'edgedesk_player_registry_v1';
function file(league) { return path.join(__dirname, league.toLowerCase(), 'players.json'); }
function load(league) {
  try { const j = JSON.parse(fs.readFileSync(file(league), 'utf8')); if (j && j.schema === SCHEMA) return j; } catch (_) { /* first run */ }
  return { schema: SCHEMA, league: league.toUpperCase(), updated_at: null, anchor: league.toUpperCase() === 'NFL' ? 'gsis' : 'espn', players: {}, by_anchor: {}, by_slug: {} };
}
function uniqueSlug(reg, name, id) {
  const base = P.slugify(name);
  if (!reg.by_slug[base] || reg.by_slug[base] === id) return base;
  for (let i = 2; i < 100; i++) { const s = base + '-' + i; if (!reg.by_slug[s] || reg.by_slug[s] === id) return s; }
  return base + '-' + id.slice(-6);
}
/* upsert one person; returns the EdgeDesk id. Existing ids and slugs never change. */
function upsert(reg, league, anchorId, info, seenAt) {
  if (!anchorId) return null;
  let id = reg.by_anchor[anchorId];
  if (!id) {
    id = P.mintPlayerId(league, reg.anchor, anchorId);
    const slug = uniqueSlug(reg, info.name || anchorId, id);
    reg.players[id] = { id, league: league.toUpperCase(), name: info.name || null, slug, position: info.position || null, team: info.team || null, status: info.status || null,
      ids: {}, aliases: { books: [] }, teams: [], first_seen: seenAt || null, last_seen: seenAt || null };
    reg.by_anchor[anchorId] = id;
    reg.by_slug[slug] = id;
  }
  const p = reg.players[id];
  /* a changed name (a hyphenated surname, a preferred name) keeps the old
     one as an alias: books and older records still use it */
  if (info.name && p.name && info.name !== p.name) { p.aliases.former = p.aliases.former || []; if (p.aliases.former.indexOf(p.name) < 0) p.aliases.former.push(p.name); }
  if (info.name) p.name = info.name;
  if (info.position) p.position = info.position;
  if (info.status) p.status = info.status;
  if (info.headshot) p.headshot = info.headshot;
  if (info.jersey) p.jersey = info.jersey;
  if (info.college) p.college = info.college;
  if (info.birth_date) p.birth_date = info.birth_date;
  if (info.rookie_season) p.rookie_season = info.rookie_season;
  Object.keys(info.ids || {}).forEach((k) => { if (info.ids[k]) p.ids[k] = String(info.ids[k]); });
  p.ids[reg.anchor] = String(anchorId);
  if (info.team) {
    const last = p.teams[p.teams.length - 1];
    if (!last || last.team !== info.team) p.teams.push({ team: info.team, first_seen: seenAt || null, last_seen: seenAt || null });
    else last.last_seen = seenAt || last.last_seen;
    p.team = info.team;
  }
  if (seenAt && (!p.last_seen || seenAt > p.last_seen)) p.last_seen = seenAt;
  return id;
}
/* a sportsbook name that resolved unambiguously becomes an alias */
function learnAlias(reg, id, book, rawName) {
  const p = reg.players[id];
  if (!p || !rawName) return false;
  const norm = P.normName(rawName);
  if (norm === P.normName(p.name)) return false;
  if (p.aliases.books.some((a) => a.norm === norm)) return false;
  p.aliases.books.push({ name: rawName, norm, book: book || null });
  return true;
}
/* candidates for one team (the resolver's search space) */
function candidatesFor(reg, team, extraIds) {
  const out = [];
  Object.keys(reg.players).forEach((id) => {
    const p = reg.players[id];
    if (p.team !== team && !(extraIds && extraIds.has(id))) return;
    out.push({ player_id: id, name: p.name, position: p.position, team: p.team, aliases: p.aliases.books.map((a) => a.name).concat(p.aliases.former || []) });
  });
  return out;
}
function overrides() {
  try { const j = JSON.parse(fs.readFileSync(path.join(__dirname, 'identity_overrides.json'), 'utf8')); return j.map || {}; } catch (_) { return {}; }
}
function save(reg, writeIfChanged) {
  reg.updated_at = new Date().toISOString();
  return writeIfChanged(file(reg.league), reg);
}
module.exports = { SCHEMA, load, upsert, learnAlias, candidatesFor, overrides, save, file };
