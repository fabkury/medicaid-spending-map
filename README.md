# Medicaid Spending Map

Interactive choropleth map of Medicaid provider spending by U.S. county, HCPCS procedure code, and calendar quarter.

**Live site:** [fabkury.github.io/medicaid-spending-map](https://fabkury.github.io/medicaid-spending-map/)

## What this shows

Per-enrollee Medicaid spending for each U.S. county, broken down by HCPCS code and quarter. Select a procedure code and quarter to see how spending varies geographically. Toggle between per-enrollee and total spending views. Click or hover over any county to see its Medicaid enrollment, total population, and spending figures.

## Data sources

| Source | Description |
|--------|-------------|
| [HHS/CMS Medicaid Provider Spending](https://opendata.hhs.gov/datasets/medicaid-provider-spending/) | 238M rows of claims data, Jan 2018 -- Dec 2024 |
| [ACS Table C27007](https://data.census.gov/table/ACSDT5Y2023.C27007) | County-level Medicaid/means-tested public coverage enrollment (2023 5-year estimates) |
| [CMS NPPES](https://download.cms.gov/nppes/NPI_Files.html) | NPI-to-ZIP code registry (9.1M providers) |
| [Census ZCTA-to-County Crosswalk](https://www.census.gov/geographies/reference-files/time-series/geo/relationship-files.2020.html) | ZIP code to county FIPS mapping |
| [Census County Population Estimates](https://www.census.gov/data/datasets/time-series/demo/popest/2020s-counties-total.html) | 2024 county population estimates |
| [CMS Physician Fee Schedule RVU](https://www.cms.gov/medicare/payment/fee-schedules/physician/pfs-relative-value-files) | HCPCS code descriptions |

## Repository structure

```
docs/               Static website (served by GitHub Pages)
  index.html        Main page
  app.js            Map logic (MapLibre GL JS)
  style.css         Styles
  data/             Pre-processed JSON data files
    index.json      HCPCS code index with metadata
    counties.json   County names, states, Medicaid enrollment, total population
    counties-10m.json  TopoJSON county/state boundaries
    <CODE>.json     Per-county per-enrollee spending for each HCPCS code
preprocess.py       Data pipeline (raw CSV -> website JSON)
in/                 Input data (excluded from repo due to size)
  ref/              Reference files (NPPES, crosswalks, ACS data)
```

## Preprocessing

The `preprocess.py` script transforms the raw spending CSV and reference data into website-ready JSON files. It requires the input files in an `in/` directory (excluded from the repo due to size). Steps:

0. Download ACS Medicaid enrollment by county from the Census API (cached after first run)
1. Extract NPI-to-ZIP mappings from the NPPES registry
2. Build NPI-to-county lookup via Census ZCTA crosswalk
3. Aggregate 238M spending rows by county, HCPCS code, and quarter using DuckDB
4. Filter to the top 35% most popular HCPCS codes (3,893 of 12,263)
5. Compute per-enrollee values and export JSON files

Requirements: Python 3, [DuckDB](https://duckdb.org/)

```bash
pip install duckdb
python preprocess.py
```

## Methodology

See the Methodology link on the live site for detailed documentation of data processing decisions, including NPI-to-county mapping, billing vs. servicing provider handling, per-enrollee calculation, and known limitations.

## License

[MIT](LICENSE)
