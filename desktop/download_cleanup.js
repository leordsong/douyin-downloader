const fs = require('node:fs/promises');
const path = require('node:path');

// Completed media and live room sidecars; preserve temporary and unrelated files.
const MEDIA_EXTENSIONS = new Set([
  '.flv', '.mp4', '.mkv', '.mov', '.webm', '.m3u8', '.ts',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic',
]);

const isRoomMetadata = (name) => name.endsWith('_room.json');

async function roomHasMedia(target) {
  const stem = path.basename(target).slice(0, -'_room.json'.length);
  return (await fs.readdir(path.dirname(target))).some((name) =>
    name.startsWith(stem + '.') &&
    (MEDIA_EXTENSIONS.has(path.extname(name).toLowerCase()) || name.endsWith('.tmp')));
}

async function checkParents(root, target) {
  const relative = path.relative(root, target);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error('文件不在下载目录内');
  }
  let parent = path.dirname(target);
  for (;;) {
    const info = await fs.lstat(parent);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('目录已改变');
    if (parent === root) break;
    parent = path.dirname(parent);
  }
}

function cutoffForDays(days, now = Date.now()) {
  if (!Number.isSafeInteger(days) || days < 1 || days > 36500) {
    throw new Error('天数必须是 1 到 36500 之间的整数');
  }
  return now - days * 24 * 60 * 60 * 1000;
}

async function hasPendingRecording(target) {
  try {
    await fs.lstat(target + '.tmp');
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

async function scanDownloads(directory, days) {
  const cutoff = cutoffForDays(days);
  if (typeof directory !== 'string' || !directory.trim() || !path.isAbsolute(directory)) {
    throw new Error('请先设置有效的绝对下载目录');
  }
  const root = path.resolve(directory);
  if (root === path.parse(root).root) throw new Error('不能清理磁盘根目录');
  const files = [];
  const directories = [];
  const errors = [];
  async function visit(dir) {
    // Never follow symbolic links or Windows junctions, including the selected root.
    const stat = await fs.lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`不是普通目录或为符号链接：${dir}`);
    }
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const target = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) await visit(target);
        else if (entry.isFile() && (MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) ||
            isRoomMetadata(entry.name))) {
          const info = await fs.lstat(target);
          if (info.isFile() && !info.isSymbolicLink() && info.mtimeMs < cutoff &&
              !await hasPendingRecording(target)) {
            files.push({ path: target, size: info.size, mtimeMs: info.mtimeMs, ino: info.ino, dev: info.dev });
          }
        }
      } catch (err) {
        errors.push({ path: target, error: err.message });
      }
    }
    // Post-order permits pruning recording / live / author directories up to the root.
    if (dir !== root && (stat.mtimeMs < cutoff || files.some((file) =>
      file.path.startsWith(dir + path.sep)))) {
      directories.push({ path: dir, ino: stat.ino, dev: stat.dev });
    }
  }
  try {
    await visit(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  // Remove metadata only after its corresponding media has been removed successfully.
  files.sort((a, b) => Number(isRoomMetadata(path.basename(a.path))) -
    Number(isRoomMetadata(path.basename(b.path))));
  return { root, cutoff, files, directories, errors, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

async function trashDownloads(plan, trashItem) {
  const result = { count: 0, bytes: 0, skipped: 0, directories: 0, errors: [...plan.errors] };
  for (const file of plan.files) {
    try {
      await checkParents(plan.root, file.path);
      const info = await fs.lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= plan.cutoff ||
          info.mtimeMs !== file.mtimeMs || info.size !== file.size ||
          info.ino !== file.ino || info.dev !== file.dev ||
          await hasPendingRecording(file.path) ||
          (isRoomMetadata(path.basename(file.path)) && await roomHasMedia(file.path))) {
        result.skipped += 1;
        continue;
      }
      await trashItem(file.path);
      result.count += 1;
      result.bytes += file.size;
    } catch (err) {
      if (err.code === 'ENOENT') result.skipped += 1;
      else result.errors.push({ path: file.path, code: err.code,
        error: `${err.code ? err.code + ': ' : ''}${err.message}` });
    }
  }
  for (const directory of plan.directories || []) {
    try {
      await checkParents(plan.root, directory.path);
      const info = await fs.lstat(directory.path);
      if (!info.isDirectory() || info.isSymbolicLink() ||
          info.ino !== directory.ino || info.dev !== directory.dev) continue;
      // Never recursively delete: a concurrent recording creating a file prevents rmdir.
      await fs.rmdir(directory.path);
      result.directories += 1;
    } catch (err) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(err.code)) {
        result.errors.push({ path: directory.path, code: err.code, error: err.message });
      }
    }
  }
  return result;
}

module.exports = { cutoffForDays, scanDownloads, trashDownloads };
