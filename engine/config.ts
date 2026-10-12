// coach.yaml loader and validator (contracts §1).
import { CoachError } from "./errors.ts";
import { isValidTimezone, WEEKDAYS } from "./dates.ts";
import { DEFAULT_THRESHOLDS, thresholdErrors } from "./readiness.ts";
import { isPlainObject, readYamlFile } from "./yaml-file.ts";
import type { BigChangeKind, ChangeKind, CoachConfig, SmallChangeKind, Thresholds } from "./types.ts";

export const SMALL_KINDS: readonly SmallChangeKind[] = [
  "trim_session",
  "swap_to_recovery",
  "load_progression",
  "reschedule_within_week",
  "annotate",
  "block_session",
];
/** Hard-rule kinds: never allowed in `approval.auto`. */
export const BIG_KINDS: readonly BigChangeKind[] = [
  "new_exercise",
  "volume_above_plan",
  "override_user_day",
  "skip_or_delete_user_day",
  "limit_change",
  "new_block",
  "method_change",
];
export const ALL_KINDS: readonly ChangeKind[] = [...SMALL_KINDS, ...BIG_KINDS];

/** athlete.sleep_target_min (E3, decided 2026-10-09): optional, minutes. */
export const DEFAULT_SLEEP_TARGET_MIN = 480;
export const SLEEP_TARGET_RANGE: readonly [number, number] = [240, 720];

const TOP_KEYS = ["version", "athlete", "method", "template", "signals", "logger", "tally_mentioned", "consent", "automation", "approval", "thresholds"];
/** Where plans live (v0.2, contracts §1, §12a). */
export const LOGGERS = ["tally", "files", "other"] as const;
/** The tool-name prefix of a connected logger server, in any of its name forms (launch review finding 7). */
export const LOGGER_TOOL_PREFIX_RE = /^mcp__[A-Za-z0-9_-]*[Tt]ally[A-Za-z0-9_-]*__$/;
// `logger` was required up to 0.1; a release never adds a required key, and 0.2 makes it optional (§24).
const REQUIRED_TOP = ["version", "athlete", "method", "template", "signals", "approval"];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

class Checker {
  errors: string[] = [];

  fail(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }

  object(v: unknown, path: string, allowed: string[], required: string[] = allowed): v is Record<string, unknown> {
    if (!isPlainObject(v)) {
      this.fail(path, "must be a mapping");
      return false;
    }
    for (const k of Object.keys(v)) if (!allowed.includes(k)) this.fail(`${path}.${k}`, `unknown key (allowed: ${allowed.join(", ")})`);
    for (const k of required) if (!(k in v)) this.fail(`${path}.${k}`, "is required");
    return true;
  }

  oneOf<T>(v: unknown, path: string, values: readonly T[]): void {
    if (!values.includes(v as T)) this.fail(path, `must be one of ${values.join(" | ")}, got ${JSON.stringify(v)}`);
  }

  string(v: unknown, path: string, re?: RegExp, hint?: string): void {
    if (typeof v !== "string" || v.length === 0) this.fail(path, "must be a non-empty string");
    else if (re && !re.test(v)) this.fail(path, `${hint ?? `must match ${re}`}, got ${JSON.stringify(v)}`);
  }
}

