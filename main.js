const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');

let mainWindow;

const REQUIRED_GHOST_FILES = [
  'persona.txt',
  'topics.json',
  'messages.json',
  'ghost_normal.png',
  'ghost_happy.png',
  'ghost_sad.png',
  'ghost_surprised.png',
];

const REQUIRED_SHELL_FILES = [
  'persona.txt',
  'topics.json',
  'ghost_normal.png',
  'ghost_happy.png',
  'ghost_sad.png',
  'ghost_surprised.png',
];

const OPTIONAL_GHOST_FILES = [
  'style_examples.json',
  'ghost_design.json',
  'main_menu.png',
  'main_manu.png',
  'window_yoko.png',
];

const OPTIONAL_SHELL_FILES = [
  'style_examples.json',
  'shell.json',
  'messages.json',
];

function getBundledResourceDir() {
  return app.isPackaged ? process.resourcesPath : __dirname;
}

function getCurrentGhostDir() {
  return path.join(app.getPath('userData'), 'current_ghost');
}

function getCurrentShellDir() {
  return path.join(app.getPath('userData'), 'current_shell');
}

function getMemoryPath() {
  return path.join(app.getPath('userData'), 'memory.json');
}

function getGhostMetaPath() {
  return path.join(getCurrentGhostDir(), '.ghost_meta.json');
}

function getShellMetaPath() {
  return path.join(getCurrentShellDir(), '.shell_meta.json');
}

function getShellChangePendingPath() {
  return path.join(app.getPath('userData'), 'shell_change_pending.json');
}

function readJsonFile(filePath, fallback = null) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
  } catch (error) {
    console.error('JSON読み込み失敗:', filePath, error);
    return fallback;
  }
}

function hasShellFiles(shellDir) {
  return REQUIRED_SHELL_FILES.every((file) => {
    return fs.existsSync(path.join(shellDir, file));
  });
}

function getGhostId() {
  const metaPath = getGhostMetaPath();
  if (!fs.existsSync(metaPath)) {
    const currentGhostDir = getCurrentGhostDir();
    const hasCurrentGhost = REQUIRED_GHOST_FILES.every((file) => {
      return fs.existsSync(path.join(currentGhostDir, file));
    });

    if (!hasCurrentGhost) return 'bundled-default-ghost';

    const hash = crypto.createHash('sha256');
    for (const file of ['persona.txt', 'messages.json']) {
      hash.update(fs.readFileSync(path.join(currentGhostDir, file)));
    }
    return `legacy-${hash.digest('hex').slice(0, 16)}`;
  }

  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return meta.ghostId || 'bundled-default-ghost';
  } catch (error) {
    console.error('Ghostメタ情報の読み込み失敗:', error);
    return 'bundled-default-ghost';
  }
}

function getShellId() {
  const shellDir = getCurrentShellDir();
  if (!hasShellFiles(shellDir)) return 'default-shell';

  const metaPath = getShellMetaPath();
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return meta.shellId || 'default-shell';
    } catch (error) {
      console.error('Shellメタ情報の読み込み失敗:', error);
    }
  }

  const hash = crypto.createHash('sha256');
  for (const file of ['persona.txt', 'topics.json']) {
    hash.update(fs.readFileSync(path.join(shellDir, file)));
  }
  return `legacy-shell-${hash.digest('hex').slice(0, 16)}`;
}

function getGhostBaseDir() {
  const currentGhostDir = getCurrentGhostDir();
  const hasCurrentGhost = REQUIRED_GHOST_FILES.every((file) => {
    return fs.existsSync(path.join(currentGhostDir, file));
  });

  return hasCurrentGhost ? currentGhostDir : getBundledResourceDir();
}

function getShellBaseDir() {
  const currentShellDir = getCurrentShellDir();
  return hasShellFiles(currentShellDir) ? currentShellDir : getGhostBaseDir();
}

