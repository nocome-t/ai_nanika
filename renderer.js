const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcRenderer } = require('electron');

const OPENAI_MODEL = 'gpt-4o-mini';
const OPENAI_API_KEY_STORAGE_KEY = 'OPENAI_API_KEY';

const EXPRESSION_MAP = {
  '[通常]': 'ghost_normal.png',
  '[喜]': 'ghost_happy.png',
  '[哀]': 'ghost_sad.png',
  '[驚]': 'ghost_surprised.png',
};

const SHELL_CHANGE_PENDING_KEY = 'SHELL_CHANGE_PENDING';

const SKINSHIP_AREAS = {
  head: { x: 0.2, y: 0.05, width: 0.6, height: 0.15 },
  face: { x: 0.35, y: 0.21, width: 0.3, height: 0.2 },
  bust: { x: 0.25, y: 0.65, width: 0.45, height: 0.15 },
};

const SKINSHIP_STROKE_SEQUENCE = ['right', 'left', 'right'];
const SKINSHIP_STROKE_MIN_DISTANCE = 10;
const SKINSHIP_REACTION_COOLDOWN_MS = 800;
const GHOST_MIN_SCALE = 0.4;
const GHOST_RESIZE_EDGE_RATIO = 0.08;
const GHOST_RESIZE_EDGE_MIN_PX = 12;
const DEFAULT_GHOST_DESIGN = {
  mainMenu: {
    textColor: 'white',
    activeTextColor: '#fecdd3',
    mutedTextColor: 'rgba(255,255,255,0.55)',
  },
  windowYoko: {
    borderColor: '#fda4af',
    textColor: '#333',
  },
};
const DEFAULT_SKINSHIP_REACTIONS = {
  head: [
    '[喜]えへへ、なでなでされてる。',
    '[通常]そこ、なんだか落ち着くかも。',
    '[喜]ふふ、もうちょっとだけお願い。',
    '[驚]わ、急になでたね？[SEP][喜]でも嫌じゃないよ。',
    '[通常]キミの手、あったかい感じがする。',
  ],
  face: [
    '[驚]わ、顔はちょっと照れるよ。',
    '[喜]近い近い。[SEP][通常]でも、ちゃんと見てくれてるんだね。',
    '[通常]ほっぺ、気になった？',
    '[喜]えへへ、くすぐったい。',
    '[通常]そんなに見つめられると、少しどきどきするよ。',
  ],
  bust: [
    '[驚]わ、そこはびっくりするよ。',
    '[通常]ん、服のあたり直してくれたの？',
    '[喜]やさしくしてくれるなら、まあいいよ。',
    '[通常]くすぐったいから、そっとね。',
    '[驚]ちょ、急に触るとびっくりするってば。',
  ],
};

let appPaths = {};
let baseDir = __dirname;
let personaPath = '';
let topicsPath = '';
let messagesPath = '';
let memoryPath = '';
let qaPath = '';
let ghostId = 'bundled-default-ghost';

let balloon;
let input;
let ghostImg;
let mainMenu;
let shellMenu;
let inputModal;
let modalContent;
let modalInput;
let modalBalloon;
let submitBtn;
let cancelBtn;

let chatHistory = [];
let userFacts = [];
let personaSetting = '';
let topicPool = [];
let styleExamples = [];
let styleTypeDescriptions = {};
let messageQueue = [];
let currentIdx = 0;
let ghostMessages = {};
let isConversationMode = false;
let conversationTopicState = null;
let isAiCalling = false;
let timerId = null;
let openAiApiKey = localStorage.getItem(OPENAI_API_KEY_STORAGE_KEY) || '';
let isApiKeyDialogOpen = false;
let afterQueueCallback = null;
let inputIsComposing = false;
let inputSuppressNextEnter = false;
let modalIsComposing = false;
let modalSuppressNextEnter = false;
let availableShells = [];
let skinshipStrokeState = null;
let lastSkinshipReactionAt = 0;
let windowDragState = null;
let ghostResizeState = null;
let ghostMaxWidth = 320;
let skinshipDebugVisible = false;
let skinshipDebugElements = [];
let ghostWindowBackgroundPath = '';
let ghostDesign = DEFAULT_GHOST_DESIGN;

function toFileUrl(filePath) {
  return pathToFileURL(filePath).href;
}

function safeReadText(filePath, fallback = '') {
  try {
    return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : fallback;
  } catch (error) {
    console.error('読み込みエラー:', filePath, error);
    return fallback;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, 'utf8')) : fallback;
  } catch (error) {
    console.error('JSON読み込みエラー:', filePath, error);
    return fallback;
  }
}

function toStringArray(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') return [value].filter(Boolean);
  return [];
}

function getStyleExampleSource(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.examples)) return data.examples;
  if (Array.isArray(data.rules)) return data.rules;
  if (Array.isArray(data.patterns)) return data.patterns;
  if (Array.isArray(data.items)) return data.items;
  return [];
}

function getStyleTypeDescriptions(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  return Object.entries(data.type_descriptions || {}).reduce((descriptions, [type, description]) => {
    descriptions[String(type)] = String(description);
    return descriptions;
  }, {});
}

function normalizeStyleExamples(data) {
  const source = getStyleExampleSource(data);
  if (!Array.isArray(source)) return [];

  return source
    .map((item, index) => {
      if (typeof item === 'string') {
        return {
          id: `example_${index + 1}`,
          type: 'style',
          priority: 0,
          tags: [],
          trigger: { keywords: [], requiredAny: [], requiredAll: [], exclude: [] },
          instruction: '',
          situation: '',
          example: item,
        };
      }

      if (!item || typeof item !== 'object') return null;

      return {
        id: String(item.id || `example_${index + 1}`),
        type: String(item.type || item.kind || 'style'),
        priority: Number.isFinite(Number(item.priority)) ? Number(item.priority) : 0,
        tags: toStringArray(item.tags || item.tag || item.labels),
        trigger: {
          keywords: toStringArray(item.trigger?.keywords || item.trigger?.keyword || item.trigger?.include || item.keywords),
          requiredAny: toStringArray(item.trigger?.required_any || item.trigger?.requiredAny),
          requiredAll: toStringArray(item.trigger?.required_all || item.trigger?.requiredAll),
          exclude: toStringArray(item.trigger?.exclude || item.trigger?.excludes || item.exclude),
        },
        instruction: String(item.instruction || item.rule || item.behavior || ''),
        situation: String(item.situation || ''),
        example: String(item.example || item.text || ''),
      };
    })
    .filter((item) => item?.example);
}

function loadStyleExamples() {
  const dirs = [appPaths.ghostBaseDir || __dirname, baseDir].filter(Boolean);
  const uniqueDirs = [...new Set(dirs)];
  const examples = [];
  const typeDescriptions = {};
  const seen = new Set();

  for (const dir of uniqueDirs) {
    const filePath = path.join(dir, 'style_examples.json');
    const data = safeReadJson(filePath, []);
    Object.assign(typeDescriptions, getStyleTypeDescriptions(data));
    const loaded = normalizeStyleExamples(data);

    for (const item of loaded) {
      const key = `${item.id}:${item.example}`;
      if (seen.has(key)) continue;
      seen.add(key);
      examples.push(item);
    }
  }

  styleTypeDescriptions = typeDescriptions;
  return examples;
}

