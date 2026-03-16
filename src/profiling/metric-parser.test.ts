/**
 * Unit tests for metric-parser — the pure-logic core of the profiling module.
 *
 * Tests cover parsing of:
 *   • xctrace Time Profiler XML export
 *   • xctrace Allocations XML export
 *   • adb dumpsys meminfo (compact format)
 *   • adb dumpsys meminfo (standard format)
 *   • adb dumpsys cpuinfo
 */

import {
  parseXctraceTimeProfle,
  parseXctraceAllocations,
  parseDumpsysMeminfo,
  parseDumpsysCpuinfo,
  parseDumpsysMeminfoStandard,
  aggregateSamples,
  parseXctraceLaunchTime,
  parseProcStat,
  parseProcStatus,
  parseAmStartOutput,
} from './metric-parser.js';

// ── xctrace Time Profiler ──

describe('parseXctraceTimeProfle', () => {
  it('should extract CPU weight from xctrace id/ref format', () => {
    // Real xctrace format: weight defined once with id, then referenced
    const xml = `
      <trace-query-result>
        <node xpath="//data/table[@schema='time-profile']">
          <row><weight id="9" fmt="1.00 ms">1000000</weight></row>
          <row><weight ref="9"/></row>
          <row><weight ref="9"/></row>
          <row><weight ref="9"/></row>
        </node>
      </trace-query-result>
    `;

    const result = parseXctraceTimeProfle(xml);
    expect(result.platform).toBe('ios');
    // 4 samples × 1,000,000 ns = 4,000,000 ns → 4,000 µs
    expect(result.cpuUsagePercent).toBe(4000);
  });

  it('should handle multiple weight definitions with different values', () => {
    const xml = `
      <trace-query-result>
        <node xpath="//data/table[@schema='time-profile']">
          <row><weight id="5" fmt="1.00 ms">1000000</weight></row>
          <row><weight ref="5"/></row>
          <row><weight id="10" fmt="2.00 ms">2000000</weight></row>
          <row><weight ref="10"/></row>
        </node>
      </trace-query-result>
    `;

    const result = parseXctraceTimeProfle(xml);
    // id=5: 1,000,000 (def) + 1,000,000 (ref) = 2,000,000
    // id=10: 2,000,000 (def) + 2,000,000 (ref) = 4,000,000
    // Total: 6,000,000 ns → 6,000 µs
    expect(result.cpuUsagePercent).toBe(6000);
  });

  it('should handle legacy inline format (no id/ref)', () => {
    const xml = `
      <trace-query-result>
        <node xpath="//data/table[@schema='time-profile']">
          <row><weight>5000000</weight></row>
          <row><weight>3000000</weight></row>
        </node>
      </trace-query-result>
    `;

    const result = parseXctraceTimeProfle(xml);
    // 5,000,000 + 3,000,000 = 8,000,000 ns → 8,000 µs
    expect(result.cpuUsagePercent).toBe(8000);
  });

  it('should return undefined cpuUsagePercent for empty XML', () => {
    const result = parseXctraceTimeProfle('<trace-query-result></trace-query-result>');
    expect(result.platform).toBe('ios');
    expect(result.cpuUsagePercent).toBeUndefined();
  });

  it('should handle malformed XML gracefully', () => {
    const result = parseXctraceTimeProfle('not valid xml at all');
    expect(result.platform).toBe('ios');
    expect(result.cpuUsagePercent).toBeUndefined();
  });
});

// ── xctrace Allocations ──

describe('parseXctraceAllocations', () => {
  it('should extract peak memory from total-bytes element', () => {
    const xml = `
      <trace-query-result>
        <node xpath="//data/table[@schema='allocations']">
          <total-bytes>52428800</total-bytes>
        </node>
      </trace-query-result>
    `;

    const result = parseXctraceAllocations(xml);
    expect(result.platform).toBe('ios');
    // 52428800 bytes = 50 MB
    expect(result.peakMemoryMb).toBe(50);
  });

  it('should fall back to size elements if total-bytes is missing', () => {
    const xml = `
      <trace-query-result>
        <row><size>10485760</size></row>
        <row><size>20971520</size></row>
        <row><size>5242880</size></row>
      </trace-query-result>
    `;

    const result = parseXctraceAllocations(xml);
    expect(result.platform).toBe('ios');
    // Max size: 20971520 bytes = 20 MB
    expect(result.peakMemoryMb).toBe(20);
  });

  it('should return undefined for empty XML', () => {
    const result = parseXctraceAllocations('<empty/>');
    expect(result.peakMemoryMb).toBeUndefined();
  });
});

// ── dumpsys meminfo (compact) ──

