/* ===========================================================================
   A SINGLES DRAW'S LINES, IN DRAW ORDER, FROM WIKIPEDIA'S DRAW ARTICLE.

   Why Wikipedia: ESPN's scoreboard lists a draw's matches by time, with no
   position in the draw and TBD for every match not yet scheduled; its
   bracket page answers GitHub's runners with a bot challenge. Wikipedia's
   draw article ("2026 Swiss Indoors – Singles") lays the main draw out in
   bracket templates whose first-round parameters RD1-team01, RD1-team02, ...
   are the lines top to bottom. Only the ORDER is taken from it: who is on a
   line is confirmed against ESPN's own matches (inputs.ts), and every result
   comes from ESPN.

   The main draw is the article's "Draw" section up to the next level-2
   heading (Qualifying, References). Its bracket templates in document order
   are the draw's sections, top to bottom, except the "Finals" bracket (the
   semifinals or quarterfinals on, which repeats lines already listed). In
   a "-Byes" template a bye leaves out its pair of first-round parameters
   (RD1-team01 and 02 when the top seed has a bye) and the seed appears
   straight in the second round (RD2-team01): the line pair is then the
   player and a bye.

   A line is a player (the link's target, "Tommy Paul (tennis)" read as
   Tommy Paul, or the plain text), a bye, or EMPTY: an article whose draw is
   not yet filled in (an editor's lag) leaves {{flagicon|}} lines, and the
   draw is then not used.
   =========================================================================== */

export interface WikiLine { name: string | null; label: string | null; seed: string | null; bye: boolean }
export interface WikiDraw { lines: WikiLine[]; sections: Array<{ heading: string; template: string; size: number }>; empty: number; reason: string | null }

/** the template body starting at `start` (just after "{{"), brace-matched */
function templateBody(text: string, start: number): string {
  let depth = 1, i = start;
  while (i < text.length && depth > 0) {
    if (text.startsWith('{{', i)) { depth++; i += 2; continue; }
    if (text.startsWith('}}', i)) { depth--; i += 2; continue; }
    i++;
  }
  return text.slice(start, i - 2);
}
/** a template's named parameters (split on "|" outside [[...]] and {{...}}) */
export function templateParams(body: string): Map<string, string> {
  const out = new Map<string, string>();
  let depthB = 0, depthT = 0, cur = '';
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    if (body.startsWith('[[', i)) { depthB++; cur += '[['; i++; continue; }
    if (body.startsWith(']]', i)) { depthB = Math.max(0, depthB - 1); cur += ']]'; i++; continue; }
    if (body.startsWith('{{', i)) { depthT++; cur += '{{'; i++; continue; }
    if (body.startsWith('}}', i)) { depthT = Math.max(0, depthT - 1); cur += '}}'; i++; continue; }
    if (body[i] === '|' && !depthB && !depthT) { parts.push(cur); cur = ''; continue; }
    cur += body[i];
  }
  parts.push(cur);
  for (const p of parts.slice(1)) { const k = p.indexOf('='); if (k > 0) out.set(p.slice(0, k).trim(), p.slice(k + 1).trim()); }
  return out;
}
/** a team cell -> the player's name (link target) and the label shown, or a bye, or empty */
export function readLine(cell: string | undefined, seed: string | undefined): WikiLine {
  const s = String(cell || '');
  const seedText = String(seed || '').replace(/&nbsp;/g, ' ').replace(/<[^>]*>/g, '').trim() || null;
  const link = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(s);
  if (link) return { name: link[1].replace(/\s*\((?:tennis|tennis player|[a-z ]*player)\)\s*$/i, '').replace(/_/g, ' ').trim(), label: (link[2] || link[1]).trim(), seed: seedText, bye: false };
  const plain = s.replace(/\{\{[^{}]*\}\}/g, '').replace(/'''?/g, '').replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  if (/^bye$/i.test(plain)) return { name: null, label: 'Bye', seed: null, bye: true };
  if (/[A-Za-zÀ-ž]{2}/.test(plain)) return { name: plain, label: plain, seed: seedText, bye: false };
  return { name: null, label: null, seed: seedText, bye: false };
}

export function parseWikiDraw(wikitext: string): WikiDraw {
  const fail = (reason: string): WikiDraw => ({ lines: [], sections: [], empty: 0, reason });
  const start = /^==\s*(Main\s+)?Draw\s*==\s*$/mi.exec(wikitext);
  if (!start) return fail('no Draw section');
  const rest = wikitext.slice(start.index + start[0].length);
  const end = /^==[^=].*==\s*$/m.exec(rest);
  const main = end ? rest.slice(0, end.index) : rest;
  const lines: WikiLine[] = [], sections: WikiDraw['sections'] = [];
  const re = /\{\{\s*(\d+)TeamBracket([^|}\n]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(main))) {
    const size = Number(m[1]), name = (m[1] + 'TeamBracket' + m[2]).trim();
    const before = main.slice(0, m.index), hs = [...before.matchAll(/^===+\s*([^=]+?)\s*===+\s*$/gm)];
    const heading = hs.length ? hs[hs.length - 1][1] : '';
    if (/^finals?$/i.test(heading)) continue;
    const P = templateParams(templateBody(main, m.index + 2));
    const pad = (k: number) => [String(k), String(k).padStart(2, '0'), String(k).padStart(3, '0')];
    const get = (prefix: string, k: number) => { for (const key of pad(k)) { const v = P.get(prefix + key); if (v != null) return v; } return undefined; };
    for (let k = 1; k <= size; k += 2) {
      const a = get('RD1-team', k), b = get('RD1-team', k + 1);
      if (a == null && b == null) {
        /* a bye: the pair is left out and the seed is in the second round */
        const r2 = get('RD2-team', (k + 1) / 2), s2 = get('RD2-seed', (k + 1) / 2);
        lines.push(readLine(r2, s2), { name: null, label: 'Bye', seed: null, bye: true });
        continue;
      }
      lines.push(readLine(a, get('RD1-seed', k)), readLine(b, get('RD1-seed', k + 1)));
    }
    sections.push({ heading, template: name, size });
  }
  if (!sections.length) return fail('no bracket template in the Draw section');
  const empty = lines.filter((l) => !l.bye && !l.name).length;
  const n = lines.length;
  if ((n & (n - 1)) !== 0) return { lines, sections, empty, reason: n + ' lines (not a power of two)' };
  return { lines, sections, empty, reason: empty ? empty + ' of ' + n + ' lines not filled in' : null };
}