/** Validates a parsed coach.yaml. Throws CoachError CONFIG_INVALID listing every problem. */
export function validateConfig(raw: unknown, where = "coach.yaml"): CoachConfig {
  const c = new Checker();
  if (!c.object(raw, "coach.yaml", TOP_KEYS, REQUIRED_TOP)) throw invalid(where, c.errors);

  if ("version" in raw && raw.version !== 1) c.fail("version", `must be 1, got ${JSON.stringify(raw.version)}`);

  const a = raw.athlete;
  if ("athlete" in raw && c.object(a, "athlete", ["name", "timezone", "units", "sleep_target_min"], ["name", "timezone", "units"])) {
    c.string(a.name, "athlete.name");
    if (!isValidTimezone(a.timezone)) c.fail("athlete.timezone", `must be an IANA timezone, got ${JSON.stringify(a.timezone)}`);
    c.oneOf(a.units, "athlete.units", ["lbs", "kg"]);
    const st = a.sleep_target_min;
    if (st !== undefined && !(Number.isInteger(st) && (st as number) >= SLEEP_TARGET_RANGE[0] && (st as number) <= SLEEP_TARGET_RANGE[1])) {
      c.fail("athlete.sleep_target_min", `must be a whole number of minutes from ${SLEEP_TARGET_RANGE[0]} to ${SLEEP_TARGET_RANGE[1]}, got ${JSON.stringify(st)}`);
    }
  }

  if ("method" in raw) c.string(raw.method, "method", NAME_RE, "must be a folder name under methods/");
  if ("logger" in raw) c.oneOf(raw.logger, "logger", LOGGERS);
  if ("tally_mentioned" in raw && typeof raw.tally_mentioned !== "boolean") c.fail("tally_mentioned", "must be true or false");

  // launch review finding 5: health details go into logger notes only after this separate consent.
  const consent = raw.consent ?? {};
  if (c.object(consent, "consent", ["logger_health_notes"], [])) {
    if ("logger_health_notes" in consent && typeof consent.logger_health_notes !== "boolean") c.fail("consent.logger_health_notes", "must be true or false");
  }

  const t = raw.template;
  if ("template" in raw && c.object(t, "template", ["days", "emphasis"])) {
    c.oneOf(t.days, "template.days", [3, 4, 5]);
    c.oneOf(t.emphasis, "template.emphasis", ["all-around", "strength", "hypertrophy", "endurance", "general-health"]);
  }

  const s = raw.signals;
  if ("signals" in raw && c.object(s, "signals", ["wearable", "checkin"])) {
    c.oneOf(s.wearable, "signals.wearable", ["apple-health-shortcut", "oura", "none"]);
    c.oneOf(s.checkin, "signals.checkin", ["shortcut", "chat"]);
  }

  const auto = raw.automation ?? {
    mode: "manual",
    daily_window: { start: "05:07", end: "10:07" },
    weekly: { day: "sun", time: "17:07" },
    verified: false,
  };
  if (c.object(auto, "automation", ["mode", "daily_window", "weekly", "verified", "tool_prefix"], ["mode", "daily_window", "weekly", "verified"])) {
    c.oneOf(auto.mode, "automation.mode", ["cloud", "mac", "manual"]);
    if ("tool_prefix" in auto) c.string(auto.tool_prefix, "automation.tool_prefix", LOGGER_TOOL_PREFIX_RE, "must be a logger tool prefix such as mcp__tally__ or mcp__claude_ai_Tally_Workout__");
    const w = auto.daily_window;
    if (c.object(w, "automation.daily_window", ["start", "end"])) {
      c.string(w.start, "automation.daily_window.start", TIME_RE, "must be HH:MM");
      c.string(w.end, "automation.daily_window.end", TIME_RE, "must be HH:MM");
      if (typeof w.start === "string" && typeof w.end === "string" && w.start >= w.end) {
        c.fail("automation.daily_window", "start must be before end");
      }
    }
    const wk = auto.weekly;
    if (c.object(wk, "automation.weekly", ["day", "time"])) {
      c.oneOf(wk.day, "automation.weekly.day", WEEKDAYS);
      c.string(wk.time, "automation.weekly.time", TIME_RE, "must be HH:MM");
    }
    if (typeof auto.verified !== "boolean") c.fail("automation.verified", "must be true or false");
  }

  let approval: CoachConfig["approval"] = { auto: [], ask: [] };
  const ap = raw.approval;
  if ("approval" in raw && c.object(ap, "approval", ["auto", "ask"])) {
    const lists: Record<"auto" | "ask", ChangeKind[]> = { auto: [], ask: [] };
    for (const key of ["auto", "ask"] as const) {
      const list = ap[key];
      if (!Array.isArray(list)) {
        c.fail(`approval.${key}`, "must be a list of change kinds");
        continue;
      }
      list.forEach((k, i) => {
        if (!ALL_KINDS.includes(k as ChangeKind)) {
          c.fail(`approval.${key}[${i}]`, `unknown change kind ${JSON.stringify(k)} (known: ${ALL_KINDS.join(", ")})`);
        } else if (lists[key].includes(k as ChangeKind)) {
          c.fail(`approval.${key}[${i}]`, `duplicate kind ${k}`);
        } else {
          lists[key].push(k as ChangeKind);
        }
      });
    }
    for (const k of lists.auto) {
      if (lists.ask.includes(k)) c.fail("approval", `kind ${k} appears in both auto and ask`);
      if ((BIG_KINDS as readonly string[]).includes(k)) {
        c.fail("approval.auto", `kind ${k} is a hard-rule kind and cannot be in auto; move it to ask`);
      }
    }
    // Fail closed: a kind listed nowhere needs approval.
    for (const k of ALL_KINDS) if (!lists.auto.includes(k) && !lists.ask.includes(k)) lists.ask.push(k);
    approval = lists;
  }

  const thresholds: Partial<Thresholds> = {};
  const th = raw.thresholds ?? {};
  const thKeys = Object.keys(DEFAULT_THRESHOLDS);
  if (c.object(th, "thresholds", thKeys, [])) {
    for (const [k, v] of Object.entries(th)) {
      if (!thKeys.includes(k)) continue;
      if (typeof v !== "number" || !Number.isFinite(v)) c.fail(`thresholds.${k}`, "must be a number");
      else thresholds[k as keyof Thresholds] = v;
    }
    c.errors.push(...thresholdErrors(thresholds));
  }

  if (c.errors.length > 0) throw invalid(where, c.errors);
  const r = raw as Record<string, any>;
  return {
    version: 1,
    athlete: {
      name: r.athlete.name,
      timezone: r.athlete.timezone,
      units: r.athlete.units,
      ...(r.athlete.sleep_target_min !== undefined ? { sleep_target_min: r.athlete.sleep_target_min } : {}),
    },
    method: r.method,
    template: { days: r.template.days, emphasis: r.template.emphasis },
    signals: { wearable: r.signals.wearable, checkin: r.signals.checkin },
    logger: r.logger ?? defaultLogger(auto),
    tally_mentioned: r.tally_mentioned === true,
    // v0.2: setup's one data question covers the notes; only an explicit false keeps them generic.
    consent: { logger_health_notes: (consent as Record<string, unknown>).logger_health_notes !== false },
    automation: {
      mode: (auto as any).mode,
      daily_window: { start: (auto as any).daily_window.start, end: (auto as any).daily_window.end },
      weekly: { day: (auto as any).weekly.day, time: (auto as any).weekly.time },
      verified: (auto as any).verified,
      ...(typeof (auto as any).tool_prefix === "string" ? { tool_prefix: (auto as any).tool_prefix } : {}),
    },
    approval,
    thresholds,
  };
}

/**
 * The logger when coach.yaml has no `logger` key: `files` (plans in this repo), unless the copy
 * already uses Tally (a connected Tally server's tool prefix is recorded), which stays on Tally.
 */
export function defaultLogger(automation: unknown): CoachConfig["logger"] {
  return isPlainObject(automation) && typeof automation.tool_prefix === "string" ? "tally" : "files";
}

function invalid(where: string, errors: string[]): CoachError {
  return new CoachError("CONFIG_INVALID", `${where} is invalid:\n  - ${errors.join("\n  - ")}`);
}

export function loadConfig(path: string): CoachConfig {
  return validateConfig(readYamlFile(path, "CONFIG_INVALID"), path);
}
