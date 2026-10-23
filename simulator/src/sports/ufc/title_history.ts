/* ===========================================================================
   UFC TITLE HISTORY, READ FROM WIKIPEDIA'S "LIST OF UFC CHAMPIONS".

   The page is saved whole by the feed job on a GitHub runner
   (simulator/data/feeds/ufc_champions_wikipedia.html.gz, Parsoid HTML;
   simulator/src/cli/fetch_sports_data.ts). ESPN's scoreboard carries no
   title flag for past bouts, so this page is the only owned record of which
   bouts were title fights. Each division's championship table lists:
     a reign row      No. | Name | Event | Date | Reign | Defenses
                      the Name cell says "def. X" when the title was vacant
                      (or "def. interim champion X" for a unification),
                      "promoted to undisputed champion" when an interim
                      champion was elevated without a fight (no bout);
                      otherwise the previous champion lost the title here
     an interim row   No. "—": an interim title, not the undisputed one
     a note row       one cell: stripped, vacated, retired
     Defenses         "1. def. X at EVENT on DATE", "drew with", "NC. vs."
   From these, every UNDISPUTED title fight per division (a vacant-title
   fight, a title change, a defence, a draw or a no contest) with its date,
   the champion going in (none for a vacant title) and the result; interim
   title fights are kept apart (the simulation does not model interim
   belts). Nothing is guessed: a line that matches no pattern is counted
   and reported (unparsed), never interpreted.
   =========================================================================== */

/** Wikipedia section id -> the division name ESPN's feed uses (the simulator's canonical name) */
export const WIKI_DIVISIONS: Array<[string, string]> = [
  ['Flyweight_Championship', 'Flyweight'], ['Bantamweight_Championship', 'Bantamweight'], ['Featherweight_Championship', 'Featherweight'],
  ['Lightweight_Championship', 'Lightweight'], ['Welterweight_Championship', 'Welterweight'], ['Middleweight_Championship', 'Middleweight'],
  ['Light_Heavyweight_Championship', 'Light Heavyweight'], ['Heavyweight_Championship', 'Heavyweight'],
  ["Women's_Strawweight_Championship", 'W Strawweight'], ["Women's_Flyweight_Championship", 'W Flyweight'], ["Women's_Bantamweight_Championship", 'W Bantamweight']
];

