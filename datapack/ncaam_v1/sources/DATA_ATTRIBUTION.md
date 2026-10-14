# Sources and attribution

Data publisher: SportsDataverse and its contributors, sportsdataverse/sportsdataverse-data release repository, hoopR-mbb-data and ncaa-mbb-hoops-data/sportsdataverse-py pipelines. Underlying sources: ESPN men's college basketball and stats.ncaa.org. Their outputs are separate provider/pipeline views, not independent ground truth by default.

- Release repository: https://github.com/sportsdataverse/sportsdataverse-data
- ESPN college pipeline/data definitions: https://github.com/sportsdataverse/hoopR-mbb-data
- Loader documentation: https://hoopr.sportsdataverse.org/reference/load_mbb_pbp.html
- NCAA loader/field definitions: https://github.com/sportsdataverse/hoopR/blob/main/R/load_ncaa_mbb.R
- NCAA statistics: https://www.ncaa.com/stats/basketball-men/d1
- NCAA statistics policies/manuals: https://www.ncaa.org/championships/statistics-and-records/
- Men's playing rules: https://www.ncaa.org/championships/playing-rules/mens-basketball-playing-rules/

Exact release tags, file URLs, update/retrieval timestamps and original byte hashes are in source_assets.json. They are captured observations, not inferred publication times for individual game events. Delivered hashes, native schemas and exact-value recompression checks are in inventory.json. Source values/columns were preserved; EdgeDesk measured/lagged features and audits are separate files with documented formulas. No endorsement by the publisher, ESPN or NCAA is implied.

The release repository README labels the data CC BY 4.0: https://creativecommons.org/licenses/by/4.0/ . Attribution and change disclosure are retained here. The repository's LICENSE file is MIT software text and is separately reproduced as SPORTSDATAVERSE_SOFTWARE_LICENSE.txt; do not confuse software terms with all underlying data/media rights. No publisher article/video/photo content was separately collected for this pack. Source tables contain their native provider metadata/URLs. No private proprietary quant methodology is represented as copied or known.
