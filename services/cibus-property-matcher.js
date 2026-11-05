// Links free-text property names (from the inspection sheet or a report's location path) to the Cibus
// properties from SharePoint. A name matches a property when the first significant word starts the same way
// (first 6 letters, so "Halgårdvej" finds "Halgård Skolevej" and "Fjeldstrupsvej" finds "Fjelstrup Vej");
// the postcode, when known, decides between several candidates and adds confidence.
const fold = (value) => String(value ?? '')
  .toLocaleLowerCase('da')
  .replace(/[æ]/g, 'ae').replace(/[ø]/g, 'o').replace(/[å]/g, 'a')
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

const PREFIXES = new Set(['ef', 'gf', 'af', 'cibus']);
function words(value) {
  return fold(value).replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}
function firstWord(value) {
  // Skip "E/F", "GF", "Gl." and other short prefixes: the street or centre name is the first real word.
  return words(value).find((word) => !PREFIXES.has(word) && /[a-z]/.test(word) && word.length >= 3) || '';
}
const stem = (word) => word.slice(0, 6);

function createPropertyMatcher(properties = []) {
  const entries = properties.map((property) => ({
    property,
    zip: String(property.zipCode || '').trim(),
    stems: new Set([property.name, property.address, ...String(property.address2 || '').split(',')]
      .filter(Boolean)
      .flatMap((text) => words(text).filter((word) => /[a-z]/.test(word) && word.length >= 3).map(stem))),
  }));
  return {
    match(name, zip = null) {
      const word = firstWord(name);
      if (word.length < 3) return null;
      const key = stem(word);
      const candidates = entries.filter((entry) => entry.stems.has(key));
      if (!candidates.length) return null;
      const zipText = zip == null ? '' : String(zip).trim();
      const sameZip = zipText ? candidates.filter((entry) => entry.zip === zipText) : [];
      if (sameZip.length === 1) return sameZip[0].property;
      if (candidates.length === 1) return candidates[0].property;
      const pool = sameZip.length ? sameZip : candidates;
      // Several properties share the word (e.g. "Grindsted"): prefer the one whose name starts with it,
      // then the one with the same house number.
      const byFirstWord = pool.filter((entry) => stem(firstWord(entry.property.name)) === key);
      if (byFirstWord.length === 1) return byFirstWord[0].property;
      const number = (fold(name).match(/\d+/) || [])[0];
      const byNumber = pool.filter((entry) => number && words(entry.property.name).concat(words(entry.property.address)).includes(number));
      return byNumber.length === 1 ? byNumber[0].property : null;
    },
  };
}

module.exports = { createPropertyMatcher, fold };
