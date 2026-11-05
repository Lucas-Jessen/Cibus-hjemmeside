// Propbinder's GetTasks has no property field, so a task that has no time registration cannot be placed on a
// property from the data. Many tasks still name the property in their title or text. This matcher finds, in
// order of reliability:
//   1. a lease/unit code "1-4355-20-4" (the second part is the EjendomNr without the F),
//   2. an EjendomNr written out ("F4350"),
//   3. the property's address or name ("Rungsted Bytorv 1", "Vestamagercentret") as whole words.
// Addresses and names shorter than 8 characters, or shared with a property outside the list, are not used.
const fold = (value) => String(value ?? '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('da');
const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const LEASE_CODE = /(?:^|[^\d-])0?1\s*-\s*(\d{4})\s*-\s*\d+/g;
const PROPERTY_NUMBER = /\bF\s?(\d{4})\b/gi;

// properties: [{ number: 'F4354', name, addresses: ['Rungsted Bytorv 1-7', ...] }]
// foreignKeys: names/addresses (any case) of properties that are NOT on the list, to avoid false matches.
function createTaskTextMatcher(properties = [], { foreignKeys = [] } = {}) {
  const byDigits = new Map(properties.filter((p) => /^F\d{4}$/i.test(p.number)).map((p) => [p.number.slice(1), p.number]));
  const foreign = new Set(foreignKeys.map(fold));
  const keys = [];
  for (const property of properties) {
    for (const text of [property.name, ...(property.addresses || [])]) {
      const key = fold(text);
      if (key.length < 8 || foreign.has(key)) continue;
      keys.push({ key, number: property.number, text: String(text).trim() });
    }
  }
  // Longest first, so "Rungsted Bytorv 1-7" wins over "Rungsted Bytorv".
  keys.sort((a, b) => b.key.length - a.key.length);
  const pattern = keys.length ? new RegExp('(^|[^\\p{L}\\d])(' + keys.map((entry) => escape(entry.key)).join('|') + ')(?![\\p{L}\\d])', 'giu') : null;
  const byKey = new Map(keys.map((entry) => [entry.key, entry]));

  return {
    get size() { return keys.length + byDigits.size; },
    // Returns { number, via, evidence } or null; a text that points at two different properties is ambiguous.
    match(task) {
      const text = `${task.title || ''} ${task.description || task.text || ''}`;
      const found = (method, hits) => {
        const numbers = [...new Set(hits.map((hit) => hit.number))];
        if (numbers.length === 1) return { number: numbers[0], via: method, evidence: hits[0].evidence };
        return numbers.length > 1 ? { ambiguous: true } : null;
      };
      const lease = [...text.matchAll(LEASE_CODE)].filter((m) => byDigits.has(m[1])).map((m) => ({ number: byDigits.get(m[1]), evidence: m[0].replace(/^[^\d]+/, '').trim() }));
      const leaseHit = found('lejemålsnr.', lease);
      if (leaseHit) return leaseHit;
      const numbered = [...text.matchAll(PROPERTY_NUMBER)].filter((m) => byDigits.has(m[1])).map((m) => ({ number: byDigits.get(m[1]), evidence: m[0].trim() }));
      const numberHit = found('ejendomsnr. i tekst', numbered);
      if (numberHit) return numberHit;
      if (!pattern) return null;
      const named = [...text.matchAll(pattern)].map((m) => byKey.get(fold(m[2]))).filter(Boolean).map((entry) => ({ number: entry.number, evidence: entry.text }));
      return found('adresse/navn i tekst', named);
    },
  };
}

module.exports = { createTaskTextMatcher };
