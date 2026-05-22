'use strict';

// Lightweight retry wrapper for transient network / rate-limit errors.
//
// Usage:
//   const result = await withRetry(() => graphClient.api('/...').get());
//
// Retries up to `maxAttempts` times with exponential back-off starting at
// `baseDelayMs`. Only retries when `isTransientError(err)` returns true —
// auth failures (401/403) and client errors (400, 404) are thrown immediately.

/**
 * Calls `fn` and retries on transient errors with exponential back-off.
 *
 * @param {() => Promise<any>} fn           Async function to attempt
 * @param {number}             maxAttempts  Total attempts (default 3)
 * @param {number}             baseDelayMs  Initial delay in ms (doubles each retry; default 1000)
 * @returns {Promise<any>}
 * @throws  The last error if all attempts are exhausted, or any non-transient error immediately
 */
async function withRetry(fn, maxAttempts = 3, baseDelayMs = 1000) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;

      // Don't retry on non-transient errors (auth failures, bad requests, etc.)
      if (!isTransientError(err)) throw err;

      // Don't wait after the last attempt — just throw
      if (attempt === maxAttempts) throw err;

      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(delay);
      console.warn(`[retryHelper] Attempt ${attempt} failed (${err.message}); retrying in ${delay}ms…`);
    }
  }
  throw lastErr; // unreachable, but satisfies linters
}

/**
 * Returns true for errors that are likely transient and worth retrying:
 *   • HTTP 429 (rate limited)
 *   • HTTP 502 / 503 / 504 (gateway / service unavailable)
 *   • Node network errors: ECONNRESET, ETIMEDOUT, ENOTFOUND
 */
function isTransientError(err) {
  const status = err.statusCode ?? err.status;
  if (status === 429 || status === 502 || status === 503 || status === 504) return true;

  const code = (err.code || '').toUpperCase();
  if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'ENOTFOUND') return true;

  // Some Graph SDK errors embed the status in the message
  const msg = (err.message || '').toLowerCase();
  if (msg.includes('econnreset') || msg.includes('etimedout')) return true;

  return false;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { withRetry, isTransientError };
