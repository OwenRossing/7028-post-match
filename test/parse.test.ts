import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseDSLog } from '../src/lib/dslog';
import { parseDSEvents } from '../src/lib/dsevents';
import { analyze, computeStats, findProblems, summarize } from '../src/lib/analysis';

const dir = new URL('../public/sample/', import.meta.url);
const load = (ext: string) => new Uint8Array(readFileSync(new URL(`2026_05_16%2011_38_21%20Sat.${ext}`, dir)));

describe('sample log (MNST Qualification 22)', () => {
  const log = parseDSLog(load('dslog'));
  const events = parseDSEvents(load('dsevents'), log.startTime);
  const analysis = analyze(log, events);

  it('reads the header and every record', () => {
    expect(log.version).toBe(4);
    expect(new Date(Math.floor(log.startTime) * 1000).toISOString()).toBe('2026-05-16T16:38:21.000Z');
    expect(log.count).toBe(13710);
    expect(log.truncated).toBe(false);
    expect(log.pdType).toBe('rev');
    expect(log.channelCount).toBe(24);
  });

  it('decodes plausible telemetry', () => {
    const v = Array.from(log.voltage).filter((x) => !Number.isNaN(x));
    expect(Math.max(...v)).toBeLessThan(20);
    expect(Math.min(...v)).toBeGreaterThan(5);
    const total = Array.from(log.totalCurrent).filter((x) => !Number.isNaN(x));
    expect(Math.max(...total)).toBeGreaterThan(10);
    expect(Math.max(...total)).toBeLessThan(700);
  });

  it('finds the match and its periods', () => {
    expect(analysis.match?.label).toBe('Qualification 22');
    expect(analysis.match!.autoTime).toBeGreaterThan(19.5);
    expect(analysis.match!.autoTime).toBeLessThan(21.5);
    expect(analysis.match!.teleopTime).toBeGreaterThan(130);
  });

  it('extracts event metadata', () => {
    expect(events.meta.eventName).toBe('MNST');
    expect(events.meta.team).toBe(7028);
    expect(events.meta.dsVersion).toBe('26.0');
    expect(events.meta.robotLanguage).toBe('Java');
    expect(events.meta.joysticks.length).toBeGreaterThanOrEqual(3);
    expect(events.meta.railFaults.at(-1)?.value.v12).toBe(9);
    expect(events.events.filter((e) => e.kind === 'error').length).toBeGreaterThan(10);
  });

  it('flags the real problems', () => {
    const stats = computeStats(log, events, analysis, analysis.focus);
    const problems = findProblems(log, events, analysis, stats);
    const ids = problems.map((p) => p.id);
    expect(ids).toContain('rail-v12');
    expect(ids).toContain('loop');
    expect(ids).toContain('can-devices');
    expect(ids).toContain('comms-enabled');
    expect(ids).toContain('code-stall');
    expect(ids).toContain('radio-fw');
    expect(ids).not.toContain('brownout');
    expect(analysis.loopCulprits.find((c) => !c.framework)?.name).toBe('IntakeSubsytem.periodic()');
  });

  it('puts the most urgent finding first and says what to check for every one that matters', () => {
    const stats = computeStats(log, events, analysis, analysis.focus);
    const problems = findProblems(log, events, analysis, stats);
    const sev = problems.map((p) => p.severity);
    expect([...sev].sort((a, b) => ['bad', 'warn', 'info'].indexOf(a) - ['bad', 'warn', 'info'].indexOf(b))).toEqual(sev);
    // losing the robot mid-match outranks a voltage dip that never became a brownout
    expect(problems[0].id).toBe('comms-enabled');
    expect(problems.findIndex((p) => p.id === 'rail-v12')).toBeLessThan(problems.findIndex((p) => p.id === 'volt-low'));
    for (const p of problems.filter((x) => x.severity !== 'info')) {
      expect(p.fix, p.id).toBeTruthy();
      // advice lives in `fix`, not mixed into the description ('errors'/'crash' quote the robot's own message text)
      if (p.id !== 'errors' && p.id !== 'crash') expect(p.detail, p.id).not.toMatch(/\bCheck\b/);
    }
  });

  it('summarizes for the library', () => {
    const s = summarize(log, events);
    expect(s).toMatchObject({ isMatch: true, fms: true, team: 7028, eventName: 'MNST', matchNumber: 22, verdict: 'bad' });
    expect(s.minVoltage).toBeLessThan(6.5);
  });
});
