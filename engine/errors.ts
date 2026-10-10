/** Every engine function throws this. Hooks turn any throw into a deny (contracts §7). */
export class CoachError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CoachError";
    this.code = code;
  }
}
