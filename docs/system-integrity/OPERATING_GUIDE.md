# Owner operating guide

Two routines: a five-minute daily check of the research, and the steps from
draft to publisher. Nothing is ever emailed, sent or published unless you
press the button and confirm.

## Daily: is today's research trustworthy?

Open the CFB board (the app's Football tab) and the terminal (`/research/cfb/`).

1. **The header.**
   - It names **this week** and how many **look-ahead** games are listed.
     Look-ahead rows carry a "WK n" badge and never feed this week's briefs or
     articles.
   - It shows **kickoff TBA**: games whose time the schedule has not set.
     They read "time TBA", never a clock time.
2. **The counts.** Hover any count for its definition.
   - **Research-grade** means only games that cleared every gate.
   - **Investigate** is separate: a 7+ point gap nobody has verified yet.
   - **Usable market** excludes stale and faulted lines.
3. **Integrity marks.** On the board, ⚠ is a WARNING and ⛔ is BLOCKED.
   Hover the mark for the rule. In the terminal the badge reads CHECK or
   DATA CHECK.
   - Routine notes stay quiet so the marks keep their meaning: a look-ahead
     week, a TBA time (already shown), or a missing team id, venue or
     snapshot id.
   - Open the game page: the *Data integrity* card names the rule, the
     evidence and what to do.
   - A game BLOCKED for publication is kept out of every brief and article
     automatically. You only need to look if it is a game you care about.
4. **Gaps.** A gap always equals the difference of the two lines printed beside
   it. If you ever see one that does not, that is a bug: run
   `npm run integrity:audit` and send the output to engineering.
5. **Two answers, not one.** Each game shows a research status (*is it worth
   investigating?*) and a decision (*do the betting rules approve this exact
   price?*). The sentence under them says why they differ. **Worth Researching
   is never a bet.**
6. **Raw EV.** A large raw EV with "no skill shown" beside it is not an edge.
   The calibration currently maps every cover probability to about 50%. The
   game page explains it.

Weekly, optionally: `npm run integrity:performance` refreshes
`docs/system-integrity/PERFORMANCE.md`. Live and backtest results are kept
apart, and each row carries its sample-size label.

## From draft to publisher (`/admin/content/`)

1. **Discover.**
   - The message lists the opportunities found and **the games the integrity
     engine withheld, with the rule for each**.
   - A 7+ gap that has not been verified is never offered as a "Model vs.
     Market" article. It is an internal investigation.
2. **Draft.**
   - Generate the deterministic draft (free).
   - *Rewrite with AI* is optional and metered:
     - it reserves against the monthly cap first;
     - it refuses a duplicate of a request already paid for;
     - its version is kept only if it passes every check.
3. **Check.** The checks panel shows **integrity: PASS / WARNING / BLOCKED**
   and every rule that failed:
   - a number on the wrong game;
   - an unsourced quarterback or injury claim;
   - a wrong conference;
   - a TBA kickoff given a time;
   - a spread that is not EdgeDesk's or the market's.

   Fix the text and check again.
4. **Review and approve.**
   - Confirm the five review points, then **Approve this exact version**.
   - Approval is refused if any automated check fails, the integrity engine
     blocks it, or the research changed after the draft was written.
   - **Reject…** turns a draft down with a reason. It can be reworked or
     archived.
5. **Ready to send.** The publishing queue shows the **Ready-to-send
   checklist**. Every line must pass:
   - owner approval of this revision;
   - the integrity verdict;
   - research unchanged;
   - matchups, numbers and claims;
   - sources and timestamps;
   - language and SEO;
   - the campaign-tagged link and the disclosures;
   - **Markdown, HTML and Word carry the approved numbers**.

   The snapshot line under it names the revision, the content and research
   fingerprints, and the approval time. Every export carries the same line.
6. **Send.** Either download the Word file, email it yourself and press **Mark
   as sent**, or press **Send**, which names the address and asks first. Every
   export is read back before it leaves: a file whose numbers differ from the
   approved article is refused.
7. **If the research changes after approval** (a new projection or a line
   move), the article is sent back to review automatically, with the old and
   new research on record. Review the new numbers and approve again. An old
   number can never be sent.
8. **Published.** Record the published URL. Visits, registrations, trials and
   paid subscriptions through the article's tagged link appear under
   **Performance** → *Acquisition loop*, beside the 90-day targets:

   | Target | Value |
   |---|---|
   | Active partners | 3 |
   | Articles a month | 8 |
   | Visits a month | 250 |
   | Registrations a month | 25 |
   | Paid subscribers a month | 3 |
   | Cost per paid subscriber | ≤ $25 |

   These are targets, not forecasts. A dash means not measured. Revenue is
   Stripe's gross amount, not profit.

## Budget (`/admin/content/` → Settings → AI spend)

- The content engine's AI budget is **$10 a month**.
- The panel shows what is spent, what is in flight, what remains and what
  was refused.
- At the cap, AI rewrites stop and the deterministic draft stands.
- Raising the cap above $10 asks for confirmation. It is never raised
  automatically.
