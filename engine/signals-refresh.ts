// signals refresh. Refreshes the Oura cache for the last
// 3 days before a daily run loads signals. Oura is Mac-only in v1 (contracts §14): the
// command does the fetch only when coach.yaml sets signals.wearable: oura, the platform is
// macOS and the Keychain holds an Oura sign-in. Otherwise it changes nothing and says why.
// It never prints a token: errors go through the Oura adapter's fixed messages.
// The Oura adapter is imported only when Oura is configured on a Mac.
import type { fetchOura, FetchResult } from "../adapters/signals/oura/fetch.ts";
import type { SecretStore } from "../adapters/signals/oura/secrets.ts";
import type { FetchFn } from "../adapters/signals/oura/auth.ts";
import type { LockOptions } from "../adapters/signals/oura/lock.ts";
import type { CoachConfig } from "./types.ts";

export const REFRESH_DAYS = 3;

export type RefreshResult = {
  refreshed: boolean;
  /** One line: what happened, or why nothing was fetched. */
  note: string;
  result?: FetchResult;
  error?: { code: string; message: string };
};

export type RefreshDeps = {
  platform?: NodeJS.Platform;
  store?: SecretStore;
  fetch?: FetchFn;
  now?: () => number;
  lock?: LockOptions;
  /** Injectable for tests. Default: the Oura adapter's fetchOura. */
  fetchOura?: typeof fetchOura;
};

export async function refreshSignals(root: string, cfg: CoachConfig | null, deps: RefreshDeps = {}): Promise<RefreshResult> {
  if (!cfg) return { refreshed: false, note: "no coach.yaml: Oura is not configured" };
  if (cfg.signals.wearable !== "oura") return { refreshed: false, note: `Oura is not configured (signals.wearable is ${cfg.signals.wearable})` };
  const platform = deps.platform ?? process.platform;
  if (platform !== "darwin") return { refreshed: false, note: `not macOS (${platform}): Oura refreshes on the Mac only; this run uses the cached signals` };
  const [{ ACCOUNT_TOKENS, KeychainStore }, { formatCliError }] = await Promise.all([import("../adapters/signals/oura/secrets.ts"), import("../adapters/signals/oura/errors.ts")]);
  const store = deps.store ?? new KeychainStore();
  try {
    if (store.get(ACCOUNT_TOKENS) === null) {
      return { refreshed: false, note: "no Oura sign-in in the Keychain: run node adapters/signals/oura/auth.ts on the Mac" };
    }
  } catch {
    return { refreshed: false, note: "no Keychain access (locked, or not a user session): this run uses the cached signals" };
  }
  try {
    const result = await (deps.fetchOura ?? (await import("../adapters/signals/oura/fetch.ts")).fetchOura)({
      root,
      days: REFRESH_DAYS,
      tz: cfg.athlete.timezone,
      deps: { store, fetch: deps.fetch ?? fetch, ...(deps.now ? { now: deps.now } : {}), ...(deps.lock ? { lock: deps.lock } : {}) },
    });
    return { refreshed: true, note: `Oura refreshed ${result.from} to ${result.to} (${result.records} records)`, result };
  } catch (e) {
    const error = formatCliError(e);
    return { refreshed: false, note: `Oura fetch failed (${error.code}): this run uses the cached signals`, error };
  }
}
