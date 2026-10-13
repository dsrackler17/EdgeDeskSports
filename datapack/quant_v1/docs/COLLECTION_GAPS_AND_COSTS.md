# What Claude must still collect

This ZIP is a substantial historical starter and exact data/feature contract. It is not an exhaustive multi-sport data warehouse. "Every imaginable statistic" is not an attainable fixed public dataset; tracking, charting, injuries, lineup archives and odds are often restricted or unavailable. Do not turn empty schema templates into data or fabricated advanced values.

P0 gaps: current authorized odds and historical quote archive; contemporaneous injury/starting lineup history; NHL calibrated xG and verified goalie starts; complete CFB play-by-play; complete NCAA season coverage; soccer event/xG feed; tennis serve/return and point data; MMA round-level strike/grappling records. Also multiple-season datasets outside NFL and coverage reconciliation for all retrieved feeds.

Access recorded now: native NHL returned 403; original Sackmann tennis repositories returned 404; UFCStats returned a browser challenge or upstream error; CFBD needs a key. MoneyPuck and tennis mirrors have noncommercial restrictions. Do not bypass blocks or assume a paid product can reuse restricted research data. Choose an authorized feed or obtain applicable permission.

ESPN endpoints are undocumented; monthly/league queries may filter or truncate. NCAA baseball monthly queries returned no events; explicit dates are sampled instead. CFB monthly outputs are sparse; treat as samples. Tennis responses may combine both draws; delivered normalized match tables filter main men's/women's singles by grouping, but raw replies preserve broader tournament context.

Do not spend credits collecting an entire multi-sport market matrix every page load. Check existing EdgeDesk storage first. Deduplicate by provider/sport/market/time partition. Use completed-season caching and incremental live updates. Enforce monetary/credit ceilings before dispatch; account for provider billing units, not merely HTTP request count. Honor rate-limit headers and record retries. No automatic paid-provider calls are included here.

Additional sports (golf, cricket, rugby, boxing, motorsport, esports): explicit extension schemas and features only; no real data is shipped for them. Each requires its own league/title/rules-specific dataset and validation before claiming coverage.
