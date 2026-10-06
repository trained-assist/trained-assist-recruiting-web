import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = join(root, 'ops/r03-release.py');
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const revision = git.stdout.trim();

function python(...args) {
  return spawnSync('python3', [script, ...args], { cwd: root, encoding: 'utf8' });
}

test('release artifact binds source commit, archive digest and fails closed on a wrong approved digest', () => {
  assert.equal(git.status, 0);
  const directory = mkdtempSync(join(tmpdir(), 'r03-release-'));
  try {
    const archive = join(directory, 'source.tar');
    const manifestPath = join(directory, 'manifest.json');
    const packaged = python('package', '--source', root, '--source-sha', revision,
      '--archive', archive, '--manifest', manifestPath);
    assert.equal(packaged.status, 0, packaged.stderr);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    assert.equal(manifest.sourceSha, revision);
    assert.equal(manifest.repository, 'trained-assist/trained-assist-recruiting-web');
    const verified = python('verify', '--archive', archive, '--manifest', manifestPath,
      '--approved-sha256', manifest.archiveSha256);
    assert.equal(verified.status, 0, verified.stderr);
    const rejected = python('verify', '--archive', archive, '--manifest', manifestPath,
      '--approved-sha256', '0'.repeat(64));
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /artifact_manifest_mismatch/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('staged release is readable by the service user and rejects escaping dependency links', () => {
  const result = spawnSync('python3', ['-c', `
import importlib.util, pathlib, tempfile, os
spec = importlib.util.spec_from_file_location('release', ${JSON.stringify(script)})
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as outer:
    root = pathlib.Path(outer) / 'release'
    child = root / 'src'
    child.mkdir(parents=True, mode=0o700)
    source = child / 'server.js'
    source.write_text('ok')
    source.chmod(0o600)
    module.make_release_readable(root)
    assert root.stat().st_mode & 0o777 == 0o755
    assert child.stat().st_mode & 0o777 == 0o755
    assert source.stat().st_mode & 0o777 == 0o644
    outside = pathlib.Path(outer) / 'outside'
    outside.write_text('x')
    (root / 'escape').symlink_to(outside)
    try:
        module.make_release_readable(root)
    except RuntimeError as error:
        assert str(error) == 'release_dependency_symlink_escapes_root'
    else:
        raise AssertionError('external symlink accepted')
`], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
