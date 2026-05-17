const { ipcRenderer } = require('electron');

const files = {
  ghost: null,
  persona: null,
  topics: null,
};

let outputPath = '';
let isGenerating = false;

const errorBox = document.getElementById('errorBox');
const generateButton = document.getElementById('generateButton');
const closeButton = document.getElementById('closeButton');
const completeModal = document.getElementById('completeModal');
const completePath = document.getElementById('completePath');
const revealButton = document.getElementById('revealButton');

function setError(message = '') {
  errorBox.textContent = message;
}

function allUploadsReady() {
  return Boolean(files.ghost && files.persona && files.topics);
}

function updateGenerateState() {
  generateButton.disabled = isGenerating || !allUploadsReady();
  generateButton.textContent = isGenerating ? '生成中...' : 'Ghostを生成';
}

function renderUpload(kind) {
  const item = document.querySelector(`.uploadItem[data-kind="${kind}"]`);
  const stateText = item.querySelector('.stateText');
  const fileName = item.querySelector('.fileName');
  const file = files[kind];

  item.classList.toggle('uploaded', Boolean(file));
  stateText.textContent = file ? 'アップロード済みです' : '';
  fileName.textContent = file ? file.name : '';
  updateGenerateState();
}

function applyUploadResult(kind, result) {
  if (!result || result.canceled) return;

  if (!result.ok) {
    files[kind] = null;
    setError(result.reason || 'ファイルを読み込めませんでした。');
    renderUpload(kind);
    return;
  }

  files[kind] = result.file;
  setError('');
  renderUpload(kind);
}

async function pickUpload(kind) {
  const result = await ipcRenderer.invoke('pick-upload', kind);
  applyUploadResult(kind, result);
}

async function validateDroppedUpload(kind, filePath) {
  const result = await ipcRenderer.invoke('validate-dropped-upload', kind, filePath);
  applyUploadResult(kind, result);
}

for (const item of document.querySelectorAll('.uploadItem')) {
  const kind = item.dataset.kind;
  const button = item.querySelector('.dropButton');

  button.addEventListener('click', () => pickUpload(kind));
  button.addEventListener('dragover', (event) => {
    event.preventDefault();
    button.classList.add('dragOver');
  });
  button.addEventListener('dragleave', () => {
    button.classList.remove('dragOver');
  });
  button.addEventListener('drop', (event) => {
    event.preventDefault();
    button.classList.remove('dragOver');

    const file = event.dataTransfer.files?.[0];
    if (!file?.path) return;
    validateDroppedUpload(kind, file.path);
  });
}

generateButton.addEventListener('click', async () => {
  if (!allUploadsReady() || isGenerating) return;

  isGenerating = true;
  setError('');
  updateGenerateState();

  try {
    const result = await ipcRenderer.invoke('generate-ghost', files);
    if (result?.canceled) return;
    if (!result?.ok) {
      setError(result?.reason || 'zipファイルを生成できませんでした。');
      return;
    }

    outputPath = result.outputPath;
    completePath.textContent = outputPath;
    completeModal.classList.remove('hidden');
  } finally {
    isGenerating = false;
    updateGenerateState();
  }
});

closeButton.addEventListener('click', () => {
  ipcRenderer.send('close-generator');
});

revealButton.addEventListener('click', async () => {
  const result = await ipcRenderer.invoke('reveal-output', outputPath);
  if (!result.ok) setError(result.reason || 'ファイルを開けませんでした。');
});

completeModal.addEventListener('click', (event) => {
  if (event.target === completeModal) completeModal.classList.add('hidden');
});

updateGenerateState();
