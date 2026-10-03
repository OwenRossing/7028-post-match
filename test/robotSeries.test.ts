import { describe, expect, it } from 'vitest';
import { extractRobotSignals, motorCurrent, resample, splitName } from '../src/lib/robotSeries';
import { parseWPILog, type WPILogSeries } from '../src/lib/wpilog';
import { WPILogWriter } from './helpers/wpilog-writer';

const series = (pairs: [number, number][]): WPILogSeries => ({ t: Float64Array.from(pairs.map((p) => p[0])), v: Float64Array.from(pairs.map((p) => p[1])) });

describe('which signals are motor currents', () => {
  it('finds Phoenix, REV and power distribution currents and names the motor', () => {
    expect(motorCurrent('Phoenix6/TalonFX-1/StatorCurrent')).toMatchObject({ group: 'Phoenix6/TalonFX-1', label: 'TalonFX 1 · Stator' });
    expect(motorCurrent('Phoenix6/TalonFX-12/SupplyCurrent')?.label).toBe('TalonFX 12 · Supply');
    expect(motorCurrent('NT:/Robot/Shooter/OutputCurrent')?.label).toBe('Shooter · Output');
    expect(motorCurrent('/Drive/FrontLeft/CurrentAmps')?.label).toBe('FrontLeft');
    expect(motorCurrent('PowerDistribution/ChannelCurrent[3]')?.label).toBe('PowerDistribution ch 3');
  });

  it('leaves out limits, settings, totals and everything that is not a current', () => {
    for (const n of [
      'Phoenix6/TalonFX-1/StatorCurrentLimit',
      'Phoenix6/TalonFX-1/SupplyCurrentLimitEnable',
      'Phoenix6/TalonFX-1/Position',
      'Phoenix6/TalonFX-1/SupplyVoltage',
      'PowerDistribution/TotalCurrent',
      'Robot/TotalCurrent',
      'SystemStats/BatteryVoltage',
      'Shooter/CurrentSetpoint',
      'Shooter/MaxCurrent',
    ])
      expect(motorCurrent(n), n).toBeNull();
  });

  it('splits a name into the device and the signal', () => {
    expect(splitName('NT:/Robot/Shooter/OutputCurrent')).toEqual({ group: 'Robot/Shooter', short: 'OutputCurrent' });
    expect(splitName('systemTime')).toEqual({ group: 'Other', short: 'systemTime' });
  });
});

describe('putting a robot signal on the Driver Station grid', () => {
  // the DS log has 50 records a second; record i covers DS time [i*0.02, (i+1)*0.02)
  it('moves it by the offset: DS time = robot time + offset', () => {
    const s = series([[1.0, 5], [1.5, 6]]);
    const out = resample(s, 2, 400, 0.02, 'mean'); // robot 1.0 s is DS 3.0 s: record 150
    expect(out[149]).toBeNaN();
    expect(out[150]).toBe(5);
    expect(out[175]).toBe(6); // robot 1.5 s is DS 3.5 s
    expect(resample(s, -0.5, 400, 0.02, 'mean')[25]).toBe(5); // a negative offset moves it earlier
  });

  it('keeps a spike in a current, but averages anything else', () => {
    // 250 Hz samples: five land in each 20 ms record, one of them a 200 A spike
    const pairs: [number, number][] = [];
    for (let k = 0; k < 50; k++) pairs.push([k * 0.004, k % 5 === 2 ? 200 : 10]);
    const s = series(pairs);
    expect(resample(s, 0, 10, 0.02, 'peak')[0]).toBe(200);
    expect(resample(s, 0, 10, 0.02, 'mean')[0]).toBeCloseTo((200 + 40) / 5, 6);
    // the biggest swing counts, whichever way it goes (regenerating current is negative)
    expect(resample(series([[0, 5], [0.004, -80], [0.008, 20]]), 0, 2, 0.02, 'peak')[0]).toBe(-80);
  });

  it('holds the last value between slow samples, and has none before the first or after the last', () => {
    const out = resample(series([[0.1, 1], [0.5, 2]]), 0, 50, 0.02, 'mean'); // 2 samples a second apart is a slow signal
    expect(out[4]).toBeNaN(); // before the first
    expect(out[5]).toBe(1);
    expect(out[20]).toBe(1); // held
    expect(out[25]).toBe(2);
    expect(out[26]).toBeNaN(); // the signal's last record is at 0.5 s (record 25): nothing after it
    expect(out[40]).toBeNaN();
  });

  it('ignores samples outside the match and returns all NaN when nothing falls inside', () => {
    const out = resample(series([[100, 1], [101, 2]]), 0, 50, 0.02, 'mean');
    expect(out.every((v) => Number.isNaN(v))).toBe(true);
    expect(resample(series([]), 0, 10, 0.02, 'mean')).toHaveLength(10);
  });
});

