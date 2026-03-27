export class ThreadClawError extends Error {
  constructor(message: string, public code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ThreadClawError";
    // Restore prototype chain broken by extending built-in Error
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ParseError extends ThreadClawError {
  constructor(message: string, public filePath?: string, options?: { cause?: unknown }) {
    // Include filePath in message for better diagnostics
    const fullMessage = filePath ? `${message} (file: ${filePath})` : message;
    super(fullMessage, "PARSE_ERROR", options);
    this.name = "ParseError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class EmbeddingError extends ThreadClawError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "EMBEDDING_ERROR", options);
    this.name = "EmbeddingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
