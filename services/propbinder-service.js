const { createTaskTextMatcher } = require('./task-text-matcher');

const MOCK_TASKS = [
  {
    id: 'MOCK-187683',
    title: 'Kontrol af ventilation',
    description: 'Gennemgang af ventilationsanlæg og kontrollér af aktuelle funktion.',
    property: 'Testejendom',
    status: 'Igangværende',
    priority: 'Normal',
    createdAt: '2026-10-01',
    dueDate: '2026-10-15',
    assignedTo: 'Testmedarbejder',
    updatedAt: '2026-10-05',
  },
  {
    id: 'MOCK-187684',
    title: 'Målning af afsnitningskabler',
    description: 'Fastlæggning af installationsomfang og forventede behov.',
    property: 'Testejendom',
    status: 'Åben',
    priority: 'Høj',
    createdAt: '2026-09-28',
    dueDate: '2026-10-20',
    assignedTo: 'Testmedarbejder',
    updatedAt: '2026-10-06',
  },
  {
    id: 'MOCK-187685',
    title: 'Afsluttende kontrol af elinstallation',
    description: 'Kontrol af dokumentation og afsluttede ændringer.',
    property: 'Testejendom',
    status: 'Afsluttet',
    priority: 'Lav',
    createdAt: '2026-09-12',
    dueDate: '2026-09-30',
    assignedTo: 'Testmedarbejder',
    updatedAt: '2026-09-29',
  },
];

const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses 'guid=Label;guid=Label' so Propbinder status ids can be shown with readable names.
function parseStatusLabels(value) {
  return Object.fromEntries(String(value || '').split(/[;\n]/).map((pair) => pair.split('=').map((part) => part.trim())).filter(([id, label]) => id && label).map(([id, label]) => [id.toLowerCase(), label]));
}

const normalizeNumber = (value) => (value == null || String(value).trim() === '' ? null : String(value).trim().toUpperCase());

function normalizeTask(task, statusLabels = {}) {
  const rawStatus = task.status ?? task.state ?? null;
  const mappedStatus = rawStatus == null ? null : statusLabels[String(rawStatus).toLowerCase()];
  return {
    id: String(task.number ?? task.id ?? task.taskId ?? 'Ukendt-id'),
    number: task.number ?? null,
    title: String(task.title ?? task.name ?? 'Uden titel'),
    description: String(task.description ?? task.summary ?? task.text ?? ''),
    property: task.property ?? task.propertyName ?? task.customer ?? null,
    propertyNumber: normalizeNumber(task.propertyNumber),
    propertyId: task.propertyId ?? null,
    status: mappedStatus ?? (rawStatus == null || GUID_PATTERN.test(String(rawStatus)) ? 'Ukendt' : String(rawStatus)),
    statusId: rawStatus == null ? null : String(rawStatus),
    priority: task.priority ?? task.severity ?? null,
    createdAt: task.createdAt ?? task.createdDate ?? null,
    startDate: task.startDateTime ?? task.startDate ?? null,
    dueDate: task.dueDate ?? task.deadline ?? task.endDateTime ?? task.endDate ?? null,
    assignedTo: task.assignedTo ?? task.owner ?? task.responsible ?? null,
    updatedAt: task.updatedAt ?? task.modifiedAt ?? task.lastModified ?? task.lastUpdated ?? null,
  };
}

// Candidate property numbers for a task: its own fields first, then Propbinder's property record, then time registrations.
// Propbinder's own property number is translated to financeUnit, which holds the EjendomNr used in the property list.
function propertyCandidates(task, links) {
  const candidates = [task.propertyNumber];
  const property = task.propertyId ? links.propertiesById.get(String(task.propertyId).toLowerCase()) : null;
  if (property) candidates.push(property.number, property.externalId, property.financeUnit);
  if (task.number != null) candidates.push(...(links.propertiesByTaskNumber.get(String(task.number)) || []));
  for (const candidate of [...candidates]) {
    const known = candidate ? links.propertiesByNumber.get(candidate) : null;
    if (known) candidates.push(known.externalId, known.financeUnit);
  }
  return [...new Set(candidates.filter(Boolean))];
}

