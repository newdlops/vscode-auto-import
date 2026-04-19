export class StringTable {
  private ids = new Map<string, number>();
  private strings: string[] = [];

  intern(s: string): number {
    const existing = this.ids.get(s);
    if (existing !== undefined) return existing;
    const id = this.strings.length;
    this.ids.set(s, id);
    this.strings.push(s);
    return id;
  }

  lookup(s: string): number | undefined {
    return this.ids.get(s);
  }

  get(id: number): string {
    const s = this.strings[id];
    if (s === undefined) throw new Error(`StringTable: invalid id ${id}`);
    return s;
  }

  has(s: string): boolean {
    return this.ids.has(s);
  }

  size(): number {
    return this.strings.length;
  }

  *entries(): IterableIterator<[number, string]> {
    for (let i = 0; i < this.strings.length; i++) {
      yield [i, this.strings[i]!];
    }
  }

  serialize(): Buffer {
    const encoder = new TextEncoder();
    const parts: Buffer[] = [];
    const header = Buffer.alloc(4);
    header.writeUInt32LE(this.strings.length, 0);
    parts.push(header);
    for (const s of this.strings) {
      const bytes = encoder.encode(s);
      const len = Buffer.alloc(2);
      if (bytes.length > 0xffff) {
        throw new Error(`StringTable: string exceeds 65535 bytes (${bytes.length})`);
      }
      len.writeUInt16LE(bytes.length, 0);
      parts.push(len);
      parts.push(Buffer.from(bytes));
    }
    return Buffer.concat(parts);
  }

  static deserialize(buf: Buffer): StringTable {
    const table = new StringTable();
    if (buf.length < 4) throw new Error('StringTable: truncated');
    const count = buf.readUInt32LE(0);
    let offset = 4;
    const decoder = new TextDecoder('utf-8');
    for (let i = 0; i < count; i++) {
      if (offset + 2 > buf.length) throw new Error('StringTable: truncated length');
      const len = buf.readUInt16LE(offset);
      offset += 2;
      if (offset + len > buf.length) throw new Error('StringTable: truncated payload');
      const s = decoder.decode(buf.subarray(offset, offset + len));
      offset += len;
      table.ids.set(s, i);
      table.strings.push(s);
    }
    return table;
  }
}
