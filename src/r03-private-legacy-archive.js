import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { closeSync, constants, createReadStream, fstatSync, lstatSync,
  openSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const fail = () => { throw new Error('private_legacy_import_unavailable'); };

export function privateDirectory(path) {
  try {
    if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path ||
        realpathSync(path) !== path || !lstatSync(path).isDirectory() ||
        lstatSync(path).mode & 0o077 || lstatSync(path).uid !== process.getuid()) fail();
  } catch { fail(); }
}

export function privateBytes(path, maxBytes) {
  privateDirectory(dirname(path));
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 ||
        info.size < 1 || info.size > maxBytes) fail();
    const bytes = readFileSync(fd);
    if (bytes.length !== info.size) fail();
    return bytes;
  } catch { fail(); }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function readPrivateJson(path, maxBytes) {
  try { return JSON.parse(privateBytes(path, maxBytes).toString('utf8')); } catch { fail(); }
}

export async function digestPrivateFile(path, maxBytes) {
  privateDirectory(dirname(path));
  let fd;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
  catch { fail(); }
  const info = fstatSync(fd);
  if (!info.isFile() || info.uid !== process.getuid() || info.mode & 0o077 ||
      info.size < 1 || info.size > maxBytes) { closeSync(fd); fail(); }
  const hash = createHash('sha256');
  let bytes = 0;
  try { for await (const chunk of createReadStream(null, { fd, autoClose: false })) {
    hash.update(chunk); bytes += chunk.length;
  } } finally { closeSync(fd); }
  return { bytes, sha256: hash.digest('hex') };
}

export function checkedTar(archivePath) {
  const list = spawnSync('tar', ['-tf', archivePath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  const verbose = spawnSync('tar', ['-tvf', archivePath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  if (list.status !== 0 || verbose.status !== 0) fail();
  const paths = list.stdout.split('\n').filter(Boolean);
  const types = verbose.stdout.split('\n').filter(Boolean);
  if (paths.length !== types.length || paths.length > 100_000 ||
      new Set(paths).size !== paths.length ||
      paths.some(path => path.startsWith('/') || path.split('/').includes('..') || path.includes('\\') ||
        /[\x00-\x1f\x7f]/.test(path) || !['agent-data/hh', 'agent-tokens', 'users'].some(root =>
          path === root || path === `${root}/` || path.startsWith(`${root}/`))) ||
      types.some(line => !['-', 'd'].includes(line[0]))) fail();
  return paths;
}

function parseBytes(bytes) {
  try { return JSON.parse(bytes.toString('utf8')); } catch { fail(); }
}

export function buildInput(root, row, migrationId) {
  const dir = join(root, 'agent-data', 'hh', row.sourceProfileRef, 'proactive');
  const files = readdirSync(dir);
  if (!files.includes('all-candidates.json') || !files.includes('seen-ids.json')) fail();
  const sourceFiles = {}, snapshots = [], comments = Object.create(null);
  const read = name => { const bytes = privateBytes(join(dir, name), 32 * 1024 * 1024);
    sourceFiles[name] = bytes; return parseBytes(bytes); };
  const allCandidates = read('all-candidates.json');
  const seenIds = read('seen-ids.json');
  let globalComments = null;
  for (const name of files) {
    if (/^search-results-[A-Za-z0-9_-]+\.json$/.test(name))
      snapshots.push({ sourceFile: name, payload: read(name) });
    else if (name === 'candidate-comments.json') globalComments = read(name);
    else if (/^candidate-comments-.+\.json$/.test(name)) {
      let vacancyId;
      try { vacancyId = decodeURIComponent(name.slice('candidate-comments-'.length, -'.json'.length)); }
      catch { fail(); }
      if (comments[vacancyId] !== undefined) fail();
      comments[vacancyId] = read(name);
    }
  }
  return { migrationId, sourceProfileRef: row.sourceProfileRef, allCandidates, seenIds,
    snapshots, comments, globalComments, expectedCounts: row.expectedCounts, sourceFiles };
}

export function relevantSources(root) {
  const hh = join(root, 'agent-data', 'hh');
  return readdirSync(hh, { withFileTypes: true }).filter(entry => entry.isDirectory())
    .filter(entry => {
      let files;
      try { files = readdirSync(join(hh, entry.name, 'proactive')); } catch { return false; }
      return files.some(file => file === 'all-candidates.json' || file === 'seen-ids.json' ||
        /^search-results-.*\.json$/.test(file) || /^candidate-comments(?:-.*)?\.json$/.test(file));
    }).map(entry => entry.name).sort();
}
