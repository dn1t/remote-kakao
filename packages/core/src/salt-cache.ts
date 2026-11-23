/**
 * Remembers the session salts of recent hellos, so that a recorded hello cannot be sent again.
 * `ttl` must cover the whole time a recorded hello still passes the timestamp check.
 */
export class SaltCache {
  readonly #ttl: number;
  /** Salt (base64) to the time it is forgotten. Oldest first, because every salt is kept for the same `ttl`. */
  readonly #expiries = new Map<string, number>();

  /** `ttl` is how long, in ms, a salt is remembered. */
  constructor(ttl: number) {
    this.#ttl = ttl;
  }

  /** Number of salts remembered. */
  get size(): number {
    return this.#expiries.size;
  }

  /**
   * Remembers the salt. Returns `false` if it is already remembered, which means the hello is a replay.
   * Seeing a salt again does not extend how long it is remembered.
   */
  add(salt: Uint8Array): boolean {
    const now = Date.now();
    this.#forgetExpired(now);
    const key = Buffer.from(salt).toString("base64");
    if (this.#expiries.has(key)) return false;
    this.#expiries.set(key, now + this.#ttl);
    return true;
  }

  #forgetExpired(now: number): void {
    for (const [key, expiry] of this.#expiries) {
      if (expiry > now) break;
      this.#expiries.delete(key);
    }
  }
}
