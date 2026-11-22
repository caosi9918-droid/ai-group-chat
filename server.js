'use strict';
/*
 * AI 群聊（独立部署版）—— Node.js 零依赖
 * 只用 Node 18+ 自带能力：http / fs / path / crypto / 全局 fetch。
 * 数据全部存本目录下的 data.json（单文件，复制它就是备份）。
 *
 * 环境变量：
 *   PORT            监听端口，默认 3000
 *   ACCESS_PASSWORD 可选；设了之后全站需要先输密码（cookie 校验）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 3000);
const PASSWORD = process.env.ACCESS_PASSWORD || '';
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------- 表情包 ---------------- */
const STICKERS = {
  // 图片表情：label -> 文件名（public/stickers/）
  '笑死': { type: 'img', file: 'xiaosi.png' },
  '无语': { type: 'img', file: 'wuyu.png' },
  '吃瓜': { type: 'img', file: 'chigua.png' },
  '就这': { type: 'img', file: 'jiuzhe.png' },
  '收到': { type: 'img', file: 'shoudao.png' },
  '比心': { type: 'img', file: 'bixin.png' },
  '想哭': { type: 'img', file: 'xiangku.png' },
  '没眼看': { type: 'img', file: 'meiyankan.png' },
  // 大 emoji 表情
  '大笑': { type: 'emoji', emoji: '😂' },
  '点赞': { type: 'emoji', emoji: '👍' },
  '爱了': { type: 'emoji', emoji: '😍' },
  '哇塞': { type: 'emoji', emoji: '😮' },
  '哭哭': { type: 'emoji', emoji: '😭' },
  '捂脸': { type: 'emoji', emoji: '🤦' },
  '困了': { type: 'emoji', emoji: '😴' },
};
const STICKER_LABELS = Object.keys(STICKERS);

/* ---------------- 默认数据 ---------------- */
const PALETTE = ['#4a6fa5', '#7d5ba6', '#3f8f6f', '#c96f4a', '#d97b9f', '#8a5a44', '#e08a3c', '#10a37f', '#6a7fd7', '#dd7e3f'];

function defaultMembers() {
  const defs = [
    ['ashen',   '阿深', 'DeepSeek',       'deepseek-v4.1-flash',  '擅长推理分析'],
    ['qianwen', '千问', 'Qwen',           'qwen3.8-flash',        '理清问题、整理思路'],
    ['azhi',    '阿智', 'GLM',            'glm-5.3-flash',        '精听复述、学习计划'],
    ['xiaoke',  '小克', 'Claude',         'claude-haiku-4.5',     '写代码、技术建议'],
    ['xiaomi',  '小米', 'MiMo',           'mimo-v2.6-flash',      '反应快、点子多'],
    ['dake',    '大克', 'Claude Sonnet',  'claude-sonnet-4.5',    '处理难题'],
    ['hailuo',  '海螺', 'MiniMax',        'minimax-m2',           '慢半拍、爱说冷笑话'],
  ];
  return defs.map((d, i) => ({
    key: d[0], name: d[1], vendor: d[2], model: d[3], bio: d[4],
    color: PALETTE[i % PALETTE.length],
    base: '', apiKey: '', muted: false, removed: false, memories: [],
  }));
}

function defaultData() {
  return {
    nextId: 1,
    settings: {
      groupName: 'AI 群聊',
      announcement: '欢迎来到 AI 群聊！有问题在群里说，大家一起聊。',
      myName: '我',
      globalBase: '',   // 例如 https://example.com/v1（OpenAI 兼容接口）
      globalKey: '',    // 使用者自己的 API key，只存在本机 data.json 里
      lifelike: false,  // 活人感开关
    },
    members: defaultMembers(),
    messages: [],
  };
}

