/**
 * Unified error formatting and wrapping utilities.
 */

import { log } from './logger';

/**
 * Convert any thrown value into a human-readable string.
 */
export function formatError(err: unknown): string {
  if (err === null) return 'Unknown error (null)';
  if (err === undefined) return 'Unknown error (undefined)';

  if (err instanceof Error) {
    if (err instanceof AggregateError) {
      const inner = err.errors.map((e) => formatError(e)).join('; ');
      return `${err.name}: ${err.message} [${inner}]`;
    }
    if (err.name && err.name !== 'Error') {
      return `${err.name}: ${err.message}`;
    }
    return err.message;
  }

  if (typeof err === 'string') return err;
  if (typeof err === 'number' || typeof err === 'boolean' || typeof err === 'bigint') {
    return String(err);
  }

  if (typeof err === 'object') {
    try {
      return JSON.stringify(err);
    } catch {
      return '[unserializable object]';
    }
  }

  return String(err);
}

/**
 * Wrap any thrown value into a proper Error with a cause chain.
 */
export function toErrorWithCause(err: unknown, message: string): Error {
  const cause = err instanceof Error ? err : new Error(formatError(err));
  return new Error(message, { cause });
}

/**
 * Structured error logging that preserves message, stack, and optional context.
 */
export function logError(
  prefix: string,
  message: string,
  err: unknown,
  context?: Record<string, unknown>,
): void {
  const formatted = formatError(err);
  const stack = err instanceof Error ? err.stack : undefined;

  const data: Record<string, unknown> = {
    error: formatted,
    ...(stack !== undefined && { stack }),
    ...context,
  };

  log(`${prefix} ${message}`, data);
}
