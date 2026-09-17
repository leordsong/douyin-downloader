#!/usr/bin/env node
/**
 * 打包前暂存：把 Electron 之外需要随包分发的文件聚拢到 desktop/staging/。
 *
 * - python-project/  仓库里的 Python 后端源码（白名单目录/文件），
 *                    供打包后首次启动释放到 %APPDATA%/douyin-downloader-ui/backend
 *                    并执行 `uv sync --extra browser`。
 *                    注意：绝不打包 config.yml、config/cookies.json 等本机私密文件。
 * - vendor/uv/       本机的 uv.exe（首次启动用它创建 venv 并安装依赖）。
 *
 * electron-builder 通过 package.json 的 build.extraResources 把 staging/ 内容
 * 放进安装目录的 resources/。
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(DESKTOP_DIR, '..');
const STAGING = path.join(DESKTOP_DIR, 'staging');
const IS_WIN = process.platform === 'win32';

const PROJECT_DIRS = ['auth', 'cli', 'config', 'control', 'core', 'storage', 'utils', 'tools', 'server'];
const PROJECT_FILES = ['pyproject.toml', 'uv.lock', 'run.py', '__init__.py'];

function findUv() {
  const probe = spawnSync(IS_WIN ? 'where' : 'which', ['uv'], { encoding: 'utf8', windowsHide: true });
  if (probe.status !== 0) return null;
  const first = String(probe.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
  return first || null;
}

function dirSize(p) {
  let total = 0;
  for (const entry of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, entry.name);
    total += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return total;
}

function main() {
  fs.rmSync(STAGING, { recursive: true, force: true });
  const projDir = path.join(STAGING, 'python-project');
  fs.mkdirSync(projDir, { recursive: true });

  let missing = [];

  for (const name of PROJECT_FILES) {
    const src = path.join(ROOT, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(projDir, name));
    else missing.push(name);
  }

  for (const dir of PROJECT_DIRS) {
    const src = path.join(ROOT, dir);
    if (!fs.existsSync(src)) {
      missing.push(dir);
      continue;
    }
    fs.cpSync(src, path.join(projDir, dir), {
      recursive: true,
      filter: (s) => {
        const rel = path.relative(src, s);
        if (rel.split(/[\\/]/).includes('__pycache__')) return false;
        // 防止把本机 cookies 打进安装包
        if (dir === 'config' && rel === 'cookies.json') return false;
        return true;
      },
    });
  }

  // 监控脚本随包：打包后位于 <backend>/desktop/live_monitor.py
  fs.mkdirSync(path.join(projDir, 'desktop'), { recursive: true });
  fs.cpSync(path.join(DESKTOP_DIR, 'live_monitor.py'), path.join(projDir, 'desktop', 'live_monitor.py'));

  // 捆绑 uv
  const uvPath = findUv();
  if (!uvPath) {
    console.error('[prepare-dist] 未找到 uv（where uv 失败），无法捆绑。请先安装 uv。');
    process.exit(1);
  }
  const vendorDir = path.join(STAGING, 'vendor', 'uv');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.cpSync(uvPath, path.join(vendorDir, IS_WIN ? 'uv.exe' : 'uv'));

  if (missing.length) {
    console.warn(`[prepare-dist] 警告：以下项目在仓库中不存在，已跳过：${missing.join(', ')}`);
  }
  const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
  console.log(`[prepare-dist] python-project: ${mb(dirSize(projDir))} -> ${projDir}`);
  console.log(`[prepare-dist] uv: ${uvPath} -> ${path.join(vendorDir, IS_WIN ? 'uv.exe' : 'uv')}`);
}

main();
