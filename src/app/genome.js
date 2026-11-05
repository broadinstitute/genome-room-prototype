// GRCh38 primary-assembly chromosome lengths in base pairs (NCBI GRCh38.p14).
export const GRCH38_CHROMOSOMES = [
  ["1", 248956422],
  ["2", 242193529],
  ["3", 198295559],
  ["4", 190214555],
  ["5", 181538259],
  ["6", 170805979],
  ["7", 159345973],
  ["8", 145138636],
  ["9", 138394717],
  ["10", 133797422],
  ["11", 135086622],
  ["12", 133275309],
  ["13", 114364328],
  ["14", 107043718],
  ["15", 101991189],
  ["16", 90338345],
  ["17", 83257441],
  ["18", 80373285],
  ["19", 58617616],
  ["20", 64444167],
  ["21", 46709983],
  ["22", 50818468],
  ["X", 156040895],
  ["Y", 57227415],
];

/**
 * Fixed-size genome bins in chromosome order. A chromosome's last bin is short; bins never
 * straddle two chromosomes.
 */
export function makeGenomeBins(binSizeBp) {
  const bins = [];
  GRCH38_CHROMOSOMES.forEach(([chrom, length], chromIndex) => {
    for (let start = 0; start < length; start += binSizeBp) {
      bins.push({
        index: bins.length,
        chrom,
        chromIndex,
        start,
        end: Math.min(start + binSizeBp, length),
      });
    }
  });
  return bins;
}

export function formatBp(bp) {
  return `${(bp / 1e6).toFixed(0)} Mb`;
}

// ---------------------------------------------------------------------------------------------
// GWAS Catalog traits. gwas_traits.json is built by scripts/build_gwas_traits.py: one study per
// trait, hits at p < 5e-8, pre-binned at 1 Mb (strongest -log10 p, hit count, gene of the
// strongest hit). Re-binned here to the app's bin size.
// ---------------------------------------------------------------------------------------------

const SIGNIFICANT_MLOG = 7.30103; // -log10(5e-8)

// Architecture tiers by how many app bins a trait touches. Used for colour families and the legend.
export const TRAIT_TIERS = [
  { key: "few", label: "One or a few regions", maxBins: 6 },
  { key: "dozens", label: "Dozens of regions", maxBins: 60 },
  { key: "many", label: "Hundreds of regions", maxBins: Infinity },
];

/**
 * Traits with per-bin values in [0, 1]: log-scaled strength of the bin's strongest hit relative to
 * the trait's strongest, so a trait dominated by one locus (eye colour at HERC2/OCA2) shows one
 * bright bin and dim others. 0 = no significant hit in the bin.
 */
export function makeGwasTraits(bins, data, binSizeBp) {
  const sourceBin = data.source.binBp;
  if (binSizeBp % sourceBin !== 0) throw new Error(`bin size ${binSizeBp} is not a multiple of ${sourceBin}`);
  const chromStart = {};
  for (const bin of bins) if (!(bin.chrom in chromStart)) chromStart[bin.chrom] = bin.index;

  return data.traits.map((t, index) => {
    const byBin = new Map(); // bin index -> { mlog, hits, gene }
    for (const [chrom, mb, mlog, hits, gene] of t.loci) {
      if (!(chrom in chromStart)) continue;
      const binIndex = chromStart[chrom] + Math.floor((mb * sourceBin) / binSizeBp);
      const cur = byBin.get(binIndex);
      if (!cur) byBin.set(binIndex, { mlog, hits, gene });
      else {
        cur.hits += hits;
        if (mlog > cur.mlog) Object.assign(cur, { mlog, gene });
      }
    }
    const maxMlog = Math.max(...[...byBin.values()].map((b) => b.mlog));
    const span = Math.log(maxMlog / SIGNIFICANT_MLOG) || 1;
    const values = bins.map((bin) => {
      const b = byBin.get(bin.index);
      return b ? Math.max(0.05, Math.log(b.mlog / SIGNIFICANT_MLOG) / span) : 0;
    });
    const binCount = byBin.size;
    return {
      index,
      key: t.key,
      label: t.label,
      shortLabel: t.shortLabel,
      study: t.study,
      significantHits: t.significantHits,
      byBin,
      values,
      binCount,
      density: binCount / bins.length,
      tier: TRAIT_TIERS.find((tier) => binCount <= tier.maxBins).key,
    };
  });
}
