import test from 'node:test';
import assert from 'node:assert/strict';
import { registerApiRoutes } from '../src/api/routes.ts';
import {
  saveDailyReport,
  saveFleetOverview,
} from '../src/storage/archive-store.ts';

test('api routes: registration and read-only cache endpoints', async () => {
  const routes = new Map();

  const mockServer = {
    route: (method, path, handler) => {
      routes.set(`${method}:${path}`, handler);
    },
  };

  registerApiRoutes(mockServer);

  // 1. Check registered routes
  assert.ok(routes.has('GET:/api/plugin/ipqa-alert-report/v1/capabilities'));
  assert.ok(routes.has('GET:/api/plugin/ipqa-alert-report/v1/overview'));
  assert.ok(routes.has('GET:/api/plugin/ipqa-alert-report/v1/nodes'));
  assert.ok(routes.has('GET:/api/plugin/ipqa-alert-report/v1/nodes/*action') || routes.has('GET:/api/plugin/ipqa-alert-report/v1/nodes/*'));

  function createMockRes() {
    return {
      statusCode: 0,
      headers: {},
      body: '',
      setHeader(k, v) { this.headers[k] = v; },
      end(data) { this.body = data; },
    };
  }

  // 2. Test /capabilities
  {
    const req = { context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/capabilities' };
    const res = createMockRes();
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/capabilities');
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.schema_version, 1);
    assert.strictEqual(data.plugin_version, '0.2.4');
    assert.strictEqual(data.archive_api, true);
    assert.strictEqual(data.change_api, true);
  }

  // 3. Test /overview
  {
    const fleetOverview = {
      schema_version: 1,
      updated_at: '2026-09-21T12:00:00Z',
      total_nodes: 2,
      ipqa_nodes: 2,
      nodes_with_risk: 1,
      nodes_with_changes_today: 1,
      latest_archive_date: '2026-09-21',
      nodes: [
        {
          uuid: 'node-tokyo',
          name: 'Tokyo VPS',
          status: 'ok',
          latest_date: '2026-09-21',
          has_ipv4: true,
          has_ipv6: false,
          highest_risk: { category: 'Low', source: 'IPQS' },
          media_summary: { Netflix: { unlocked: true, region: 'JP' } },
          ai_summary: { ChatGPT: { unlocked: true } },
          changes_today: 0,
        },
      ],
    };
    saveFleetOverview(fleetOverview);

    const req = { context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/overview' };
    const res = createMockRes();
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/overview');
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.total_nodes, 2);
    assert.strictEqual(data.nodes[0].name, 'Tokyo VPS');
  }

  // 4. Test /nodes/:uuid/latest
  {
    const dailyReport = {
      schemaVersion: 1,
      nodeUuid: 'node-tokyo',
      date: '2026-09-21',
      updatedAt: '2026-09-21T12:00:00Z',
      v4: {
        schemaVersion: 1,
        ipVersion: 'IPv4',
        archiveId: '2026-09-21_040002.json',
        date: '2026-09-21',
        timestamp: '2026-09-21T04:00:02Z',
        info: { ip: '1.2.3.4', country: 'Japan' },
        scores: { IPQS: 10 },
        type: { usage: {}, company: {} },
        factors: {},
        media: { Netflix: { status: '解锁', region: 'JP' } },
        mail: {},
        extra: {},
      },
      v6: null,
      summary: {
        hasV4: true,
        hasV6: false,
        highestRiskCategory: 'Low',
        highestRiskSource: 'IPQS',
        mediaSummary: { Netflix: { unlocked: true, region: 'JP' } },
        aiSummary: {},
      },
      changesFromPrevious: [],
    };
    saveDailyReport('node-tokyo', dailyReport);

    const req = { context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/nodes/node-tokyo/latest' };
    const res = createMockRes();
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*action') || routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*');
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.nodeUuid, 'node-tokyo');
    assert.strictEqual(data.v4.info.ip, '1.2.3.4');
  }

  // 5. Test /nodes/:uuid/archives/:date
  {
    const req = { context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/nodes/node-tokyo/archives/2026-09-21' };
    const res = createMockRes();
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*action') || routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*');
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.date, '2026-09-21');
  }

  // 6. Test not found node
  {
    const req = { context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/nodes/non-existent/latest' };
    const res = createMockRes();
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*action') || routes.get('GET:/api/plugin/ipqa-alert-report/v1/nodes/*');
    await handler(req, res);
    assert.strictEqual(res.statusCode, 404);
  }

  // 7. Test /overview with ?uuids= query parameter
  {
    const req = { context: { principal: { type: 'user', roles: ['admin'] } }, url: '/api/plugin/ipqa-alert-report/v1/overview?uuids=node-tokyo,node-missing' };
    const res = createMockRes();
    const handler = routes.get('GET:/api/plugin/ipqa-alert-report/v1/overview');
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.total_nodes, 1);
    assert.strictEqual(data.nodes.length, 1);
    assert.strictEqual(data.nodes[0].uuid, 'node-tokyo');
  }

  // 8. Test automatic pruning of deleted server via server.call('common:getNodes')
  {
    const rpcMethods = new Map();
    const serverWithLiveNodes = {
      registerRPC: (name, fn) => { rpcMethods.set(name, fn); },
      route: () => {},
      call: async (method) => {
        if (method === 'common:getNodes') {
          // Komari only has 'node-active', 'node-tokyo' was deleted!
          return [{ uuid: 'node-active', name: 'Active VPS' }];
        }
        return null;
      },
    };

    saveFleetOverview({
      schema_version: 1,
      updated_at: '2026-09-21T12:00:00Z',
      total_nodes: 2,
      ipqa_nodes: 2,
      nodes_with_risk: 0,
      nodes_with_changes_today: 0,
      latest_archive_date: '2026-09-21',
      nodes: [
        {
          uuid: 'node-tokyo', // deleted in Komari!
          name: 'Tokyo VPS',
          status: 'ok',
          latest_date: '2026-09-21',
          has_ipv4: true,
          has_ipv6: false,
          highest_risk: { category: 'Low', source: 'IPQS' },
          media_summary: {},
          ai_summary: {},
          changes_today: 0,
        },
        {
          uuid: 'node-active', // still exists!
          name: 'Active VPS',
          status: 'ok',
          latest_date: '2026-09-21',
          has_ipv4: true,
          has_ipv6: false,
          highest_risk: { category: 'Low', source: 'IPQS' },
          media_summary: {},
          ai_summary: {},
          changes_today: 0,
        },
      ],
    });

    registerApiRoutes(serverWithLiveNodes);
    const { handleGetOverviewAsync } = await import('../src/api/routes.ts');
    const getOverviewRpc = rpcMethods.get('plugin:ipqaGetOverview');
    assert.ok(getOverviewRpc);

    assert.equal(getOverviewRpc() instanceof Promise, false);
    const prunedOverview = await handleGetOverviewAsync(serverWithLiveNodes);
    assert.strictEqual(prunedOverview.total_nodes, 1);
    assert.strictEqual(prunedOverview.nodes.length, 1);
    assert.strictEqual(prunedOverview.nodes[0].uuid, 'node-active');

    // Verify persisted fleet overview was also pruned
    const { getFleetOverview } = await import('../src/storage/archive-store.ts');
    const persisted = getFleetOverview();
    assert.strictEqual(persisted.total_nodes, 1);
    assert.strictEqual(persisted.nodes[0].uuid, 'node-active');
  }
});
