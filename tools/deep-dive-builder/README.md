# EdgeDesk UFC + WTA + ATP Deep-Dive Dataset Builder

This package builds a populated local data warehouse from public sources.

Sources:
- ATP/WTA: Jeff Sackmann tennis_atp / tennis_wta archives. These contain yearly tour-level match files, player files and ranking files through 2026.
- UFC: UFCStats-derived public archive structure, with fighter profiles, fight results and fight-level statistics.

IMPORTANT:
Jeff Sackmann's tennis datasets are licensed CC BY-NC-SA 4.0. They are explicitly non-commercial/share-alike. Do not place those raw files into a commercial EdgeDesk production database without resolving licensing.

The builder:
1. Downloads the yearly ATP/WTA files.
2. Downloads player/ranking files.
3. Downloads UFCStats-derived CSVs when a source URL is supplied.
4. Produces normalized CSVs plus an Excel workbook.
5. Calculates season, career, surface and opponent/H2H aggregates.
6. Adds provenance columns: source, source_tier, retrieved_at.

Run:
    pip install -r requirements.txt
    python build_dataset.py

The environment used to create this package cannot directly download GitHub raw files, so this is the executable ingestion build rather than pretending a few rows are a complete historical warehouse.
