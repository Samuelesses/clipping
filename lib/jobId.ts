const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Job ids are crypto.randomUUID() values - validate before using one to build a filesystem path. */
export function isValidJobId(value: string): boolean {
  return UUID_RE.test(value);
}
