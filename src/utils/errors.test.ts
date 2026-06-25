import { describe, it, expect } from 'bun:test';
import { formatError, toErrorWithCause } from './errors';

describe('formatError', () => {
  it('formats Error objects with custom name', () => {
    expect(formatError(new TypeError('bad type'))).toBe('TypeError: bad type');
  });

  it('formats generic Error without name prefix', () => {
    expect(formatError(new Error('oops'))).toBe('oops');
  });

  it('formats Error with empty name', () => {
    const e = new Error('msg');
    e.name = '';
    expect(formatError(e)).toBe('msg');
  });

  it('formats string directly', () => {
    expect(formatError('fail')).toBe('fail');
  });

  it('formats number', () => {
    expect(formatError(42)).toBe('42');
  });

  it('formats boolean', () => {
    expect(formatError(true)).toBe('true');
    expect(formatError(false)).toBe('false');
  });

  it('formats null', () => {
    expect(formatError(null)).toBe('Unknown error (null)');
  });

  it('formats undefined', () => {
    expect(formatError(undefined)).toBe('Unknown error (undefined)');
  });

  it('formats plain object via JSON', () => {
    expect(formatError({ code: 'ENOENT' })).toBe('{"code":"ENOENT"}');
  });

  it('handles circular reference', () => {
    const obj: any = {};
    obj.self = obj;
    expect(formatError(obj)).toBe('[unserializable object]');
  });

  it('formats AggregateError', () => {
    const agg = new AggregateError([new Error('a'), 'b'], 'multi fail');
    const result = formatError(agg);
    expect(result).toContain('AggregateError: multi fail');
    expect(result).toContain('a');
    expect(result).toContain('b');
  });

  it('formats custom Error subclass', () => {
    class AppError extends Error {
      constructor(m: string) {
        super(m);
        this.name = 'AppError';
      }
    }
    expect(formatError(new AppError('boom'))).toBe('AppError: boom');
  });

  it('formats bigint', () => {
    expect(formatError(BigInt(123))).toBe('123');
  });
});

describe('toErrorWithCause', () => {
  it('wraps Error as cause', () => {
    const original = new Error('original');
    const wrapped = toErrorWithCause(original, 'wrapper');
    expect(wrapped.message).toBe('wrapper');
    expect(wrapped.cause).toBe(original);
  });

  it('wraps non-Error as Error cause', () => {
    const wrapped = toErrorWithCause('string error', 'wrapper');
    expect(wrapped.message).toBe('wrapper');
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect((wrapped.cause as Error).message).toBe('string error');
  });

  it('wraps null', () => {
    const wrapped = toErrorWithCause(null, 'wrapper');
    expect(wrapped.cause).toBeInstanceOf(Error);
    expect((wrapped.cause as Error).message).toBe('Unknown error (null)');
  });

  it('wraps undefined', () => {
    const wrapped = toErrorWithCause(undefined, 'wrapper');
    expect(wrapped.cause).toBeInstanceOf(Error);
  });
});
