const { ClientSecretCredential } = require('@azure/identity');

const GRAPH = 'https://graph.microsoft.com/v1.0';

const normalizeHeader = (value) => String(value ?? '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .replace(/[åæø]/gi, (letter) => ({ å: 'a', æ: 'ae', ø: 'o' }[letter.toLowerCase()]))
  .replace(/[^a-z0-9]+/gi, '')
  .toLowerCase();

// Reads one SharePoint list through Microsoft Graph with an app registration (client credentials).
// Rows come back keyed by the columns' display names, so they match the column names of an Excel export of
// the same list. Person and lookup columns are requested explicitly, which makes Graph return their names.
// `where` ({ column, equals }) asks SharePoint to return only matching rows, e.g. Kunde1 = "Fokus Nordic".
function createSharePointListClient({ tenantId, clientId, clientSecret, site, listName, columns, where = null, fetchImpl = fetch, credential = null, timeoutMs = 60 * 1000 } = {}) {
  if (!tenantId || !clientId || !clientSecret || !site || !listName) return null;
  const tokenSource = credential || new ClientSecretCredential(tenantId, clientId, clientSecret);
  const wanted = new Set([...columns, ...(where ? [where.column] : [])].map(normalizeHeader));
  let resolved = null;

  async function graph(url, extraHeaders = {}) {
    const token = await tokenSource.getToken('https://graph.microsoft.com/.default');
    const response = await fetchImpl(url.startsWith('https://') ? url : GRAPH + url, {
      headers: { Authorization: `Bearer ${token.token}`, Accept: 'application/json', ...extraHeaders },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const code = body?.error?.code ? ` (${body.error.code})` : '';
      throw new Error(`SharePoint svarede ${response.status}${code} på ${url.replace(GRAPH, '').split('?')[0]}.`);
    }
    return body;
  }

  // Site id, list id and the display name -> internal name map change rarely; they are looked up once.
  async function resolve() {
    if (resolved) return resolved;
    const siteInfo = await graph(`/sites/${site}`);
    const lists = await graph(`/sites/${siteInfo.id}/lists?$select=id,displayName&$top=200`);
    const list = lists.value.find((entry) => entry.displayName === listName);
    if (!list) throw new Error(`Listen "${listName}" blev ikke fundet på SharePoint-sitet.`);
    const listColumns = await graph(`/sites/${siteInfo.id}/lists/${list.id}/columns?$top=500`);
    const fieldToHeader = new Map();
    for (const column of listColumns.value) {
      if (column.hidden || !wanted.has(normalizeHeader(column.displayName))) continue;
      if ([...fieldToHeader.values()].some((header) => normalizeHeader(header) === normalizeHeader(column.displayName))) continue;
      fieldToHeader.set(column.name, column.displayName);
    }
    resolved = { siteId: siteInfo.id, listId: list.id, fieldToHeader };
    return resolved;
  }

  const toValue = (value) => (Array.isArray(value) ? value.join(', ') : value);

  return {
    async getRows() {
      const { siteId, listId, fieldToHeader } = await resolve();
      const select = [...fieldToHeader.keys()].join(',');
      let filter = '';
      if (where) {
        const field = [...fieldToHeader].find(([, header]) => normalizeHeader(header) === normalizeHeader(where.column))?.[0];
        if (!field) throw new Error(`Kolonnen "${where.column}" findes ikke i listen "${listName}".`);
        filter = `&$filter=fields/${field} eq '${String(where.equals).replace(/'/g, "''")}'`;
      }
      // The filter column is not indexed; SharePoint allows that below its 5,000-item threshold when asked to.
      const headers = where ? { Prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } : {};
      const rows = [];
      let next = `/sites/${siteId}/lists/${listId}/items?$expand=fields($select=${select})${filter}&$top=500`;
      while (next) {
        const page = await graph(next, headers);
        for (const item of page.value) {
          const row = {};
          for (const [field, header] of fieldToHeader) row[header] = toValue(item.fields?.[field] ?? null);
          rows.push(row);
        }
        next = page['@odata.nextLink'] || null;
      }
      const list = await graph(`/sites/${siteId}/lists/${listId}?$select=lastModifiedDateTime`);
      return { rows, listModifiedAt: list.lastModifiedDateTime || null, columns: [...fieldToHeader.values()] };
    },
  };
}

module.exports = { createSharePointListClient };
