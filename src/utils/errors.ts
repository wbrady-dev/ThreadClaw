export class ClawCoreError extends Error {
  constructor(message: string, public code: string) {
    super(message);
    this.name = "ClawCoreError";
  }
}

export class ParseError extends ClawCoreError {
  constructor(message: string, public filePath?: string) {
    super(message, "PARSE_ERROR");
    this.name = "ParseError";
  }
}

export class EmbeddingError extends ClawCoreError {
  constructor(message: string) {
    super(message, "EMBEDDING_ERROR");
    this.name = "EmbeddingError";
  }
}
