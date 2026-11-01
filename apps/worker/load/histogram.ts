const MAX_MS = 60_000;

/** Millisecond values in fixed buckets: percentiles to the millisecond, without keeping every value. */
export class Histogram {
  private readonly counts = new Uint32Array(MAX_MS + 1);
  private total = 0;
  private highest = 0;

  add(ms: number) {
    const bucket = Math.min(MAX_MS, Math.max(0, Math.round(ms)));
    this.counts[bucket]! += 1;
    this.total += 1;
    this.highest = Math.max(this.highest, ms);
  }

  get count() {
    return this.total;
  }

  get max() {
    return Math.round(this.highest);
  }

  percentile(p: number) {
    if (this.total === 0) return 0;
    const rank = Math.ceil((p / 100) * this.total);
    let seen = 0;
    for (let ms = 0; ms <= MAX_MS; ms++) {
      seen += this.counts[ms]!;
      if (seen >= rank) return ms;
    }
    return MAX_MS;
  }

  reset() {
    this.counts.fill(0);
    this.total = 0;
    this.highest = 0;
  }
}
