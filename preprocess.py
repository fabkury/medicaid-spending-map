#!/usr/bin/env python3
"""
Preprocessing pipeline for HHS Medicaid Provider Spending choropleth map.
Transforms raw spending CSV + reference data into website-ready JSON files.

Steps:
0. Download ACS Medicaid enrollment by county from Census API (cached)
1. Extract NPI->ZIP5 from NPPES ZIP (streaming, no full extraction)
2. Build ZIP5->county FIPS lookup from Census ZCTA crosswalk
3. Use DuckDB to join spending data with NPI->county mapping,
   aggregate by county x HCPCS x quarter, compute per-enrollee values
4. Identify top 35% HCPCS codes by popularity
5. Export JSON data files for the website
"""

import duckdb
import json
import csv
import io
import os
import sys
import time
import urllib.request
import zipfile
from pathlib import Path

BASE = Path(__file__).parent
IN = BASE / "in"
REF = IN / "ref"
OUT = BASE / "docs" / "data"


def step0_download_acs_medicaid_pop():
    """Download ACS C27007 Medicaid/means-tested public coverage by county."""
    output_path = REF / "acs_medicaid_pop.csv"
    if output_path.exists():
        size_kb = output_path.stat().st_size / 1024
        print(f"  [skip] acs_medicaid_pop.csv already exists ({size_kb:.1f} KB)")
        return

    print("  Downloading ACS 2023 5-year Table C27007 from Census API...")
    # C27007: Medicaid/Means-Tested Public Coverage by Sex by Age
    # "With Medicaid" variables by sex and age group:
    medicaid_vars = "C27007_004E,C27007_007E,C27007_010E,C27007_014E,C27007_017E,C27007_020E"
    url = f"https://api.census.gov/data/2023/acs/acs5?get=NAME,{medicaid_vars}&for=county:*&in=state:*"

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urllib.request.urlopen(req, timeout=60)
    data = json.loads(resp.read().decode())
    print(f"  Received {len(data) - 1} county rows from Census API")

    count = 0
    with open(output_path, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["county_fips", "medicaid_pop"])
        for row in data[1:]:
            state_code = row[7]
            county_code = row[8]
            fips = state_code.zfill(2) + county_code.zfill(3)
            medicaid_pop = sum(int(v) for v in row[1:7] if v and int(v) >= 0)
            writer.writerow([fips, medicaid_pop])
            count += 1

    print(f"  Done: {count} counties saved to acs_medicaid_pop.csv")


def step1_extract_npi_zip():
    """Extract NPI->ZIP5 lookup from NPPES ZIP file (streaming)."""
    output_path = REF / "npi_zip.csv"
    if output_path.exists():
        size_mb = output_path.stat().st_size / 1024 / 1024
        print(f"  [skip] npi_zip.csv already exists ({size_mb:.1f} MB)")
        return

    print("  Streaming through NPPES ZIP to extract NPI + ZIP5...")
    t0 = time.time()
    count = 0

    with zipfile.ZipFile(REF / "nppes.zip") as z:
        # Find the main NPI data file
        npi_file = [n for n in z.namelist() if n.startswith("npidata_pfile_") and n.endswith(".csv") and "fileheader" not in n][0]
        print(f"  Reading: {npi_file}")

        with z.open(npi_file) as f:
            reader = csv.reader(io.TextIOWrapper(f, encoding="utf-8"))
            header = next(reader)
            npi_idx = header.index("NPI")
            zip_idx = header.index("Provider Business Practice Location Address Postal Code")
            country_idx = header.index("Provider Business Practice Location Address Country Code (If outside U.S.)")

            with open(output_path, "w", newline="") as out:
                writer = csv.writer(out)
                writer.writerow(["NPI", "ZIP5"])
                for row in reader:
                    country = row[country_idx].strip()
                    if country and country != "US":
                        continue
                    npi = row[npi_idx].strip()
                    zip_raw = row[zip_idx].strip()
                    zip5 = zip_raw[:5]
                    if npi and zip5 and len(zip5) == 5:
                        writer.writerow([npi, zip5])
                        count += 1
                        if count % 2_000_000 == 0:
                            elapsed = time.time() - t0
                            print(f"    {count:>10,} NPIs extracted ({elapsed:.0f}s)")

    elapsed = time.time() - t0
    print(f"  Done: {count:,} NPI->ZIP5 mappings in {elapsed:.0f}s")