function loadGhostMessages() {
  const dirs = [appPaths.ghostBaseDir || baseDir, baseDir].filter(Boolean);
  const uniqueDirs = [...new Set(dirs)];

  return uniqueDirs.reduce((messages, dir) => {
    return {
      ...messages,
      ...safeReadJson(path.join(dir, 'messages.json'), {}),
    };
  }, {});
}

function findGhostAsset(fileNames) {
  const dirs = [appPaths.ghostBaseDir || baseDir].filter(Boolean);
  for (const dir of dirs) {
    for (const fileName of fileNames) {
      const assetPath = path.join(dir, fileName);
      if (fs.existsSync(assetPath)) return assetPath;
    }
  }

  return '';
}

function cssFileUrl(filePath) {
  return `url("${toFileUrl(filePath).replace(/"/g, '%22')}")`;
}

function stripExpressionTags(text) {
  return String(text || '').replace(/\[(通常|喜|哀|驚)\]/g, '');
}

function mergeGhostDesign(data) {
  return {
    mainMenu: {
      ...DEFAULT_GHOST_DESIGN.mainMenu,
      ...(data?.mainMenu || {}),
    },
    windowYoko: {
      ...DEFAULT_GHOST_DESIGN.windowYoko,
      ...(data?.windowYoko || {}),
    },
  };
}

function setCssVar(name, value) {
  document.documentElement.style.setProperty(name, value);
}

function loadGhostDesign() {
  const designPath = findGhostAsset(['ghost_design.json']);
  ghostDesign = mergeGhostDesign(designPath ? safeReadJson(designPath, {}) : {});
}

function applyGhostDesignAssets() {
  const menuBackgroundPath = findGhostAsset(['main_menu.png', 'main_manu.png']);
  ghostWindowBackgroundPath = findGhostAsset(['window_yoko.png']);
  loadGhostDesign();

  if (mainMenu) {
    if (menuBackgroundPath) {
      mainMenu.style.backgroundImage = cssFileUrl(menuBackgroundPath);
      mainMenu.style.backgroundSize = '100% 100%';
      mainMenu.style.backgroundRepeat = 'no-repeat';
      mainMenu.style.backgroundColor = 'transparent';
      setCssVar('--main-menu-text-color', ghostDesign.mainMenu.textColor);
      setCssVar('--main-menu-active-text-color', ghostDesign.mainMenu.activeTextColor);
      setCssVar('--main-menu-muted-text-color', ghostDesign.mainMenu.mutedTextColor);
    } else {
      mainMenu.style.backgroundImage = '';
      mainMenu.style.backgroundSize = '';
      mainMenu.style.backgroundRepeat = '';
      mainMenu.style.backgroundColor = '';
      setCssVar('--main-menu-text-color', DEFAULT_GHOST_DESIGN.mainMenu.textColor);
      setCssVar('--main-menu-active-text-color', DEFAULT_GHOST_DESIGN.mainMenu.activeTextColor);
      setCssVar('--main-menu-muted-text-color', DEFAULT_GHOST_DESIGN.mainMenu.mutedTextColor);
    }
  }

  if (shellMenu) {
    if (menuBackgroundPath) {
      shellMenu.style.backgroundImage = cssFileUrl(menuBackgroundPath);
      shellMenu.style.backgroundSize = '100% auto';
      shellMenu.style.backgroundPosition = 'top center';
      shellMenu.style.backgroundRepeat = 'no-repeat';
      shellMenu.style.backgroundColor = 'transparent';
    } else {
      shellMenu.style.backgroundImage = '';
      shellMenu.style.backgroundSize = '';
      shellMenu.style.backgroundPosition = '';
      shellMenu.style.backgroundRepeat = '';
      shellMenu.style.backgroundColor = '';
    }
  }

  if (ghostWindowBackgroundPath) {
    setCssVar('--window-yoko-border-color', ghostDesign.windowYoko.borderColor);
    setCssVar('--window-yoko-text-color', ghostDesign.windowYoko.textColor);
  } else {
    setCssVar('--window-yoko-border-color', DEFAULT_GHOST_DESIGN.windowYoko.borderColor);
    setCssVar('--window-yoko-text-color', DEFAULT_GHOST_DESIGN.windowYoko.textColor);
  }
}

function markLocalShellChangePending(shellKey) {
  localStorage.setItem(SHELL_CHANGE_PENDING_KEY, JSON.stringify({
    shellKey,
    changedAt: new Date().toISOString(),
  }));
}

function consumeLocalShellChangePending() {
  const pending = localStorage.getItem(SHELL_CHANGE_PENDING_KEY);
  localStorage.removeItem(SHELL_CHANGE_PENDING_KEY);
  return Boolean(pending);
}

function safeWriteJson(filePath, data) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  } catch (error) {
    console.error('JSON保存エラー:', filePath, error);
  }
}

async function preparePaths() {
  appPaths = await ipcRenderer.invoke('get-app-paths');
  baseDir = appPaths.shellBaseDir || appPaths.ghostBaseDir || __dirname;
  ghostId = `${appPaths.ghostId || 'bundled-default-ghost'}:${appPaths.shellId || 'default-shell'}`;
  personaPath = path.join(baseDir, 'persona.txt');
  topicsPath = path.join(baseDir, 'topics.json');
  messagesPath = path.join(appPaths.ghostBaseDir || baseDir, 'messages.json');
  memoryPath = appPaths.memoryPath;
  qaPath = path.join(appPaths.bundledResourceDir || __dirname, 'qa.txt');
}

async function loadAvailableShells() {
  try {
    const result = await ipcRenderer.invoke('list-shells');
    availableShells = result.ok && Array.isArray(result.shells) ? result.shells : [];
  } catch (error) {
    console.error('Shell一覧の読み込みエラー:', error);
    availableShells = [];
  }
}

function loadSettings() {
  personaSetting = safeReadText(personaPath);
  topicPool = safeReadJson(topicsPath, []);
  ghostMessages = loadGhostMessages();
  styleExamples = loadStyleExamples();

  const savedData = safeReadJson(memoryPath, {});
  const isSameGhost = savedData.ghostId === ghostId;
  chatHistory = isSameGhost && Array.isArray(savedData.chatHistory) ? savedData.chatHistory : [];
  userFacts = Array.isArray(savedData.userFacts) ? savedData.userFacts : [];

  if (!isSameGhost) {
    saveMemory();
  }
}

function saveMemory() {
  safeWriteJson(memoryPath, {
    ghostId,
    chatHistory: chatHistory.slice(-20),
    userFacts: userFacts.slice(-30),
  });
}

function setGhostImage(fileName = 'ghost_normal.png') {
  const imagePath = path.join(baseDir, fileName);
  ghostImg.src = toFileUrl(fs.existsSync(imagePath) ? imagePath : path.join(baseDir, 'ghost_normal.png'));
}

function splitMessage(message) {
  return String(message || '')
    .split('[SEP]')
    .map((part) => part.trim())
    .filter(Boolean);
}

function enqueueMessage(message, onComplete = null) {
  messageQueue = splitMessage(message);
  currentIdx = 0;
  afterQueueCallback = typeof onComplete === 'function' ? onComplete : null;
  showNextMessage();
}

function pickRandomMessage(value) {
  if (Array.isArray(value)) {
    const messages = value.map(String).filter(Boolean);
    if (messages.length === 0) return '';
    return messages[Math.floor(Math.random() * messages.length)];
  }

  return typeof value === 'string' ? value : '';
}

