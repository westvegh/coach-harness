// The check-in block shape (contracts §5, §11; V6 B.3), one check for every entry point:
// the CLI, the daily-file normalizer, the cached-record check (engine/signals.ts) and the
// readiness input check. The JSON-schema subset has no anyOf or dependencies, so the group
// rules live here:
// - the rating is one group: `overall`, or the four scales together (all four or none);
// - never both `overall` and the four scales;
// - at least one field: the rating, `want_to_train` or `pain` (an empty pain list counts).
// Each value: a scale is a whole number from 1 to 5; pain is a list of {region, score 0-10}.

export const FOUR_SCALES = ["sleep_quality", "energy", "soreness", "stress"] as const;

const isScale = (v: unknown) => typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5;

/** The problems with a check-in block, each `<path>.<field>: <problem>`. Empty means valid. */
export function checkinBlockProblems(block: unknown, path = "checkin"): string[] {
  if (typeof block !== "object" || block === null || Array.isArray(block)) return [`${path}: must be an object`];
  const b = block as Record<string, unknown>;
  const errors: string[] = [];
  const scales = FOUR_SCALES.filter((k) => b[k] !== undefined);
  for (const k of [...scales, ...(b.overall !== undefined ? ["overall"] : []), ...(b.want_to_train !== undefined ? ["want_to_train"] : [])]) {
    if (!isScale(b[k])) errors.push(`${path}.${k}: must be a whole number from 1 to 5`);
  }
  if (scales.length > 0 && scales.length < FOUR_SCALES.length) {
    const missing = FOUR_SCALES.filter((k) => b[k] === undefined);
    errors.push(`${path}: the four scales go together (all four or none); missing ${missing.join(", ")}`);
  }
  if (b.overall !== undefined && scales.length > 0) errors.push(`${path}: overall and the four scales cannot both be set`);
  if (b.pain !== undefined) {
    if (!Array.isArray(b.pain)) errors.push(`${path}.pain: must be a list`);
    else
      b.pain.forEach((p, i) => {
        const e = p as { region?: unknown; score?: unknown } | null;
        if (typeof e?.region !== "string" || e.region === "") errors.push(`${path}.pain[${i}].region: is required`);
        if (typeof e?.score !== "number" || !Number.isFinite(e.score) || e.score < 0 || e.score > 10) errors.push(`${path}.pain[${i}].score: must be a number from 0 to 10`);
      });
  }
  if (b.overall === undefined && scales.length === 0 && b.want_to_train === undefined && b.pain === undefined) {
    errors.push(`${path}: needs at least one of overall, the four scales, want_to_train or pain`);
  }
  return errors;
}
