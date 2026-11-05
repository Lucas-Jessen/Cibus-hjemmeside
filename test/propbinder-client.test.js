const test = require('node:test');
const assert = require('node:assert/strict');
const { createPropbinderClient } = require('../services/propbinder-client');

function jwt(expSeconds) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ exp: expSeconds })}.signature`;
}

function fakeApi(handlers) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const pathname = new URL(url).pathname;
    calls.push({ pathname, method: options.method, headers: options.headers, body: options.body ? JSON.parse(options.body) : null });
    const { status = 200, json } = handlers[pathname](calls.at(-1), calls);
    return { ok: status >= 200 && status < 300, status, text: async () => (json === undefined ? '' : JSON.stringify(json)) };
  };
  return { calls, fetchImpl };
}

test('requires username and password', () => {
  assert.throws(() => createPropbinderClient({ username: 'user' }), /PROPBINDER_PASSWORD/);
});

test('logs in, sends the bearer token and reuses it until expiry', async () => {
  const token = jwt(3600);
  const api = fakeApi({
    '/api/Auth': () => ({ json: { accessToken: token, refreshToken: 'refresh-1' } }),
    '/DashboardData/GetTasks': () => ({ json: [{ id: 't1', title: 'Opgave' }] }),
  });
  const client = createPropbinderClient({ username: 'user', password: 'pass', fetchImpl: api.fetchImpl, now: () => 0 });

  assert.deepEqual(await client.getTasks(), [{ id: 't1', title: 'Opgave' }]);
  await client.getTasks();

  const authCalls = api.calls.filter((call) => call.pathname === '/api/Auth');
  assert.equal(authCalls.length, 1);
  assert.deepEqual(authCalls[0].body, { userName: 'user', password: 'pass' });
  const taskCall = api.calls.find((call) => call.pathname === '/DashboardData/GetTasks');
  assert.equal(taskCall.headers.Authorization, `Bearer ${token}`);
});

test('refreshes an expired token with the refresh token', async () => {
  let clock = 0;
  const api = fakeApi({
    '/api/Auth': () => ({ json: { accessToken: jwt(100), refreshToken: 'refresh-1' } }),
    '/api/Auth/RefreshToken': () => ({ json: { accessToken: jwt(10000), refreshToken: 'refresh-2' } }),
    '/DashboardData/GetTasks': () => ({ json: [] }),
  });
  const client = createPropbinderClient({ username: 'user', password: 'pass', fetchImpl: api.fetchImpl, now: () => clock });

  await client.getTasks();
  clock = 100 * 1000;
  await client.getTasks();

  const refreshCall = api.calls.find((call) => call.pathname === '/api/Auth/RefreshToken');
  assert.equal(refreshCall.body.refreshToken, 'refresh-1');
  assert.equal(api.calls.filter((call) => call.pathname === '/api/Auth').length, 1);
});

test('logs in again once when the API rejects a token', async () => {
  let rejectNext = true;
  const api = fakeApi({
    '/api/Auth': () => ({ json: { accessToken: jwt(3600), refreshToken: 'r' } }),
    '/DashboardData/GetTasks': () => {
      if (rejectNext) { rejectNext = false; return { status: 401 }; }
      return { json: [{ id: 'ok' }] };
    },
  });
  const client = createPropbinderClient({ username: 'user', password: 'pass', fetchImpl: api.fetchImpl, now: () => 0 });

  assert.deepEqual(await client.getTasks(), [{ id: 'ok' }]);
  assert.equal(api.calls.filter((call) => call.pathname === '/api/Auth').length, 2);
});

test('reports rejected credentials without exposing the password', async () => {
  const api = fakeApi({ '/api/Auth': () => ({ status: 401 }) });
  const client = createPropbinderClient({ username: 'user', password: 'very-secret', fetchImpl: api.fetchImpl });

  await assert.rejects(client.getTasks(), (error) => {
    assert.match(error.message, /afviste brugernavn\/adgangskode/);
    assert.doesNotMatch(error.message, /very-secret/);
    return true;
  });
});

test('fetches properties and time registrations with the bearer token', async () => {
  const api = fakeApi({
    '/api/Auth': () => ({ json: { accessToken: jwt(3600), refreshToken: 'r' } }),
    '/Property/Properties': () => ({ json: [{ id: 'p1', number: 'F2020' }] }),
    '/TimeRegistration/2025-10-20T00%3A00%3A00.000Z': () => ({ json: [{ taskNumber: 7, propertyNumber: 'F2020' }] }),
  });
  const client = createPropbinderClient({ username: 'user', password: 'pass', fetchImpl: api.fetchImpl, now: () => 0 });

  assert.deepEqual(await client.getProperties(), [{ id: 'p1', number: 'F2020' }]);
  assert.deepEqual(await client.getTimeRegistrations(new Date('2025-10-20T00:00:00Z')), [{ taskNumber: 7, propertyNumber: 'F2020' }]);
  assert.ok(api.calls.filter((call) => call.pathname !== '/api/Auth').every((call) => call.headers.Authorization.startsWith('Bearer ')));
});

test('reports a slow response as a timeout in Danish', async () => {
  const client = createPropbinderClient({
    username: 'user', password: 'pass', timeoutMs: 5000,
    fetchImpl: async () => { const error = new Error('The operation was aborted due to timeout'); error.name = 'TimeoutError'; throw error; },
  });

  await assert.rejects(client.getTasks(), /intet svar inden for 5 sekunder/);
});