describe('reading a robot log into signals', () => {
  function log() {
    const w = new WPILogWriter();
    const a = w.start('Phoenix6/TalonFX-1/StatorCurrent', 'double');
    const b = w.start('Phoenix6/TalonFX-2/StatorCurrent', 'double');
    const pos = w.start('Phoenix6/TalonFX-1/Position', 'double');
    const pd = w.start('PowerDistribution/ChannelCurrent', 'double[]');
    const sys = w.start('systemTime', 'int64');
    const label = w.start('Notes', 'string');
    for (let k = 0; k <= 5000; k++) {
      const t = k * 0.004;
      w.double(a, t, t >= 4 && t < 4.004 ? 180 : 20);
      w.double(b, t, 0);
      w.double(pos, t, t);
      if (k % 25 === 0) {
        w.doubles(pd, t, [1, 2, t > 10 ? 40 : 3, 0]);
        w.int64(sys, t, 1_780_000_000_000_000 + t * 1e6);
        w.string(label, t, 'x');
      }
    }
    return w.bytes();
  }

  it('lists currents first, each motor on its own, with array elements as channels, and skips what is not a signal', () => {
    // robot time 0 is DS time 5 s: the grid starts 5 s into the robot log's own time
    const out = extractRobotSignals(log(), 'FRC.wpilog', 5, 1500, 0.02);
    const names = out.map((s) => s.name);
    expect(names.slice(0, 6).sort()).toEqual([
      'Phoenix6/TalonFX-1/StatorCurrent',
      'Phoenix6/TalonFX-2/StatorCurrent',
      'PowerDistribution/ChannelCurrent[0]',
      'PowerDistribution/ChannelCurrent[1]',
      'PowerDistribution/ChannelCurrent[2]',
      'PowerDistribution/ChannelCurrent[3]',
    ]);
    expect(out.slice(0, 6).every((s) => s.kind === 'current')).toBe(true);
    expect(names).toContain('Phoenix6/TalonFX-1/Position');
    expect(out.find((s) => s.name === 'Phoenix6/TalonFX-1/Position')!.kind).toBe('other');
    expect(names).not.toContain('systemTime'); // not something to graph
    expect(names).not.toContain('Notes'); // text
    expect(out.find((s) => s.name === 'PowerDistribution/ChannelCurrent[2]')!.label).toBe('PowerDistribution ch 2');
  });

  it('puts a spike where it happened on the match timeline and keeps it', () => {
    const out = extractRobotSignals(log(), 'FRC.wpilog', 5, 1500, 0.02);
    const a = out.find((s) => s.name === 'Phoenix6/TalonFX-1/StatorCurrent')!;
    // robot 4.0 s is DS 9.0 s: record 450
    expect(a.arr[450]).toBe(180);
    expect(a.arr[449]).toBe(20);
    expect(a.arr[0]).toBeNaN(); // the DS log began before the robot log did
    const idle = out.find((s) => s.name === 'Phoenix6/TalonFX-2/StatorCurrent')!;
    expect(Math.max(...idle.arr.filter((v) => !Number.isNaN(v)))).toBe(0); // a motor that did nothing is still listed, at zero
    const ch2 = out.find((s) => s.name === 'PowerDistribution/ChannelCurrent[2]')!;
    expect(ch2.arr[Math.round(16 / 0.02)]).toBe(40); // robot 11 s is DS 16 s
  });

  it('leaves out signals that never fall inside the match', () => {
    const out = extractRobotSignals(log(), 'FRC.wpilog', 1000, 1500, 0.02); // lined up a thousand seconds away
    expect(out).toEqual([]);
  });

  it('stores arrays only when asked, so ordinary parsing is unchanged', () => {
    expect(parseWPILog(log()).series.has('PowerDistribution/ChannelCurrent[0]')).toBe(false);
    expect(parseWPILog(log(), { arrays: true }).series.get('PowerDistribution/ChannelCurrent[2]')!.v.at(-1)).toBe(40);
  });
});
