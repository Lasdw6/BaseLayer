export function expiresAtFromNow(timeoutSec: number): string {
  return new Date(Date.now() + timeoutSec * 1000).toISOString();
}
