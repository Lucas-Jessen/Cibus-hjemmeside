const DEFAULT_BASE_URL = 'https://propbinderpartnerapi.azurewebsites.net';
// GetTasks returns ~80 MB for all of Forenede's tasks, which has taken 5-20 s.
const DEFAULT_TIMEOUT_MS = 90 * 1000;
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
const FALLBACK_TOKEN_LIFETIME_MS = 10 * 60 * 1000;

class PropbinderApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PropbinderApiError';
    this.status = status;
  }
}

function tokenExpiry(accessToken, now) {
  try {
    const payload = JSON.parse(Buffer.from(String(accessToken).split('.')[1], 'base64url').toString('utf8'));
    if (Number.isFinite(payload.exp)) return payload.exp * 1000;
  } catch {
    // Not a decodable JWT; fall back to a short fixed lifetime.
  }
  return now() + FALLBACK_TOKEN_LIFETIME_MS;
}

// Server-side Propbinder Partner API client. Credentials and tokens never leave the backend.
function createPropbinderClient({ baseUrl = DEFAULT_BASE_URL, username, password, fetchImpl = fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!username || !password) {
    throw new Error('Propbinder live mode mangler PROPBINDER_USERNAME og PROPBINDER_PASSWORD i .env.');
  }
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  let tokens = null;
  let pendingLogin = null;

  async function request(pathname, { method = 'GET', body, accessToken } = {}) {
    let response;
    let text;
    try {
      response = await fetchImpl(`${root}${pathname}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        throw new PropbinderApiError(`Propbinder svarede ${response.status} på ${pathname}.`, response.status);
      }
      // The timeout also covers reading the body, which is where a slow, large response stalls.
      text = await response.text();
    } catch (error) {
      if (error instanceof PropbinderApiError) throw error;
      const reason = error.name === 'TimeoutError' || error.name === 'AbortError' ? `intet svar inden for ${Math.round(timeoutMs / 1000)} sekunder` : error.message;
      throw new PropbinderApiError(`Propbinder kunne ikke kontaktes (${reason}).`, 0);
    }
    return text ? JSON.parse(text) : null;
  }

  function storeTokens(result) {
    if (!result || !result.accessToken) throw new PropbinderApiError('Propbinder returnerede intet access token.', 0);
    tokens = { ...result, expiresAt: tokenExpiry(result.accessToken, now) };
    return tokens.accessToken;
  }

  async function login() {
    try {
      return storeTokens(await request('/api/Auth', { method: 'POST', body: { userName: username, password } }));
    } catch (error) {
      if (error.status === 401) throw new PropbinderApiError('Propbinder afviste brugernavn/adgangskode. Kontrollér PROPBINDER_USERNAME og PROPBINDER_PASSWORD.', 401);
      throw error;
    }
  }

  async function refresh() {
    try {
      return storeTokens(await request('/api/Auth/RefreshToken', { method: 'POST', body: { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken } }));
    } catch {
      return login();
    }
  }

  async function accessToken({ force = false } = {}) {
    if (!force && tokens && tokens.expiresAt - TOKEN_EXPIRY_MARGIN_MS > now()) return tokens.accessToken;
    pendingLogin ||= (tokens && tokens.refreshToken && !force ? refresh() : login()).finally(() => { pendingLogin = null; });
    return pendingLogin;
  }

  async function authorizedGet(pathname) {
    try {
      return await request(pathname, { accessToken: await accessToken() });
    } catch (error) {
      if (error.status !== 401) throw error;
      return request(pathname, { accessToken: await accessToken({ force: true }) });
    }
  }

  const getList = async (pathname) => {
    const items = await authorizedGet(pathname);
    return Array.isArray(items) ? items : [];
  };

  return {
    getTasks: () => getList('/DashboardData/GetTasks'),
    getProperties: () => getList('/Property/Properties'),
    getTimeRegistrations: (updatedAfter) => getList(`/TimeRegistration/${encodeURIComponent(new Date(updatedAfter).toISOString())}`),
  };
}

module.exports = { createPropbinderClient, PropbinderApiError, DEFAULT_BASE_URL };