export interface TitleFight {
  division: string;
  /** the event date as Wikipedia gives it (local date of the card), YYYY-MM-DD */
  date: string;
  event: string;
  /** undisputed: vacant (no champion going in), change (the champion lost), defense (kept: a win, a draw or a no contest) */
  kind: 'vacant' | 'change' | 'defense';
  interim: boolean;
  /** the champion going in (null for a vacant title) and the challenger */
  champion: string | null;
  challenger: string;
  /** who left with the title (null when the champion going in kept it without a win: a draw or a no contest) */
  winner: string | null;
  result: 'champion_won' | 'challenger_won' | 'draw' | 'no_contest' | 'vacant_won';
  unification: boolean;
}
export interface Reign { division: string; no: number | null; interim: boolean; name: string; date: string; event: string | null; promoted: boolean; opponent: string | null; defenses: number; incumbent: boolean }
export interface DivisionHistory { division: string; reigns: Reign[]; fights: TitleFight[]; incumbent: string | null; incumbent_since: string | null; unparsed: string[] }

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
export function wikiDate(s: string): string | null {
  const m = /^([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})$/.exec(s.trim());
  if (!m || !MONTHS[m[1].toLowerCase()]) return null;
  return m[3] + '-' + MONTHS[m[1].toLowerCase()] + '-' + m[2].padStart(2, '0');
}
/* a tag, with quoted attribute values that may themselves hold '>' (Parsoid's data-mw JSON) */
const TAG = /<[a-zA-Z/!](?:[^>"']|"[^"]*"|'[^']*')*>/g;
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—' };
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (m, e: string) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m);
}
/** a cell's text: <br> become line breaks, tags dropped, entities decoded, whitespace collapsed per line */
export function cellText(html: string): string[] {
  const t = unescape(html.replace(/<br\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, '\n').replace(TAG, ''));
  return t.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l !== '');
}
function cells(rowHtml: string): Array<{ tag: string; attrs: string; html: string }> {
  const out: Array<{ tag: string; attrs: string; html: string }> = [];
  const re = /<(t[hd])((?:[^>"']|"[^"]*"|'[^']*')*)>([\s\S]*?)<\/t[hd]>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml))) out.push({ tag: m[1], attrs: m[2], html: m[3] });
  return out;
}
/** "Randy Couture (2)" -> "Randy Couture" */
const bare = (s: string) => s.replace(/\s*\(\d+\)\s*$/, '').trim();

const DEF = /^(\d+|NC)\.?\s+(def\.|drew with|vs\.)\s+(interim champion\s+)?(.+?)\s+at\s+(.+)\s+on\s+([A-Z][a-z]{2,4}\.? \d{1,2}, \d{4})\s*$/;

export function parseDivision(page: string, sectionId: string, division: string): DivisionHistory {
  const out: DivisionHistory = { division, reigns: [], fights: [], incumbent: null, incumbent_since: null, unparsed: [] };
  const i = page.indexOf('id="' + sectionId + '"');
  if (i < 0) { out.unparsed.push('section ' + sectionId + ' not found'); return out; }
  const j = page.indexOf('<table', i), k = page.indexOf('</table>', j);
  if (j < 0 || k < 0) { out.unparsed.push('no table after ' + sectionId); return out; }
  const rows = page.slice(j, k).match(/<tr\b[\s\S]*?<\/tr>/g) || [];
  let prevUndisputed: string | null = null;   /* the undisputed champion going into the next fight; null while vacant */
  for (const r of rows) {
    const c = cells(r);
    if (c.length === 1) {
      /* a note row: the title was stripped, vacated or relinquished */
      const note = cellText(c[0].html).join(' ');
      /* (a note about the INTERIM title, "stripped of the interim title", leaves the undisputed champion in place) */
      if (/\b(stripped|vacat|relinquish|retire)/i.test(note) && !/interim title/i.test(note)) prevUndisputed = null;
      continue;
    }
    if (c.length !== 6) continue;
    const no = cellText(c[0].html).join(' ');
    if (!/^(\d+|—|-)$/.test(no)) continue;                  // the header row
    const interim = no === '—' || no === '-';
    const nameLine = cellText(c[1].html).join(' ');
    const ev = cellText(c[2].html), date = wikiDate(cellText(c[3].html).join(' '));
    const reignText = cellText(c[4].html).join(' ');
    if (!date) { out.unparsed.push(division + ': reign date "' + cellText(c[3].html).join(' ') + '"'); continue; }
    const promoted = /promoted to undisputed/i.test(nameLine);
    const dm = /\s+def\.\s+(interim champion\s+)?(.+?)(\s+for interim title)?$/.exec(nameLine);
    const name = bare(nameLine.replace(/\s+promoted to undisputed champion.*$/i, '').replace(/\s+def\.\s+.*$/, ''));
    const event = ev.length && ev[0] !== '—' ? ev[0] : null;
    const defLines = cellText(c[5].html);
    const reign: Reign = { division, no: interim ? null : Number(no), interim, name, date, event, promoted, opponent: dm ? bare(dm[2]) : null, defenses: 0, incumbent: /incumbent/i.test(reignText) };
    out.reigns.push(reign);
    /* the fight that won this title (none for a promotion) */
    if (!promoted && event) {
      const unif = !!(dm && dm[1]);
      if (dm) out.fights.push({ division, date, event, kind: interim ? 'vacant' : unif ? 'change' : 'vacant', interim, champion: interim ? null : unif ? null : null, challenger: name, winner: name,
        result: 'vacant_won', unification: unif });
      else if (!interim && prevUndisputed) out.fights.push({ division, date, event, kind: 'change', interim: false, champion: prevUndisputed, challenger: name, winner: name, result: 'challenger_won', unification: false });
      else out.unparsed.push(division + ': ' + date + ' ' + name + ' won the title with no named opponent and no champion going in');
      /* a vacant-title fight's loser is named: record it as the challenger side for the record */
      if (dm) { const f = out.fights[out.fights.length - 1]; f.champion = null; f.challenger = bare(dm[2]); f.winner = name; }
    }
    /* the defences of this reign */
    for (const line of defLines) {
      const m = DEF.exec(line);
      if (!m) { if (!/^\[?\w?\]?$/.test(line)) out.unparsed.push(division + ': defence "' + line.slice(0, 80) + '"'); continue; }
      const d = wikiDate(m[6]);
      if (!d) { out.unparsed.push(division + ': defence date "' + m[6] + '"'); continue; }
      const result = m[1] === 'NC' || m[2] === 'vs.' ? 'no_contest' : m[2] === 'drew with' ? 'draw' : 'champion_won';
      out.fights.push({ division, date: d, event: m[5], kind: 'defense', interim, champion: name, challenger: bare(m[4]), winner: result === 'champion_won' ? name : null, result, unification: !!m[3] });
      if (result === 'champion_won') reign.defenses++;
    }
    if (!interim) prevUndisputed = name;
    if (reign.incumbent && !interim) { out.incumbent = name; out.incumbent_since = date; }
  }
  out.fights.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

export function parseTitleHistory(page: string): DivisionHistory[] {
  return WIKI_DIVISIONS.map(([id, div]) => parseDivision(page, id, div));
}

/* ------------------------------------------------------------ what the simulation measures from it */
const DAY = 86400000;
const days = (a: string, b: string) => (Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / DAY;

export interface DivisionRates {
  division: string;
  window: { from: string; to: string; years: number };
  /** undisputed title fights in the window, and per year (the rate the title path runs at) */
  title_fights: number; per_year: number;
  interim_fights: number;
  last_title_fight: string | null;
  incumbent: string | null; incumbent_since: string | null;
  /** fights with a champion going in, in the window: kept with a win, lost, drawn or no contest */
  champion_fights: number; champion_won: number; champion_lost: number; draws_nc: number;
}
/** every division's undisputed title-fight rate over the window ending at asOf (YYYY-MM-DD) */
export function divisionRates(H: DivisionHistory[], asOf: string, years: number): DivisionRates[] {
  const from = (Number(asOf.slice(0, 4)) - years) + asOf.slice(4);
  return H.map((h) => {
    const und = h.fights.filter((f) => !f.interim && f.date <= asOf);
    const inWin = und.filter((f) => f.date > from);
    const champ = inWin.filter((f) => f.champion != null);
    return { division: h.division, window: { from, to: asOf, years }, title_fights: inWin.length, per_year: Math.round(inWin.length / years * 1e6) / 1e6,
      interim_fights: h.fights.filter((f) => f.interim && f.date > from && f.date <= asOf).length,
      last_title_fight: und.length ? und[und.length - 1].date : null, incumbent: h.incumbent, incumbent_since: h.incumbent_since,
      champion_fights: champ.length, champion_won: champ.filter((f) => f.result === 'champion_won').length, champion_lost: champ.filter((f) => f.result === 'challenger_won').length,
      draws_nc: champ.filter((f) => f.result === 'draw' || f.result === 'no_contest').length };
  });
}

/** gaps (days) between consecutive undisputed title fights in a division, each divided by that division's mean gap
    over the same span: the shape of the gap distribution, pooled across divisions */
export function normalisedGaps(H: DivisionHistory[], from: string, to: string): { gaps: number[]; raw: Array<{ division: string; gap: number }> } {
  const gaps: number[] = [], raw: Array<{ division: string; gap: number }> = [];
  for (const h of H) {
    const d = h.fights.filter((f) => !f.interim && f.date >= from && f.date <= to).map((f) => f.date);
    const g: number[] = [];
    for (let i = 1; i < d.length; i++) g.push(days(d[i - 1], d[i]));
    if (g.length < 2) continue;
    const mean = g.reduce((a, x) => a + x, 0) / g.length;
    for (const x of g) { gaps.push(x / mean); raw.push({ division: h.division, gap: x }); }
  }
  return { gaps, raw };
}
