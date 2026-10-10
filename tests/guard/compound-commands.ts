// Bash commands for the guard-files compound-command tests: what must pass, and the
// attack set that must still deny unattended and ask interactive.

export const COMPOUND_ALLOWED = [
  "node engine/cli.ts hold status",
  "node engine/hold.ts status",
  "node engine/cli.ts hold init",
  "node engine/cli.ts hold set --reason knee",
  'node engine/cli.ts window-check --kind daily; echo "exit $?"',
  "node engine/cli.ts opid --date 2026-10-14 --kind trim; grep x adapters/loggers/tally/adapter.yaml",
  "git add athlete/.safety-pending && git commit -m x",
  'git add athlete/limits.yaml athlete/.safety-pending && git commit -m "hold set; limits.yaml unchanged (NA-SAFE-001)"',
  "node engine/cli.ts readiness --input .tmp/coach/r.json && node engine/cli.ts adjust --input .tmp/coach/a.json",
  "node engine/cli.ts mode | head -n 1",
  "node engine/cli.ts weeks\nnode engine/cli.ts hold status",
  "node engine/cli.ts hold status || cat athlete/hold.yaml",
  "cat athlete/hold.yaml; cat athlete/.safety-pending",
  "git add athlete && git commit -m log && git push origin main",
];

/** The part of COMPOUND_ALLOWED on the unattended allowlist (launch review finding 1); the rest denies unattended. */
export const COMPOUND_ALLOWED_UNATTENDED = [
  "node engine/cli.ts hold status",
  "node engine/hold.ts status",
  "node engine/cli.ts hold init",
  "node engine/cli.ts hold set --reason knee",
  "git add athlete/.safety-pending && git commit -m x",
  'git add athlete/limits.yaml athlete/.safety-pending && git commit -m "hold set; limits.yaml unchanged (NA-SAFE-001)"',
  "node engine/cli.ts readiness --input .tmp/coach/r.json && node engine/cli.ts adjust --input .tmp/coach/a.json",
  "node engine/cli.ts weeks\nnode engine/cli.ts hold status",
  "git add athlete && git commit -m log && node engine/cli.ts push",
];

export const COMPOUND_ATTACKS = [
  // the earlier attack set
  "ls; rm engine/x",
  "cat x > athlete/limits.yaml",
  "node engine/cli.ts hold clear-pending",
  "node engine/cli.ts hold clear --approved",
  "node engine/hold.ts clear",
  "git checkout HEAD~1 -- .",
  "true && sed -i '' s/a/b/ athlete/limits.yaml",
  "node engine/cli.ts opid; ls engine/protect.ts(e:touch engine/pwned:)",
  "node engine/cli.ts opid; ls *(e:'touch engine/pwned':)",
  "node engine/cli.ts opid; cat =(touch engine/pwned)",
  "node engine/cli.ts opid; rm ENGINE/protect.ts",
  "ls; rm Athlete/Limits.yaml",
  "node ENGINE/cli.ts hold clear-pending",
  // hold subcommands: only the word right after `hold` counts
  "node engine/cli.ts hold --reason status clear",
  "node engine/cli.ts hold --approved clear-pending",
  "node engine/cli.ts hold status; node engine/cli.ts hold clear-pending",
  "node engine/cli.ts hold",
  // a segment that writes a protected path denies the whole command
  "node engine/cli.ts opid && rm -rf engine",
  "node engine/cli.ts opid; echo x > .claude/settings.json",
  "node engine/cli.ts opid | tee athlete/limits.yaml",
  "node engine/cli.ts opid >& athlete/limits.yaml",
  "node engine/cli.ts opid &> athlete/limits.yaml",
  "node engine/cli.ts opid & rm -rf methods",
  "node engine/cli.ts opid\nrm coach.yaml",
  // commands that cannot be split reliably keep the strict rule
  "node engine/cli.ts opid $(rm athlete/limits.yaml)",
  "node engine/cli.ts opid `rm engine/x`",
  "node engine/cli.ts opid <(rm engine/x)",
  "node engine/cli.ts opid; cat <<EOF > engine/x\nhi\nEOF",
  "node engine/cli.ts opid 'unbalanced; rm engine/x",
  "node engine/cli.ts opid; (rm engine/x)",
  "node engine/cli.ts opid $'a'; rm engine/x",
  // a comment that hides a newline from a naive quote scan
  "node engine/cli.ts opid #'\nrm engine/x #'",
  "git commit -m x #'\nrm engine/x #'",
  // git add and commit pass; other git subcommands and redirects keep today's rules
  "git commit -m x > athlete/limits.yaml",
  "git add athlete/limits.yaml; git stash",
  "git add . && git checkout HEAD~1 -- .",
  "git -c core.hooksPath=/tmp/h commit -m x",
  "git commit -m x; git reset --hard",
  "git add athlete && git restore athlete/limits.yaml",
];