function buildLinks(properties, timeRegistrations) {
  const records = properties.filter((property) => property.id || property.number).map((property) => ({
    id: property.id ? String(property.id).toLowerCase() : null,
    number: normalizeNumber(property.number),
    externalId: normalizeNumber(property.externalId),
    financeUnit: normalizeNumber(property.financeUnit),
  }));
  const propertiesById = new Map(records.filter((property) => property.id).map((property) => [property.id, property]));
  const propertiesByNumber = new Map(records.filter((property) => property.number).map((property) => [property.number, property]));
  const propertiesByTaskNumber = new Map();
  for (const registration of timeRegistrations) {
    const propertyNumber = normalizeNumber(registration.propertyNumber);
    if (registration.taskNumber == null || !propertyNumber) continue;
    const key = String(registration.taskNumber);
    if (!propertiesByTaskNumber.has(key)) propertiesByTaskNumber.set(key, new Set());
    propertiesByTaskNumber.get(key).add(propertyNumber);
  }
  // Names and addresses per financeUnit, so the text matcher can skip words shared with other customers' properties.
  const namesByFinanceUnit = properties.map((property) => ({ financeUnit: normalizeNumber(property.financeUnit), texts: [property.name, property.address].filter(Boolean) }));
  return { propertiesById, propertiesByNumber, namesByFinanceUnit, propertiesByTaskNumber: new Map([...propertiesByTaskNumber].map(([key, numbers]) => [key, [...numbers]])) };
}

