/** Thrown for errors retrying can't fix (e.g. an auth/config problem) - withRetry gives up immediately instead of wasting attempts. */
export class NonRetryableError extends Error {}

/**
 * Retries a network-dependent step a few times with backoff before giving up.
 * Meant for the steps that actually need the internet (downloading, transcription,
 * highlight selection) - a brief connection drop shouldn't fail the whole job.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    attempts?: number;
    baseDelayMs?: number;
    onRetry?: (attempt: number, err: unknown) => void | Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 2000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt === attempts || err instanceof NonRetryableError) break;
      await options.onRetry?.(attempt, err);
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}
