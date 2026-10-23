/* ===========================================================================
   ESPN'S GOLF DOCUMENTS, AS THE SIMULATOR READS THEM — one parser for the
   committed feeds (simulator/src/cli/fetch_sports_data.ts writes them with
   it) and for the live leaderboard a golf run reads on GitHub's runners
   (inputs.ts), so a player read live and a player read from the committed
   file are the same record.

   Sources (public, keyless):
     scoreboard   https://site.api.espn.com/apis/site/v2/sports/golf/<league>/scoreboard
     leaderboard  https://site.web.api.espn.com/apis/site/v2/sports/golf/leaderboard?league=<league>&event=<id>
   The leaderboard carries each player's status (cut, WD), position, thru and
   tee time; the scoreboard does not. league: pga (PGA Tour), lpga, eur (DP
   World Tour).

   One competitor -> { id, name, country, rounds: [{ r, strokes, holes,
   to_par, tee_time, is_playoff }], status, position, sort_order, score,
   thru, tee_time, start_hole, playoff }. A round's strokes are the strokes
   so far while it is being played (thru < 18); a playoff is a linescore of
   its own (is_playoff, or a period after the last regulation round).
   =========================================================================== */

export const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/golf';
export const ESPN_WEB = 'https://site.web.api.espn.com/apis/site/v2/sports/golf';
export const leaderboardUrl = (league: string, id: string) => ESPN_WEB + '/leaderboard?league=' + encodeURIComponent(league) + '&event=' + encodeURIComponent(id);

const num = (v: unknown) => { const n = Number(v); return v == null || v === '' || !Number.isFinite(n) ? null : n; };
const str = (v: unknown) => (v == null ? null : String(v));

export interface EspnRound { r: number; strokes: number | null; holes: number | null; to_par: string | null; tee_time?: string | null; is_playoff?: boolean }
export interface EspnCompetitor {
  id: string | null; name: string | null; country: string | null; rounds: EspnRound[];
  status: 'active' | 'cut' | 'wd' | 'dq' | 'mdf'; status_text: string | null; position: string | null; sort_order: number | null; score: string | null;
  thru: number | null; tee_time: string | null; start_hole: number | null; playoff: boolean;
}

/** one competitor of a scoreboard or leaderboard event */
export function golfCompetitor(c: any): EspnCompetitor {
  const ath = c.athlete || {};
  const rounds: EspnRound[] = [];
  for (const ls of Array.isArray(c.linescores) ? c.linescores : []) {
    const r = num(ls.period);
    if (r == null) continue;
    const holes = Array.isArray(ls.linescores) ? ls.linescores.filter((h: any) => num(h.value) != null).length : null;
    rounds.push({ r, strokes: num(ls.value), holes, to_par: str(ls.displayValue), tee_time: str(ls.teeTime || null), is_playoff: ls.isPlayoff === true });
  }
  const st = c.status || {};
  const stType = (st.type && (st.type.name || st.type.description)) || '';
  const stText = [stType, st.displayValue, st.position && st.position.displayName, c.status && c.status.shortDetail].map((x) => String(x || '')).join(' ');
  const status = /\bWD\b|withdr/i.test(stText) ? 'wd' : /\bDQ\b|disqual/i.test(stText) ? 'dq' : /\bMDF\b/i.test(stText) ? 'mdf' : /\bCUT\b/i.test(stText) ? 'cut' : 'active';
  return {
    id: str(ath.id != null ? ath.id : c.id), name: str(ath.displayName || ath.fullName || (c.team && c.team.displayName) || null),
    country: str((ath.flag && (ath.flag.alt || ath.flag.description)) || (ath.country && ath.country.name) || null),
    rounds, status, status_text: stText.trim().slice(0, 60) || null,
    position: str(st.position && (st.position.displayName || st.position.id)), sort_order: num(c.sortOrder != null ? c.sortOrder : c.order),
    score: str(typeof c.score === 'object' && c.score ? (c.score.displayValue || c.score.value) : c.score),
    thru: num(st.thru), tee_time: str(st.teeTime || null), start_hole: num(st.startHole), playoff: c.playoff === true || st.playoff === true || /playoff/i.test(stText)
  };
}

/** a competition's own fields, whole but without competitors (the cut line, rounds, status as ESPN states them) */
export function competitionMeta(comp: any): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(comp || {})) if (k !== 'competitors') out[k] = v;
  return out;
}

/** an object's scalar fields and its child objects' scalar fields (ESPN's tournament and playoffType: number of rounds,
    cut round and count, playoff format), at most ~4 KB, so a feed carries what ESPN states without its links */
export function scalarFields(o: any): Record<string, unknown> | null {
  if (!o || typeof o !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v == null || typeof v !== 'object') out[k] = v;
    else if (!Array.isArray(v)) { const sub: Record<string, unknown> = {}; for (const [k2, v2] of Object.entries(v)) if (v2 == null || typeof v2 !== 'object') sub[k2] = v2; out[k] = sub; }
  }
  return JSON.stringify(out).length <= 4096 ? out : null;
}

export interface EspnEvent {
  league: string; id: string | null; name: string | null; short_name: string | null; start: string | null; end: string | null; course: string | null; par: number | null;
  status: string | null; period: number | null; fetched_by: string; competitors: EspnCompetitor[];
  tournament: Record<string, unknown> | null; playoff_type: Record<string, unknown> | null;
  shape: { competitor: string[]; linescore: string[]; status: string[] } | null;
}
export function golfEvent(ev: any, league: string, how: string): EspnEvent {
  const comp = (ev.competitions || [])[0] || {};
  const comps = Array.isArray(comp.competitors) ? comp.competitors : [];
  const venue = comp.venue || (ev.courses && ev.courses[0]) || {};
  return {
    league, id: str(ev.id), name: str(ev.name), short_name: str(ev.shortName), start: str(ev.date), end: str(ev.endDate),
    course: str(venue.fullName || venue.name || (ev.courses && ev.courses[0] && ev.courses[0].name) || null),
    par: num((ev.courses && ev.courses[0] && ev.courses[0].shotsToPar) ?? (ev.courses && ev.courses[0] && ev.courses[0].par) ?? comp.par),
    status: str(comp.status && comp.status.type && comp.status.type.name) || str(ev.status && ev.status.type && ev.status.type.name),
    period: num((comp.status && comp.status.period) ?? (ev.status && ev.status.period)),
    fetched_by: how,
    competitors: comps.map(golfCompetitor).filter((x: EspnCompetitor) => x.id && x.name),
    tournament: scalarFields(ev.tournament), playoff_type: scalarFields(ev.playoffType),
    /* the first competitor's raw keys, so a change in the feed's shape is visible in the data itself */
    shape: comps[0] ? { competitor: Object.keys(comps[0]).sort(), linescore: comps[0].linescores && comps[0].linescores[0] ? Object.keys(comps[0].linescores[0]).sort() : [], status: comps[0].status ? Object.keys(comps[0].status).sort() : [] } : null
  };
}

/** the event with this id in a leaderboard or scoreboard document, when it lists competitors */
export function eventFromDocument(doc: any, id: string): any | null {
  const evs = doc ? (Array.isArray(doc.events) ? doc.events : doc.id != null ? [doc] : []) : [];
  const ev = evs.find((e: any) => String(e.id) === String(id));
  return ev && ev.competitions && ev.competitions[0] && Array.isArray(ev.competitions[0].competitors) && ev.competitions[0].competitors.length ? ev : null;
}
