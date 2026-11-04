const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { cutoffForDays, scanDownloads, trashDownloads } = require('../download_cleanup');

async function fixture(t) {
  const base = path.resolve(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, 'douyin-cleanup-'));
  t.after(async () => {
    assert.equal(path.dirname(root), base);
    assert.ok(path.basename(root).startsWith('douyin-cleanup-'));
    await fs.rm(root, { recursive: true, force: true });
  });
  async function write(name, days = 10) {
    const target = path.join(root, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'media');
    const date = new Date(Date.now() - days * 86400000);
    await fs.utimes(target, date, date);
    return target;
  }
  return { root, write };
}

test('validates day count and exact rolling cutoff', () => {
  assert.equal(cutoffForDays(7, 10 * 86400000), 3 * 86400000);
  for (const days of [0, -1, 1.5, NaN, Infinity, '7', null, 36501]) {
    assert.throws(() => cutoffForDays(days), /整数/);
  }
});

test('scans nested completed media, preserving recent, temporary and unrelated files', async (t) => {
  const { root, write } = await fixture(t);
  const old = await write('主播/live/old.FLV');
  await write('new.mp4', 1);
  await write('partial.flv.tmp');
  await write('metadata.json');
  await write('notes.txt');
  const photo = await write('gallery/photo.jpg');
  const plan = await scanDownloads(root, 7);
  assert.deepEqual(plan.files.map((file) => file.path).sort(), [old, photo].sort());
  assert.equal(plan.bytes, 10);
  assert.deepEqual(plan.errors, []);
  const trashed = [];
  const result = await trashDownloads(plan, async (target) => trashed.push(target));
  assert.equal(result.count, 2);
  assert.equal(result.bytes, 10);
  assert.deepEqual(trashed.sort(), [old, photo].sort());
});

test('skips files changed or removed since preview and reports trash errors', async (t) => {
  const { root, write } = await fixture(t);
  const changed = await write('changed.flv');
  const removed = await write('removed.flv');
  const failed = await write('failed.flv');
  const plan = await scanDownloads(root, 7);
  await fs.writeFile(changed, 'new recording');
  await fs.unlink(removed);
  const attempted = [];
  const result = await trashDownloads(plan, async (target) => {
    attempted.push(target);
    throw new Error('access denied');
  });
  assert.deepEqual(attempted, [failed]);
  assert.equal(result.count, 0);
  assert.equal(result.skipped, 2);
  assert.equal(result.errors[0].error, 'access denied');
});

test('preserves ongoing recordings and same-name targets while cleaning expired files', async (t) => {
  const { root, write } = await fixture(t);
  const old = await write('old.flv');
  const active = await write('active.flv');
  const pending = await write('active.flv.tmp');
  const plan = await scanDownloads(root, 7);
  assert.deepEqual(plan.files.map((file) => file.path), [old]);
  await trashDownloads(plan, async (target) => {
    assert.equal(target, old);
    await fs.unlink(target);
  });
  assert.equal((await fs.stat(active)).isFile(), true);
  assert.equal((await fs.stat(pending)).isFile(), true);
});

test('skips a target when recording starts after the scan', async (t) => {
  const { root, write } = await fixture(t);
  await write('old.flv');
  const plan = await scanDownloads(root, 7);
  await write('old.flv.tmp', 0);
  const result = await trashDownloads(plan, async () => assert.fail('recording target must be preserved'));
  assert.equal(result.count, 0);
  assert.equal(result.skipped, 1);
});

test('does not traverse directory links or a linked download root', async (t) => {
  const { root, write } = await fixture(t);
  await write('real/old.flv');
  const link = path.join(root, 'linked');
  await fs.symlink(path.join(root, 'real'), link, process.platform === 'win32' ? 'junction' : 'dir');
  const plan = await scanDownloads(root, 7);
  assert.equal(plan.files.length, 1);
  await assert.rejects(scanDownloads(link, 7), /符号链接/);
});

test('rejects a directory replaced by a link after preview', async (t) => {
  const { root, write } = await fixture(t);
  await write('recordings/old.flv');
  const plan = await scanDownloads(root, 7);
  await fs.rename(path.join(root, 'recordings'), path.join(root, 'moved'));
  await fs.symlink(path.join(root, 'moved'), path.join(root, 'recordings'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const result = await trashDownloads(plan, async () => assert.fail('must not trash through link'));
  assert.equal(result.count, 0);
  assert.equal(result.errors.length, 1);
});

test('missing download directory is empty; relative and disk root paths are rejected', async (t) => {
  const { root } = await fixture(t);
  assert.equal((await scanDownloads(path.join(root, 'missing'), 7)).files.length, 0);
  await assert.rejects(scanDownloads('', 7), /绝对/);
  await assert.rejects(scanDownloads('relative', 7), /绝对/);
  await assert.rejects(scanDownloads(path.parse(root).root, 7), /根目录/);
});
