export type PhaseCap = { tokens_in: number; tokens_out: number; dollars: number };
export type Usage = { tokens_in: number; tokens_out: number; dollars: number };

export class CostCapTracker {
  private used: Usage = { tokens_in: 0, tokens_out: 0, dollars: 0 };

  constructor(private readonly cap: PhaseCap) {}

  add(delta: Usage): void {
    this.used.tokens_in += delta.tokens_in;
    this.used.tokens_out += delta.tokens_out;
    this.used.dollars += delta.dollars;
    if (this.used.tokens_in > this.cap.tokens_in) {
      throw new Error(`cost cap exceeded: tokens_in ${this.used.tokens_in} > ${this.cap.tokens_in}`);
    }
    if (this.used.tokens_out > this.cap.tokens_out) {
      throw new Error(`cost cap exceeded: tokens_out ${this.used.tokens_out} > ${this.cap.tokens_out}`);
    }
    if (this.used.dollars > this.cap.dollars) {
      throw new Error(`cost cap exceeded: dollars ${this.used.dollars.toFixed(2)} > ${this.cap.dollars}`);
    }
  }

  usage(): Usage {
    return { ...this.used };
  }

  approachingCap(threshold = 0.8): boolean {
    return (
      this.used.tokens_in / this.cap.tokens_in >= threshold ||
      this.used.tokens_out / this.cap.tokens_out >= threshold ||
      this.used.dollars / this.cap.dollars >= threshold
    );
  }
}
