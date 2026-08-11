// Structured DSL diagnostics. Every parser reports through this shape and never
// throws: the caller (compile.ts) keeps the last valid patch playing (Glicol style).

export interface DslError {
  /** 1-based line number, relative to the whole markdown document. */
  line: number;
  /** 1-based column number. */
  col: number;
  message: string;
}

export interface Pos {
  line: number;
  col: number;
}

export function err(pos: Pos, message: string): DslError {
  return { line: pos.line, col: pos.col, message };
}

/** Collects diagnostics so parsers can keep going after a bad field. */
export class ErrorSink {
  readonly errors: DslError[] = [];

  push(pos: Pos, message: string): void {
    this.errors.push(err(pos, message));
  }

  get ok(): boolean {
    return this.errors.length === 0;
  }
}

/** Sort by document position; handy for stable UI output. */
export function sortErrors(list: DslError[]): DslError[] {
  return [...list].sort((a, b) => (a.line - b.line) || (a.col - b.col));
}
