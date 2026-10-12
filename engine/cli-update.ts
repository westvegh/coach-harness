// CLI for the template update and the config check (contracts §24).
//
//   node engine/cli.ts update --check [--ref <tag or branch>]
//   node engine/cli.ts update --yes --to <sha> [--ref <ref>] [--keep-mine <path>]... [--take-template <path>]...
//   node engine/cli.ts config-check                       (exit 1: coach.yaml has problems)
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { CoachError } from "./errors.ts";
import { unattendedMarker } from "./mode.ts";
import { isGithubSource, MANIFEST } from "./manifest.ts";

function out(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

/** The source: the local manifest's repo, a GitHub URL (it ships in the template; not a coach.yaml key). */
function manifestSource(root: string): string {
  let text: string;
  try {
    text = execFileSync("git", ["show", `HEAD:${MANIFEST}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    throw new CoachError(
      "NO_MANIFEST",
      "this copy has no template-manifest.json (it was made before updates existed), so it cannot be updated safely. Compare the files by hand, or start a new copy from the template and move athlete/ and coach.yaml into it.",
    );
  }
  let repo: unknown;
  try {
    repo = JSON.parse(text).repo;
  } catch {
    throw new CoachError("MANIFEST_INVALID", `${MANIFEST} is not JSON`);
  }
  if (!isGithubSource(repo)) throw new CoachError("MANIFEST_INVALID", `${MANIFEST} repo must be https://github.com/<owner>/<repo>, got ${JSON.stringify(repo)}`);
  return repo;
}

export async function cmdUpdate(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      root: { type: "string" },
      check: { type: "boolean" },
      yes: { type: "boolean" },
      ref: { type: "string" },
      to: { type: "string" },
      "keep-mine": { type: "string", multiple: true },
      "take-template": { type: "string", multiple: true },
    },
  });
  const marker = unattendedMarker(process.env);
  if (marker) throw new CoachError("UNATTENDED", `update never runs unattended (${marker} is set); it needs the athlete's yes`);
  if (values.check && values.yes) throw new CoachError("USAGE", "update takes --check or --yes, not both");
  if (!values.check && !values.yes) throw new CoachError("USAGE", "usage: update --check [--ref <ref>] | update --yes --to <sha> [--keep-mine <path>]... [--take-template <path>]...");
  if (values.check && (values.to || values["keep-mine"] || values["take-template"])) throw new CoachError("USAGE", "--to, --keep-mine and --take-template go with --yes");
  const root = resolve(values.root ?? ".");
  const source = manifestSource(root);
  const ref = values.ref ?? "main";
  const { applyUpdate, checkReport, prepareUpdate } = await import("./update.ts");
  if (values.check) {
    out(checkReport(prepareUpdate({ root, source, ref })));
    return 0;
  }
  if (!values.to || !/^([0-9a-f]{40}|[0-9a-f]{64})$/.test(values.to)) throw new CoachError("USAGE", "update --yes needs --to <the full sha that update --check printed>");
  out({ source, ref, ...applyUpdate({ root, source, ref, to: values.to, keepMine: values["keep-mine"] ?? [], takeTemplate: values["take-template"] ?? [] }) });
  return 0;
}

/**
 * Loads coach.yaml with this engine (run it in a new process after an update), and checks
 * that .claude/settings.json registers the urgent gate with onFailure: block. Hooks in
 * .claude/settings.local.json that point at the v0.1 guard stubs are reported as notes.
 */
export async function cmdConfigCheck(argv: string[]): Promise<number> {
  const { values } = parseArgs({ args: argv, strict: true, options: { root: { type: "string" } } });
  const root = resolve(values.root ?? ".");
  const [{ loadConfig }, { guardStubHooks, urgentGateProblems }, { existsSync, readFileSync }] = await Promise.all([import("./config.ts"), import("./settings-gate.ts"), import("node:fs")]);
  const read = (rel: string) => (existsSync(join(root, rel)) ? readFileSync(join(root, rel), "utf8") : null);
  const problems: string[] = [];
  let message: string | undefined;
  try {
    loadConfig(join(root, "coach.yaml"));
  } catch (e) {
    message = e instanceof Error ? e.message : String(e);
    problems.push(...message.split("\n").map((l) => l.replace(/^\s*-\s*/, "").trim()).filter((l) => l !== "" && !/is invalid:$/.test(l)));
  }
  problems.push(...urgentGateProblems(read(".claude/settings.json")));
  const local = guardStubHooks(read(".claude/settings.local.json"));
  const notes = local.length ? [`.claude/settings.local.json still runs the v0.1 guard stubs (harmless; they allow everything): ${local.join(", ")}`] : [];
  out({ ok: problems.length === 0, problems, notes, ...(message ? { message } : {}) });
  return problems.length === 0 ? 0 : 1;
}