describe('parseDumpsysMeminfo', () => {
  it('should extract TOTAL PSS from compact format', () => {
    const output = [
      'proc,N/A,com.example.app,12345',
      'Native Heap,8192,4096,0,0,0,0,16384',
      'Dalvik Heap,4096,2048,0,0,0,0,8192',
      'TOTAL,51200,6144,0,0,0,0,24576',
    ].join('\n');

    const result = parseDumpsysMeminfo(output, 'com.example.app');
    expect(result.platform).toBe('android');
    // 51200 KB = 50 MB
    expect(result.memoryFootprintMb).toBe(50);
  });

  it('should extract Native + Dalvik heap for peak memory', () => {
    const output = [
      'Native Heap,16384,8192,0,0,0,0,32768',
      'Dalvik Heap,8192,4096,0,0,0,0,16384',
      'TOTAL,51200,12288,0,0,0,0,49152',
    ].join('\n');

    const result = parseDumpsysMeminfo(output, 'com.example.app');
    // Native (16384) + Dalvik (8192) = 24576 KB = 24 MB
    expect(result.peakMemoryMb).toBe(24);
  });

  it('should handle output with no TOTAL line', () => {
    const output = 'proc,N/A,com.example.app,12345\nNative Heap,0,0,0';
    const result = parseDumpsysMeminfo(output, 'com.example.app');
    expect(result.memoryFootprintMb).toBeUndefined();
  });

  it('should handle empty output', () => {
    const result = parseDumpsysMeminfo('', 'com.example.app');
    expect(result.memoryFootprintMb).toBeUndefined();
    expect(result.peakMemoryMb).toBeUndefined();
  });
});

// ── dumpsys meminfo (standard) ──

describe('parseDumpsysMeminfoStandard', () => {
  it('should extract TOTAL from standard format with colon', () => {
    const output = [
      '** MEMINFO in pid 12345 [com.example.app] **',
      '                   Pss  Private  ...',
      '  Native Heap    8192     4096   ...',
      '  Dalvik Heap    4096     2048   ...',
      '  TOTAL:    51200     6144   ...',
    ].join('\n');

    const result = parseDumpsysMeminfoStandard(output, 'com.example.app');
    expect(result.memoryFootprintMb).toBe(50);
  });

  it('should extract TOTAL from standard format without colon', () => {
    const output = '  TOTAL    25600     3072     ...\n';
    const result = parseDumpsysMeminfoStandard(output, 'com.example.app');
    expect(result.memoryFootprintMb).toBe(25);
  });

  it('should handle empty output', () => {
    const result = parseDumpsysMeminfoStandard('', 'com.example.app');
    expect(result.memoryFootprintMb).toBeUndefined();
  });
});

// ── dumpsys cpuinfo ──

describe('parseDumpsysCpuinfo', () => {
  it('should extract CPU percentage for the target package', () => {
    const output = [
      '  3.2% 1000/system_server: 2.1% user + 1.1% kernel',
      '  12.5% 12345/com.example.app: 8.3% user + 4.2% kernel',
      '  0.8% 2000/com.other.app: 0.5% user + 0.3% kernel',
    ].join('\n');

    const result = parseDumpsysCpuinfo(output, 'com.example.app');
    expect(result.platform).toBe('android');
    expect(result.cpuUsagePercent).toBe(12.5);
  });

  it('should return undefined if package not found', () => {
    const output = '  3.2% 1000/system_server: 2.1% user + 1.1% kernel';
    const result = parseDumpsysCpuinfo(output, 'com.nonexistent.app');
    expect(result.cpuUsagePercent).toBeUndefined();
  });

  it('should handle empty output', () => {
    const result = parseDumpsysCpuinfo('', 'com.example.app');
    expect(result.cpuUsagePercent).toBeUndefined();
  });
});

// ── Lightweight sampling ──

describe('aggregateSamples', () => {
  it('should compute avg/peak CPU and peak/final memory', () => {
    const samples = [
      { timestamp: 1000, cpuPercent: 10, memoryRssKb: 102400 },
      { timestamp: 2000, cpuPercent: 30, memoryRssKb: 153600 },
      { timestamp: 3000, cpuPercent: 20, memoryRssKb: 128000 },
    ];

    const result = aggregateSamples(samples);
    // Avg CPU: (10 + 30 + 20) / 3 = 20
    expect(result.avgCpuPercent).toBe(20);
    // Peak CPU: 30
    expect(result.peakCpuPercent).toBe(30);
    // Peak RSS: 153600 KB = 150 MB
    expect(result.peakMemoryMb).toBe(150);
    // Final RSS: 128000 KB = 125 MB
    expect(result.finalMemoryMb).toBe(125);
  });

  it('should handle a single sample', () => {
    const samples = [
      { timestamp: 1000, cpuPercent: 42.5, memoryRssKb: 51200 },
    ];

    const result = aggregateSamples(samples);
    expect(result.avgCpuPercent).toBe(42.5);
    expect(result.peakCpuPercent).toBe(42.5);
    expect(result.peakMemoryMb).toBe(50);
    expect(result.finalMemoryMb).toBe(50);
  });

  it('should return empty metrics for no samples', () => {
    const result = aggregateSamples([]);
    expect(result.avgCpuPercent).toBeUndefined();
    expect(result.peakCpuPercent).toBeUndefined();
    expect(result.peakMemoryMb).toBeUndefined();
    expect(result.finalMemoryMb).toBeUndefined();
  });
});