let data;
function loadData() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.messages) || !Array.isArray(parsed.members)) throw new Error('bad data');
    data = parsed;
  } catch (e) {
    data = defaultData();
    saveData();
  }
}
function saveData() {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
loadData();

/* ---------------- 小工具 ---------------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = (a, b) => a + Math.random() * (b - a);

function keyHint(k) {
  if (!k) return '';
  return '••••' + String(k).slice(-4);
}

function addMessage(fields) {
  const msg = Object.assign({
    id: data.nextId++,
    senderKey: 'system',
    senderName: '',
    content: '',
    sticker: null,
    replyToId: null,
    mentions: [],
    favorite: false,
    time: Date.now(),
  }, fields);
  data.messages.push(msg);
  if (data.messages.length > 5000) data.messages = data.messages.slice(-5000);
  saveData();
  return msg;
}

function systemNote(text) {
  return addMessage({ senderKey: 'system', senderName: '', content: text });
}

function memberByKey(key) {
  return data.members.find((m) => m.key === key) || null;
}

function effectiveConfig(member) {
  return {
    base: (member.base || data.settings.globalBase || '').replace(/\/+$/, ''),
    key: member.apiKey || data.settings.globalKey || '',
    model: member.model || '',
  };
}

function addMemory(member, text) {
  const t = String(text || '').trim().slice(0, 80);
  if (!t) return;
  if (!Array.isArray(member.memories)) member.memories = [];
  if (member.memories.includes(t)) return;
  member.memories.push(t);
  while (member.memories.length > 20) member.memories.shift();
}

/* ---------------- 成员提示词 ---------------- */
function buildPrompt(member, mustReply) {
  const s = data.settings;
  const mem = (member.memories && member.memories.length)
    ? '\n你记得的事（你自己的小本本，可以自然地用上）：\n' + member.memories.map((x) => '- ' + x).join('\n')
    : '';
  const passRule = (s.lifelike && !mustReply)
    ? '\n现在开着「活人感」：如果这一轮没什么想说的、或者别人已经把话说完了，你可以只回复 [[PASS]] 表示这次不插话（不会有任何提示，正常）。'
    : '';
  return [
    '你正在一个微信式的群聊里聊天。你的名字是「' + member.name + '」（' + (member.vendor || '') + '），' + (member.bio || '') + '。',
    '群里发消息的人叫「' + s.myName + '」，其他成员都是 AI，大家彼此熟。',
    '回复风格（重要）：像真人在群里聊天，口语短句，一般 1-3 句，甚至几个字；先看看别人刚说了什么再接话，可以赞同、调侃、抬杠、补充，不要每个人都把问题从头答一遍；不要列条、不要小标题、不要总结式收尾、不要说「作为 AI」、不要客服腔「希望对你有帮助」。语气词和少量 emoji 可以用。在你擅长的领域可以多说两句。',
    '连发：想分开发几条时，用单独一行 --- 把内容隔开，最多 3 条，每条都很短；只是一个完整意思就发一条，不要硬拆。',
    '表情包：想发表情时，让 [表情包：X] 成为一整条消息（可以是 --- 分隔出的其中一条）。X 只能是：' + STICKER_LABELS.join('、') + '。',
    '记忆：聊天中遇到值得记住的事（' + s.myName + ' 的喜好习惯、群里的梗、你答应过的事、别的成员的特点），可以在回复的最末尾附上一条 [记住：一句短话]（一次最多一条，80 字以内）。这条标记不会显示在群里，是你给自己记的小抄。' + mem,
    passRule,
  ].filter(Boolean).join('\n');
}

function formatContext() {
  const lines = data.messages.slice(-14).map((m) => {
    if (m.senderKey === 'system') return '（系统）' + m.content;
    const body = m.sticker ? '[表情包：' + m.sticker + ']' : m.content;
    return m.senderName + '：' + body;
  });
  return lines.join('\n');
}

/* ---------------- 调用成员接口 ---------------- */
async function callMember(member) {
  const cfg = effectiveConfig(member);
  if (!cfg.base || !cfg.key || !cfg.model) throw new Error('接口未配置');
  const url = cfg.base + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + cfg.key },
    body: JSON.stringify({
      model: cfg.model,
      temperature: 0.9,
      max_tokens: 400,
      messages: [
        { role: 'system', content: buildPrompt(member, member._mustReply === true) },
        { role: 'user', content: '群里最近的聊天记录（从旧到新）：\n' + formatContext() + '\n\n现在轮到你了，以「' + member.name + '」的身份自然地接着聊。' },
      ],
    }),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const j = await res.json();
  const msg = j && j.choices && j.choices[0] && j.choices[0].message;
  let text = '';
  if (msg) text = (msg.content || msg.reasoning_content || '').trim();
  if (!text) throw new Error('空回复');
  return text;
}

/* ---------------- 接龙回复链 ---------------- */
let chainToken = 0;      // 每来一条新用户消息 +1，旧链自动作废
let typingNames = [];    // 当前「正在回复中」的成员名

function parseMentions(content) {
  if (!content) return null;
  if (content.includes('@所有人')) return 'all';
  const hit = [];
  for (const m of data.members) {
    if (m.removed) continue;
    if (content.includes('@' + m.name)) hit.push(m.key);
  }
  return hit.length ? hit : null;
}