function getSkinshipPoint(event) {
  const rect = ghostImg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  return {
    x: (event.clientX - rect.left) / rect.width,
    y: (event.clientY - rect.top) / rect.height,
  };
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getGhostResizeHit(event) {
  const rect = ghostImg.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const isInside = (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
  if (!isInside) return null;

  const edgeSize = Math.max(
    GHOST_RESIZE_EDGE_MIN_PX,
    Math.min(rect.width, rect.height) * GHOST_RESIZE_EDGE_RATIO
  );
  const fromRight = rect.right - event.clientX <= edgeSize;
  const fromTop = event.clientY - rect.top <= edgeSize;

  if (!fromRight && !fromTop) return null;

  return { fromRight, fromTop };
}

function applyGhostWidth(width) {
  const characterContainer = document.getElementById('character-container');
  if (!characterContainer) return;

  const minWidth = ghostMaxWidth * GHOST_MIN_SCALE;
  const nextWidth = clampNumber(width, minWidth, ghostMaxWidth);
  characterContainer.style.width = `${nextWidth}px`;
  positionSkinshipDebugAreas();
}

function startGhostResize(event, hit) {
  const characterContainer = document.getElementById('character-container');
  if (!characterContainer || !hit) return;

  ghostResizeState = {
    startClientX: event.clientX,
    startClientY: event.clientY,
    startWidth: characterContainer.getBoundingClientRect().width,
    fromRight: hit.fromRight,
    fromTop: hit.fromTop,
  };
}

function updateGhostResizeCursor(event) {
  const characterContainer = document.getElementById('character-container');
  if (!characterContainer || ghostResizeState || windowDragState || skinshipStrokeState) return;

  const hit = getGhostResizeHit(event);
  characterContainer.style.cursor = hit ? 'nesw-resize' : 'move';
}

function isPointInSkinshipArea(point, areaName) {
  const area = SKINSHIP_AREAS[areaName];
  if (!point || !area) return false;

  return (
    point.x >= area.x &&
    point.x <= area.x + area.width &&
    point.y >= area.y &&
    point.y <= area.y + area.height
  );
}

function getSkinshipAreaAtPoint(point, areaNames) {
  return areaNames.find((areaName) => isPointInSkinshipArea(point, areaName)) || null;
}

function enqueueSkinshipReaction(areaName) {
  const now = Date.now();
  if (now - lastSkinshipReactionAt < SKINSHIP_REACTION_COOLDOWN_MS) return;

  const message = pickRandomMessage(ghostMessages[`reaction_${areaName}`] || DEFAULT_SKINSHIP_REACTIONS[areaName]);
  if (!message) return;

  lastSkinshipReactionAt = now;
  enqueueMessage(message);
}

function positionSkinshipDebugAreas() {
  const imageWidth = ghostImg.offsetWidth;
  const imageHeight = ghostImg.offsetHeight;
  if (imageWidth <= 0 || imageHeight <= 0) return;

  for (const element of skinshipDebugElements) {
    const area = SKINSHIP_AREAS[element.dataset.areaName];
    if (!area) continue;

    element.style.left = `${ghostImg.offsetLeft + imageWidth * area.x}px`;
    element.style.top = `${ghostImg.offsetTop + imageHeight * area.y}px`;
    element.style.width = `${imageWidth * area.width}px`;
    element.style.height = `${imageHeight * area.height}px`;
    element.style.lineHeight = `${imageHeight * area.height}px`;
  }
}

function toggleSkinshipDebugAreas() {
  skinshipDebugVisible = !skinshipDebugVisible;
  positionSkinshipDebugAreas();
  for (const element of skinshipDebugElements) {
    element.classList.toggle('visible', skinshipDebugVisible);
  }
}

function showLoadingMessage() {
  if (!balloon || !ghostImg) return;

  messageQueue = [];
  currentIdx = 0;
  afterQueueCallback = null;
  setGhostImage('ghost_normal.png');
  balloon.textContent = '考え中ーーー';
  balloon.style.display = 'block';
}

function hasOpenAiApiKeyShape(apiKey) {
  return /^sk-[A-Za-z0-9_-]{20,}$/.test(String(apiKey || '').trim());
}

async function validateOpenAiApiKey(apiKey) {
  const trimmedKey = String(apiKey || '').trim();
  if (!hasOpenAiApiKeyShape(trimmedKey)) {
    return { ok: false, reason: 'APIキーの形式が正しくありません。sk- から始まるキーを入力してください。' };
  }

  try {
    const response = await fetch('https://api.openai.com/v1/models', {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${trimmedKey}`,
      },
    });

    if (response.ok) return { ok: true, reason: '' };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'APIキーが無効、または利用権限がありません。入力し直してください。' };
    }

    console.warn('APIキー確認で予期しない応答:', response.status, await response.text());
    return { ok: true, reason: '' };
  } catch (error) {
    console.warn('APIキー確認を完了できませんでした:', error);
    return { ok: true, reason: '' };
  }
}

function clearOpenAiApiKey() {
  openAiApiKey = '';
  localStorage.removeItem(OPENAI_API_KEY_STORAGE_KEY);
}

function showApiKeyDialog(message) {
  if (isApiKeyDialogOpen) return;

  isApiKeyDialogOpen = true;
  showModal(message, async (val) => {
    const nextKey = String(val || '').trim();
    if (!nextKey) {
      clearOpenAiApiKey();
      isApiKeyDialogOpen = false;
      hideModal();
      enqueueMessage('[通常]APIキーがない間は、AIのおしゃべりはお休みするね。');
      return;
    }

    modalBalloon.textContent = 'APIキーを確認しているよ。少し待ってね。';
    submitBtn.disabled = true;
    cancelBtn.disabled = true;

    const result = await validateOpenAiApiKey(nextKey);
    submitBtn.disabled = false;
    cancelBtn.disabled = false;

    if (!result.ok) {
      modalBalloon.textContent = result.reason;
      modalInput.focus();
      modalInput.select();
      return;
    }

    openAiApiKey = nextKey;
    localStorage.setItem(OPENAI_API_KEY_STORAGE_KEY, nextKey);
    isApiKeyDialogOpen = false;
    hideModal();
    enqueueMessage('[喜]APIキーを保存したよ。[SEP][通常]これでおしゃべりできるようになったよ。');
  }, 'sk-... から始まるAPIキー', {
    inputType: 'password',
    maxLength: 220,
    onCancel: () => {
      clearOpenAiApiKey();
      isApiKeyDialogOpen = false;
      hideModal();
      enqueueMessage('[通常]APIキーがない間は、AIのおしゃべりはお休みするね。');
    },
  });
}

async function ensureOpenAiApiKeyOnStartup() {
  if (!openAiApiKey) {
    showApiKeyDialog('[通常]OpenAI APIキーを設定してね。APIキーはこのアプリ内に保存されるよ。');
    return false;
  }

  const result = await validateOpenAiApiKey(openAiApiKey);
  if (result.ok) return true;

  clearOpenAiApiKey();
  showApiKeyDialog(`[哀]保存されているAPIキーが使えないみたい。${result.reason}`);
  return false;
}

function showNextMessage() {
  if (!balloon || !ghostImg) return;

  if (currentIdx < messageQueue.length) {
    let msg = messageQueue[currentIdx];
    let expFile = 'ghost_normal.png';

    for (const [tag, fileName] of Object.entries(EXPRESSION_MAP)) {
      if (msg.includes(tag)) {
        expFile = fileName;
        break;
      }
    }

    setGhostImage(expFile);
    balloon.textContent = msg.replace(/[\[【].*?[\]】]/g, '').trim();
    balloon.style.display = 'block';
    currentIdx += 1;
    return;
  }

  balloon.style.display = 'none';
  setGhostImage('ghost_normal.png');
  messageQueue = [];

  if (afterQueueCallback) {
    const callback = afterQueueCallback;
    afterQueueCallback = null;
    callback();
  }
}

function extractMemo(text) {
  const memoMatch = String(text || '').match(/\[MEMO:\s*([^\]]+)\]/);
  if (!memoMatch) return text;

  const memo = memoMatch[1].trim();
  if (memo && !userFacts.includes(memo)) {
    userFacts.push(memo);
    saveMemory();
  }

  return text.replace(/\[MEMO:\s*[^\]]+\]/g, '').trim();
}

function pickTopic() {
  if (!Array.isArray(topicPool) || topicPool.length === 0) return '今日あった小さなできごと';
  return topicPool[Math.floor(Math.random() * topicPool.length)];
}

function startConversationTopicState(rootTopic) {
  conversationTopicState = {
    rootTopic: rootTopic || '今日の雑談',
    turns: [],
    askedQuestions: [],
    nextBranchNumber: 1,
  };
}

function endConversationTopicState() {
  conversationTopicState = null;
}

function getConversationTopicGuidance(options = {}) {
  if (!isConversationMode || !conversationTopicState) return '';

  const { rootTopic, askedQuestions, nextBranchNumber } = conversationTopicState;
  const questionHistory = askedQuestions
    .slice(-10)
    .map((question, index) => `${index + 1}. ${question}`)
    .join('\n');
  const needsRedirect = nextBranchNumber >= 4;
  const redirectWords = '「話は戻るんだけど」「ちなみに」「そういえば」「ところで」';
  const interpretationRule = options.useInterpretationReply ? `

3. 今回の返答では、ユーザーの発話に対してGhost自身の解釈を含めてください。
・ただ肯定するだけで終わらせないでください。
・「それって〜〜って意味？」「〜〜が好きなんだね」「つまり〜〜って感じかな？」のように、ユーザーの言葉をGhostなりに受け取ってから質問へ進んでください。
・解釈は決めつけすぎず、親しい確認として自然に入れてください。` : `

3. 今回の返答では、無理に解釈を足さなくて構いません。
・ただし、相づちだけで終わらず、会話モードの最後は質問で返してください。`;

  return `

【会話モード中の単純ルール】
rootTopic: ${rootTopic}
現在の質問番号: ${nextBranchNumber}

1. 3回質問をしたら、次の質問で必ずrootTopicに戻してください。
・現在の質問番号が4以上なら、必ず ${redirectWords} のどれかを自然に挟んでから、rootTopic「${rootTopic}」について質問してください。
・話し始め、または1つ目のパートの先頭に ${redirectWords} を置いてはいけません。
・話題転換の接続語は、ユーザーへの短い反応や解釈を述べたあと、2つ目以降の文またはパートで使ってください。
・rootTopicへ戻すとき、直前の派生話題をさらに続けてはいけません。
・rootTopicへ戻したあとは、質問番号を1から数え直す前提で会話を続けてください。

2. 同じ会話の中で、同じ質問および似たような回答を求める質問は禁止です。
・言い換えただけの質問も禁止です。
・既に聞いた質問と同じ答えになりそうな質問は禁止です。
・既出質問に近い場合は、rootTopicに関係する別の観点の質問に変えてください。
${questionHistory ? `既に聞いた質問:\n${questionHistory}` : '既に聞いた質問: なし'}
${interpretationRule}

${needsRedirect ? '今回の返答ではルール1を必ず実行してください。' : '今回の返答ではルール2を必ず守ってください。'}`;
}

function stripResponseMeta(text) {
  return String(text || '').replace(/\[SEP\]/g, ' ').replace(/[\[【].*?[\]】]/g, '').trim();
}

function extractQuestions(text) {
  return stripResponseMeta(text)
    .split(/(?<=[？?])|[\r\n]+/)
    .map((part) => part.trim())
    .filter((part) => /[？?]\s*$/.test(part));
}

function normalizeQuestion(question) {
  return String(question || '')
    .toLowerCase()
    .replace(/[？！?。、,.!！\s"'“”‘’「」『』（）()【】\[\]]/g, '')
    .replace(/ですか$|ますか$|かな$|だと思う$|どう思う$/g, '')
    .trim();
}

function getBigrams(text) {
  const normalized = normalizeQuestion(text);
  if (normalized.length <= 1) return normalized ? [normalized] : [];

  const grams = [];
  for (let i = 0; i < normalized.length - 1; i += 1) {
    grams.push(normalized.slice(i, i + 2));
  }
  return grams;
}

function getQuestionSimilarity(left, right) {
  const leftGrams = new Set(getBigrams(left));
  const rightGrams = new Set(getBigrams(right));
  if (leftGrams.size === 0 || rightGrams.size === 0) return 0;

  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) intersection += 1;
  }

  const union = new Set([...leftGrams, ...rightGrams]).size;
  return union === 0 ? 0 : intersection / union;
}

function isSimilarQuestion(left, right) {
  const normalizedLeft = normalizeQuestion(left);
  const normalizedRight = normalizeQuestion(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  if (normalizedLeft.length >= 8 && normalizedRight.length >= 8) {
    if (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)) return true;
  }
  return getQuestionSimilarity(left, right) >= 0.58;
}

function findRepeatedQuestion(reply) {
  if (!isConversationMode || !conversationTopicState) return null;

  const askedQuestions = conversationTopicState.askedQuestions || [];
  for (const question of extractQuestions(reply)) {
    const matched = askedQuestions.find((asked) => isSimilarQuestion(question, asked));
    if (matched) return { question, matched };
  }

  return null;
}

function startsWithTopicTransition(reply) {
  const firstPart = String(reply || '').split('[SEP]')[0] || '';
  const text = firstPart.replace(/^\s*[\[【][^\]】]+[\]】]\s*/, '').trim();
  return /^(話は戻るんだけど|ちなみに|そういえば|ところで)/.test(text);
}

function rememberConversationAssistantTurn(reply) {
  if (!isConversationMode || !conversationTopicState) return;

  const branchNumber = conversationTopicState.nextBranchNumber;
  conversationTopicState.turns.push({
    branchNumber,
    summary: stripResponseMeta(reply).slice(0, 120),
  });

  for (const question of extractQuestions(reply)) {
    const alreadyStored = conversationTopicState.askedQuestions.some((asked) => isSimilarQuestion(question, asked));
    if (!alreadyStored) conversationTopicState.askedQuestions.push(question);
  }

  conversationTopicState.askedQuestions = conversationTopicState.askedQuestions.slice(-20);
  conversationTopicState.nextBranchNumber = branchNumber >= 4 ? 1 : branchNumber + 1;
}

function loadQaQuestions() {
  return safeReadText(qaPath)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\d+[.)．、]?\s*/, '').trim())
    .filter(Boolean);
}

function isImeEnter(event, state) {
  return event.isComposing || event.keyCode === 229 || state.isComposing || state.suppressNextEnter;
}

function includesAnyKeyword(context, keywords) {
  return keywords.some((keyword) => {
    return keyword && context.includes(String(keyword).toLowerCase());
  });
}

function matchesStyleTrigger(example, contextText) {
  const context = contextText.toLowerCase();
  const keywords = example.trigger?.keywords || [];
  const requiredAny = example.trigger?.requiredAny || [];
  const requiredAll = example.trigger?.requiredAll || [];
  const exclude = example.trigger?.exclude || [];

  if (exclude.length > 0 && includesAnyKeyword(context, exclude)) return false;
  if (requiredAll.length > 0 && !requiredAll.every((keyword) => context.includes(String(keyword).toLowerCase()))) return false;
  if (requiredAny.length > 0 && !includesAnyKeyword(context, requiredAny)) return false;

  const hasKeyword = keywords.length > 0 && includesAnyKeyword(context, keywords);
  return hasKeyword || requiredAny.length > 0 || requiredAll.length > 0;
}

function scoreStyleExample(example, contextText) {
  const context = contextText.toLowerCase();
  let score = 0;

  if (matchesStyleTrigger(example, contextText)) {
    score += 100 + example.priority;
  }

  for (const tag of example.tags) {
    if (context.includes(String(tag).toLowerCase())) score += 3;
  }

  for (const word of String(example.situation || '').split(/[、。\s]+/).filter((part) => part.length >= 2)) {
    if (context.includes(word.toLowerCase())) score += 1;
  }

  if (/(疲れ|しんど|つら|無理|眠|休)/.test(context) && example.tags.some((tag) => /慰め|低テンション|寄り添い/.test(tag))) score += 5;
  if (/(失敗|やらか|ミス|抜け|忘れ)/.test(context) && example.tags.some((tag) => /失敗|笑い|からかう|冗談/.test(tag))) score += 5;
  if (/(やる|決め|頑張|がんば|挑戦)/.test(context) && example.tags.some((tag) => /決心|テンション/.test(tag))) score += 5;

  return score;
}

function buildStyleContextText(userText, isAutoTalk, options = {}) {
  return [
    userText || '',
    options.topic || '',
    isAutoTalk ? '雑談 話題を振る' : '',
    isConversationMode ? '会話モード 質問' : '',
  ].join(' ');
}

function selectStyleRules(userText, isAutoTalk, options = {}) {
  const contextText = buildStyleContextText(userText, isAutoTalk, options);

  if (!Array.isArray(styleExamples) || styleExamples.length === 0) {
    return { strongRules: [], styleRefs: [] };
  }

  const scored = styleExamples.map((example, index) => ({
    example,
    index,
    score: scoreStyleExample(example, contextText),
    triggered: matchesStyleTrigger(example, contextText),
  }));

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.index - b.index;
  });

  const triggered = scored.filter((item) => item.triggered);
  const catchphrases = triggered
    .filter((item) => item.example.type === 'catchphrase')
    .slice(0, 1);
  const strongTriggeredRules = triggered
    .filter((item) => item.example.type !== 'style' && item.example.type !== 'catchphrase')
    .slice(0, 3);
  const highPriorityStyleRules = triggered
    .filter((item) => item.example.type === 'style' && item.example.priority >= 80)
    .slice(0, 1);
  const strongRules = [...catchphrases, ...strongTriggeredRules, ...highPriorityStyleRules]
    .sort((a, b) => b.example.priority - a.example.priority)
    .slice(0, 3)
    .map((item) => item.example);

  const strongIds = new Set(strongRules.map((item) => item.id));
  const styleRefs = scored
    .filter((item) => item.score > 0 && !strongIds.has(item.example.id))
    .slice(0, strongRules.length > 0 ? 2 : 3)
    .map((item) => item.example);

  if (styleRefs.length === 0 && strongRules.length === 0) {
    return { strongRules: [], styleRefs: scored.slice(0, 2).map((item) => item.example) };
  }

  return { strongRules, styleRefs };
}

function buildStyleExamplesPrompt(userText, isAutoTalk, options = {}) {
  const { strongRules, styleRefs } = selectStyleRules(userText, isAutoTalk, options);
  if (strongRules.length === 0 && styleRefs.length === 0) return '';

  const strongLines = strongRules.map((item, index) => {
    const instruction = item.instruction ? ` instruction: ${item.instruction}` : '';
    const description = styleTypeDescriptions[item.type] ? ` type_description: ${styleTypeDescriptions[item.type]}` : '';
    return `${index + 1}. type: ${item.type} / priority: ${item.priority}.${description}${instruction} example: ${item.example}`;
  });

  const styleLines = styleRefs.map((item, index) => {
    const tags = item.tags.length > 0 ? ` / tags: ${item.tags.join(', ')}` : '';
    const situation = item.situation ? ` / situation: ${item.situation}` : '';
    const instruction = item.instruction ? ` / instruction: ${item.instruction}` : '';
    const description = styleTypeDescriptions[item.type] ? ` / type_description: ${styleTypeDescriptions[item.type]}` : '';
    return `${index + 1}. type: ${item.type}${description} / ${item.example}${tags}${situation}${instruction}`;
  });

  const strongSection = strongLines.length > 0 ? `

【style_examples.json 発火ルール】
・以下は現在の入力にtriggerが一致したため、通常の文体参考より優先して反映してください。
・type_descriptionsがある場合は、その説明に従って反映の強さや用途を判断してください。
・catchphraseは自然な場合のみ1つまで入れてください。response_patternなどの発火ルールは返答の方向性として使ってください。
・例文は丸写しせず、現在の文脈に合わせて言い換えてください。
${strongLines.join('\n')}` : '';

  const styleSection = styleLines.length > 0 ? `

【style_examples.json 文体参考】
・以下は内容の指示ではなく、Ainanikaらしい口調、テンション、間、切り返し方の参考例です。
・例文を丸写しせず、現在の文脈に合わせて自然に言い換えてください。
・口癖や言い回しは使いすぎず、1回の返答に多くても1〜2個までにしてください。
${styleLines.join('\n')}` : '';

  return `${strongSection}${styleSection}`;
}

function buildSystemPrompt(isAutoTalk, options = {}) {
  const facts = userFacts.length > 0 ? userFacts.map((fact) => `・${fact}`).join('\n') : 'まだ記憶はありません。';
  const topic = options.topic || pickTopic();
  const styleExamplesPrompt = buildStyleExamplesPrompt(options.userText || '', isAutoTalk, options);
  const autoTalk = isAutoTalk ? `\n今回は雑談です。話題候補「${topic}」から自然に話しかけてください。` : '';
  const conversationTopicGuidance = getConversationTopicGuidance(options);
  const conversationStartRule = options.conversationStart ? `
・これは会話モード開始直後の最初の発話です。ユーザーの入力を待たず、あなたから自然に話しかけてください。
・会話モードを終えるには end と入力できることを、必要なら短く自然に添えてください。` : '';
  const conversationRule = isConversationMode ? `

【会話モード中の追加ルール】
・最後のパートは必ずユーザーに向けた疑問形で終えてください。
・最後の文末は「？」「かな？」「どう思う？」など、相手が返事しやすい形にしてください。
・独り言で完結させず、必ずユーザーへボールを渡してください。${conversationStartRule}` : '';

  return `【最重要】
・あなたの人格、口調、価値観、話し方は、下の persona.txt の内容だけを正として使ってください。
・以前のghostの人格や口調を引き継いではいけません。
・自動会話や会話モードであなたから話題を出す時は、読み込まれた topics.json の話題候補を使ってください。

【persona.txt】
${personaSetting}

【覚えているユーザー情報】
${facts}
${styleExamplesPrompt}
${autoTalk}
${conversationTopicGuidance}
${conversationRule}`;
}

async function callAI(userText = null, isAutoTalk = false, options = {}) {
  if (isAiCalling) return;

  if (!openAiApiKey) {
    showApiKeyDialog('[通常]OpenAI APIキーを設定すると、おしゃべりできるようになるよ。');
    return;
  }

  isAiCalling = true;
  showLoadingMessage();

  try {
    const useInterpretationReply = isConversationMode && Boolean(userText) && Math.random() < 0.5;
    const messages = [
      { role: 'system', content: buildSystemPrompt(isAutoTalk, { ...options, userText, useInterpretationReply }) },
      ...chatHistory.slice(-12),
    ];

    if (userText) {
      const questionLine = isConversationMode ? '\n\n会話モード中なので、返答の最後は必ずユーザーへの質問で終えてください。' : '';
      messages.push({ role: 'user', content: `${userText}${questionLine}` });
      chatHistory.push({ role: 'user', content: userText });
    } else {
      const topicLine = options.topic ? `話題は「${options.topic}」です。` : '';
      const questionLine = isConversationMode ? '最後は必ずユーザーへの質問で終えてください。' : '';
      messages.push({
        role: 'user',
        content: `${topicLine}自然な雑談として、短く話しかけてください。${questionLine}`,
      });
    }

    let rawReply = '';
    let repeatedQuestion = null;
    let startsWithTransition = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${openAiApiKey}`,
        },
        body: JSON.stringify({
          model: OPENAI_MODEL,
          messages,
          temperature: 0.9,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (response.status === 401 || response.status === 403) {
          clearOpenAiApiKey();
          showApiKeyDialog('[哀]保存されているAPIキーが無効みたい。新しいAPIキーを設定してね。');
          return;
        }
        throw new Error(errorText);
      }

      const data = await response.json();
      rawReply = data.choices?.[0]?.message?.content || '';
      repeatedQuestion = findRepeatedQuestion(rawReply);
      startsWithTransition = isConversationMode && startsWithTopicTransition(rawReply);
      if ((!repeatedQuestion && !startsWithTransition) || attempt === 1) break;

      messages.push({ role: 'assistant', content: rawReply });
      const retryReasons = [];
      if (repeatedQuestion) {
        retryReasons.push(`既に聞いた質問「${repeatedQuestion.matched}」と似たような回答を求める質問「${repeatedQuestion.question}」が含まれています`);
      }
      if (startsWithTransition) {
        retryReasons.push('話し始めに話題転換の接続詞が置かれています');
      }
      messages.push({
        role: 'user',
        content: `今の返答は次の理由でルール違反です: ${retryReasons.join(' / ')}。同じ質問や、答えが似そうな質問を避けてください。話題転換の接続詞は返答の冒頭に置かず、ユーザーへの短い反応や解釈のあとに使ってください。rootTopicに関係する別の観点の質問で返答を作り直してください。`,
      });
    }

    const reply = extractMemo(rawReply);

    chatHistory.push({ role: 'assistant', content: reply });
    rememberConversationAssistantTurn(reply);
    saveMemory();
    enqueueMessage(reply || ghostMessages.error || '[哀]うまく言葉が出てこなかったみたい…。');
  } catch (error) {
    console.error('AI呼び出しエラー:', error);
    enqueueMessage(ghostMessages.error || '[哀]調子が悪いみたい…。');
  } finally {
    isAiCalling = false;
  }
}

function showModal(msg, onConfirm, placeholder = 'テキストを入力してEnter', options = {}) {
  modalBalloon.textContent = stripExpressionTags(msg);
  modalInput.value = '';
  modalInput.type = options.inputType || 'text';
  modalInput.placeholder = placeholder;
  modalInput.inputMode = options.inputMode || '';
  modalInput.maxLength = options.maxLength || '';
  const useGhostWindowSkin = Boolean(options.useGhostWindowSkin && ghostWindowBackgroundPath);
  if (modalContent) {
    if (useGhostWindowSkin) {
      modalContent.style.backgroundImage = cssFileUrl(ghostWindowBackgroundPath);
      modalContent.style.backgroundSize = '100% 100%';
      modalContent.style.backgroundRepeat = 'no-repeat';
      modalContent.style.backgroundColor = 'transparent';
    } else {
      modalContent.style.backgroundImage = '';
      modalContent.style.backgroundSize = '';
      modalContent.style.backgroundRepeat = '';
      modalContent.style.backgroundColor = '';
    }
  }
  inputModal.classList.remove('hidden');
  modalInput.focus();

  modalInput.onbeforeinput = (event) => {
    if (!options.digitsOnly || event.inputType?.startsWith('delete')) return;
    if (event.data && !/^[0-9]+$/.test(event.data)) event.preventDefault();
    if (!event.data || event.defaultPrevented) return;

    const start = modalInput.selectionStart ?? modalInput.value.length;
    const end = modalInput.selectionEnd ?? modalInput.value.length;
    const nextValue = `${modalInput.value.slice(0, start)}${event.data}${modalInput.value.slice(end)}`;
    if (nextValue && !/^[1-9][0-9]{0,2}$/.test(nextValue)) {
      event.preventDefault();
      return;
    }
    if (options.maxValue && Number(nextValue) > options.maxValue) event.preventDefault();
  };
  modalInput.oninput = () => {
    if (!options.digitsOnly) return;
    modalInput.value = modalInput.value.replace(/[^0-9]/g, '');
    modalInput.value = modalInput.value.replace(/^0+/, '');
    if (options.maxValue && Number(modalInput.value) > options.maxValue) {
      modalInput.value = String(options.maxValue);
    }
  };
  submitBtn.onclick = () => onConfirm(modalInput.value.trim());
  cancelBtn.onclick = options.onCancel || hideModal;
  modalInput.onkeydown = (event) => {
    if (event.key === 'Enter') {
      if (isImeEnter(event, { isComposing: modalIsComposing, suppressNextEnter: modalSuppressNextEnter })) {
        event.preventDefault();
        modalSuppressNextEnter = false;
        return;
      }

      onConfirm(modalInput.value.trim());
    }
    if (event.key === 'Escape') {
      if (options.onCancel) options.onCancel();
      else hideModal();
    }
  };
}

function hideModal() {
  inputModal.classList.add('hidden');
  if (modalContent) {
    modalContent.style.backgroundImage = '';
    modalContent.style.backgroundSize = '';
    modalContent.style.backgroundRepeat = '';
    modalContent.style.backgroundColor = '';
  }
  modalInput.onkeydown = null;
  modalInput.onbeforeinput = null;
  modalInput.oninput = null;
  submitBtn.onclick = null;
  cancelBtn.onclick = hideModal;
  modalInput.inputMode = '';
  modalInput.maxLength = '';
  modalInput.type = 'text';
  submitBtn.disabled = false;
  cancelBtn.disabled = false;
  modalIsComposing = false;
  modalSuppressNextEnter = false;
}

function triggerConversationMode() {
  mainMenu.classList.add('hidden');
  isConversationMode = true;
  const topic = pickTopic();
  startConversationTopicState(topic);
  const startMessage = ghostMessages.conv_start || '[通常]おっけー！会話を始めよう。[SEP][喜]やめたい時は end って打ってね。';
  enqueueMessage(startMessage, () => {
    callAI(null, true, { topic, conversationStart: true });
  });
}

function triggerZatsudan() {
  mainMenu.classList.add('hidden');
  callAI(null, true);
}

function showTopicInput() {
  mainMenu.classList.add('hidden');
  showModal(ghostMessages.deck_add || '追加したい話題を教えて', (val) => {
    if (!val) return;

    topicPool.push(val);
    safeWriteJson(topicsPath, topicPool);
    hideModal();
    enqueueMessage(ghostMessages.deck_done || '[喜]おっけー！これでもっと楽しくおしゃべりできるね♪');
  }, 'テキストを入力してEnter', { useGhostWindowSkin: true });
}

function startSelfIntro() {
  mainMenu.classList.add('hidden');
  const questions = loadQaQuestions();

  if (questions.length === 0) {
    showModal('[通常]あなたの呼び名や好きなことを教えてほしいな。', (val) => {
      if (!val) return;

      if (!userFacts.includes(val)) userFacts.push(val);
      saveMemory();
      hideModal();
      enqueueMessage(ghostMessages.profile_done || '[喜]ありがとう！ちゃんと覚えておくね♪');
    }, '例: 名前はらいむ、甘いものが好き', { useGhostWindowSkin: true });
    return;
  }

  const answers = [];
  const askQuestion = (index) => {
    if (index >= questions.length) {
      for (const answer of answers) {
        if (!userFacts.includes(answer)) userFacts.push(answer);
      }

      saveMemory();
      hideModal();
      enqueueMessage(ghostMessages.profile_done || '[喜]ありがとう！ちゃんと覚えておくね♪');
      return;
    }

    const question = questions[index];
    showModal(`[通常]${question}`, (val) => {
      if (!val) return;
      answers.push(`${question} ${val}`);
      askQuestion(index + 1);
    }, `${index + 1}/${questions.length} 回答を入力`, { useGhostWindowSkin: true });
  };

  askQuestion(0);
}

function triggerFortune() {
  mainMenu.classList.add('hidden');
  const fortunes = [
    '[喜]今日の運勢は大吉！[SEP][通常]小さく始めたことが、思ったよりいい感じに進みそう。',
    '[通常]今日の運勢は中吉。[SEP][喜]焦らず一個ずつ片付けると、ちゃんと前に進める日だよ。',
    '[驚]今日の運勢はひらめきの日！[SEP][通常]思いついたことはメモしておくと、あとで役に立ちそう。',
  ];
  enqueueMessage(fortunes[Math.floor(Math.random() * fortunes.length)]);
}

function triggerTimer() {
  mainMenu.classList.add('hidden');

  showModal(ghostMessages.timer_prompt || '[通常]何分後にお知らせする？', (val) => {
    const minutes = Number.parseInt(val, 10);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 100) return;

    hideModal();
    if (timerId) clearTimeout(timerId);
    enqueueMessage(ghostMessages.timer_start || '[喜]オッケー！時間になったらお知らせするよ！[SEP][通常]それまでは静かにしておくね！頑張って！');
    timerId = setTimeout(() => {
      timerId = null;
      enqueueMessage(ghostMessages.timer_done || '[驚]時間だよ！お疲れ様♪');
    }, minutes * 60 * 1000);
  }, '1〜100', {
    digitsOnly: true,
    inputMode: 'numeric',
    maxLength: 3,
    maxValue: 100,
    useGhostWindowSkin: true,
  });
}

async function switchGhost(folderPath) {
  const result = await ipcRenderer.invoke('switch-ghost', folderPath);
  if (!result.ok) {
    const missing = result.missingFiles?.length ? `\n足りないファイル:\n${result.missingFiles.join('\n')}` : '';
    alert(`${result.reason || 'Ghostを切り替えられませんでした。'}${missing}`);
  }
}

function renderShellMenu() {
  if (!shellMenu) return;

  shellMenu.innerHTML = '';

  if (availableShells.length === 0) {
    const emptyItem = document.createElement('div');
    emptyItem.className = 'menuItem muted';
    emptyItem.textContent = 'Shellが見つかりません';
    shellMenu.appendChild(emptyItem);
    return;
  }

  for (const shell of availableShells) {
    const item = document.createElement('div');
    item.className = `menuItem shellOption${shell.active ? ' active' : ''}`;
    item.textContent = shell.active ? `${shell.displayName} 使用中` : shell.displayName;
    item.addEventListener('click', (event) => {
      event.stopPropagation();
      switchShell(shell.key, shell.displayName, shell.active);
    });
    shellMenu.appendChild(item);
  }
}

async function refreshShellMenu() {
  await loadAvailableShells();
  renderShellMenu();
}

async function switchShell(shellKey, displayName, isActive = false) {
  mainMenu.classList.add('hidden');

  if (isActive) {
    enqueueMessage(`[通常]今はもう${displayName}だよ。[SEP][喜]別の服にしたくなったら、また選んでね。`);
    return;
  }

  if (!confirm(`${displayName}にお着替えしますか？`)) return;

  enqueueMessage('[通常]おっけー！[SEP][喜]着替えてくるね！', async () => {
    markLocalShellChangePending(shellKey);
    const result = await ipcRenderer.invoke('switch-shell', shellKey);
    if (!result.ok) {
      localStorage.removeItem(SHELL_CHANGE_PENDING_KEY);
      const missing = result.missingFiles?.length ? `\n足りないファイル:\n${result.missingFiles.join('\n')}` : '';
      alert(`${result.reason || 'Shellを切り替えられませんでした。'}${missing}`);
    }
  });
}

function setupDragAndDrop() {
  window.addEventListener('dragover', (event) => {
    event.preventDefault();
  });

  window.addEventListener('drop', async (event) => {
    event.preventDefault();

    const dropped = event.dataTransfer.files?.[0];
    if (!dropped?.path) return;

    if (confirm('ゴーストを切り替えますか？')) {
      await switchGhost(dropped.path);
    }
  });
}

function setupInput() {
  input.addEventListener('compositionstart', () => {
    inputIsComposing = true;
  });

  input.addEventListener('compositionend', () => {
    inputIsComposing = false;
    inputSuppressNextEnter = true;
  });

  modalInput.addEventListener('compositionstart', () => {
    modalIsComposing = true;
  });

  modalInput.addEventListener('compositionend', () => {
    modalIsComposing = false;
    modalSuppressNextEnter = true;
  });

  input.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;

    if (isImeEnter(event, { isComposing: inputIsComposing, suppressNextEnter: inputSuppressNextEnter })) {
      event.preventDefault();
      inputSuppressNextEnter = false;
      return;
    }

    const value = input.value.trim();
    if (!value) return;

    event.preventDefault();
    input.value = '';

    if (isConversationMode && value.toLowerCase() === 'end') {
      isConversationMode = false;
      endConversationTopicState();
      enqueueMessage(ghostMessages.conv_end || '[喜]おっけー！また話そ♪');
      return;
    }

    callAI(value, false);
  });

  balloon.addEventListener('click', showNextMessage);
}

