const SIZE = 64n;
const MASK = (1n << SIZE) - 1n;
const END = 1n << 64n;

/**
 * Refuses a frame counter that was already used or is too old, so that a recorded frame
 * cannot be sent again. It remembers the 64 latest counters, which lets frames arrive out of order.
 * A session has one for each direction.
 */
export class ReplayWindow {
  /** The highest counter accepted so far, or -1 before the first. */
  #highest = -1n;
  /** Bit `n` is set when the counter `#highest - n` was accepted. */
  #seen = 0n;

  /** Whether the counter is new. If it is, it is remembered, so a second call with it is refused. */
  accept(counter: bigint): boolean {
    if (counter < 0n || counter >= END) return false;

    if (counter > this.#highest) {
      const shift = counter - this.#highest;
      this.#seen = shift >= SIZE ? 1n : ((this.#seen << shift) & MASK) | 1n;
      this.#highest = counter;
      return true;
    }

    const age = this.#highest - counter;
    if (age >= SIZE) return false;
    const bit = 1n << age;
    if ((this.#seen & bit) !== 0n) return false;
    this.#seen |= bit;
    return true;
  }
}
