 export class TtlCache<T> {
  private ts = 0;
  private val: T | null = null;

  constructor(private ttlMs: number) {}

  get(): T | null {
    if (this.val !== null && Date.now() - this.ts < this.ttlMs) return this.val;
    return null;
  }

  set(value: T): void {
    this.ts = Date.now();
    this.val = value;
  }

  invalidate(): void {
    this.val = null;
  }
}
