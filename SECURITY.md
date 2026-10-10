# Security policy

## Report a problem privately

Report a security problem through GitHub's private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Click **Report a vulnerability**.
3. Describe the problem, the steps to reproduce it, and the effect.

Do not open a public issue, pull request or discussion for a security problem. We will reply in the private report.

## Scope

In scope:

- **The guard:** any way to make a logger write that the guard should deny, to pass a write that breaks a limit or a hold, or to make a hook fail open (`.claude/hooks/`, `engine/validate.ts`, `engine/protect.ts`, `engine/classify.ts`, `engine/approvals.ts`).
- **The hooks:** the safety detector, the file guard, the snapshot capture, the write log and the session context.
- **Data handling:** a path that commits or pushes athlete data, tokens or credentials where they should not go; the pre-push check; the privacy scan; the Oura credential store; error messages that echo a secret.
- **Approvals:** a way for an unattended run to approve its own big change.

Out of scope:

- Problems in Claude Code, GitHub, Tally, Oura or Apple Health themselves. Report them to their owners.
- A model that a user gives full shell access and asks to remove the guard. The guard protects against model mistakes and drift, not against a user who turns it off.
- Training advice that you disagree with. Open a normal issue for that.

## Supported versions

Only the latest release gets security fixes.