def step2_build_lookups_and_aggregate(con):
    """Build all lookup tables and run the main aggregation in DuckDB."""

    # --- ZCTA -> county FIPS (pick county with largest land area overlap) ---
    print("  Loading ZCTA->county FIPS crosswalk...")
    con.execute(f"""
        CREATE TABLE zcta_county AS
        WITH ranked AS (
            SELECT
                GEOID_ZCTA5_20 AS zcta,
                GEOID_COUNTY_20 AS county_fips,
                CAST(AREALAND_PART AS BIGINT) AS area,
                ROW_NUMBER() OVER (PARTITION BY GEOID_ZCTA5_20 ORDER BY CAST(AREALAND_PART AS BIGINT) DESC) AS rn
            FROM read_csv('{REF / "zcta_county.txt"}',
                delim='|', header=true, all_varchar=true,
                encoding='utf-8')
            WHERE GEOID_ZCTA5_20 IS NOT NULL
              AND GEOID_ZCTA5_20 != ''
              AND GEOID_COUNTY_20 IS NOT NULL
              AND GEOID_COUNTY_20 != ''
        )
        SELECT zcta, county_fips FROM ranked WHERE rn = 1
    """)
    r = con.execute("SELECT COUNT(*) FROM zcta_county").fetchone()
    print(f"    {r[0]:,} ZCTA->county mappings")

    # --- NPI -> ZIP5 ---
    print("  Loading NPI->ZIP5...")
    con.execute(f"""
        CREATE TABLE npi_zip AS
        SELECT NPI, ZIP5
        FROM read_csv('{REF / "npi_zip.csv"}', types={{'NPI': 'VARCHAR', 'ZIP5': 'VARCHAR'}})
    """)
    r = con.execute("SELECT COUNT(*) FROM npi_zip").fetchone()
    print(f"    {r[0]:,} NPI->ZIP5 mappings")

    # --- NPI -> county FIPS (via ZIP5 -> ZCTA -> county) ---
    print("  Building NPI->county FIPS...")
    con.execute("""
        CREATE TABLE npi_county AS
        SELECT n.NPI, z.county_fips
        FROM npi_zip n
        JOIN zcta_county z ON n.ZIP5 = z.zcta
    """)
    r = con.execute("SELECT COUNT(*) FROM npi_county").fetchone()
    print(f"    {r[0]:,} NPI->county mappings")

    # Free memory
    con.execute("DROP TABLE npi_zip")
    con.execute("DROP TABLE zcta_county")

    # --- County population (total + Medicaid enrollment) ---
    print("  Loading county population...")
    con.execute(f"""
        CREATE TABLE county_pop AS
        SELECT
            c.county_fips,
            c.population,
            COALESCE(m.medicaid_pop, 0) AS medicaid_pop,
            c.county_name,
            c.state_name
        FROM (
            SELECT
                LPAD(CAST(STATE AS VARCHAR), 2, '0') || LPAD(CAST(COUNTY AS VARCHAR), 3, '0') AS county_fips,
                CAST(POPESTIMATE2024 AS INTEGER) AS population,
                CTYNAME AS county_name,
                STNAME AS state_name
            FROM read_csv('{REF / "co-est2025-alldata.csv"}',
                types={{'STATE': 'VARCHAR', 'COUNTY': 'VARCHAR'}},
                encoding='latin-1')
            WHERE SUMLEV = '050' AND COUNTY != '000'
        ) c
        LEFT JOIN (
            SELECT county_fips, CAST(medicaid_pop AS INTEGER) AS medicaid_pop
            FROM read_csv('{REF / "acs_medicaid_pop.csv"}',
                types={{'county_fips': 'VARCHAR', 'medicaid_pop': 'INTEGER'}})
        ) m ON c.county_fips = m.county_fips
    """)
    r = con.execute("SELECT COUNT(*), SUM(population), SUM(medicaid_pop) FROM county_pop").fetchone()
    print(f"    {r[0]:,} counties, total pop {r[1]:,}, Medicaid enrollment {r[2]:,}")

    # --- Main aggregation: spending CSV -> county x HCPCS x quarter ---
    print("  Aggregating spending data (238M rows, this will take a few minutes)...")
    t0 = time.time()

    spending_csv = str(IN / "medicaid-provider-spending.csv").replace("\\", "/")
    con.execute(f"""
        CREATE TABLE spending_agg AS
        SELECT
            s.HCPCS_CODE,
            SUBSTRING(s.CLAIM_FROM_MONTH, 1, 4) || 'Q' ||
                CASE
                    WHEN CAST(SUBSTRING(s.CLAIM_FROM_MONTH, 6, 2) AS INTEGER) <= 3 THEN '1'
                    WHEN CAST(SUBSTRING(s.CLAIM_FROM_MONTH, 6, 2) AS INTEGER) <= 6 THEN '2'
                    WHEN CAST(SUBSTRING(s.CLAIM_FROM_MONTH, 6, 2) AS INTEGER) <= 9 THEN '3'
                    ELSE '4'
                END AS quarter,
            COALESCE(sc.county_fips, bc.county_fips) AS county_fips,
            SUM(s.TOTAL_PAID) AS total_paid,
            SUM(s.TOTAL_CLAIM_LINES) AS total_claims
        FROM read_csv('{spending_csv}',
            types={{
                'BILLING_PROVIDER_NPI_NUM': 'VARCHAR',
                'SERVICING_PROVIDER_NPI_NUM': 'VARCHAR',
                'HCPCS_CODE': 'VARCHAR',
                'CLAIM_FROM_MONTH': 'VARCHAR'
            }}) s
        LEFT JOIN npi_county sc ON s.SERVICING_PROVIDER_NPI_NUM = sc.NPI
        LEFT JOIN npi_county bc ON s.BILLING_PROVIDER_NPI_NUM = bc.NPI
        WHERE COALESCE(sc.county_fips, bc.county_fips) IS NOT NULL
        GROUP BY s.HCPCS_CODE, quarter, COALESCE(sc.county_fips, bc.county_fips)
    """)

    elapsed = time.time() - t0
    r = con.execute("SELECT COUNT(*) FROM spending_agg").fetchone()
    print(f"    {r[0]:,} aggregated rows in {elapsed:.0f}s")

    # --- HCPCS code popularity (across ALL codes, before subsetting) ---
    print("  Computing HCPCS code popularity...")
    con.execute("""
        CREATE TABLE hcpcs_popularity AS
        SELECT
            HCPCS_CODE,
            SUM(total_claims) AS total_claims,
            SUM(total_paid) AS total_paid
        FROM spending_agg
        GROUP BY HCPCS_CODE
        ORDER BY total_claims DESC
    """)

    r = con.execute("SELECT COUNT(*) FROM hcpcs_popularity").fetchone()
    total_codes = r[0]
    top_n_percent = 35
    top_n = max(1, int(total_codes * (top_n_percent/100)))
    print(f"    {total_codes:,} total HCPCS codes, keeping top {top_n:,} (35%)")

    # Get the top top_n_percent% codes
    con.execute(f"""
        CREATE TABLE top_codes AS
        SELECT HCPCS_CODE, total_claims, total_paid
        FROM hcpcs_popularity
        ORDER BY total_claims DESC
        LIMIT {top_n}
    """)

    # Filter spending_agg to top codes only
    con.execute("""
        CREATE TABLE spending_top AS
        SELECT a.*
        FROM spending_agg a
        SEMI JOIN top_codes t ON a.HCPCS_CODE = t.HCPCS_CODE
    """)
    r = con.execute("SELECT COUNT(*) FROM spending_top").fetchone()
    print(f"    {r[0]:,} rows after filtering to top {top_n_percent}% codes")

    return top_n


