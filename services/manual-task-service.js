// Opgaver, der ikke findes i Propbinder, men er meldt ind på anden vis (fx Stokas ugentlige tidsforbrug pr. mail).
// Hver JSON-fil i `root` har { source: { subject, from, received }, tasks: [{ key, title, propertyNumber, ... }] }.
// Rækkerne får samme form som Propbinder-opgaverne, så de står i samme liste, grafer og filtre, men er markeret
// med kilden ("Fra mail"). Filerne læses igen, når de ændres.
const fs = require('fs');
const path = require('path');

function createManualTaskService({ root, fsImpl = fs } = {}) {
  let cache = null;
  const files = () => {
    if (!root || !fsImpl.existsSync(root)) return [];
    return fsImpl.readdirSync(root).filter((name) => name.toLowerCase().endsWith('.json')).sort()
      .map((name) => ({ file: path.join(root, name), stat: fsImpl.statSync(path.join(root, name)) }));
  };
  return {
    // Rows for the task list. `properties` is the Map EjendomNr -> property of the active Cibus properties.
    getTasks(properties = new Map()) {
      const list = files();
      const version = list.map(({ file, stat }) => `${file}:${stat.mtimeMs}`).join('|');
      if (!cache || cache.version !== version) {
        const rows = [];
        const errors = [];
        for (const { file } of list) {
          try {
            const data = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
            for (const task of data.tasks || []) rows.push({ task, source: data.source || {}, file: path.basename(file) });
          } catch (error) {
            errors.push(`${path.basename(file)}: ${error.message}`);
          }
        }
        cache = { version, rows, errors };
      }
      const tasks = cache.rows.map(({ task, source }) => {
        const number = task.propertyNumber ? String(task.propertyNumber).toUpperCase() : null;
        const property = number ? properties.get(number) : null;
        const sourceLabel = source.type === 'mail' ? `mail "${source.subject}" fra ${source.from}` : (source.subject || 'manuel registrering');
        return {
          id: task.key,
          number: null,
          kind: 'Opgave',
          manual: true,
          title: task.title,
          description: [task.timeSpent ? `Tidsforbrug: ${task.timeSpent}` : null, task.mailDates ? `mails ${task.mailDates}` : null, `Kilde: ${sourceLabel}`].filter(Boolean).join(' · '),
          status: task.status || 'Ikke angivet',
          statusId: null,
          priority: null,
          createdAt: task.firstDate ? `${task.firstDate}T00:00:00` : source.received || null,
          startDate: null,
          dueDate: null,
          assignedTo: task.assignedTo || source.from || null,
          updatedAt: source.received || null,
          timeSpent: task.timeSpent || null,
          minutes: Number.isFinite(task.minutes) ? task.minutes : null,
          propertyNumber: property ? number : null,
          property: property ? property.name : null,
          propertyAddress: property ? [property.address, [property.zipCode, property.city].filter(Boolean).join(' ')].filter(Boolean).join(', ') || null : null,
          propertyNote: task.propertyNote || (number && !property ? `${number} er ikke en aktiv Cibus-ejendom` : null),
          link: { via: 'mail', evidence: task.propertyNote || null },
          source: { subject: source.subject, from: source.from, received: source.received },
        };
      });
      return { tasks, errors: cache.errors };
    },
  };
}

module.exports = { createManualTaskService };