// Keeps only tasks linked to a property on the allowed list and labels them with the list's name. Tasks without
// any property data are tried against `textMatcher` (address, name or lease code in the task text); a task that
// is linked to a property outside the list is never moved onto the list by its text.
function filterTasksByPropertyList(tasks, allowedProperties, links, textMatcher = null) {
  const stats = { total: tasks.length, shown: 0, unlinked: 0, otherProperties: 0, linkedByData: 0, linkedByText: 0, ambiguous: 0 };
  const shown = [];
  const label = (task, number, link) => {
    const property = allowedProperties.get(number);
    return { ...task, propertyNumber: number, property: property.name, propertyAddress: [property.address, [property.zipCode, property.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null, link };
  };
  for (const task of tasks) {
    const candidates = propertyCandidates(task, links);
    const match = candidates.find((number) => allowedProperties.has(number));
    if (match) {
      const viaTime = task.number != null && links.propertiesByTaskNumber.has(String(task.number)) && !task.propertyNumber && !task.propertyId;
      shown.push(label(task, match, { via: viaTime ? 'tidsregistrering' : 'ejendomsfelt', evidence: null }));
      stats.linkedByData += 1;
    } else if (candidates.length) {
      stats.otherProperties += 1;
    } else {
      const text = textMatcher ? textMatcher.match(task) : null;
      if (text && text.number && allowedProperties.has(text.number)) {
        shown.push(label(task, text.number, { via: text.via, evidence: text.evidence }));
        stats.linkedByText += 1;
      } else {
        if (text && text.ambiguous) stats.ambiguous += 1;
        stats.unlinked += 1;
      }
    }
  }
  stats.shown = shown.length;
  return { tasks: shown, stats };
}

// Propbinder case statuses arrive as resource keys ("CaseStatus.Name.Open").
const CASE_STATUS_LABELS = { open: 'Åben', closed: 'Lukket', canceled: 'Annulleret', cancelled: 'Annulleret', awaitinganswer: 'Afventer svar', offer: 'Tilbud', needplanning: 'Skal planlægges', planned: 'Planlagt', inprogress: 'I gang' };
const CLOSED_CASE_STATUSES = new Set(['Lukket', 'Annulleret']);
function caseStatusLabel(status) {
  const key = String(status || '').split('.').pop();
  return CASE_STATUS_LABELS[key.toLowerCase()] || key.replace(/([a-z])([A-Z])/g, '$1 $2') || 'Ukendt';
}

// Cases (GetCases) carry Propbinder's property number; it is translated to financeUnit (EjendomNr) and kept
// when that is on the allowed list.
function filterCasesByPropertyList(cases, allowedProperties, links) {
  const shown = [];
  for (const item of cases) {
    const record = links.propertiesByNumber.get(normalizeNumber(item.propertyNumber))
      || (item.propertyId ? links.propertiesById.get(String(item.propertyId).toLowerCase()) : null);
    const number = record && [record.financeUnit, record.externalId, record.number].find((candidate) => candidate && allowedProperties.has(candidate));
    if (!number) continue;
    const property = allowedProperties.get(number);
    const status = caseStatusLabel(item.status);
    shown.push({
      id: String(item.id),
      shortId: String(item.id).slice(0, 8).toUpperCase(),
      createdAt: item.createdAt || null,
      updatedAt: item.lastModified || null,
      status,
      open: !CLOSED_CASE_STATUSES.has(status),
      responsible: item.responsible || null,
      customerType: item.customerType ? String(item.customerType).split('.').pop().replace(/([a-z])([A-Z])/g, '$1 $2') : null,
      propertyNumber: number,
      property: property.name,
      propertyAddress: [property.address, [property.zipCode, property.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null,
      propbinderName: item.propertyName || null,
    });
  }
  return shown.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function createPropbinderService({
  mode = 'mock',
  backendClient = null,
  statusLabels = {},
  propertyList = null,
  timeRegistrationLookbackDays = 1095,
  cacheTtlMs = 60 * 1000,
  linkCacheTtlMs = 15 * 60 * 1000,
  // Also place tasks on a property from an address, name or lease code in their text (see task-text-matcher).
  textMatching = false,
  now = Date.now,
} = {}) {
  const normalizedMode = String(mode).toLowerCase();
  let cache = null;
  let linkCache = null;
  let refreshing = null;
  let lastError = null;

  async function loadLinks(warnings) {
    if (linkCache && now() - linkCache.fetchedAt < linkCacheTtlMs) return linkCache.links;
    const since = new Date(now() - timeRegistrationLookbackDays * 24 * 60 * 60 * 1000);
    const [properties, timeRegistrations] = await Promise.all([
      backendClient.getProperties().catch((error) => { warnings.push(`Ejendomme kunne ikke hentes fra Propbinder: ${error.message}`); return null; }),
      backendClient.getTimeRegistrations(since).catch((error) => { warnings.push(`Tidsregistreringer kunne ikke hentes fra Propbinder: ${error.message}`); return null; }),
    ]);
    const links = buildLinks(properties || [], timeRegistrations || []);
    // Only cache complete link data, so a temporary failure is retried on the next request.
    if (properties && timeRegistrations) linkCache = { fetchedAt: now(), links };
    return links;
  }

  async function fetchLive() {
    const warnings = [];
    const tasks = (await backendClient.getTasks()).map((task) => normalizeTask(task, statusLabels));
    if (!propertyList || !propertyList.configured) {
      return { tasks, filter: null, warnings };
    }
    const list = propertyList.getProperties();
    const [links, rawCases] = await Promise.all([
      loadLinks(warnings),
      backendClient.getCases ? backendClient.getCases().catch((error) => { warnings.push(`Sager kunne ikke hentes fra Propbinder: ${error.message}`); return []; }) : [],
    ]);
    let textMatcher = null;
    if (textMatching) {
      const allowed = new Set(list.byNumber.keys());
      const foreignKeys = links.namesByFinanceUnit.filter((entry) => !entry.financeUnit || !allowed.has(entry.financeUnit)).flatMap((entry) => entry.texts);
      textMatcher = createTaskTextMatcher(list.properties.map((property) => ({ number: property.number, name: property.name, addresses: property.textKeys || [property.address] })), { foreignKeys });
    }
    const { tasks: shown, stats } = filterTasksByPropertyList(tasks, list.byNumber, links, textMatcher);
    const cases = filterCasesByPropertyList(rawCases, list.byNumber, links);
    return { tasks: shown, cases, filter: { ...stats, textMatching: Boolean(textMatcher), propertyCount: list.properties.length, listModifiedAt: list.modifiedAt, cases: cases.length, casesTotal: rawCases.length }, warnings };
  }

  // Stale-while-revalidate: Propbinder's full task list is large and slow, so a stale list is served while a
  // single refresh runs in the background. Only the very first load waits for Propbinder.
  async function load() {
    if (!backendClient) {
      throw new Error('Propbinder live mode er ikke konfigureret. Angiv PROPBINDER_USERNAME og PROPBINDER_PASSWORD i .env, og genstart appen.');
    }
    if (cache && now() - cache.fetchedAt < cacheTtlMs) return cache;
    if (!refreshing) {
      refreshing = fetchLive()
        .then((result) => { cache = { fetchedAt: now(), ...result }; lastError = null; })
        .catch((error) => { lastError = { message: error.message, at: now() }; throw error; })
        .finally(() => { refreshing = null; });
    }
    if (cache) {
      refreshing.catch(() => {});
      return cache;
    }
    await refreshing;
    return cache;
  }

  return {
    get mode() {
      return normalizedMode;
    },
    async getTasks() {
      if (normalizedMode === 'mock') {
        return MOCK_TASKS.map((task) => normalizeTask(task, statusLabels));
      }
      return (await load()).tasks;
    },
    // Propbinder cases on the listed properties (fetched together with the tasks).
    async getCases() {
      if (normalizedMode === 'mock') return [];
      return (await load()).cases || [];
    },
    getConfiguration() {
      return {
        mode: normalizedMode,
        liveConfigured: normalizedMode === 'live' && Boolean(backendClient),
        source: normalizedMode === 'mock' ? 'Mock-data (testdata)' : 'Propbinder Partner API',
        fetchedAt: cache ? new Date(cache.fetchedAt).toISOString() : null,
        filter: normalizedMode === 'live' && cache ? cache.filter : null,
        propertyFilterConfigured: Boolean(propertyList && propertyList.configured),
        warnings: normalizedMode === 'live' && cache
          ? [...cache.warnings, ...(lastError ? [`Seneste opdatering fejlede (${lastError.message}); viser data fra ${new Date(cache.fetchedAt).toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' })}.`] : [])]
          : [],
      };
    },
  };
}

module.exports = { createPropbinderService, normalizeTask, parseStatusLabels, filterTasksByPropertyList, filterCasesByPropertyList, caseStatusLabel, buildLinks };
