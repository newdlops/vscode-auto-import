export class Position {
  constructor(public readonly line: number, public readonly character: number) {}
}

export class Range {
  constructor(public readonly start: Position, public readonly end: Position) {}
}

export class TextEdit {
  constructor(public range: Range, public newText: string) {}
  static insert(pos: Position, text: string): TextEdit {
    return new TextEdit(new Range(pos, pos), text);
  }
  static replace(range: Range, text: string): TextEdit {
    return new TextEdit(range, text);
  }
}

export class CompletionItem {
  label: string;
  kind: number;
  detail?: string;
  insertText?: string;
  filterText?: string;
  sortText?: string;
  range?: Range;
  additionalTextEdits?: TextEdit[];
  constructor(label: string, kind: number) {
    this.label = label;
    this.kind = kind;
  }
}

export const CompletionItemKind = {
  Text: 0,
  Method: 1,
  Function: 2,
  Constructor: 3,
  Field: 4,
  Variable: 5,
  Class: 6,
  Interface: 7,
  Module: 8,
  Property: 9,
  Unit: 10,
  Value: 11,
  Enum: 12,
  Keyword: 13,
  Snippet: 14,
  Color: 15,
  File: 16,
  Reference: 17,
  TypeParameter: 24,
};

export class MockDocument {
  readonly uri: { fsPath: string; scheme: string };
  constructor(fsPath: string, private text: string) {
    this.uri = { fsPath, scheme: 'file' };
  }
  getText(range?: Range): string {
    if (!range) return this.text;
    const start = this.offsetAt(range.start);
    const end = this.offsetAt(range.end);
    return this.text.slice(start, end);
  }
  positionAt(offset: number): Position {
    let line = 0;
    let col = 0;
    for (let i = 0; i < offset && i < this.text.length; i++) {
      if (this.text[i] === '\n') {
        line++;
        col = 0;
      } else {
        col++;
      }
    }
    return new Position(line, col);
  }
  offsetAt(p: Position): number {
    let offset = 0;
    let line = 0;
    while (line < p.line && offset < this.text.length) {
      if (this.text[offset] === '\n') line++;
      offset++;
    }
    return offset + p.character;
  }
  getWordRangeAtPosition(pos: Position, re: RegExp): Range | undefined {
    const lines = this.text.split('\n');
    const lineText = lines[pos.line] ?? '';
    const source = /^(?:\^|\$)/.test(re.source) ? re.source : `(?:${re.source})`;
    const scan = new RegExp(source, 'g');
    let m: RegExpExecArray | null;
    while ((m = scan.exec(lineText)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      if (pos.character >= start && pos.character <= end) {
        return new Range(new Position(pos.line, start), new Position(pos.line, end));
      }
    }
    return undefined;
  }
}
