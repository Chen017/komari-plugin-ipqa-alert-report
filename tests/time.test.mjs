import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BJT_OFFSET_MS,
  getBeijingParts,
  formatBeijingDateKey,
  beijingEpochSeconds,
  getBeijingDailyWindow,
  isBeijingDue,
} from '../src/time.ts';

describe('time.ts - Beijing Time & Timezone Handling', () => {
  it('should calculate Beijing time parts correctly regardless of system timezone', () => {
    // 2026-09-20 23:00:00 UTC == 2026-09-21 07:00:00 BJT
    const utcDate = new Date('2026-09-20T23:00:00.000Z');
    const bj = getBeijingParts(utcDate);

    assert.equal(bj.year, 2026);
    assert.equal(bj.month, 9);
    assert.equal(bj.day, 21);
    assert.equal(bj.hour, 7);
    assert.equal(bj.minute, 0);
    assert.equal(bj.second, 0);

    const dateKey = formatBeijingDateKey(bj);
    assert.equal(dateKey, '2026-09-21');
  });

  it('should calculate exact epoch seconds for Beijing daily window [00:00:00, 07:00:59]', () => {
    const window = getBeijingDailyWindow('2026-09-21');
    assert.equal(window.windowStart, '2026-09-21 00:00:00');
    assert.equal(window.windowEnd, '2026-09-21 07:00:59');

    // 2026-09-21 00:00:00 BJT = 2026-09-20 16:00:00 UTC
    const expectedStartUtc = Math.floor(
      Date.UTC(2026, 8, 20, 16, 0, 0) / 1000
    );
    assert.equal(window.startEpoch, expectedStartUtc);

    // 2026-09-21 07:00:59 BJT = 2026-09-20 23:00:59 UTC
    const expectedEndUtc = Math.floor(
      Date.UTC(2026, 8, 20, 23, 0, 59) / 1000
    );
    assert.equal(window.endEpoch, expectedEndUtc);

    // Difference between start and end must be exactly 7 hours and 59 seconds = 25259 seconds
    assert.equal(window.endEpoch - window.startEpoch, 7 * 3600 + 59);
  });

  it('should trigger isBeijingDue within 07:00 to 07:09:59 (10-minute catch-up window)', () => {
    // 06:59:59 BJT -> false
    assert.equal(isBeijingDue(new Date('2026-09-20T22:59:59.000Z')), false);

    // 07:00:00 BJT -> true
    assert.equal(isBeijingDue(new Date('2026-09-20T23:00:00.000Z')), true);

    // 07:04:30 BJT -> true (controller restarted briefly)
    assert.equal(isBeijingDue(new Date('2026-09-20T23:04:30.000Z')), true);

    // 07:09:59 BJT -> true
    assert.equal(isBeijingDue(new Date('2026-09-20T23:09:59.000Z')), true);

    // 07:10:00 BJT -> false
    assert.equal(isBeijingDue(new Date('2026-09-20T23:10:00.000Z')), false);

    // 08:00:00 BJT -> false
    assert.equal(isBeijingDue(new Date('2026-09-21T00:00:00.000Z')), false);
  });

  it('Test 9: should correctly filter across different node timezones (UTC, PDT, JST) using epoch window', () => {
    // Daily window for 2026-09-21 BJT:
    // startEpoch = 2026-09-20 16:00:00 UTC (1758384000)
    // endEpoch   = 2026-09-20 23:00:59 UTC (1758409259)
    const { startEpoch, endEpoch } = getBeijingDailyWindow('2026-09-21');

    // Beijing 04:05:00 corresponds to UTC 2026-09-20 20:05:00
    const bjt0405UtcMs = Date.UTC(2026, 8, 20, 20, 5, 0);
    const bjt0405Epoch = Math.floor(bjt0405UtcMs / 1000);

    assert.ok(
      bjt0405Epoch >= startEpoch && bjt0405Epoch <= endEpoch,
      'Epoch of 04:05 BJT must fall strictly within [startEpoch, endEpoch]'
    );

    // Node A: UTC (UTC+0). Local time: "2026-09-20 20:05:00"
    // Remote script converts start/end to local time:
    const startA = new Date(startEpoch * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const endA = new Date(endEpoch * 1000).toISOString().replace('T', ' ').slice(0, 19);
    const localA = '2026-09-20 20:05:00';
    assert.ok(localA >= startA && localA <= endA, 'UTC node local timestamp must be within local window');

    // Node B: PDT (UTC-7). Local time: "2026-09-20 13:05:00"
    const pdtOffsetMs = -7 * 3600 * 1000;
    const startB = new Date(startEpoch * 1000 + pdtOffsetMs).toISOString().replace('T', ' ').slice(0, 19);
    const endB = new Date(endEpoch * 1000 + pdtOffsetMs).toISOString().replace('T', ' ').slice(0, 19);
    const localB = '2026-09-20 13:05:00';
    assert.ok(localB >= startB && localB <= endB, 'PDT node local timestamp must be within local window');

    // Node C: JST (UTC+9). Local time: "2026-09-21 05:05:00"
    const jstOffsetMs = 9 * 3600 * 1000;
    const startC = new Date(startEpoch * 1000 + jstOffsetMs).toISOString().replace('T', ' ').slice(0, 19);
    const endC = new Date(endEpoch * 1000 + jstOffsetMs).toISOString().replace('T', ' ').slice(0, 19);
    const localC = '2026-09-21 05:05:00';
    assert.ok(localC >= startC && localC <= endC, 'JST node local timestamp must be within local window');
  });
});