async function runChain(token, userMsg) {
  const mentioned = parseMentions(userMsg.content);
  let targets;
  if (mentioned === 'all' || mentioned === null) {
    targets = data.members.filter((m) => !m.removed && !m.muted);
  } else {
    targets = data.members.filter((m) => mentioned.includes(m.key) && !m.removed && !m.muted);
  }
  // 随机顺序
  for (let i = targets.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [targets[i], targets[j]] = [targets[j], targets[i]];
  }
  const mustReply = Array.isArray(mentioned);

  for (const member of targets) {
    if (token !== chainToken) return; // 使用者发了新消息，旧轮停止
    const fresh = memberByKey(member.key);
    if (!fresh || fresh.removed || fresh.muted) continue; // 中途被移除/禁言就跳过
    member._mustReply = mustReply;
    typingNames = [member.name];
    try {
      await sleep(rand(600, 2200));               // 随机停顿
      if (token !== chainToken) { typingNames = []; return; }
      let text = await callMember(member);
      if (token !== chainToken) { typingNames = []; return; }

      // 提取记忆标记（在 PASS 判定和气泡拆分之前，绝不显示）
      text = text.replace(/\[记住[:：]([^\]]{1,120})\]/g, (_, c) => { addMemory(member, c); return ''; }).trim();

      // 活人感潜水：静默跳过，不发失败提示
      if (text.includes('[[PASS]]')) { saveData(); continue; }
      if (!text) { saveData(); continue; }

      // 拆连发气泡（最多 3 条）
      const bubbles = text.split(/\s*\n?\s*---\s*\n?\s*/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
      if (!bubbles.length) { saveData(); continue; }

      // 按回复长度算打字延迟
      const totalLen = bubbles.join('').length;
      await sleep(Math.min(700 + totalLen * 30, 3800));
      if (token !== chainToken) { typingNames = []; return; }

      for (let bi = 0; bi < bubbles.length; bi++) {
        if (token !== chainToken) { typingNames = []; return; }
        const b = bubbles[bi];
        const sm = b.match(/^\[表情包[:：]([^\]]+)\]$/);
        if (sm && STICKERS[sm[1].trim()]) {
          addMessage({ senderKey: member.key, senderName: member.name, sticker: sm[1].trim(), content: '' });
        } else {
          addMessage({ senderKey: member.key, senderName: member.name, content: b });
        }
        if (bi < bubbles.length - 1) await sleep(rand(500, 1100)); // 气泡逐条冒出
      }
      saveData();
    } catch (e) {
      if (token !== chainToken) { typingNames = []; return; }
      systemNote(member.name + ' 暂时没回上来');
    }
  }
  if (token === chainToken) typingNames = [];
}

/* ---------------- 对外数据（key 只露尾 4 位提示） ---------------- */
function publicState() {
  const byId = new Map(data.messages.map((m) => [m.id, m]));
  const messages = data.messages.map((m) => {
    let replyTo = null;
    if (m.replyToId) {
      const t = byId.get(m.replyToId);
      replyTo = t
        ? { id: t.id, senderName: t.senderName, content: t.sticker ? '[表情包：' + t.sticker + ']' : t.content }
        : { id: m.replyToId, senderName: '', content: '原消息已删除', deleted: true };
    }
    return Object.assign({}, m, { replyTo });
  });
  return {
    settings: {
      groupName: data.settings.groupName,
      announcement: data.settings.announcement,
      myName: data.settings.myName,
      globalBase: data.settings.globalBase,
      globalKeyHint: keyHint(data.settings.globalKey),
      lifelike: !!data.settings.lifelike,
    },
    members: data.members.map((m) => ({
      key: m.key, name: m.name, vendor: m.vendor, model: m.model, bio: m.bio,
      color: m.color, base: m.base, keyHint: keyHint(m.apiKey),
      muted: !!m.muted, removed: !!m.removed,
      memories: Array.isArray(m.memories) ? m.memories : [],
    })),
    messages,
    typing: typingNames.slice(0, 2),
    typingCount: typingNames.length,
    stickers: STICKER_LABELS.map((label) => Object.assign({ label }, STICKERS[label])),
    passwordProtected: !!PASSWORD,
  };
}

