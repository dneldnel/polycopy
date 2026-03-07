export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export interface LogEntry {
  ts: string;
  level: "info" | "warn" | "error";
  event: string;
  fields: Record<string, unknown>;
}

export interface CreateLoggerOptions {
  silent?: boolean;
  onWrite?: (entry: LogEntry) => void;
}

function write(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> | undefined,
  options: CreateLoggerOptions
): void {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    event,
    fields: fields ?? {},
  };

  options.onWrite?.(entry);
  if (options.silent) {
    return;
  }

  const line = JSON.stringify({
    ts: entry.ts,
    level,
    event,
    ...entry.fields,
  });

  if (level === "error") {
    process.stderr.write(`${line}\n`);
    return;
  }

  process.stdout.write(`${line}\n`);
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  return {
    info(event, fields) {
      write("info", event, fields, options);
    },
    warn(event, fields) {
      write("warn", event, fields, options);
    },
    error(event, fields) {
      write("error", event, fields, options);
    },
  };
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "unknown_error";
}
