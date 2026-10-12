# Security policy

## Report a problem privately

Report a security problem through GitHub's private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the steps to reproduce it, and the effect.

This is the private route: only you and the maintainers see the report. Do not open a public issue, pull request or discussion for a security problem. We will reply in the private report.

**Never send real health data.** Use a made-up example (an athlete called "Alex", invented readiness values and limits) or redact your own files before you attach them: no real names, check-ins, pain reports, Oura or Apple Health values, tokens or repository names.

## Scope

In scope:

- **The urgent stop:** any way to make a plan write while `athlete/.urgent-stop` exists, to clear the stop without the athlete's answer, or to make the urgent gate fail open (`.claude/hooks/urgent-gate.ts`, `.claude/hooks/urgent-list.ts`, `.claude/hooks/safety-detect.ts`, `engine/urgent.ts`).
- **The hooks:** the urgent detector and gate, the snapshot capture, the write log, the auto-commit and the session context.
- **Data handling:** a path that commits or pushes athlete data (`athlete/`, `plans/`, `coach.yaml`), tokens or credentials where they should not go; the pre-push check and `node engine/cli.ts push`; the privacy scan; the Oura credential store; error messages that echo a secret.

Out of scope:

- Problems in Claude Code, GitHub, Tally, Oura or Apple Health themselves. Report them to their owners.
- A plan that breaks one of your limits. In v0.2 code does not check plans: the coach follows your limits by its own judgment, and the evals measure how often it does. Open a normal issue with the plan and the limit.
- A user who turns off the urgent gate or the pre-push hook on their own copy.
- Training advice that you disagree with. Open a normal issue for that.

## Supported versions

Only the latest release gets security fixes.
