export function average(values: number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function percentile(values: number[], pct: number): number {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((pct / 100) * sorted.length) - 1),
  );
  return sorted[index] ?? 0;
}

export function maxValue(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return Math.max(...values);
}

export function stddev(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const avg = average(values);
  const variance =
    values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/** Full distribution summary for BrowserArena stage timings. */
export function metricStatsFull(values: number[]): {
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  stddev: number;
} {
  if (values.length === 0) {
    return { avg: 0, p50: 0, p95: 0, p99: 0, max: 0, stddev: 0 };
  }
  return {
    avg: average(values),
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    max: maxValue(values),
    stddev: stddev(values),
  };
}
