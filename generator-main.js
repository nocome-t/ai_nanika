const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const crypto = require('crypto');
const { spawn } = require('child_process');

let mainWindow;

const REQUIRED_UPLOADS = {
  ghost: {
    label: 'ghost_normal.png',
    extensions: ['png'],
  },
  persona: {
    label: 'persona.txt',
    extensions: ['txt'],
  },
  topics: {
    label: 'topics.json',
    extensions: ['json'],
  },
};

const DEFAULT_MESSAGES = {
  launch: [
    '[通常]こんにちは。今日からここにいるね。',
    '[喜]呼んでくれてありがとう。よろしくね。',
  ],
  zatsudanFallback: [
    '[通常]少しだけ、きみの話を聞かせて。',
  ],
  switchShell: [
    '[通常]お着替えしたよ。',
  ],
};

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 430,
    height: 670,
    minWidth: 390,
    minHeight: 620,
    resizable: false,
    title: 'Ghost-generator 🔰primary',
    backgroundColor: '#f4f4f4',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'generator.html'));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      windowsHide: true,
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${path.basename(command)} exited with code ${code}`));
      }
    });
  });
}

function validateUpload(kind, filePath) {
  const upload = REQUIRED_UPLOADS[kind];
  if (!upload) return { ok: false, reason: '不明なファイル種別です。' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, reason: 'ファイルが見つかりません。' };

  const ext = path.extname(filePath).slice(1).toLowerCase();
  if (!upload.extensions.includes(ext)) {
    return { ok: false, reason: `${upload.label} として使える ${upload.extensions.join(', ')} ファイルを選んでください。` };
  }

  if (kind === 'topics') {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
      return { ok: false, reason: `topics.json のJSON形式が正しくありません: ${error.message}` };
    }
  }

  if (kind === 'persona') {
    const text = fs.readFileSync(filePath, 'utf8').trim();
    if (!text) return { ok: false, reason: 'persona.txt が空です。' };
  }

  return {
    ok: true,
    file: {
      kind,
      path: filePath,
      name: path.basename(filePath),
    },
  };
}

async function createGhostZip(files, outputPath) {
  const buildId = crypto.randomUUID();
  const workDir = path.join(app.getPath('temp'), `ghost-generator-primary-${buildId}`);
  const ghostDir = path.join(workDir, 'ghost');

  await fs.remove(workDir);
  await fs.ensureDir(ghostDir);

  try {
    await fs.copy(files.ghost.path, path.join(ghostDir, 'ghost_normal.png'));
    await fs.copy(files.persona.path, path.join(ghostDir, 'persona.txt'));
    await fs.copy(files.topics.path, path.join(ghostDir, 'topics.json'));
    await fs.writeJson(path.join(ghostDir, 'messages.json'), DEFAULT_MESSAGES, { spaces: 2 });
    await fs.writeJson(path.join(ghostDir, 'ghost.json'), {
      generator: 'Ghost Generator primary',
      generatorVersion: app.getVersion(),
      target: 'AInanika',
      createdAt: new Date().toISOString(),
    }, { spaces: 2 });

    await fs.remove(outputPath);
    await runCommand('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', ghostDir, outputPath]);
  } finally {
    await fs.remove(workDir).catch(() => {});
  }
}

app.whenReady().then(() => {
  app.setName('Ghost-generator 🔰primary');
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

ipcMain.handle('pick-upload', async (event, kind) => {
  const upload = REQUIRED_UPLOADS[kind];
  if (!upload) return { ok: false, reason: '不明なファイル種別です。' };

  const result = await dialog.showOpenDialog(mainWindow, {
    title: `${upload.label} を選択`,
    properties: ['openFile'],
    filters: [{ name: upload.label, extensions: upload.extensions }],
  });

  if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
  return validateUpload(kind, result.filePaths[0]);
});

ipcMain.handle('validate-dropped-upload', async (event, kind, filePath) => {
  return validateUpload(kind, filePath);
});

ipcMain.handle('generate-ghost', async (event, files) => {
  for (const kind of Object.keys(REQUIRED_UPLOADS)) {
    const validation = validateUpload(kind, files?.[kind]?.path);
    if (!validation.ok) return validation;
  }

  const defaultName = `AInanika-ghost-${new Date().toISOString().slice(0, 10)}.zip`;
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Ghost zipを保存',
    defaultPath: path.join(app.getPath('downloads'), defaultName),
    filters: [{ name: 'Zip Archive', extensions: ['zip'] }],
  });

  if (saveResult.canceled || !saveResult.filePath) return { ok: false, canceled: true };

  try {
    await createGhostZip(files, saveResult.filePath);
    return { ok: true, outputPath: saveResult.filePath };
  } catch (error) {
    return { ok: false, reason: error.message };
  }
});

ipcMain.handle('reveal-output', async (event, outputPath) => {
  if (outputPath && fs.existsSync(outputPath)) {
    shell.showItemInFolder(outputPath);
    return { ok: true };
  }
  return { ok: false, reason: '生成したzipファイルが見つかりません。' };
});

ipcMain.on('close-generator', () => {
  app.quit();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
