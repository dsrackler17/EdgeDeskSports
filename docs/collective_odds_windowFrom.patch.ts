/** Window helpers. "week" here is the Collective's own slate week, which the
 *  odds feed carries only when the provider supplies it, so the default
 *  window is time based.
 *
 *  IT REACHES BACKWARDS AS WELL AS FORWARDS, and it did not used to. `days`
 *  widened only the future while the lower bound was a hardcoded 24 hours, so
 *  a game fell off the board one day after kickoff. That looked harmless and
 *  was not: the board is where the site recovers a CLOSING LINE for a finished
 *  game whose record carries none, and an ATS grade is measured against that
 *  close and nothing else. So a model's graded record silently shrank to
 *  whatever had finished in the last 24 hours and refilled the next day with a
 *  different set — reported, accurately, as "the ATS results reset daily and
 *  aren't cumulative". The record was following the odds window, not results.
 *
 *  `back` defaults to 8 days because a slate week runs Tuesday to Monday in
 *  college: a week's finished games keep their close for as long as the site
 *  is still showing that week. Capped at 28, the same ceiling as `days`.
 *
 *  An EXPLICIT from/to is still never touched. A caller that named a range
 *  meant it, and quietly extending it backwards would be the same class of
 *  bug in the other direction.
 */
function windowFrom(u: URL): {
  from: string | null;
  to: string | null;
  explicit: boolean;
} {
  const from = u.searchParams.get("from");
  const to = u.searchParams.get("to");
  if (from || to) {
    return { from: safeDate(from), to: safeDate(to), explicit: true };
  }
  const days = Math.min(28, Math.max(1, num(u.searchParams.get("days"), 8)));
  const back = Math.min(28, Math.max(1, num(u.searchParams.get("back"), 8)));
  return {
    from: new Date(Date.now() - back * 24 * 3600e3).toISOString(),
    to: new Date(Date.now() + days * 24 * 3600e3).toISOString(),
    explicit: false,
  };
}
