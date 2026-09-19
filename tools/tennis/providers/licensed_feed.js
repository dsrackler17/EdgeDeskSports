#!/usr/bin/env node
/* HistoricalTennisProvider / LiveResultsProvider / RankingsProvider —
   THE LICENSED FEED SLOT.

   This is the adapter a commercial tennis data agreement plugs into. It is
   deliberately unimplemented and deliberately ISOLATED: nothing else in the
   tennis system imports it, so its absence blocks nothing. The database, the
   importer, the features, the model, the board, the AI and the public record
   all run today on the research archive.

   WHAT AN IMPLEMENTOR HAS TO DO, and nothing more:

     1. Register the source in tennis.source_licenses with commercial_use=true
        and who cleared it. Until that row exists the database refuses its rows.
     2. Set the credentials named below in the environment / repository secrets.
        They are never read in browser code and never written into SQL.
     3. Implement read(), fixtures(), results() and rankings() to return the
        NORMALISED shapes in providers/index.js. Nothing downstream changes.
     4. Raise its priority in SOURCE_PRIORITY so it wins a disagreement with
        the archive — the archive's rows are kept, and the conflict is recorded.

   The contract test (tools/tennis/providers.test.js) runs against this stub
   too, so the day it is implemented the shape is already proven. */
'use strict';
const P = require('./index.js');

module.exports = P.defineProvider({
  kind: 'historical',
  name: 'licensed_feed',
  source_key: 'licensed_feed',
  priority: 100,
  credentials: ['TENNIS_FEED_API_KEY', 'TENNIS_FEED_BASE_URL'],
  capabilities: {
    pre_match_features: false, serve_statistics: true, exact_start_time: true,
    live_score: true, closing_price: false, doubles: true
  },
  implemented: false,

  async *read() {
    throw new Error(unavailable('read'));
  },
  async fixtures() { throw new Error(unavailable('fixtures')); },
  async results() { throw new Error(unavailable('results')); },
  async rankings() { throw new Error(unavailable('rankings')); },

  describe() {
    return {
      name: 'licensed_feed',
      implemented: false,
      coverage: 'whatever the agreement covers',
      licence: 'commercial (to be registered in tennis.source_licenses before first write)',
      credentials: ['TENNIS_FEED_API_KEY', 'TENNIS_FEED_BASE_URL'],
      blocking: 'nothing. The research archive runs the whole system today; this '
              + 'adapter replaces its source without changing one contract downstream.'
    };
  }
});

function unavailable(what) {
  return 'licensed_feed.' + what + ' is not implemented: no commercial tennis feed is '
       + 'contracted yet. Set TENNIS_FEED_API_KEY and TENNIS_FEED_BASE_URL, register the '
       + 'source in tennis.source_licenses, and implement this adapter against the '
       + 'normalised shapes in tools/tennis/providers/index.js. Nothing else has to change.';
}
