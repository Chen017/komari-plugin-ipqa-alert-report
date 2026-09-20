import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTaskResults, isTerminalResult, runRemoteTask } from '../src/remote.ts';

describe('remote.ts - TaskResult Normalization and Polling', () => {
  it('Test 1: pending native Komari result is not terminal', () => {
    const raw = [
      {
        task_id: 'task-1',
        client: 'node-1',
        client_info: {},
        result: '',
        exit_code: null,
        finished_at: null,
        created_at: '2026-09-20T09:00:00Z',
      },
    ];

    const map = normalizeTaskResults(raw);
    const res = map.get('node-1');

    assert.ok(res);
    assert.equal(res.exit_code, null);
    assert.equal(res.finished_at, null);
    assert.equal(res.stdout, '');
    assert.equal(isTerminalResult(res), false);
  });

  it('Test 2: completed native Komari result is terminal', () => {
    const raw = [
      {
        task_id: 'task-1',
        client: 'node-1',
        result: 'IPQA_PLUGIN_POC\n',
        exit_code: 0,
        finished_at: '2026-09-20T09:00:02Z',
      },
    ];

    const map = normalizeTaskResults(raw);
    const res = map.get('node-1');

    assert.ok(res);
    assert.equal(res.stdout, 'IPQA_PLUGIN_POC\n');
    assert.equal(res.exit_code, 0);
    assert.equal(isTerminalResult(res), true);
  });

  it('Test 3: non-zero exit code is terminal', () => {
    const raw = [
      {
        client: 'node-1',
        result: 'command failed',
        exit_code: 1,
        finished_at: '2026-09-20T09:00:02Z',
      },
    ];

    const res = normalizeTaskResults(raw).get('node-1');

    assert.ok(res);
    assert.equal(res.exit_code, 1);
    assert.equal(isTerminalResult(res), true);
  });

  it('Test 4: successful empty-output command is terminal', () => {
    const raw = [
      {
        client: 'node-1',
        result: '',
        exit_code: 0,
        finished_at: '2026-09-20T09:00:02Z',
      },
    ];

    const res = normalizeTaskResults(raw).get('node-1');

    assert.ok(res);
    assert.equal(res.stdout, '');
    assert.equal(isTerminalResult(res), true);
  });

  it('Test 5: normalizer must not reintroduce raw null/incorrect fields', () => {
    const raw = [
      {
        client: 'node-1',
        result: '',
        exit_code: null,
      },
    ];

    const res = normalizeTaskResults(raw).get('node-1');
    assert.ok(res);
    assert.equal(res.exit_code, null);
    assert.equal(isTerminalResult(res), false);
  });

  it('Test 6: synthetic timeout is terminal', () => {
    const res = {
      client_id: 'node-1',
      status: 'TIMEOUT',
      error: 'Agent task timeout after 15s',
    };

    assert.equal(isTerminalResult(res), true);
  });

  it('Test 7: polling sequence: pending -> completed', async () => {
    let pollCount = 0;

    const mockServer = {
      call: async (method, params) => {
        if (method === 'admin:exec') {
          return { task_id: 'task-1' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          pollCount++;
          if (pollCount === 1 || pollCount === 2) {
            return [
              {
                task_id: 'task-1',
                client: 'node-1',
                result: '',
                exit_code: null,
                finished_at: null,
              },
            ];
          }
          return [
            {
              task_id: 'task-1',
              client: 'node-1',
              result: 'IPQA_PLUGIN_POC\n',
              exit_code: 0,
              finished_at: '2026-09-20T09:00:03Z',
            },
          ];
        }
        return {};
      },
    };

    const { results } = await runRemoteTask(
      mockServer,
      "printf 'IPQA_PLUGIN_POC\\n'",
      ['node-1'],
      5000,
      10
    );

    assert.equal(pollCount, 3, 'runRemoteTask must poll 3 times until task completes');
    const res = results.get('node-1');
    assert.ok(res);
    assert.ok(res.stdout.includes('IPQA_PLUGIN_POC'));
    assert.equal(res.exit_code, 0);
  });

  it('Test 8: multi-node completion waits for all nodes', async () => {
    let pollCount = 0;

    const mockServer = {
      call: async (method) => {
        if (method === 'admin:exec') {
          return { task_id: 'task-multi' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          pollCount++;
          if (pollCount === 1) {
            return [
              {
                client: 'node-A',
                result: 'OK_A',
                exit_code: 0,
                finished_at: '2026-09-20T09:00:01Z',
              },
              {
                client: 'node-B',
                result: '',
                exit_code: null,
                finished_at: null,
              },
            ];
          }
          return [
            {
              client: 'node-A',
              result: 'OK_A',
              exit_code: 0,
              finished_at: '2026-09-20T09:00:01Z',
            },
            {
              client: 'node-B',
              result: 'OK_B',
              exit_code: 0,
              finished_at: '2026-09-20T09:00:02Z',
            },
          ];
        }
        return {};
      },
    };

    const { results } = await runRemoteTask(
      mockServer,
      'command',
      ['node-A', 'node-B'],
      5000,
      10
    );

    assert.equal(pollCount, 2, 'runRemoteTask must not return after poll #1 while node-B is pending');
    assert.equal(results.get('node-A')?.exit_code, 0);
    assert.equal(results.get('node-B')?.exit_code, 0);
  });

  it('Test 9: timeout text uses configured timeout', async () => {
    const mockServer = {
      call: async (method) => {
        if (method === 'admin:exec') {
          return { task_id: 'task-timeout' };
        }
        if (method === 'admin:getTaskResultsByTaskId') {
          return [
            {
              client: 'node-1',
              result: '',
              exit_code: null,
              finished_at: null,
            },
          ];
        }
        return {};
      },
    };

    // Timeout 1000ms, pollInterval 100ms
    const { results } = await runRemoteTask(
      mockServer,
      'command',
      ['node-1'],
      1000,
      100
    );

    const res = results.get('node-1');
    assert.ok(res);
    assert.equal(res.status, 'TIMEOUT');
    assert.equal(res.error, 'Agent task timeout after 1s');
  });
});