// ── App Launch ──

describe('parseXctraceLaunchTime', () => {
  it('should extract duration from TOC XML', () => {
    const toc = `
      <trace-toc>
        <run number="1">
          <info><summary>
            <duration>2.345678</duration>
          </summary></info>
        </run>
      </trace-toc>
    `;
    const result = parseXctraceLaunchTime(toc);
    // 2.345678 seconds → 2346 ms (rounded)
    expect(result).toBe(2346);
  });

  it('should return undefined if duration is missing', () => {
    const toc = '<trace-toc><run><info></info></run></trace-toc>';
    expect(parseXctraceLaunchTime(toc)).toBeUndefined();
  });

  it('should return undefined for invalid duration', () => {
    const toc = '<duration>not-a-number</duration>';
    expect(parseXctraceLaunchTime(toc)).toBeUndefined();
  });
});

// ── /proc/stat parser ──

describe('parseProcStat', () => {
  it('should extract PID, utime, and stime from a real /proc/stat line', () => {
    // Real Android /proc/<pid>/stat format:
    // pid (comm) state ppid pgrp session tty_nr tpgid flags minflt cminflt majflt cmajflt utime stime ...
    const statLine =
      '12345 (com.example.app) S 1 12345 0 0 -1 4194304 1234 0 56 0 150 30 0 0 20 0 25 0 123456 987654321 12345 18446744073709551615 1 1 0 0 0 0 0 0 0 0 0 0 17 0 0 0 0 0 0';
    const result = parseProcStat(statLine);
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(12345);
    expect(result!.utime).toBe(150);
    expect(result!.stime).toBe(30);
  });

  it('should handle comm field with spaces', () => {
    const statLine =
      '999 (My App Name) R 1 999 0 0 -1 0 0 0 0 0 42 8 0 0 20 0 1 0 0 0 0 0 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0';
    const result = parseProcStat(statLine);
    expect(result).not.toBeNull();
    expect(result!.pid).toBe(999);
    expect(result!.utime).toBe(42);
    expect(result!.stime).toBe(8);
  });

  it('should return null for empty input', () => {
    expect(parseProcStat('')).toBeNull();
  });

  it('should return null for malformed input (no parentheses)', () => {
    expect(parseProcStat('12345 no_parens here')).toBeNull();
  });

  it('should return null if not enough fields after comm', () => {
    expect(parseProcStat('1 (app) S 1 1 0 0')).toBeNull();
  });
});

// ── /proc/status parser ──

describe('parseProcStatus', () => {
  it('should extract VmRSS from proc status output', () => {
    const status = [
      'Name:\tcom.example.app',
      'Umask:\t0077',
      'State:\tS (sleeping)',
      'Tgid:\t12345',
      'VmPeak:\t1234567 kB',
      'VmSize:\t1000000 kB',
      'VmRSS:\t  85432 kB',
      'VmData:\t  50000 kB',
    ].join('\n');

    const result = parseProcStatus(status);
    expect(result).toBe(85432);
  });

  it('should return null if VmRSS is not present', () => {
    const status = 'Name:\tapp\nState:\tS\n';
    expect(parseProcStatus(status)).toBeNull();
  });

  it('should return null for empty input', () => {
    expect(parseProcStatus('')).toBeNull();
  });
});

// ── am start -W parser ──

describe('parseAmStartOutput', () => {
  it('should extract TotalTime from am start output', () => {
    const output = [
      'Starting: Intent { cmp=com.example.app/.MainActivity }',
      'Status: ok',
      'LaunchState: COLD',
      'Activity: com.example.app/.MainActivity',
      'TotalTime: 1234',
      'WaitTime: 1256',
      'Complete',
    ].join('\n');

    expect(parseAmStartOutput(output)).toBe(1234);
  });

  it('should return undefined if TotalTime is missing', () => {
    const output = 'Starting: Intent { ... }\nStatus: ok\nComplete';
    expect(parseAmStartOutput(output)).toBeUndefined();
  });

  it('should return undefined for empty output', () => {
    expect(parseAmStartOutput('')).toBeUndefined();
  });
});

