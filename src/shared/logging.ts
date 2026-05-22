export function log(scope: string, message: string, extra?: Record<string, unknown>): void {
  const payload = {
    ts: new Date().toISOString(),
    scope,
    message,
    ...extra,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

export function logError(scope: string, message: string, error: unknown, extra?: Record<string, unknown>): void {
  const normalized =
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { error };
  log(scope, message, { ...extra, ...normalized });
}