def step3_load_hcpcs_descriptions(con):
    """Load HCPCS code descriptions from the RVU file."""
    print("  Loading HCPCS descriptions from RVU file...")
    rvu_path = REF / "PPRRVU2026_Jan_nonQPP.csv"

    # The RVU file has 9 header lines before the actual data header on line 10
    con.execute(f"""
        CREATE TABLE hcpcs_desc AS
        SELECT DISTINCT
            TRIM(HCPCS) AS HCPCS_CODE,
            TRIM(DESCRIPTION) AS description
        FROM read_csv('{str(rvu_path).replace(chr(92), "/")}',
            skip=9, header=true, all_varchar=true, quote='"', strict_mode=false)
        WHERE HCPCS IS NOT NULL AND TRIM(HCPCS) != ''
    """)

    r = con.execute("SELECT COUNT(*) FROM hcpcs_desc").fetchone()
    print(f"    {r[0]:,} HCPCS descriptions loaded")


def step4_export_json(con):
    """Export website-ready JSON files."""
    os.makedirs(OUT, exist_ok=True)

    # --- Quarters list ---
    quarters = con.execute("""
        SELECT DISTINCT quarter FROM spending_top ORDER BY quarter
    """).fetchall()
    quarters = [q[0] for q in quarters]
    print(f"  Quarters: {quarters[0]} to {quarters[-1]} ({len(quarters)} total)")

    # --- HCPCS index with descriptions and popularity ---
    print("  Exporting HCPCS code index...")
    codes = con.execute("""
        SELECT
            t.HCPCS_CODE,
            COALESCE(d.description, '') AS description,
            t.total_claims,
            t.total_paid
        FROM top_codes t
        LEFT JOIN hcpcs_desc d ON t.HCPCS_CODE = d.HCPCS_CODE
        ORDER BY t.total_claims DESC
    """).fetchall()

    total_all_claims = con.execute("SELECT SUM(total_claims) FROM hcpcs_popularity").fetchone()[0]

    index_data = {
        "quarters": quarters,
        "codes": [
            {
                "code": c[0],
                "desc": c[1],
                "claims": int(c[2]),
                "pct": round(100.0 * c[2] / total_all_claims, 2) if total_all_claims else 0,
                "paid": round(float(c[3]), 0)
            }
            for c in codes
        ]
    }

    with open(OUT / "index.json", "w") as f:
        json.dump(index_data, f, separators=(",", ":"))
    size_kb = (OUT / "index.json").stat().st_size / 1024
    print(f"    index.json: {size_kb:.0f} KB, {len(codes)} codes")

    # --- County population lookup (for the website to show county names) ---
    print("  Exporting county info...")
    county_info = con.execute("""
        SELECT county_fips, county_name, state_name, medicaid_pop, population
        FROM county_pop
        ORDER BY county_fips
    """).fetchall()

    counties_data = {
        c[0]: {"name": c[1], "state": c[2], "pop": c[3], "tpop": c[4]}
        for c in county_info
    }
    with open(OUT / "counties.json", "w") as f:
        json.dump(counties_data, f, separators=(",", ":"))
    size_kb = (OUT / "counties.json").stat().st_size / 1024
    print(f"    counties.json: {size_kb:.0f} KB, {len(counties_data)} counties")

    # --- Per-code data files ---
    print("  Exporting per-code data files...")
    quarter_idx = {q: i for i, q in enumerate(quarters)}
    n_quarters = len(quarters)

    # Fetch all data grouped by code
    all_data = con.execute("""
        SELECT
            s.HCPCS_CODE,
            s.quarter,
            s.county_fips,
            s.total_paid,
            p.medicaid_pop
        FROM spending_top s
        JOIN county_pop p ON s.county_fips = p.county_fips
        ORDER BY s.HCPCS_CODE, s.county_fips, s.quarter
    """).fetchall()

    # Group into per-code files
    current_code = None
    code_data = {}
    exported = 0
    total_size = 0

    def flush_code(code, data):
        nonlocal exported, total_size
        path = OUT / f"{code}.json"
        with open(path, "w") as f:
            json.dump(data, f, separators=(",", ":"))
        total_size += path.stat().st_size
        exported += 1
        if exported % 200 == 0:
            print(f"    {exported} codes exported...")

    for row in all_data:
        hcpcs, quarter, fips, paid, pop = row
        if hcpcs != current_code:
            if current_code is not None:
                flush_code(current_code, code_data)
            current_code = hcpcs
            code_data = {}

        if fips not in code_data:
            code_data[fips] = [None] * n_quarters

        qi = quarter_idx[quarter]
        # Per-enrollee: total_paid / medicaid_pop, rounded to 2 decimal places
        if pop and pop > 0:
            per_capita = round(paid / pop, 2)
        else:
            per_capita = None
        code_data[fips][qi] = per_capita

    # Flush last code
    if current_code is not None:
        flush_code(current_code, code_data)

    total_size_mb = total_size / 1024 / 1024
    print(f"    Done: {exported} code files, {total_size_mb:.1f} MB total")


def main():
    print("=" * 60)
    print("HHS Medicaid Spending Choropleth - Preprocessing Pipeline")
    print("=" * 60)
    t_start = time.time()

    print("\n[1/5] Downloading ACS Medicaid enrollment data...")
    step0_download_acs_medicaid_pop()

    print("\n[2/5] Extracting NPI->ZIP5 from NPPES...")
    step1_extract_npi_zip()

    print("\n[3/5] Building lookups and aggregating spending data...")
    con = duckdb.connect()
    con.execute("SET memory_limit = '4GB'")
    step2_build_lookups_and_aggregate(con)

    print("\n[4/5] Loading HCPCS descriptions...")
    step3_load_hcpcs_descriptions(con)

    print("\n[5/5] Exporting website JSON files...")
    step4_export_json(con)

    con.close()

    elapsed = time.time() - t_start
    print(f"\n{'=' * 60}")
    print(f"Pipeline complete in {elapsed:.0f}s ({elapsed/60:.1f} min)")
    print(f"Output: {OUT}")
    print(f"{'=' * 60}")


if __name__ == "__main__":
    main()
