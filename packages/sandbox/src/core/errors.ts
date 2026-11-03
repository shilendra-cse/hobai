export class SandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class SandboxUnavailableError extends SandboxError {}

export class SandboxCreateError extends SandboxError {}

/** The provider has no room for another sandbox right now (a quota or rate limit); trying later can work. */
export class SandboxBusyError extends SandboxCreateError {}

export class SandboxGoneError extends SandboxError {}

export class SandboxFileError extends SandboxError {
  constructor(
    message: string,
    public readonly path: string,
  ) {
    super(message);
  }
}
