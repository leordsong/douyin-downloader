const fs = require('node:fs/promises');
const path = require('node:path');

// Only completed media files; leave metadata, temporary files and other documents alone.
const MEDIA_EXTENSIONS = new Set([
  '.flv', '.mp4', '.mkv', '.mov', '.webm', '.m3u8', '.ts',
  '.mp3', '.m4a', '.aac', '.wav', '.ogg', '.flac',
  '.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic',
]);

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
        else if (entry.isFile() && MEDIA_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
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
  }
  try {
    await visit(root);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { root, cutoff, files, errors, bytes: files.reduce((sum, file) => sum + file.size, 0) };
}

async function trashDownloads(plan, trashItem) {
  const result = { count: 0, bytes: 0, skipped: 0, errors: [...plan.errors] };
  for (const file of plan.files) {
    try {
      const relative = path.relative(plan.root, file.path);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        throw new Error('文件不在下载目录内');
      }
      // Recheck every parent after the confirmation dialog in case a folder was replaced.
      let parent = path.dirname(file.path);
      for (;;) {
        const info = await fs.lstat(parent);
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('目录已改变');
        if (parent === plan.root) break;
        parent = path.dirname(parent);
      }
      const info = await fs.lstat(file.path);
      if (!info.isFile() || info.isSymbolicLink() || info.mtimeMs >= plan.cutoff ||
          info.mtimeMs !== file.mtimeMs || info.size !== file.size ||
          info.ino !== file.ino || info.dev !== file.dev ||
          await hasPendingRecording(file.path)) {
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
  return result;
}

module.exports = { cutoffForDays, scanDownloads, trashDownloads };