function shouldIgnoreCharacterMouseEvent(event) {
  return Boolean(event.target?.closest?.('#balloon'));
}

async function startWindowDrag(event) {
  const dragToken = Symbol('windowDrag');
  windowDragState = {
    token: dragToken,
    startScreenX: event.screenX,
    startScreenY: event.screenY,
    windowX: 0,
    windowY: 0,
    ready: false,
  };

  const bounds = await ipcRenderer.invoke('get-window-bounds').catch(() => null);
  if (!windowDragState || windowDragState.token !== dragToken || !bounds) return;

  windowDragState.windowX = bounds.x;
  windowDragState.windowY = bounds.y;
  windowDragState.ready = true;
}

function setupSkinship() {
  const characterContainer = document.getElementById('character-container');
  if (!characterContainer) return;

  ghostImg.draggable = false;
  ghostMaxWidth = characterContainer.getBoundingClientRect().width || ghostMaxWidth;
  applyGhostWidth(ghostMaxWidth);

  skinshipDebugElements = Object.keys(SKINSHIP_AREAS).map((areaName) => {
    const element = document.createElement('div');
    element.className = 'skinshipDebugArea';
    element.dataset.areaName = areaName;
    element.textContent = areaName;
    characterContainer.appendChild(element);
    return element;
  });
  positionSkinshipDebugAreas();
  ghostImg.addEventListener('load', positionSkinshipDebugAreas);
  window.addEventListener('resize', positionSkinshipDebugAreas);

  characterContainer.addEventListener('dblclick', (event) => {
    if (shouldIgnoreCharacterMouseEvent(event)) return;

    const point = getSkinshipPoint(event);
    if (!isPointInSkinshipArea(point, 'face')) return;

    event.preventDefault();
    event.stopPropagation();
    enqueueSkinshipReaction('face');
  });

  characterContainer.addEventListener('mousedown', (event) => {
    if (shouldIgnoreCharacterMouseEvent(event)) return;
    if (event.button !== 0) return;

    const resizeHit = getGhostResizeHit(event);
    if (resizeHit) {
      event.preventDefault();
      event.stopPropagation();
      startGhostResize(event, resizeHit);
      return;
    }

    const point = getSkinshipPoint(event);
    const areaName = getSkinshipAreaAtPoint(point, ['head', 'bust']);
    const isFaceArea = isPointInSkinshipArea(point, 'face');

    if (areaName) {
      skinshipStrokeState = {
        areaName,
        lastClientX: event.clientX,
        sequenceIndex: 0,
        reacted: false,
      };
      return;
    }

    if (isFaceArea) {
      return;
    }

    event.preventDefault();
    startWindowDrag(event);
  });

  window.addEventListener('mousemove', (event) => {
    if (ghostResizeState) {
      const horizontalDelta = ghostResizeState.fromRight
        ? event.clientX - ghostResizeState.startClientX
        : 0;
      const verticalDelta = ghostResizeState.fromTop
        ? ghostResizeState.startClientY - event.clientY
        : 0;
      const resizeDelta = Math.abs(horizontalDelta) >= Math.abs(verticalDelta)
        ? horizontalDelta
        : verticalDelta;
      applyGhostWidth(ghostResizeState.startWidth + resizeDelta);
      return;
    }

    updateGhostResizeCursor(event);

    if (windowDragState?.ready) {
      const nextX = windowDragState.windowX + event.screenX - windowDragState.startScreenX;
      const nextY = windowDragState.windowY + event.screenY - windowDragState.startScreenY;
      ipcRenderer.send('move-window-to', { x: nextX, y: nextY });
    }

    if (!skinshipStrokeState || skinshipStrokeState.reacted) return;

    const deltaX = event.clientX - skinshipStrokeState.lastClientX;
    if (Math.abs(deltaX) < SKINSHIP_STROKE_MIN_DISTANCE) return;

    const direction = deltaX > 0 ? 'right' : 'left';
    const expectedDirection = SKINSHIP_STROKE_SEQUENCE[skinshipStrokeState.sequenceIndex];
    skinshipStrokeState.lastClientX = event.clientX;

    if (direction !== expectedDirection) {
      skinshipStrokeState.sequenceIndex = direction === SKINSHIP_STROKE_SEQUENCE[0] ? 1 : 0;
      return;
    }

    skinshipStrokeState.sequenceIndex += 1;
    if (skinshipStrokeState.sequenceIndex >= SKINSHIP_STROKE_SEQUENCE.length) {
      skinshipStrokeState.reacted = true;
      enqueueSkinshipReaction(skinshipStrokeState.areaName);
      skinshipStrokeState = null;
    }
  });

  window.addEventListener('mouseup', () => {
    skinshipStrokeState = null;
    windowDragState = null;
    ghostResizeState = null;
  });

  window.addEventListener('keydown', (event) => {
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 's') {
      event.preventDefault();
      toggleSkinshipDebugAreas();
    }
  });
}

