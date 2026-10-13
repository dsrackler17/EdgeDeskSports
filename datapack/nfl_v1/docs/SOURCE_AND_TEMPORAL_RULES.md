# NFL source and time rules

Source facts are nflverse releases, attributed under the repository CC-BY-4.0 license included here. Some tables originate from NFL NGS, ESPN, PFR or other upstream sources. Dataset-specific/upstream notices and commercial rights still require review; public access is not an inferred unrestricted license for every upstream field.

The metadata/discovery and downloaded payloads were inspected. Website availability documentation can lag a release: report actual file coverage from the inventory, not a general availability promise. The 2026 archive is partial and any category can trail play-by-play. Use each dataset's date/week/season span and missingness.

known_at is not reconstructed. retrieved_at is when this archive was fetched; source_asset_updated_at is release metadata, not proof of initial availability for each row. Injury tables have season/week and status but no proven publication timestamp. Depth dt is source snapshot context; keep that provenance and do not infer announcement timing without evidence. Model-derived EPA/CPOE can be retrospectively refit.

Parquet source tables preserve native types. Compression changes are lossless and checked for exact Arrow value/type equality before replacing an encoding. The re-encoding manifest keeps the original download digest and delivered digest. Raw 2022–24 PBP is intentionally not duplicated here: the previous ZIP parts contain it, while this pack includes its measured historical seed tables.

NGS percent columns are provider-native; do not assume every percentage is 0–1 rather than 0–100. NGS/PFR denominators and conditional samples need source-specific mapping. Do not infer routes, on-field coverage, OL assignments or raw tracking from targeted-player counts. Seasonal aggregate rows are not weekly observations. Depth chart rows are snapshots and positions, not distinct players or independent training examples.

The provided opportunity tables count receiving/pass/rush observations after excluding kneels and spikes under documented conditions. EPA aggregates use valid scrimmage pass/run plays with nonmissing EPA; pass EPA includes sacks, designed-rush EPA excludes scrambles. These are explicit research definitions, not every provider's official statistic. Sack_rate in the feature file is offense sacks taken per own dropback, not a defense pressure rate.

NFL games can have pushes, ties, overtime, voids and prop participation rules. Preserve final and regulation scoring scopes. Same bookmaker/time/line/period/rules are required for no-vig grouping and price comparison. Source spread_line/total_line fields are historical labels, not verified executable quotes.

References: https://nflreadr.nflverse.com/articles/nflverse_data_schedule.html ; https://nflreadr.nflverse.com/articles/dictionary_pbp.html ; https://nflreadr.nflverse.com/articles/dictionary_snap_counts.html ; https://github.com/nflverse/nflverse-data ; https://opensourcefootball.com/posts/2020-09-28-nflfastr-ep-wp-and-cp-models/
