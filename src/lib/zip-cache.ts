/** 按字节而非包数限制 ZIP 驻留量。 / Bound retained ZIP data by bytes instead of pack count. */
export class ZipCache<Key extends object, Value> {
  private records = new Map<Key, { value: Value; bytes: number }>();
  private used = 0;

  constructor(readonly budget: number) {}

  get residentBytes(): number {
    return this.used;
  }

  get(key: Key): Value | undefined {
    const record = this.records.get(key);
    if (!record) return undefined;
    this.records.delete(key);
    this.records.set(key, record);
    return record.value;
  }

  set(key: Key, value: Value, bytes: number): void {
    this.delete(key);
    if (!Number.isFinite(bytes) || bytes < 0 || bytes > this.budget) return;
    while (this.used + bytes > this.budget) {
      const oldest = this.records.keys().next().value;
      if (!oldest) break;
      this.delete(oldest);
    }
    this.records.set(key, { value, bytes });
    this.used += bytes;
  }

  delete(key: Key): void {
    const record = this.records.get(key);
    if (!record) return;
    this.records.delete(key);
    this.used -= record.bytes;
  }

  clear(): void {
    this.records.clear();
    this.used = 0;
  }
}

/** 限制瞬时打开归档数，避免并行回退读取同时分配多个大 ArrayBuffer。 / Bound transient full-archive opens. */
export class ZipOpenGate {
  private active = 0;
  private waiting: (() => void)[] = [];

  constructor(private readonly concurrency: number) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active < this.concurrency) this.active++;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