function getActiveShellKey() {
  const currentShellDir = getCurrentShellDir();
  if (!hasShellFiles(currentShellDir)) return 'normal';

  const meta = readJsonFile(getShellMetaPath(), {});
  if (meta?.shellKey) return meta.shellKey;
  if (meta?.sourceType && meta?.shellName) return `${meta.sourceType}:${meta.shellName}`;
  if (meta?.shellName) return `bundled:${meta.shellName}`;
  return getShellId();
}

async function markShellChangePending(shellKey) {
  await fs.writeJson(getShellChangePendingPath(), {
    shellKey,
    changedAt: new Date().toISOString(),
  }, { spaces: 2 });
}

function validateGhostFolder(folderPath) {
  if (!folderPath || !fs.existsSync(folderPath)) {
    return { ok: false, missingFiles: REQUIRED_GHOST_FILES, reason: 'フォルダが見つかりません。' };
  }

  const stat = fs.statSync(folderPath);
  if (!stat.isDirectory()) {
    return { ok: false, missingFiles: REQUIRED_GHOST_FILES, reason: 'フォルダではありません。' };
  }

  const missingFiles = REQUIRED_GHOST_FILES.filter((file) => {
    return !fs.existsSync(path.join(folderPath, file));
  });

  if (missingFiles.length > 0) {
    return { ok: false, missingFiles, reason: '必要なファイルが足りません。' };
  }

  try {
    JSON.parse(fs.readFileSync(path.join(folderPath, 'topics.json'), 'utf8'));
    JSON.parse(fs.readFileSync(path.join(folderPath, 'messages.json'), 'utf8'));
    const styleExamplesPath = path.join(folderPath, 'style_examples.json');
    if (fs.existsSync(styleExamplesPath)) JSON.parse(fs.readFileSync(styleExamplesPath, 'utf8'));
    const ghostDesignPath = path.join(folderPath, 'ghost_design.json');
    if (fs.existsSync(ghostDesignPath)) JSON.parse(fs.readFileSync(ghostDesignPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      missingFiles: [],
      reason: `JSONファイルの中身が正しくありません: ${error.message}`,
    };
  }

  return { ok: true, missingFiles: [], reason: '' };
}

function validateShellFolder(shellDir, label = 'Shell') {
  if (!shellDir || !fs.existsSync(shellDir)) {
    return {
      ok: false,
      missingFiles: REQUIRED_SHELL_FILES,
      reason: `${label}フォルダが見つかりません。`,
    };
  }

  const stat = fs.statSync(shellDir);
  if (!stat.isDirectory()) {
    return { ok: false, missingFiles: REQUIRED_SHELL_FILES, reason: `${label}はフォルダではありません。` };
  }

  const missingFiles = REQUIRED_SHELL_FILES.filter((file) => {
    return !fs.existsSync(path.join(shellDir, file));
  });

  if (missingFiles.length > 0) {
    return { ok: false, missingFiles, reason: 'Shellに必要なファイルが足りません。' };
  }

  try {
    JSON.parse(fs.readFileSync(path.join(shellDir, 'topics.json'), 'utf8'));
    const styleExamplesPath = path.join(shellDir, 'style_examples.json');
    if (fs.existsSync(styleExamplesPath)) JSON.parse(fs.readFileSync(styleExamplesPath, 'utf8'));
    const shellMetaPath = path.join(shellDir, 'shell.json');
    if (fs.existsSync(shellMetaPath)) JSON.parse(fs.readFileSync(shellMetaPath, 'utf8'));
    const messagesPath = path.join(shellDir, 'messages.json');
    if (fs.existsSync(messagesPath)) JSON.parse(fs.readFileSync(messagesPath, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      missingFiles: [],
      reason: `topicsファイルの中身が正しくありません: ${error.message}`,
    };
  }

  return { ok: true, missingFiles: [], reason: '' };
}

function readShellDisplayName(shellDir, fallbackName) {
  const meta = readJsonFile(path.join(shellDir, 'shell.json'), {});
  return meta?.displayName || meta?.name || fallbackName;
}

function addShellsFrom(shells, seenKeys, parentDir, sourceType) {
  if (!fs.existsSync(parentDir)) return;

  const entries = fs.readdirSync(parentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const shellName = entry.name;
    const shellDir = path.join(parentDir, shellName);
    const validation = validateShellFolder(shellDir, `${sourceType}:${shellName}`);
    if (!validation.ok) continue;

    const key = `${sourceType}:${shellName}`;
    if (seenKeys.has(key)) continue;

    seenKeys.add(key);
    shells.push({
      key,
      shellName,
      displayName: readShellDisplayName(shellDir, shellName),
      sourceType,
    });
  }
}

function listAvailableShells() {
  const activeShellKey = getActiveShellKey();
  const ghostBaseDir = getGhostBaseDir();
  const bundledResourceDir = getBundledResourceDir();
  const shells = [
    {
      key: 'normal',
      shellName: 'normal',
      displayName: 'normal',
      sourceType: 'ghost',
    },
  ];
  const seenKeys = new Set(['normal']);

  if (ghostBaseDir !== bundledResourceDir) {
    addShellsFrom(shells, seenKeys, path.join(ghostBaseDir, 'shells'), 'ghost');
  }
  addShellsFrom(shells, seenKeys, path.join(bundledResourceDir, 'shells'), 'bundled');

  return shells.map((shell) => ({
    ...shell,
    active: shell.key === activeShellKey,
  }));
}

function resolveShellKey(shellKey) {
  if (shellKey === 'normal') {
    return { ok: true, shellKey, shellName: 'normal', sourceType: 'ghost', shellDir: getGhostBaseDir() };
  }

  const match = String(shellKey || '').match(/^(ghost|bundled):([a-zA-Z0-9_-]+)$/);
  if (!match) {
    return { ok: false, reason: 'Shellの指定が正しくありません。', missingFiles: [] };
  }

  const [, sourceType, shellName] = match;
  const parentDir = sourceType === 'ghost'
    ? path.join(getGhostBaseDir(), 'shells')
    : path.join(getBundledResourceDir(), 'shells');
  const shellDir = path.join(parentDir, shellName);
  const validation = validateShellFolder(shellDir, `${sourceType}:${shellName}`);
  if (!validation.ok) return validation;

  return { ok: true, shellKey, shellName, sourceType, shellDir };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 800,
    height: 600,
    transparent: true,
    frame: false,
    alwaysOnTop: false,
    resizable: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.on('blur', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.setAlwaysOnTop(false);
  });
}

app.whenReady().then(() => {
  fs.ensureDirSync(app.getPath('userData'));
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('get-app-paths', () => {
  return {
    userDataPath: app.getPath('userData'),
    currentGhostDir: getCurrentGhostDir(),
    currentShellDir: getCurrentShellDir(),
    memoryPath: getMemoryPath(),
    bundledResourceDir: getBundledResourceDir(),
    ghostBaseDir: getGhostBaseDir(),
    shellBaseDir: getShellBaseDir(),
    ghostId: getGhostId(),
    shellId: getShellId(),
    shellKey: getActiveShellKey(),
    isPackaged: app.isPackaged,
  };
});

ipcMain.handle('list-shells', () => {
  return { ok: true, shells: listAvailableShells() };
});

ipcMain.handle('get-window-bounds', () => {
  return mainWindow ? mainWindow.getBounds() : null;
});

ipcMain.on('move-window-to', (event, position) => {
  if (!mainWindow || !position) return;

  const x = Math.round(Number(position.x));
  const y = Math.round(Number(position.y));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return;

  mainWindow.setPosition(x, y);
});

ipcMain.handle('consume-shell-change-pending', async () => {
  const pendingPath = getShellChangePendingPath();
  const pending = readJsonFile(pendingPath, null);
  if (!pending) return { ok: true, pending: false };

  await fs.remove(pendingPath);
  return { ok: true, pending: true, shellKey: pending.shellKey || '' };
});

ipcMain.handle('switch-ghost', async (event, folderPath) => {
  const validation = validateGhostFolder(folderPath);
  if (!validation.ok) return validation;

  const destDir = getCurrentGhostDir();
  const tmpDir = `${destDir}_tmp`;

  try {
    await fs.remove(tmpDir);
    await fs.ensureDir(tmpDir);

    for (const file of REQUIRED_GHOST_FILES) {
      await fs.copy(path.join(folderPath, file), path.join(tmpDir, file), { overwrite: true });
    }

    for (const file of OPTIONAL_GHOST_FILES) {
      const sourcePath = path.join(folderPath, file);
      if (fs.existsSync(sourcePath)) {
        await fs.copy(sourcePath, path.join(tmpDir, file), { overwrite: true });
      }
    }

    const sourceShellsDir = path.join(folderPath, 'shells');
    if (fs.existsSync(sourceShellsDir)) {
      await fs.copy(sourceShellsDir, path.join(tmpDir, 'shells'), { overwrite: true });
    }

    await fs.writeJson(path.join(tmpDir, '.ghost_meta.json'), {
      ghostId: crypto.randomUUID(),
      sourceName: path.basename(folderPath),
      switchedAt: new Date().toISOString(),
    }, { spaces: 2 });

    await fs.remove(destDir);
    await fs.move(tmpDir, destDir, { overwrite: true });
    await fs.remove(getCurrentShellDir());

    app.relaunch();
    app.exit(0);
    return { ok: true, missingFiles: [], reason: '' };
  } catch (error) {
    await fs.remove(tmpDir).catch(() => {});
    console.error('Ghost切り替え失敗:', error);
    dialog.showErrorBox('Ghost切り替え失敗', error.message);
    return { ok: false, missingFiles: [], reason: error.message };
  }
});

ipcMain.handle('switch-shell', async (event, shellKey) => {
  const resolved = resolveShellKey(shellKey);
  if (!resolved.ok) return resolved;

  const destDir = getCurrentShellDir();
  const tmpDir = `${destDir}_tmp`;

  try {
    if (resolved.shellKey === 'normal') {
      await fs.remove(destDir);
      await markShellChangePending(resolved.shellKey);
      app.relaunch();
      app.exit(0);
      return { ok: true, missingFiles: [], reason: '' };
    }

    await fs.remove(tmpDir);
    await fs.ensureDir(tmpDir);

    for (const file of REQUIRED_SHELL_FILES) {
      await fs.copy(path.join(resolved.shellDir, file), path.join(tmpDir, file), { overwrite: true });
    }

    for (const file of OPTIONAL_SHELL_FILES) {
      const sourcePath = path.join(resolved.shellDir, file);
      if (fs.existsSync(sourcePath)) {
        await fs.copy(sourcePath, path.join(tmpDir, file), { overwrite: true });
      }
    }

    await fs.writeJson(path.join(tmpDir, '.shell_meta.json'), {
      shellId: crypto.randomUUID(),
      shellKey: resolved.shellKey,
      shellName: resolved.shellName,
      sourceType: resolved.sourceType,
      switchedAt: new Date().toISOString(),
    }, { spaces: 2 });

    await fs.remove(destDir);
    await fs.move(tmpDir, destDir, { overwrite: true });
    await markShellChangePending(resolved.shellKey);

    app.relaunch();
    app.exit(0);
    return { ok: true, missingFiles: [], reason: '' };
  } catch (error) {
    await fs.remove(tmpDir).catch(() => {});
    console.error('Shell切り替え失敗:', error);
    dialog.showErrorBox('Shell切り替え失敗', error.message);
    return { ok: false, missingFiles: [], reason: error.message };
  }
});

ipcMain.on('reload-app', () => {
  app.relaunch();
  app.exit(0);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
