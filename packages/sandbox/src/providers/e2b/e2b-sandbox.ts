import {
  AuthenticationError,
  CommandExitError,
  FileNotFoundError,
  InvalidArgumentError,
  RateLimitError,
  Sandbox as E2B,
  SandboxError as E2BError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  SandboxUnreachableError,
  TimeoutError,
} from "e2b";
import {
  SandboxBusyError,
  SandboxCreateError,
  SandboxError,
  SandboxFileError,
  SandboxGoneError,
  SandboxUnavailableError,
} from "../../core/errors.js";
import {
  DEFAULT_EXEC_TIMEOUT_MS,
  KILL_GRACE_SECONDS,
  MAX_EXEC_TIMEOUT_MS,
  MAX_READ_FILE_BYTES,
} from "../../core/limits.js";
import {
  WORKSPACE_DIR,
  type E2BConnection,
  type ExecOptions,
  type ExecResult,
  type FileEntry,
  type ListFilesOptions,
  type Sandbox,
  type SandboxLabels,
} from "../../core/types.js";
import { CappedBuffer } from "../../lib/capped-buffer.js";
import { findArgs, parseFindOutput } from "../../lib/find-files.js";
import { MAX_OUTPUT_BYTES } from "../../lib/run-process.js";
import { shellQuote } from "../../lib/shell-quote.js";
import { resolveInWorkspace } from "../../lib/workspace.js";
import {
  CREATE_TIMEOUT_MS,
  DEFAULT_TEMPLATE,
  FILE_TIMEOUT_MS,
  LIFETIME_MS,
  SANDBOX_ENV,
  SANDBOX_METADATA,
  SDK_TIMEOUT_MARGIN_MS,
} from "./constants.js";

type CommandOutput = { exitCode: number; stdout: string; stderr: string };

/** The part of an E2B sandbox this provider uses. */
export type RemoteSandbox = {
  sandboxId: string;
  commands: {
    run(
      command: string,
      options: {
        cwd: string;
        envs?: Record<string, string>;
        timeoutMs: number;
      },
    ): Promise<CommandOutput>;
  };
  files: {
    read(
      path: string,
      options: { format: "bytes"; requestTimeoutMs?: number },
    ): Promise<Uint8Array>;
    write(
      path: string,
      data: string,
      options?: { requestTimeoutMs?: number },
    ): Promise<unknown>;
  };
  kill(): Promise<boolean>;
};

export type E2BClient = {
  create(
    template: string,
    options: {
      apiKey?: string;
      metadata: Record<string, string>;
      envs: Record<string, string>;
      timeoutMs: number;
      requestTimeoutMs: number;
    },
  ): Promise<RemoteSandbox>;
  connect(id: string, options: { apiKey?: string }): Promise<RemoteSandbox>;
};

export type E2BSandboxOptions = Partial<E2BConnection> & {
  /** Without one, the E2B SDK is used with the connection, or E2B_API_KEY. */
  client?: E2BClient;
  template?: string;
  labels?: SandboxLabels;
};

const sdkClient: E2BClient = {
  create: (template, options) => E2B.create(template, options),
  connect: (id, options) => E2B.connect(id, options),
};

const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

// E2B's "sandbox gone" and "unreachable" errors are TimeoutErrors too.
const isCommandTimeout = (error: unknown) =>
  error instanceof TimeoutError &&
  !(error instanceof SandboxNotRunningError) &&
  !(error instanceof SandboxUnreachableError);

function capped(text: string) {
  const buffer = new CappedBuffer(MAX_OUTPUT_BYTES);
  buffer.push(Buffer.from(text));
  return { text: buffer.toString(), truncated: buffer.truncated };
}

export class E2BSandbox implements Sandbox {
  private destroyed = false;

  private constructor(private readonly remote: RemoteSandbox) {}

  get id() {
    return this.remote.sandboxId;
  }

  static async create(options: E2BSandboxOptions = {}): Promise<E2BSandbox> {
    const client = options.client ?? sdkClient;
    try {
      const remote = await client.create(options.template ?? DEFAULT_TEMPLATE, {
        apiKey: options.apiKey,
        metadata: { ...SANDBOX_METADATA, ...options.labels },
        envs: SANDBOX_ENV,
        timeoutMs: LIFETIME_MS,
        requestTimeoutMs: CREATE_TIMEOUT_MS,
      });
      return new E2BSandbox(remote);
    } catch (error) {
      if (error instanceof AuthenticationError) {
        throw new SandboxUnavailableError(
          `E2B rejected the API key: ${error.message}`,
        );
      }
      // Also how E2B refuses a sandbox past the account's concurrency limit.
      if (error instanceof RateLimitError) {
        throw new SandboxBusyError(
          `E2B has no room for another sandbox: ${error.message}`,
        );
      }
      throw new SandboxCreateError(
        `Failed to create an E2B sandbox: ${messageOf(error)}`,
      );
    }
  }