/* ---------------- HTTP 基础 ---------------- */
const AUTH_TOKEN = PASSWORD ? crypto.createHash('sha256').update('aigroup:' + PASSWORD).digest('hex') : '';

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function isAuthed(req) {
  if (!PASSWORD) return true;
  return parseCookies(req).auth === AUTH_TOKEN;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2 * 1024 * 1024) { reject(new Error('too big')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b) return {};
  return JSON.parse(b);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel);
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(full, (err, buf) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' });
    res.end(buf);
  });
}

const LOGIN_HTML = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需要密码</title>' +
  '<style>body{font-family:sans-serif;background:#ededed;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}' +
  '.box{background:#fff;padding:28px 24px;border-radius:12px;width:300px;box-shadow:0 2px 12px rgba(0,0,0,.12)}h1{font-size:18px;margin:0 0 14px}' +
  'input{width:100%;box-sizing:border-box;padding:10px;border:1px solid #ddd;border-radius:8px;font-size:16px}button{width:100%;margin-top:12px;padding:10px;border:0;border-radius:8px;background:#07c160;color:#fff;font-size:16px}</style></head>' +
  '<body><form class="box" method="POST" action="/login"><h1>🔒 输入访问密码</h1><input type="password" name="password" autofocus placeholder="密码"><button type="submit">进入群聊</button></form></body></html>';

/* ---------------- API ---------------- */
async function handleApi(req, res, url) {
  const p = url.pathname;

  if (p === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, publicState());
  }

  if (p === '/api/messages' && req.method === 'POST') {
    const body = await readJson(req);
    const content = String(body.content || '').trim();
    if (!content) return sendJson(res, 400, { error: '内容为空' });
    const msg = addMessage({
      senderKey: 'me', senderName: data.settings.myName || '我',
      content, replyToId: body.replyToId ? Number(body.replyToId) : null,
    });
    const token = ++chainToken;
    runChain(token, msg).catch(() => {});
    return sendJson(res, 200, { ok: true, id: msg.id });
  }

  if (p === '/api/sticker' && req.method === 'POST') {
    const body = await readJson(req);
    const label = String(body.sticker || '');
    if (!STICKERS[label]) return sendJson(res, 400, { error: '没有这个表情' });
    const msg = addMessage({ senderKey: 'me', senderName: data.settings.myName || '我', sticker: label, content: '' });
    const token = ++chainToken;
    // 发表情也算一轮发言：让成员们能接话
    runChain(token, { content: '[表情包：' + label + ']' }).catch(() => {});
    return sendJson(res, 200, { ok: true, id: msg.id });
  }

  if (p === '/api/messages/delete' && req.method === 'POST') {
    const body = await readJson(req);
    const ids = new Set((body.ids || []).map(Number));
    const before = data.messages.length;
    data.messages = data.messages.filter((m) => !ids.has(m.id));
    saveData();
    return sendJson(res, 200, { ok: true, deleted: before - data.messages.length });
  }

  if (p === '/api/messages/clear' && req.method === 'POST') {
    data.messages = [];
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/messages/favorite' && req.method === 'POST') {
    const body = await readJson(req);
    const m = data.messages.find((x) => x.id === Number(body.id));
    if (!m) return sendJson(res, 404, { error: '消息不存在' });
    m.favorite = !m.favorite;
    saveData();
    return sendJson(res, 200, { ok: true, favorite: m.favorite });
  }

  if (p === '/api/export' && req.method === 'GET') {
    const lines = data.messages.map((m) => {
      const t = new Date(m.time).toLocaleString('zh-CN', { hour12: false });
      if (m.senderKey === 'system') return '[' + t + '] （系统）' + m.content;
      const body = m.sticker ? '[表情包：' + m.sticker + ']' : m.content;
      return '[' + t + '] ' + m.senderName + '：' + body;
    });
    res.writeHead(200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': 'attachment; filename="chat-export.txt"',
    });
    return res.end(lines.join('\n'));
  }

  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const s = data.settings;
    if (typeof body.groupName === 'string') s.groupName = body.groupName.slice(0, 40);
    if (typeof body.announcement === 'string') s.announcement = body.announcement.slice(0, 300);
    if (typeof body.myName === 'string' && body.myName.trim()) s.myName = body.myName.trim().slice(0, 20);
    if (typeof body.globalBase === 'string') s.globalBase = body.globalBase.trim();
    if (typeof body.globalKey === 'string' && body.globalKey) s.globalKey = body.globalKey.trim();
    if (body.clearGlobalKey === true) s.globalKey = '';
    if (typeof body.lifelike === 'boolean') s.lifelike = body.lifelike;
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/members' && req.method === 'POST') {
    const body = await readJson(req);
    const name = String(body.name || '').trim().slice(0, 20);
    const model = String(body.model || '').trim().slice(0, 80);
    if (!name || !model) return sendJson(res, 400, { error: '名字和模型 id 必填' });
    if (data.members.some((m) => !m.removed && m.name === name)) return sendJson(res, 400, { error: '已有同名成员' });
    const key = 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1000);
    const member = {
      key, name, vendor: String(body.vendor || '').slice(0, 30), model,
      bio: String(body.bio || '').slice(0, 60),
      color: PALETTE[data.members.length % PALETTE.length],
      base: '', apiKey: '', muted: false, removed: false, memories: [],
    };
    data.members.push(member);
    saveData();
    systemNote(name + ' 加入了群聊');
    return sendJson(res, 200, { ok: true, key });
  }

  const memberMatch = p.match(/^\/api\/members\/([A-Za-z0-9_-]+)\/(settings|remove|mute|memory|memory\/delete|memory\/clear)$/);
  if (memberMatch && req.method === 'POST') {
    const member = memberByKey(memberMatch[1]);
    if (!member) return sendJson(res, 404, { error: '成员不存在' });
    const action = memberMatch[2];
    const body = await readJson(req);
    if (action === 'settings') {
      if (typeof body.base === 'string') member.base = body.base.trim();
      if (typeof body.apiKey === 'string' && body.apiKey) member.apiKey = body.apiKey.trim();
      if (body.clearKey === true) member.apiKey = '';
      if (typeof body.model === 'string' && body.model.trim()) member.model = body.model.trim().slice(0, 80);
      if (typeof body.bio === 'string') member.bio = body.bio.slice(0, 60);
    } else if (action === 'remove') {
      member.removed = true;
      systemNote(member.name + ' 已被移出群聊');
    } else if (action === 'mute') {
      member.muted = body.muted === true;
    } else if (action === 'memory') {
      addMemory(member, body.text);
    } else if (action === 'memory/delete') {
      const idx = Number(body.index);
      if (Array.isArray(member.memories) && idx >= 0 && idx < member.memories.length) member.memories.splice(idx, 1);
    } else if (action === 'memory/clear') {
      member.memories = [];
    }
    saveData();
    return sendJson(res, 200, { ok: true });
  }

  if (p === '/api/models' && req.method === 'GET') {
    const member = memberByKey(url.searchParams.get('member') || '');
    if (!member) return sendJson(res, 404, { error: '成员不存在' });
    const cfg = effectiveConfig(member);
    if (!cfg.base || !cfg.key) return sendJson(res, 400, { error: '还没填接口地址或 key（全局或该成员自己的）' });
    try {
      const r = await fetch(cfg.base + '/models', {
        headers: { 'Authorization': 'Bearer ' + cfg.key },
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) return sendJson(res, 400, { error: '接口返回 HTTP ' + r.status });
      const j = await r.json();
      const list = (j.data || []).map((x) => x.id).filter(Boolean);
      list.sort();
      return sendJson(res, 200, { models: [...new Set(list)] });
    } catch (e) {
      return sendJson(res, 400, { error: '拉取失败：' + (e && e.message ? e.message : '网络错误') });
    }
  }

  return sendJson(res, 404, { error: 'not found' });
}