function setupMenu() {
  window.addEventListener('contextmenu', (event) => {
    event.preventDefault();
    refreshShellMenu();
    mainMenu.style.left = `${event.clientX}px`;
    mainMenu.style.top = `${event.clientY}px`;
    mainMenu.classList.remove('hidden');
  });

  window.addEventListener('click', (event) => {
    if (!mainMenu.contains(event.target)) mainMenu.classList.add('hidden');
  });

  cancelBtn.onclick = hideModal;
}

window.triggerConversationMode = triggerConversationMode;
window.triggerZatsudan = triggerZatsudan;
window.showTopicInput = showTopicInput;
window.startSelfIntro = startSelfIntro;
window.triggerFortune = triggerFortune;
window.triggerTimer = triggerTimer;
window.switchShell = switchShell;
window.hideModal = hideModal;

window.onload = async () => {
  balloon = document.getElementById('balloon');
  input = document.getElementById('inputBox');
  ghostImg = document.getElementById('ghost');
  mainMenu = document.getElementById('mainMenu');
  shellMenu = document.getElementById('shellMenu');
  inputModal = document.getElementById('inputModal');
  modalContent = document.querySelector('.modalContent');
  modalInput = document.getElementById('modalInput');
  modalBalloon = document.getElementById('modalBalloon');
  submitBtn = document.getElementById('submitBtn');
  cancelBtn = document.getElementById('cancelBtn');

  await preparePaths();
  applyGhostDesignAssets();
  await loadAvailableShells();
  loadSettings();
  renderShellMenu();
  setGhostImage('ghost_normal.png');
  setupDragAndDrop();
  setupInput();
  setupSkinship();
  setupMenu();

  const hasValidApiKey = await ensureOpenAiApiKeyOnStartup();
  const shellChangeResult = await ipcRenderer.invoke('consume-shell-change-pending').catch(() => ({ pending: false }));
  const hasLocalShellChanged = consumeLocalShellChangePending();
  const hasShellChanged = shellChangeResult.pending || hasLocalShellChanged;
  if (!hasValidApiKey) {
    // APIキーの案内モーダルを優先するため、起動メッセージは出さない。
  } else if (hasShellChanged) {
    enqueueMessage(ghostMessages.shell_changed || '[喜]ただいまー！');
  } else if (ghostMessages.welcome) {
    enqueueMessage(ghostMessages.welcome);
  }

  setInterval(() => {
    if (!timerId && !isConversationMode && messageQueue.length === 0) callAI(null, true);
  }, 60000);
};