  static async connect(
    id: string,
    options: E2BSandboxOptions = {},
  ): Promise<E2BSandbox | null> {
    const client = options.client ?? sdkClient;
    try {
      return new E2BSandbox(
        await client.connect(id, { apiKey: options.apiKey }),
      );
    } catch (error) {
      if (error instanceof SandboxNotFoundError) return null;
      throw error;
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertAlive();
    const timeoutMs = Math.min(
      options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS,
      MAX_EXEC_TIMEOUT_MS,
    );
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));

    const started = Date.now();
    let output: CommandOutput;
    try {
      output = await this.remote.commands.run(
        `timeout -k ${KILL_GRACE_SECONDS}s ${timeoutSeconds}s bash -lc ${shellQuote(command)}`,
        {
          cwd: options.cwd ? resolveInWorkspace(options.cwd) : WORKSPACE_DIR,
          envs: options.env,
          timeoutMs:
            timeoutSeconds * 1000 +
            KILL_GRACE_SECONDS * 1000 +
            SDK_TIMEOUT_MARGIN_MS,
        },
      );
    } catch (error) {
      // A command that exits non-zero is an error to E2B, a result to us.
      if (error instanceof CommandExitError) {
        output = error;
      } else if (isCommandTimeout(error)) {
        return {
          exitCode: -1,
          stdout: "",
          stderr: `Timed out after ${timeoutSeconds}s`,
          timedOut: true,
          truncated: false,
        };
      } else if (error instanceof InvalidArgumentError) {
        // E2B refuses a working directory that doesn't exist.
        return {
          exitCode: 1,
          stdout: "",
          stderr: error.message,
          timedOut: false,
          truncated: false,
        };
      } else {
        throw this.translate(error);
      }
    }

    const stdout = capped(output.stdout);
    const stderr = capped(output.stderr);
    const elapsed = Date.now() - started;
    return {
      exitCode: output.exitCode,
      stdout: stdout.text,
      stderr: stderr.text,
      timedOut:
        output.exitCode === 124 ||
        (output.exitCode === 137 && elapsed >= timeoutMs),
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  async readFile(filePath: string): Promise<string> {
    this.assertAlive();
    const abs = resolveInWorkspace(filePath);
    let content: Uint8Array;
    try {
      content = await this.remote.files.read(abs, {
        format: "bytes",
        requestTimeoutMs: FILE_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.translate(error, abs);
    }
    // Refuse rather than truncate: an edit written back from partial content would corrupt the file.
    if (content.length > MAX_READ_FILE_BYTES) {
      throw new SandboxFileError(
        `${abs} is larger than ${MAX_READ_FILE_BYTES} bytes`,
        abs,
      );
    }
    return Buffer.from(content).toString("utf8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    this.assertAlive();
    const abs = resolveInWorkspace(filePath);
    try {
      await this.remote.files.write(abs, content, {
        requestTimeoutMs: FILE_TIMEOUT_MS,
      });
    } catch (error) {
      throw this.translate(error, abs);
    }
  }

  async listFiles(
    dirPath: string,
    options: ListFilesOptions = {},
  ): Promise<FileEntry[]> {
    const abs = resolveInWorkspace(dirPath);
    const find = ["find", ...findArgs(abs, options.maxDepth ?? 2)]
      .map(shellQuote)
      .join(" ");
    const result = await this.exec(find);
    if (result.exitCode !== 0) {
      throw new SandboxFileError(
        result.stderr.trim() || `Cannot list ${abs}`,
        abs,
      );
    }
    return parseFindOutput(result.stdout);
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      // false when it's already gone, which is fine.
      await this.remote.kill();
    } catch (error) {
      throw new SandboxError(
        `Failed to delete E2B sandbox ${this.id}: ${messageOf(error)}`,
      );
    }
  }

  private assertAlive() {
    if (this.destroyed) {
      throw new SandboxGoneError(`Sandbox ${this.id} has been destroyed`);
    }
  }

  private translate(error: unknown, filePath?: string): unknown {
    if (filePath && error instanceof FileNotFoundError) {
      return new SandboxFileError(`${filePath} doesn't exist`, filePath);
    }
    if (
      error instanceof SandboxNotRunningError ||
      error instanceof SandboxNotFoundError
    ) {
      this.destroyed = true;
      return new SandboxGoneError(`Sandbox ${this.id} no longer exists`);
    }
    if (filePath && error instanceof E2BError) {
      return new SandboxFileError(error.message, filePath);
    }
    return error;
  }
}