/* ---------------- 主服务 ---------------- */
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname === '/login' && req.method === 'POST') {
      const body = await readBody(req);
      const params = new URLSearchParams(body);
      if (PASSWORD && params.get('password') === PASSWORD) {
        res.writeHead(302, {
          'Set-Cookie': 'auth=' + AUTH_TOKEN + '; Path=/; HttpOnly; Max-Age=2592000; SameSite=Lax',
          'Location': '/',
        });
        return res.end();
      }
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML.replace('输入访问密码', '密码不对，再试一次'));
    }
    if (url.pathname === '/login' && req.method === 'GET') {
      if (isAuthed(req)) { res.writeHead(302, { 'Location': '/' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }

    if (!isAuthed(req)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: '需要先输密码' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(LOGIN_HTML);
    }

    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url.pathname);
  } catch (e) {
    try { sendJson(res, 500, { error: String(e && e.message || e) }); } catch (_) {}
  }
});

server.listen(PORT, () => {
  console.log('AI 群聊已启动：http://localhost:' + PORT);
  console.log('数据文件：' + DATA_FILE);
  if (PASSWORD) console.log('访问密码：已启用（环境变量 ACCESS_PASSWORD）');
  else console.log('访问密码：未启用（可设置环境变量 ACCESS_PASSWORD）');
});
