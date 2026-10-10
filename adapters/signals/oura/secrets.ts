// Secret storage for the Oura adapter. On the Mac this is the login Keychain, through the
// `security` tool. Values never pass through argv (where `ps` could show them): writes go
// to `security -i` on stdin, hex-encoded with -X. Nothing here prints a value.
import { execFileSync } from "node:child_process";
import { CoachError } from "../../../engine/errors.ts";

export const KEYCHAIN_SERVICE = "coach-harness.oura";
export const ACCOUNT_CLIENT_ID = "client_id";
export const ACCOUNT_CLIENT_SECRET = "client_secret";
export const ACCOUNT_TOKENS = "tokens";

export interface SecretStore {
  /** The value, or null when there is none. */
  get(account: string): string | null;
  set(account: string, value: string): void;
}

/** `security find-generic-password` exits 44 when the item does not exist. */
const NOT_FOUND = 44;

export class KeychainStore implements SecretStore {
  service: string;

  constructor(service = KEYCHAIN_SERVICE) {
    if (!/^[A-Za-z0-9._-]+$/.test(service)) throw new CoachError("OURA_KEYCHAIN", `bad Keychain service name: ${service}`);
    this.service = service;
  }

  get(account: string): string | null {
    checkAccount(account);
    try {
      const out = execFileSync("security", ["find-generic-password", "-s", this.service, "-a", account, "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return out.replace(/\n$/, "");
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === NOT_FOUND) return null;
      throw new CoachError("OURA_KEYCHAIN", `cannot read Keychain item ${this.service}/${account} (security exit ${status ?? "?"}). Is this a Mac with an unlocked login Keychain?`);
    }
  }

  set(account: string, value: string): void {
    checkAccount(account);
    const hex = Buffer.from(value, "utf8").toString("hex");
    try {
      execFileSync("security", ["-i"], {
        input: `add-generic-password -U -s ${this.service} -a ${account} -X ${hex}\n`,
        stdio: ["pipe", "ignore", "pipe"],
      });
    } catch (e) {
      const status = (e as { status?: number }).status;
      throw new CoachError("OURA_KEYCHAIN", `cannot write Keychain item ${this.service}/${account} (security exit ${status ?? "?"})`);
    }
  }
}

function checkAccount(account: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(account)) throw new CoachError("OURA_KEYCHAIN", `bad Keychain account name: ${account}`);
}

/** The command a user runs to store a client value (it prompts for the value). */
export function storeCommand(account: string, service = KEYCHAIN_SERVICE): string {
  return `security add-generic-password -U -s ${service} -a ${account} -w`;
}
