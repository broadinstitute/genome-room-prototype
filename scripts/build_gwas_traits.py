#!/usr/bin/env python3
"""
Build src/app/gwas_traits.json from a GWAS Catalog associations download.

    curl -L -o catalog.zip https://www.ebi.ac.uk/gwas/api/search/downloads/associations/v1.0.2
    python3 scripts/build_gwas_traits.py catalog.zip

One study per trait (TRAITS below), so a trait's loci come from a single analysis rather than a
union across studies of different size. Associations are kept at genome-wide significance
(p < 5e-8, -log10 p >= 7.30103) and pre-binned at 1 Mb: per (chromosome, Mb) the strongest
-log10 p, the number of significant hits, and the mapped gene of the strongest hit. The app
re-bins to its own bin size. Positions are the Catalog's (GRCh38). Rows with no position, or with
several (haplotype / interaction rows), are skipped.

Standard library only.
"""

import csv
import io
import json
import os
import re
import sys
import zipfile

SIGNIFICANT_MLOG = 7.30103  # -log10(5e-8)
BIN_BP = 1_000_000

# Ordered roughly from few loci to many. `label` is for visitors; `shortLabel` fits a row label.
# Chosen by profiling candidate studies (hits, bins, top genes) — see docs/HANDOFF.md.
TRAITS = [
    ("abo", "ABO blood type", "blood type", "GCST012518"),
    ("flush", "Alcohol flush", "alcohol flush", "GCST90444449"),
    ("bitter", "Bitter taste perception", "bitter taste", "GCST006703"),
    ("red_hair", "Red hair", "red hair", "GCST90041837"),
    ("earlobe", "Attached earlobes", "earlobes", "GCST90146359"),
    ("freckles", "Freckles", "freckles", "GCST000708"),
    ("coriander", "Liking coriander (cilantro)", "coriander", "GCST90094744"),
    # Not GCST005523 (Trynka, Immunochip): it excludes the HLA region, which carries most of the
    # coeliac signal.
    ("celiac", "Coeliac disease (gluten)", "coeliac", "GCST90468120"),
    ("hair_shape", "Curly vs straight hair", "hair shape", "GCST005191"),
    ("eye_color", "Eye colour", "eye colour", "GCST012219"),
    ("coffee", "Coffee drinking", "coffee", "GCST008526"),
    ("left_handed", "Left-handedness", "left-handed", "GCST90013421"),
    ("sneeze", "Sneezing in bright light", "light sneeze", "GCST003992"),
    ("baldness", "Male-pattern baldness", "baldness", "GCST007020"),
    ("chronotype", "Morning person vs night owl", "chronotype", "GCST007576"),
    ("height", "Height", "height", "GCST90245848"),
]


def rows_from(path):
    """Yield dict rows from a Catalog zip, a single TSV, or a directory of TSVs."""
    csv.field_size_limit(10**9)
    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as z:
            for name in sorted(n for n in z.namelist() if n.endswith(".tsv")):
                with z.open(name) as raw:
                    yield from csv.DictReader(io.TextIOWrapper(raw, encoding="utf-8", errors="replace"), delimiter="\t")
    else:
        files = [os.path.join(path, f) for f in sorted(os.listdir(path)) if f.endswith(".tsv")] if os.path.isdir(path) else [path]
        for f in files:
            with open(f, newline="", encoding="utf-8", errors="replace") as fh:
                yield from csv.DictReader(fh, delimiter="\t")


def main(path, out_path):
    by_accession = {acc: key for key, _, _, acc in TRAITS}
    found = {key: {"study": None, "hits": 0, "bins": {}} for key, *_ in TRAITS}

    for row in rows_from(path):
        key = by_accession.get(row.get("STUDY ACCESSION"))
        if key is None:
            continue
        entry = found[key]
        if entry["study"] is None:
            entry["study"] = {
                "accession": row["STUDY ACCESSION"],
                "pubmed": row["PUBMEDID"],
                "firstAuthor": row["FIRST AUTHOR"],
                "date": row["DATE"],
                "reportedTrait": row["DISEASE/TRAIT"],
                "sample": row["INITIAL SAMPLE SIZE"],
            }
        try:
            mlog = float(row["PVALUE_MLOG"])
        except ValueError:
            continue
        chrom, pos = row["CHR_ID"].strip(), row["CHR_POS"].strip()
        if mlog < SIGNIFICANT_MLOG or not re.fullmatch(r"\d+", pos) or not re.fullmatch(r"\d+|X|Y", chrom):
            continue
        entry["hits"] += 1
        b = (chrom, int(pos) // BIN_BP)
        gene = (row["MAPPED_GENE"] or "").split(",")[0].split(" - ")[0].strip()
        cur = entry["bins"].get(b)
        if cur is None:
            entry["bins"][b] = [mlog, 1, gene]
        else:
            cur[1] += 1
            if mlog > cur[0]:
                cur[0], cur[2] = mlog, gene

    traits = []
    for key, label, short, acc in TRAITS:
        entry = found[key]
        if entry["study"] is None:
            sys.exit(f"study {acc} ({key}) not found in {path}")
        loci = [[c, mb, round(m, 2), n, g] for (c, mb), (m, n, g) in sorted(entry["bins"].items(), key=lambda kv: (chrom_order(kv[0][0]), kv[0][1]))]
        traits.append({"key": key, "label": label, "shortLabel": short, "study": entry["study"], "significantHits": entry["hits"], "loci": loci})
        print(f"{label:32s} {acc:13s} hits={entry['hits']:6d} 1Mb-bins={len(loci):5d}", file=sys.stderr)

    out = {
        "source": {
            "catalog": os.path.basename(path),
            "url": "https://www.ebi.ac.uk/gwas/api/search/downloads/associations/v1.0.2",
            "threshold": "p < 5e-8",
            "binBp": BIN_BP,
            "assembly": "GRCh38",
            "columns": ["chrom", "mb", "maxMinusLog10P", "significantHits", "geneOfStrongestHit"],
        },
        "traits": traits,
    }
    with open(out_path, "w") as fh:
        json.dump(out, fh, separators=(",", ":"))
    print(f"wrote {out_path} ({os.path.getsize(out_path) // 1024} KB)", file=sys.stderr)


def chrom_order(c):
    return {"X": 23, "Y": 24}.get(c) or int(c)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    here = os.path.dirname(os.path.abspath(__file__))
    main(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else os.path.join(here, "..", "src", "app", "gwas_traits.json"))
