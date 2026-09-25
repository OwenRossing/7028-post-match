import { describe, expect, it } from 'vitest';
import { fmtDuration } from '../src/lib/time';

describe('fmtDuration', () => {
  it('formats minutes and seconds', () => {
    expect(fmtDuration(0, 0)).toBe('0:00');
    expect(fmtDuration(65.25, 2)).toBe('1:05.25');
    expect(fmtDuration(-3, 2)).toBe('-0:03.00');
    expect(fmtDuration(3725, 0)).toBe('1:02:05');
  });

  it('carries into the minute when seconds round up to 60', () => {
    // axis ticks land a hair under the minute after float math
    expect(fmtDuration(59.99999, 0)).toBe('1:00');
    expect(fmtDuration(119.9999999, 0)).toBe('2:00');
    expect(fmtDuration(59.996, 2)).toBe('1:00.00');
    expect(fmtDuration(3599.9999, 0)).toBe('1:00:00');
  });

  it('never prints a negative zero', () => {
    expect(fmtDuration(-0.001, 2)).toBe('0:00.00');
  });
});
