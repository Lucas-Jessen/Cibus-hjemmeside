// Kontrakter: a folder per active Cibus property under `root` ("F4352 Prøvestenscenteret/01 kontrakt/…").
// Folders are created for new active properties; a property's folder is found by its EjendomNr prefix, so a
// renamed property keeps its folder. Every subfolder and file found on disk is listed, so more folders can be
// added later without code changes. Files are only served when they appear in the listing (no path from input).
const fs = require('fs');
const path = require('path');

const DEFAULT_FOLDERS = ['01 kontrakt'];
const safeName = (value) => String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, ' ').replace(/\s+/g, ' ').trim().replace(/[. ]+$/, '');
const isVisible = (name) => !name.startsWith('.') && !name.startsWith('~$') && name.toLowerCase() !== 'desktop.ini' && name.toLowerCase() !== 'thumbs.db';

function createContractService({ root, fsImpl = fs, defaultFolders = DEFAULT_FOLDERS } = {}) {
  const folderFor = (number) => {
    if (!fsImpl.existsSync(root)) return null;
    const match = fsImpl.readdirSync(root, { withFileTypes: true }).find((entry) => entry.isDirectory() && entry.name.split(' ')[0].toUpperCase() === number.toUpperCase());
    return match ? path.join(root, match.name) : null;
  };

  return {
    root,
    // Creates "<EjendomNr> <navn>/01 kontrakt" for every property that has no folder yet. Existing folders and
    // files are never renamed or removed.
    ensureStructure(properties) {
      fsImpl.mkdirSync(root, { recursive: true });
      const created = [];
      for (const property of properties) {
        if (!/^F\d{4}$/i.test(property.number || '')) continue;
        let folder = folderFor(property.number);
        if (!folder) {
          folder = path.join(root, safeName(`${property.number} ${property.name || ''}`));
          created.push(path.basename(folder));
        }
        for (const sub of defaultFolders) fsImpl.mkdirSync(path.join(folder, sub), { recursive: true });
      }
      return created;
    },

    // One entry per property (in the given order) with its folders, files and counts.
    list(properties) {
      return properties.map((property) => {
        const folder = folderFor(property.number);
        const folders = [];
        if (folder) {
          for (const entry of fsImpl.readdirSync(folder, { withFileTypes: true }).filter((e) => e.isDirectory() && isVisible(e.name)).sort((a, b) => a.name.localeCompare(b.name, 'da'))) {
            const dir = path.join(folder, entry.name);
            const files = fsImpl.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && isVisible(e.name)).map((e) => {
              const stat = fsImpl.statSync(path.join(dir, e.name));
              return { name: e.name, size: stat.size, modifiedAt: stat.mtime.toISOString() };
            }).sort((a, b) => a.name.localeCompare(b.name, 'da'));
            folders.push({ name: entry.name, files });
          }
        }
        const fileCount = folders.reduce((sum, f) => sum + f.files.length, 0);
        return { ...property, folderName: folder ? path.basename(folder) : null, folders, fileCount };
      });
    },

    // Absolute path of a listed file, or null. Only names that appear in the listing are accepted.
    resolveFile(property, folderName, fileName) {
      const [entry] = this.list([property]);
      const folder = entry.folders.find((f) => f.name === folderName);
      if (!entry.folderName || !folder || !folder.files.some((f) => f.name === fileName)) return null;
      return path.join(root, entry.folderName, folder.name, fileName);
    },
  };
}

module.exports = { createContractService, safeName, DEFAULT_FOLDERS };
