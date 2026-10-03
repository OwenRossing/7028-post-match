import { describe, expect, it } from 'vitest';
import { fmtDuration, fmtSpan } from '../src/lib/time';

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

describe('fmtSpan', () => {
  it('writes short spans in seconds, long ones in minutes and hours', () => {
    expect(fmtSpan(5)).toBe('5.0s');
    expect(fmtSpan(45.2)).toBe('45s');
    expect(fmtSpan(154)).toBe('2m 34s');
    expect(fmtSpan(3780)).toBe('1h 03m');
  });

  it('carries a rounded-up second into the next unit instead of writing 60', () => {
    expect(fmtSpan(599.99925)).toBe('10m 00s'); // a 10-minute log is not "9m 60s"
    expect(fmtSpan(59.6)).toBe('1m 00s');
    expect(fmtSpan(3599.7)).toBe('1h 00m');
  });
});
