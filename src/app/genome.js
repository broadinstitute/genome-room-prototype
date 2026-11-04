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
// PLACEHOLDER association values. Not data. Stands in for per-bin trait signal until the
// GWAS Catalog pipeline exists; densities vary per trait so one row behaves like a highly
// polygenic trait ("everything lights up") and the rest are progressively sparser.
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER_DENSITIES = [0.25, 0.1, 0.06, 0.04, 0.03, 0.02, 0.015, 0.01];

function hash01(a, b) {
  // Integer hash of (a, b) to [0, 1). Deterministic so the placeholder is stable across reloads.
  let h = (a * 374761393 + b * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function makePlaceholderTraits(bins, traitCount) {
  return Array.from({ length: traitCount }, (_, t) => {
    const density = PLACEHOLDER_DENSITIES[t % PLACEHOLDER_DENSITIES.length];
    const values = bins.map((bin) => {
      const r = hash01(t + 1, bin.index + 1);
      return r < density ? 0.3 + 0.7 * hash01(bin.index + 7, t + 13) : 0;
    });
    return { index: t, label: `trait ${t + 1} (placeholder)`, shortLabel: `trait ${t + 1}`, density, values };
  });
}
