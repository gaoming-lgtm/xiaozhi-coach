import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { TOOLS, TOOL_MAP } from './lib/tools.mjs';
import { VOICES } from './lib/voices.mjs';
import { createAllowlist, suggestRule } from './lib/allowlist.mjs';
import { ideContext, openerFor, isInside } from './lib/ide.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(HERE, 'public');
const DATA_DIR = path.join(HERE, 'data');
const SESSION_DIR = path.join(DATA_DIR, 'sessions');
const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const SPEC_FILE = path.join(HERE, 'specs', process.env.SPEC || 'xiaozhi-breadboard-oled.json');
const PROMPT_FILE = path.join(HERE, 'prompts', 'coach.md');

fs.mkdirSync(SESSION_DIR, { recursive: true });
fs.mkdirSync(PHOTO_DIR, { recursive: true });

// 装机蓝图：接线、步骤、验收标准都在这份 JSON 里，模型只能读不能改。
function readSpec() {
  return JSON.parse(fs.readFileSync(SPEC_FILE, 'utf8').replace(/^\uFEFF/, ''));
}

let SPEC = readSpec();
let SPEC_STEPS = SPEC.steps || [];
let specMtime = fs.statSync(SPEC_FILE).mtimeMs;

// 改了 spec 自动重新加载，不用重启服务（改颜色/接线的时候省事）
function reloadSpec() {
  try {
    const m = fs.statSync(SPEC_FILE).mtimeMs;
    if (m === specMtime) return false;
    SPEC = readSpec();
    SPEC_STEPS = SPEC.steps || [];
    specMtime = m;
    console.log('[spec] 已重新加载');
    return true;
  } catch (e) {
    console.error('[spec] 重载失败', e.message);
    return false;
  }
}

const stepById = (id) => SPEC_STEPS.find((x) => x.id === id) || null;
const stepIndex = (id) => SPEC_STEPS.findIndex((x) => x.id === id);

const allow = createAllowlist(path.join(DATA_DIR, 'allowlist.json'));

// ---------------------------------------------------------------- config

const configPath = path.join(HERE, 'config.json');
let cfg = {};
// 注意：记事本等编辑器可能写入带 BOM 的 UTF-8，JSON.parse 会直接失败，这里先去掉 BOM。
try { cfg = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '')); } catch {}

const DIST = !!cfg.dist;
const DEFAULT_ROOT = DIST
  ? path.join(process.env.USERPROFILE || os.homedir(), 'Documents', '小智装机')
  : WORKSPACE;

// token 存盘复用：地址固定下来，重启也不用再换链接（不然每次都得重新复制）
const TOKEN_FILE = path.join(DATA_DIR, 'token.txt');
let SAVED_TOKEN = '';
try { SAVED_TOKEN = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch {}
if (!/^[a-f0-9]{20,}$/i.test(SAVED_TOKEN)) {
  SAVED_TOKEN = crypto.randomUUID().replace(/-/g, '');
  try { fs.writeFileSync(TOKEN_FILE, SAVED_TOKEN, 'utf8'); } catch {}
}

const state = {
  port: Number(cfg.port) || 7842,
  token: SAVED_TOKEN,
  model: cfg.model || 'deepseek-v4-pro',
  voice: cfg.voice || 'zh-CN-XiaoxiaoNeural',
  rate: cfg.rate || '+0%',
  visionModel: cfg.visionModel || 'deepseek-flash',
  projectRoot: cfg.projectRoot || DEFAULT_ROOT,
  apiKey: '',
  apiBase: cfg.apiBase || 'https://api.deepseek.com',
  ttsMode: cfg.tts || 'auto',
  ttsAvailable: false,
};

const MODELS = [
  { id: 'deepseek-v4-pro', name: 'deepseek-v4-pro', desc: '更强，讲复杂概念' },
  { id: 'deepseek-flash', name: 'deepseek-flash', desc: '更快，日常陪练' },
];

function loadApiKey() {
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY.trim();
  if (cfg.apiKey) return String(cfg.apiKey).trim();
  return '';
}
state.apiKey = loadApiKey();

const TEACHER_PROMPT = fs.readFileSync(PROMPT_FILE, 'utf8');

// ---------------------------------------------------------------- sessions

const sessions = new Map();

function newSession() {
  const id = crypto.randomUUID();
  const s = {
    id,
    title: '新的装机',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messages: [],
    plan: [],
    board: null,
    stepId: SPEC_STEPS[0]?.id || null,
    checks: [],
    autoAllow: new Set(),
  };
  sessions.set(id, s);
  return s;
}

function publicSession(s) {
  return {
    id: s.id,
    title: s.title,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    messages: s.messages,
    plan: s.plan,
    board: s.board,
    stepId: s.stepId,
    checks: s.checks,
  };
}

async function saveSession(s) {
  try {
    const data = { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, messages: s.messages, plan: s.plan, board: s.board, stepId: s.stepId, checks: s.checks };
    await fsp.writeFile(path.join(SESSION_DIR, `${s.id}.json`), JSON.stringify(data, null, 1), 'utf8');
  } catch (e) { console.error('[session save]', e.message); }
}

async function loadSessionsFromDisk() {
  const entries = await fsp.readdir(SESSION_DIR).catch(() => []);
  for (const f of entries) {
    if (!f.endsWith('.json')) continue;
    try {
      const d = JSON.parse(await fsp.readFile(path.join(SESSION_DIR, f), 'utf8'));
      if (!d.id) continue;
      sessions.set(d.id, { ...d, autoAllow: new Set() });
    } catch {}
  }
}

// ---------------------------------------------------------------- helpers

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("录音太大")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sse(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  res.write(':ok\n\n');
  return (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
  };
}

const boardSubs = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
  for (const res of boardSubs) {
    try { res.write(payload); } catch { boardSubs.delete(res); }
  }
}

function broadcastBoard(d) {
  broadcast('board', d);
}

function resolveInRoot(p) {
  const root = path.resolve(state.projectRoot);
  const abs = path.resolve(root, p || '.');
  const rel = path.relative(root, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('这条路径超出了教学项目目录，不能操作。');
  return abs;
}

function trimMessages(messages, keep = 36) {
  let out = messages.slice(-keep);
  let guard = 0;
  while (out.length && guard++ < 10) {
    const first = out[0];
    if (first.role === 'tool' || (first.role === 'assistant' && first.tool_calls)) out = out.slice(1);
    else break;
  }
  return out;
}

function safeParseArgs(raw) {
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return { __parse_error: String(raw).slice(0, 300) }; }
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', '.piptmp', 'vendor']);

async function tree(dir, depth, out, max = 400) {
  if (depth < 0 || out.length >= max) return;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (out.length >= max) return;
    if (e.name.startsWith('.') && e.name !== '.env.example') continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(state.projectRoot, full).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push({ type: 'dir', path: rel });
      await tree(full, depth - 1, out, max);
    } else {
      out.push({ type: 'file', path: rel, size: (await fsp.stat(full).catch(() => ({ size: 0 }))).size });
    }
  }
}

// ---------------------------------------------------------------- model

function systemPrompt(session) {
  const i = stepIndex(session.stepId);
  const cur = stepById(session.stepId);
  const done = new Set((session.checks || []).filter((c) => c.result === 'pass').map((c) => c.step));
  const progress = SPEC_STEPS.map((s, n) => `${done.has(s.id) ? '[x]' : n === i ? '[>]' : '[ ]'} ${s.id} ${s.title}`).join('\n');

  return `${TEACHER_PROMPT}

---

# 本次装机环境

- 方案：${SPEC.name}
- 主控：${SPEC.board.model}（${SPEC.board.flash} Flash / ${SPEC.board.psram} PSRAM，USB 串口芯片 ${SPEC.board.usb_serial}）
- 现在：第 ${i + 1} 步 / 共 ${SPEC_STEPS.length} 步 —— ${cur ? `「${cur.title}」` : '还没开始'}
- 今天：${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
- 学生看到的界面：左边是对话，右边是 3D 演示（面包板、零件、彩色接线），下面是步骤卡。
  你调 \`show_step\` 右侧就会换到那一步；调 \`show_3d\` 可以只高亮某个零件、只画某几根线。
- 学生可能**用嘴说**，语音识别会有错字，按发音猜原意。
- 他拍照给你看是正常操作，不是异常。

## 整条流程
${progress}

## 这一步的资料（来自蓝图，可直接引用）
${cur ? `目标：${cur.goal}\n为什么：${cur.why}\n怎么做：${(cur.do || []).join('；')}\n验收标准：${cur.check}\n易错点：${(cur.pitfalls || []).join('；') || '无'}` : '（未开始）'}

## 提醒
- 你的回答会被逐句朗读。短句，不要堆格式。
- 一次只推进一步，结尾必须留一个动作或一个问题。
- 涉及接线，先调 \`get_wiring\`，不许凭记忆说脚位。`;
}

async function streamCompletion(session, send, signal) {
  const body = {
    model: state.model,
    messages: [{ role: 'system', content: systemPrompt(session) }, ...trimMessages(session.messages)],
    tools: TOOLS,
    tool_choice: 'auto',
    temperature: 0.6,
    max_tokens: 1600,
    stream: true,
    stream_options: { include_usage: true },
  };

  const r = await fetch(`${state.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.apiKey}` },
    body: JSON.stringify(body),
    signal,
  });

  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`模型接口 ${r.status}：${t.slice(0, 300)}`);
  }

  let content = '';
  let thinking = false;
  const toolCalls = [];
  let usage = null;
  let finish = null;

  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const parts = buf.split('\n');
    buf = parts.pop() || '';
    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (payload === '[DONE]') continue;
      let evt;
      try { evt = JSON.parse(payload); } catch { continue; }
      if (evt.usage) usage = evt.usage;
      const choice = evt.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (d.reasoning_content && !thinking) { thinking = true; send('thinking', { on: true }); }
      if (d.content) {
        content += d.content;
        send('delta', { text: d.content });
      }
      if (d.tool_calls) {
        for (const tc of d.tool_calls) {
          const i = tc.index ?? 0;
          toolCalls[i] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function?.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function?.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  if (thinking) send('thinking', { on: false });
  return { content, toolCalls: toolCalls.filter(Boolean), usage, finish };
}

// ---------------------------------------------------------------- 看图

// v4-pro 不收图（会把图片当成 [Unsupported Image]），flash 能看。
// 所以照片先交给 flash 转成文字描述，再把描述喂给主模型——主模型仍然是最强的那个。
async function describePhoto(dataUrl, step) {
  const expectLines = (step?.wiring || [])
    .map((id) => {
      const w = SPEC.wiring.find((x) => x.id === id);
      if (!w) return null;
      return `- ${w.from[1]} → ${w.to[1]}（${w.color}线）${w.note ? '，' + w.note : ''}`;
    })
    .filter(Boolean);

  const sys = [
    '你是硬件装配的照片检视员。只客观描述看到的画面，不推测、不评价、不教人怎么做。',
    '按这个顺序说：',
    '1) 画面上有哪些模块、大致在什么位置；',
    '2) 能看清几根线、分别什么颜色；',
    '3) 每根线大致从哪儿连到哪儿；',
    '4) 和"这一步应该接的线"逐条比对：对上的、明显对不上的、看不清的，分开说。',
    '看不清就写"看不清"，绝对不要猜。总共不超过 220 字。',
  ].join('\n');

  const userText = [
    step ? `第 ${stepIndex(step.id) + 1} 步：${step.title}` : '小智装机',
    step ? `这一步要做的事：${step.goal}` : '',
    expectLines.length ? '这一步应该接的线：\n' + expectLines.join('\n') : '这一步不用接线。',
    step ? `验收标准：${step.check}` : '',
    '',
    '客观描述这张照片。',
  ]
    .filter((x) => x !== '')
    .join('\n');

  const r = await fetch(`${state.apiBase}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${state.apiKey}` },
    body: JSON.stringify({
      model: state.visionModel,
      messages: [
        { role: 'system', content: sys },
        {
          role: 'user',
          content: [
            { type: 'text', text: userText },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      temperature: 0.2,
      // 这个模型看图前会先想很久（实测 1200~1900 token 的 reasoning），
      // 给少了就会 finish=length 且 content 为空——所以这里必须给足
      max_tokens: 1600,
    }),
  });

  if (!r.ok) throw new Error(`看图接口 ${r.status}：${(await r.text().catch(() => '')).slice(0, 200)}`);
  const j = await r.json();
  const text = String(j.choices?.[0]?.message?.content || '').trim();
  const finish = j.choices?.[0]?.finish_reason;
  if (!text) throw new Error(`看图模型没给出内容（finish=${finish}），可能是这一题它想太久了`);
  return text;
}

// ---------------------------------------------------------------- approvals

const pending = new Map();

function askApproval(session, send, payload) {
  return new Promise((resolve) => {
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve('deny');
    }, 240000);
    pending.set(id, {
      sessionId: session.id,
      resolve: (decision) => { clearTimeout(timer); pending.delete(id); resolve(decision); },
    });
    send('approval', { id, ...payload });
  });
}

// ---------------------------------------------------------------- tools

const runPs = (script, args = [], timeout = 60000) =>
  new Promise((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'lib', script), ...args],
      { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && !String(stdout || '').trim()) return reject(new Error(String(stderr || err.message).slice(0, 400)));
        resolve(String(stdout || ''));
      }
    );
  });

function tidyOcr(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/([\u4e00-\u9fa5])[ \t]+(?=[\u4e00-\u9fa5])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const execAsync = (command, cwd, timeout) =>
  new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; ${command}`,
      ],
      { cwd, timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const out = `${stdout || ''}${stderr || ''}`.trim();
        if (err && err.killed) return resolve({ ok: false, out: `命令超时（${timeout / 1000}s）被终止。\n${out}`.trim() });
        resolve({ ok: !err, out: out || (err ? String(err.message) : '(无输出)') });
      }
    );
  });

async function executeTool(session, send, name, args) {
  if (args.__parse_error) return `工具参数不是合法 JSON：${args.__parse_error}`;

  const emit = (event, payload) => {
    try { send(event, payload); } catch {}
    try { broadcast(event, payload); } catch {}
  };

  const pushStep = (s, reason) => {
    session.stepId = s.id;
    const payload = {
      stepId: s.id,
      index: stepIndex(s.id),
      total: SPEC_STEPS.length,
      step: s,
      wiring: (s.wiring || []).map((id) => SPEC.wiring.find((w) => w.id === id)).filter(Boolean),
      parts: s.parts || [],
      reason: reason || '',
      checks: session.checks || [],
    };
    session.board = { kind: 'step', ...payload };
    emit('step', payload);
  };

  switch (name) {
    case 'show_step': {
      const raw = String(args.step || 'current').trim();
      const at = stepIndex(session.stepId);
      let s = null;
      if (raw === 'next') s = SPEC_STEPS[Math.min(at + 1, SPEC_STEPS.length - 1)];
      else if (raw === 'prev') s = SPEC_STEPS[Math.max(at - 1, 0)];
      else if (raw === 'current') s = stepById(session.stepId) || SPEC_STEPS[0];
      else s = stepById(raw);
      if (!s) {
        return `没有这一步：${raw}。现有步骤：${SPEC_STEPS.map((x) => `${x.id} ${x.title}`).join('、')}`;
      }
      pushStep(s, args.reason);
      return [
        `已切到第 ${stepIndex(s.id) + 1} 步「${s.title}」。`,
        `目标：${s.goal}`,
        `为什么：${s.why}`,
        `怎么做：${(s.do || []).join('；') || '无'}`,
        `验收：${s.check}`,
        `易错点：${(s.pitfalls || []).join('；') || '无'}`,
        `这一步涉及的接线：${(s.wiring || []).map((id) => {
          const w = SPEC.wiring.find((x) => x.id === id);
          return w ? `${w.from[1]}→${w.to[0]}.${w.to[1]}` : id;
        }).join('，') || '无'}`,
      ].join('\n');
    }

    case 'show_3d': {
      const payload = {
        parts: Array.isArray(args.parts) ? args.parts : [],
        wires: Array.isArray(args.wires) ? args.wires : [],
        camera: String(args.camera || ''),
        pulse: String(args.pulse || ''),
      };
      emit('scene', payload);
      return `3D 画面已更新${payload.camera ? `（视角：${payload.camera}）` : ''}。`;
    }

    case 'get_wiring': {
      let list = SPEC.wiring.slice();
      if (args.step) {
        const s = stepById(String(args.step));
        if (s) list = list.filter((w) => (s.wiring || []).includes(w.id));
      }
      if (args.module) {
        const alias = {
          mic: 'inmp441', '麦克风': 'inmp441', '咪头': 'inmp441',
          amp: 'max98357', '功放': 'max98357', '放大': 'max98357',
          oled: 'oled', '屏': 'oled', '屏幕': 'oled', '显示屏': 'oled',
          speaker: 'speaker', '喇叭': 'speaker', '音响': 'speaker',
          board: 'esp32s3', esp32: 'esp32s3', '板子': 'esp32s3', '主控': 'esp32s3',
        };
        const m = String(args.module).trim();
        const key = alias[m.toLowerCase()] || alias[m] || m.toLowerCase();
        list = list.filter((w) => w.from[0] === key || w.to[0] === key);
      }
      if (!list.length) {
        return '接线表里没有匹配条目。不要自己编，告诉学生这里以官方文档为准。';
      }
      return list.map((w) => `${w.id}｜${w.from[0]}.${w.from[1]} → ${w.to[0]}.${w.to[1]}｜${w.color}线｜${w.note || ''}`).join('\n');
    }

    case 'record_check': {
      const s = stepById(String(args.step));
      if (!s) return `没有这一步：${args.step}`;
      const rec = {
        step: s.id,
        result: ['pass', 'fail', 'unsure'].includes(args.result) ? args.result : 'unsure',
        note: String(args.note || '').slice(0, 300),
        at: Date.now(),
      };
      session.checks = (session.checks || []).filter((c) => c.step !== s.id).concat([rec]);
      emit('check', { rec, checks: session.checks });

      // 没过，而且指明了是哪根线 —— 3D 里标红闪几下
      if (rec.result === 'fail' && Array.isArray(args.suspect) && args.suspect.length) {
        const ids = args.suspect.map(String).filter((id) => SPEC.wiring.some((w) => w.id === id) || SPEC.parts.some((p) => p.id === id));
        if (ids.length) {
          emit('mark', { ids, reason: rec.note });
          return `已记录：第 ${stepIndex(s.id) + 1} 步「${s.title}」没过，已在 3D 里标红：${ids.join('、')}。${rec.note ? `（${rec.note}）` : ''}`;
        }
      }

      return `已记录：第 ${stepIndex(s.id) + 1} 步「${s.title}」→ ${rec.result}${rec.note ? `（${rec.note}）` : ''}`;
    }

    case 'show_checklist': {
      emit('checklist', { parts: SPEC.parts });
      return SPEC.parts.map((p) => `${p.name} ×${p.qty}${p.note ? `（${p.note}）` : ''}`).join('\n');
    }

    case 'get_troubleshoot': {
      const all = SPEC.troubleshoot || [];
      const kw = String(args.keyword || '').trim();
      if (!kw) {
        return all.map((t) => `${t.id}｜${t.symptom}`).join('\n');
      }

      // 按二字词重叠打分：学生说"没声音"，表里写"喇叭一点声音都没有"，也能对上
      const grams = (str) => {
        const out = new Set();
        const t = String(str).replace(/[\s,，、。.!！?？的了吗呢啊]/g, '');
        for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
        if (t.length === 1) out.add(t);
        return out;
      };
      const kwGrams = grams(kw);

      const scored = all
        .map((t) => {
          const blob = [t.symptom, ...(t.causes || []), ...(t.check || []), ...(t.fix || [])].join(' ');
          let sc = blob.includes(kw) ? 8 : 0;
          if (t.symptom.includes(kw)) sc += 6;
          for (const g of kwGrams) if (blob.includes(g)) sc += 2;
          return { t, sc };
        })
        .filter((x) => x.sc > 0)
        .sort((a, b) => b.sc - a.sc);

      const list = scored.slice(0, 3).map((x) => x.t);
      if (!list.length) {
        return `故障表里没有和「${kw}」对得上的条目。不要自己编原因，让学生描述得更具体（比如"是完全没反应，还是灯亮了但没声音"）。`;
      }

      emit('troubleshoot', { items: list });
      return list
        .map((t) => [
          `【${t.symptom}】`,
          `可能原因：${(t.causes || []).join('；')}`,
          `让他检查：${(t.check || []).join('；')}`,
          `怎么修：${(t.fix || []).join('；')}`,
        ].join('\n'))
        .join('\n\n');
    }

    default:
      return `未知工具 ${name}。`;
  }
}

function langOf(p) {
  const ext = path.extname(p).toLowerCase();
  return { '.py': 'python', '.js': 'javascript', '.mjs': 'javascript', '.ts': 'typescript', '.tsx': 'tsx', '.jsx': 'jsx', '.html': 'html', '.css': 'css', '.json': 'json', '.md': 'markdown', '.java': 'java', '.c': 'c', '.cpp': 'cpp', '.go': 'go', '.rs': 'rust', '.sh': 'bash', '.sql': 'sql', '.yml': 'yaml', '.yaml': 'yaml' }[ext] || 'text';
}

async function revealInIde(abs, line) {
  try {
    const ctx = await ideContext();
    if (!ctx.running.length) return '';
    const target = openerFor(abs);
    if (!target) return '';
    const a = target.kind === 'pycharm' ? ['--line', String(line), abs] : ['--goto', `${abs}:${line}`];
    execFile(target.cmd, a, { windowsHide: false, detached: true });
    return ` 已在 ${target.kind === 'pycharm' ? 'PyCharm' : 'VS Code'} 里定位到第 ${line} 行。`;
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------- agent loop

async function runAgent(session, send, signal) {
  const maxSteps = 8;
  for (let step = 0; step < maxSteps; step++) {
    if (signal.aborted) return;
    const { content, toolCalls, usage, finish } = await streamCompletion(session, send, signal);
    if (usage) send('usage', { prompt: usage.prompt_tokens, completion: usage.completion_tokens, total: usage.total_tokens, cached: usage.prompt_cache_hit_tokens || 0 });

    if (toolCalls.length) {
      const assistantMsg = {
        role: 'assistant',
        content: content || null,
        tool_calls: toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.function.name, arguments: tc.function.arguments } })),
      };
      session.messages.push(assistantMsg);
      if (content) send('segment_end', {});

      for (const tc of toolCalls) {
        const name = tc.function.name;
        const args = safeParseArgs(tc.function.arguments);
        const meta = TOOL_MAP.get(name)?.meta || { risk: 'high', label: name };

        let absPath = '';
        if (args.path) {
          try { absPath = resolveInRoot(args.path); } catch {}
        }
        const command = name === 'run_command' ? String(args.command || '') : '';
        const rule = suggestRule(name, { absPath, command });
        const auto = allow.autoAllowed(name, absPath, command);
        let allowed = meta.risk === 'low' || session.autoAllow.has(name) || auto;

        if (!allowed) {
          const decision = await askApproval(session, send, { name, args, risk: meta.risk, label: meta.label, rule });
          if (decision === 'deny') {
            session.messages.push({ role: 'tool', tool_call_id: tc.id, content: '学生拒绝了这次操作。不要重试同一个操作，问他愿不愿意换一种方式，或改用讲解。' });
            send('tool_result', { id: tc.id, name, ok: false, output: '学生拒绝了这次操作', denied: true });
            continue;
          }
          if (decision === 'turn') session.autoAllow.add(name);
          if (decision === 'always') allow.add(rule);
          allowed = true;
        }

        send('tool_start', { id: tc.id, name, label: meta.label });
        let output;
        let ok = true;
        try {
          output = await executeTool(session, send, name, args);
        } catch (e) {
          ok = false;
          output = `工具执行失败：${e.message}`;
        }
        session.messages.push({ role: 'tool', tool_call_id: tc.id, content: output });
        send('tool_result', { id: tc.id, name, ok, output: output.slice(0, 900) });
      }
      continue;
    }

    session.messages.push({ role: 'assistant', content: content || '' });
    if (session.title === '新的装机' && session.messages.find((m) => m.role === 'user')) {
      const firstUser = session.messages.find((m) => m.role === 'user')?.content || '';
      session.title = String(firstUser).replace(/\s+/g, ' ').slice(0, 24) || '新的装机';
    }
    return;
  }
  send('error', { message: '这一轮动作太多了，我停一下。我们接着来？' });
}

// ---------------------------------------------------------------- tts worker

const TTS_DIR = path.join(DATA_DIR, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });

let ttsProc = null;
const ttsPending = new Map();

// 语音合成用的 Python：优先 setup.ps1 装好的嵌入式解释器，其次系统 python / $PYTHON
const EMBED_PY = path.join(HERE, 'stt', 'py311', 'python.exe');
function pyBin() {
  return fs.existsSync(EMBED_PY) ? EMBED_PY : (process.env.PYTHON || 'python');
}

function startTts() {
  if (ttsProc) return;
  const env = {
    ...process.env,
    PYTHONPATH: path.join(HERE, 'vendor'),
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  try {
    ttsProc = spawn(pyBin(), ['-u', path.join(HERE, 'tts_worker.py'), TTS_DIR], {
      cwd: HERE,
      env,
      windowsHide: true,
    });
  } catch (e) {
    // 起不来就当没有云端音色，前端会自动退回浏览器语音，不能把服务拖死
    console.error('[tts] 启动失败：', e.message);
    ttsProc = null;
    state.ttsAvailable = false;
    return;
  }
  let buf = '';
  ttsProc.stdout.setEncoding('utf8');
  ttsProc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = ttsPending.get(msg.id);
      if (!p) continue;
      ttsPending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.path);
    }
  });
  ttsProc.stderr.on('data', (d) => console.error('[tts]', String(d).slice(0, 500)));
  ttsProc.on('exit', () => {
    ttsProc = null;
    for (const [, p] of ttsPending) { clearTimeout(p.timer); p.reject(new Error('tts worker 退出了')); }
    ttsPending.clear();
  });
}

function checkTts() {
  if (state.ttsMode === 'browser') return false;
  try {
    const probe = `import sys,os;sys.path.insert(0,os.path.join(r'${HERE}','vendor'));import edge_tts`;
    execFileSync(pyBin(), ['-c', probe], {
      cwd: HERE,
      env: { ...process.env, PYTHONPATH: path.join(HERE, 'vendor'), PYTHONUTF8: '1' },
      timeout: 20000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function synthToFile(text, voice, rate) {
  startTts();
  if (!ttsProc) return Promise.reject(new Error('语音进程没起来'));
  const id = crypto.randomUUID().replace(/-/g, '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ttsPending.delete(id); reject(new Error('语音合成超时')); }, 30000);
    ttsPending.set(id, { resolve, reject, timer });
    ttsProc.stdin.write(JSON.stringify({ id, text, voice, rate }) + '\n', 'utf8');
  });
}

async function cleanTtsDir() {
  const files = await fsp.readdir(TTS_DIR).catch(() => []);
  const now = Date.now();
  for (const f of files) {
    const p = path.join(TTS_DIR, f);
    const st = await fsp.stat(p).catch(() => null);
    if (st && now - st.mtimeMs > 3600_000) await fsp.unlink(p).catch(() => {});
  }
}

// ---------------------------------------------------------------- local STT (faster-whisper)

const STT_DIR = path.join(HERE, 'stt');
const STT_PY = path.join(STT_DIR, 'py311', 'python.exe');
const STT_SCRIPT = path.join(STT_DIR, 'stt_worker.py');
const STT_TMP = path.join(DATA_DIR, 'stt');
let sttProc = null;
const sttPending = new Map();

function sttAvailable() {
  return fs.existsSync(STT_PY) && fs.existsSync(STT_SCRIPT);
}

function findFfmpeg() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) return process.env.FFMPEG_PATH;
  const base = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  try {
    for (const d of fs.readdirSync(base)) {
      if (!/^Gyan\.FFmpeg/i.test(d)) continue;
      const root = path.join(base, d);
      const stack = [[root, 0]];
      while (stack.length) {
        const [dir, depth] = stack.pop();
        if (depth > 4) continue;
        let entries = [];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isFile() && e.name === 'ffmpeg.exe') return full;
          if (e.isDirectory()) stack.push([full, depth + 1]);
        }
      }
    }
  } catch {}
  return 'ffmpeg';
}
const FFMPEG = findFfmpeg();

function startStt() {
  if (sttProc || !sttAvailable()) return;
  fs.mkdirSync(STT_TMP, { recursive: true });
  fs.mkdirSync(path.join(STT_DIR, 'models'), { recursive: true });
  try {
    sttProc = spawn(STT_PY, ['-u', STT_SCRIPT], {
      cwd: HERE,
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com',
        HF_HOME: path.join(STT_DIR, 'models', 'hf'),
        HF_HUB_CACHE: path.join(STT_DIR, 'models', 'hf', 'hub'),
      },
      windowsHide: true,
    });
  } catch (e) {
    console.error('[stt] 启动失败：', e.message);
    sttProc = null;
    return;
  }
  let buf = '';
  sttProc.stdout.setEncoding('utf8');
  sttProc.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = sttPending.get(msg.id);
      if (!p) continue;
      sttPending.delete(msg.id);
      clearTimeout(p.timer);
      msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.text || '');
    }
  });
  sttProc.stderr.on('data', (d) => console.error('[stt]', String(d).slice(0, 300)));
  sttProc.on('exit', () => {
    sttProc = null;
    for (const [, p] of sttPending) { clearTimeout(p.timer); p.reject(new Error('识别引擎退出了')); }
    sttPending.clear();
  });
}

function transcribe(wavPath) {
  startStt();
  if (!sttProc) return Promise.reject(new Error('本地识别引擎不可用'));
  const id = crypto.randomUUID().replace(/-/g, '');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sttPending.delete(id); reject(new Error('识别超时（首次加载模型较慢）')); }, 180000);
    sttPending.set(id, { resolve, reject, timer });
    sttProc.stdin.write(JSON.stringify({ id, path: wavPath, language: 'zh' }) + '\n', 'utf8');
  });
}

function toWav(input, output) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', output], { timeout: 60000, windowsHide: true }, (err) => {
      err ? reject(new Error('音频转码失败：' + err.message)) : resolve();
    });
  });
}

let accountCache = { at: 0, data: null };
async function getAccount() {
  if (Date.now() - accountCache.at < 60000 && accountCache.data) return accountCache.data;
  let balance = null;
  let currency = 'CNY';
  try {
    const r = await fetch(`${state.apiBase}/user/balance`, { headers: { authorization: `Bearer ${state.apiKey}` } });
    if (r.ok) {
      const d = await r.json();
      const info = d.balance_infos?.[0];
      balance = info ? Number(info.total_balance) : null;
      currency = info?.currency || 'CNY';
    }
  } catch {}
  const data = {
    balance,
    currency,
    model: state.model,
    keyMasked: state.apiKey ? `${state.apiKey.slice(0, 6)}…${state.apiKey.slice(-4)}` : '未配置',
    connected: !!state.apiKey,
  };
  accountCache = { at: Date.now(), data };
  return data;
}

// ---------------------------------------------------------------- 打印页

const PRINT_COLORS = { 红: '#c0392b', 黑: '#333', 橙: '#c85a24', 黄: '#b8912a', 蓝: '#2f6fd0', 绿: '#2f9e5f' };

function renderPrintPage() {
  const esc = (s) =>
    String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const rows = (SPEC.wiring || [])
    .map((w) => {
      const mod = w.to[0] === 'esp32s3' ? w.from[0] : w.to[0];
      const modName = (SPEC.parts.find((p) => p.id === mod) || {}).name || mod;
      const dot = `<i class="dot" style="background:${PRINT_COLORS[w.color] || '#999'}"></i>`;
      return `<tr><td>${esc(modName)}</td><td class="mono">${esc(w.from[1])}</td><td class="mono">${esc(w.to[1])}</td><td>${dot}${esc(w.color)}</td><td class="note">${esc(w.note || '')}</td></tr>`;
    })
    .join('');

  const parts = (SPEC.parts || [])
    .map((p) => `<tr><td>${esc(p.name)}</td><td class="c">×${p.qty}</td><td class="note">${esc(p.note || '')}</td></tr>`)
    .join('');

  const steps = (SPEC.steps || [])
    .map(
      (s, i) => `<tr>
        <td class="c num">${i + 1}</td>
        <td><b>${esc(s.title)}</b><div class="sub">${esc(s.goal)}</div></td>
        <td>${(s.do || []).map((d) => `<div>· ${esc(d)}</div>`).join('')}</td>
        <td class="note">${esc(s.check)}</td>
      </tr>`
    )
    .join('');

  const trouble = (SPEC.troubleshoot || [])
    .map(
      (t) => `<tr><td><b>${esc(t.symptom)}</b></td><td>${esc((t.check || [])[0] || '')}</td></tr>`
    )
    .join('');

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>${esc(SPEC.name)} · 接线卡</title>
<style>
  @page { size: A4; margin: 13mm 12mm; }
  * { box-sizing: border-box; }
  body { font: 12px/1.55 "Microsoft YaHei", system-ui, sans-serif; color: #111; margin: 0; padding: 16px 18px; background: #fff; }
  h1 { font-size: 19px; margin: 0 0 2px; }
  h2 { font-size: 13.5px; margin: 18px 0 6px; padding-bottom: 3px; border-bottom: 1.5px solid #222; }
  .meta { color: #666; font-size: 11px; margin-bottom: 10px; }
  .safety { border: 1.5px solid #c0392b; border-radius: 6px; padding: 8px 11px; background: #fdf3f2; }
  .safety b { color: #c0392b; }
  .safety div { margin: 2px 0; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; }
  th, td { border: 1px solid #ccc; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f0f0ee; font-size: 11px; font-weight: 600; }
  td.c { text-align: center; }
  td.num { font-weight: 700; color: #c85a24; width: 24px; }
  td.note { color: #555; font-size: 11px; }
  .mono { font-family: Consolas, monospace; font-size: 11.5px; }
  .sub { color: #666; font-size: 11px; font-weight: 400; margin-top: 1px; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 4px; vertical-align: middle; border: 1px solid rgba(0,0,0,.2); }
  tr { page-break-inside: avoid; }
  h2 { page-break-after: avoid; }
  .foot { margin-top: 16px; color: #888; font-size: 10px; border-top: 1px solid #ddd; padding-top: 6px; }
</style></head><body>

<h1>${esc(SPEC.name)}</h1>
<div class="meta">主控 ${esc(SPEC.board.model)} · 打印于 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</div>

<div class="safety">
  <b>安全，先看这三条</b>
  ${(SPEC.safety?.rules || []).map((r) => `<div>· ${esc(r)}</div>`).join('')}
</div>

<h2>零件清单</h2>
<table><thead><tr><th>零件</th><th class="c">数量</th><th>备注</th></tr></thead><tbody>${parts}</tbody></table>

<h2>接线表（以官方为准）</h2>
<table><thead><tr><th>模块</th><th>模块脚</th><th>接到</th><th>线色</th><th>备注</th></tr></thead><tbody>${rows}</tbody></table>

<h2>17 个步骤</h2>
<table><thead><tr><th class="c">#</th><th>这一步</th><th>怎么做</th><th>验收</th></tr></thead><tbody>${steps}</tbody></table>

<h2>出问题了，先查这个</h2>
<table><thead><tr><th>症状</th><th>第一条检查</th></tr></thead><tbody>${trouble}</tbody></table>

<div class="foot">${esc(SPEC.name)} · 接线数据来源：${esc(SPEC.source?.official_wiring || '')}</div>
</body></html>`;
}

// ---------------------------------------------------------------- http

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2' };

function authed(req) {
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `dsh_teacher=${state.token}`);
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!abs.startsWith(PUBLIC_DIR)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await fsp.readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${state.port}`);
  const pathname = url.pathname;

  try {
    reloadSpec();

    // ---- login
    if (url.searchParams.get('t')) {
      if (url.searchParams.get('t') !== state.token) return json(res, 403, { error: '链接无效，请用启动时打印的地址。' });
      const keep = new URLSearchParams(url.search);
      keep.delete('t');
      const qs = keep.toString();
      res.writeHead(302, { 'set-cookie': `dsh_teacher=${state.token}; Path=/; HttpOnly; SameSite=Strict`, location: url.pathname + (qs ? `?${qs}` : '') });
      return res.end();
    }

    if (pathname === '/api/ping') return json(res, 200, { ok: true });

    if (!authed(req)) {
      if (pathname === '/' || pathname === '/index.html') {
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        return res.end('<meta charset="utf-8"><body style="background:#0b0f14;color:#cfe3ff;font:15px system-ui;padding:48px">请用终端里打印的带 token 的链接打开。<br><br>例如：http://127.0.0.1:7842/?t=……</body>');
      }
      return json(res, 401, { error: 'unauthorized' });
    }

    if (pathname === '/api/bootstrap') {
      const all = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
      const list = all.slice(0, 30).map((s) => ({ id: s.id, title: s.title, updatedAt: s.updatedAt }));
      const latest = all.find((s) => s.messages.some((m) => m.role === 'user'));
      return json(res, 200, {
        config: { model: state.model, voice: state.voice, rate: state.rate, projectRoot: state.projectRoot, models: MODELS, voices: VOICES, ttsAvailable: state.ttsAvailable, sttAvailable: sttAvailable() },
        sessions: list,
        current: latest ? publicSession(latest) : null,
        allowlist: allow.data,
        ide: await ideContext().catch(() => null),
        account: await getAccount(),
      });
    }

    if (pathname === '/api/allowlist') {
      if (req.method === 'GET') return json(res, 200, allow.data);
      const b = await readBody(req);
      if (b.op === 'clear') allow.clear();
      else if (b.op === 'remove' && b.type) allow.remove(b.type, b.value);
      else if (b.op === 'add' && b.type) allow.add({ type: b.type, value: b.value });
      return json(res, 200, allow.data);
    }

    if (pathname === '/api/photo') {
      // 学生拍的照片，按文件名回取
      const name = path.basename(url.searchParams.get('name') || '');
      if (!name) return json(res, 400, { error: 'no name' });
      const f = path.join(PHOTO_DIR, name);
      try {
        const st = await fsp.stat(f);
        const type = /\.png$/i.test(name) ? 'image/png' : /\.webp$/i.test(name) ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'max-age=86400' });
        fs.createReadStream(f).pipe(res);
      } catch {
        json(res, 404, { error: 'not found' });
      }
      return;
    }

    if (pathname === '/api/account') return json(res, 200, await getAccount());

    if (pathname === '/api/settings' && req.method === 'GET') {
      return json(res, 200, {
        model: state.model,
        voice: state.voice,
        rate: state.rate,
        apiBase: state.apiBase,
        hasKey: !!state.apiKey,
        keyHint: state.apiKey ? `${state.apiKey.slice(0, 5)}…${state.apiKey.slice(-4)}` : '',
        ttsAvailable: state.ttsAvailable,
        sttAvailable: sttAvailable(),
      });
    }

    if (pathname === '/api/settings' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.model && MODELS.some((m) => m.id === b.model)) state.model = b.model;
      if (b.voice && VOICES.some((v) => v.id === b.voice)) state.voice = b.voice;
      if (b.rate) state.rate = String(b.rate);
      if (b.apiBase) state.apiBase = String(b.apiBase).trim() || state.apiBase;
      if (typeof b.apiKey === 'string') {
        const k = b.apiKey.trim();
        if (k && !/^sk-\S{16,}$/.test(k)) {
          return json(res, 400, { error: '看着不像 DeepSeek 的 Key（应该 sk- 开头，后面一长串）' });
        }
        state.apiKey = k;
      }
      // 合并写回，别把没改的字段冲掉
      const next = { ...cfg, model: state.model, voice: state.voice, rate: state.rate, apiBase: state.apiBase, port: state.port };
      // 只有这次请求明确带了 apiKey 才写盘：既能把 Key 清成空，也不会把环境变量里的 Key 泄进文件
      if (typeof b.apiKey === 'string') next.apiKey = state.apiKey;
      try { fs.writeFileSync(configPath, JSON.stringify(next, null, 2), 'utf8'); cfg = next; } catch (e) { console.error('[config]', e.message); }
      return json(res, 200, {
        ok: true,
        hasKey: !!state.apiKey,
        keyHint: state.apiKey ? `${state.apiKey.slice(0, 5)}…${state.apiKey.slice(-4)}` : '',
      });
    }

    if (pathname === '/api/session/new' && req.method === 'POST') {
      const s = newSession();
      return json(res, 200, publicSession(s));
    }

    if (pathname.startsWith('/api/session/') && req.method === 'GET') {
      const id = pathname.split('/').pop();
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: 'not found' });
      return json(res, 200, publicSession(s));
    }

    if (pathname === '/api/tree') {
      const out = [];
      await tree(state.projectRoot, 2, out);
      out.sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === 'dir' ? -1 : 1));
      return json(res, 200, { root: state.projectRoot, entries: out.slice(0, 300) });
    }

    if (pathname === '/api/file' && req.method === 'GET') {
      const p = url.searchParams.get('path') || '';
      const abs = resolveInRoot(p);
      const st = await fsp.stat(abs);
      if (st.size > 600 * 1024) return json(res, 400, { error: '文件太大（>600KB），先别在网页里打开' });
      const content = await fsp.readFile(abs, 'utf8');
      return json(res, 200, { path: p, content, language: langOf(p) });
    }

    if (pathname === '/api/file' && req.method === 'POST') {
      const b = await readBody(req);
      const abs = resolveInRoot(b.path);
      await fsp.writeFile(abs, String(b.content ?? ''), 'utf8');
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/approve' && req.method === 'POST') {
      const b = await readBody(req);
      const p = pending.get(b.id);
      if (!p) return json(res, 404, { error: '这个请求已经过期了' });
      if (!['allow', 'turn', 'deny', 'always'].includes(b.decision)) return json(res, 400, { error: 'bad decision' });
      p.resolve(b.decision);
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/tts') {
      const text = (url.searchParams.get('text') || '').slice(0, 800).trim();
      const voice = VOICES.some((v) => v.id === url.searchParams.get('voice')) ? url.searchParams.get('voice') : state.voice;
      if (!text) return json(res, 400, { error: 'empty text' });
      if (!state.ttsAvailable) return json(res, 503, { error: 'tts unavailable' });
      let file;
      try {
        file = await synthToFile(cleanForSpeech(text), voice, state.rate);
        const st = await fsp.stat(file);
        const type = file.endsWith('.wav') ? 'audio/wav' : 'audio/mpeg';
        res.writeHead(200, { 'content-type': type, 'content-length': st.size, 'cache-control': 'no-store' });
        const stream = fs.createReadStream(file);
        stream.pipe(res);
        stream.on('error', () => res.end());
        res.on('close', () => fsp.unlink(file).catch(() => {}));
      } catch (e) {
        json(res, 502, { error: e.message });
      }
      return;
    }

    if (pathname === '/api/board') {
      const latest = [...sessions.values()]
        .filter((x) => x.board)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return json(res, 200, { board: latest?.board || null, title: latest?.title || '' });
    }

    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      res.write(':ok\n\n');
      boardSubs.add(res);
      const ping = setInterval(() => { try { res.write(':ping\n\n'); } catch {} }, 20000);
      req.on('close', () => { clearInterval(ping); boardSubs.delete(res); });
      return;
    }

    if (pathname === '/api/widget' && req.method === 'POST') {
      const script = path.join(HERE, 'board-widget.ps1');
      if (!fs.existsSync(script)) return json(res, 404, { error: '缺少 board-widget.ps1' });
      const widgetUrl = `http://127.0.0.1:${state.port}/board.html?t=${state.token}`;
      execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Url', widgetUrl], { detached: true, windowsHide: true, stdio: 'ignore' }).unref();
      return json(res, 200, { ok: true });
    }

    if (pathname === '/api/stt' && req.method === 'POST') {
      if (!sttAvailable()) return json(res, 503, { error: 'stt unavailable' });
      let buf;
      try { buf = await readRaw(req); } catch (e) { return json(res, 400, { error: e.message }); }
      if (buf.length < 800) return json(res, 400, { error: '录音太短' });
      const id = crypto.randomUUID().replace(/-/g, '');
      const src = path.join(STT_TMP, id + '.webm');
      const wav = path.join(STT_TMP, id + '.wav');
      try {
        await fsp.mkdir(STT_TMP, { recursive: true });
        await fsp.writeFile(src, buf);
        await toWav(src, wav);
        const text = await transcribe(wav);
        return json(res, 200, { text });
      } catch (e) {
        return json(res, 500, { error: e.message });
      } finally {
        fsp.unlink(src).catch(() => {});
        fsp.unlink(wav).catch(() => {});
      }
    }

    if (pathname === '/print') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(renderPrintPage());
    }

    if (pathname === '/api/state') {
      const s = [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
      return json(res, 200, {
        spec: {
          id: SPEC.id,
          name: SPEC.name,
          board: SPEC.board,
          safety: SPEC.safety,
          parts: SPEC.parts,
          wiring: SPEC.wiring,
          steps: SPEC_STEPS.map((st) => ({
            id: st.id, title: st.title, goal: st.goal, why: st.why,
            do: st.do, check: st.check, pitfalls: st.pitfalls,
            parts: st.parts, wiring: st.wiring, safety: st.safety,
          })),
        },
        sessionId: s?.id || null,
        stepId: s?.stepId || SPEC_STEPS[0]?.id || null,
        checks: s?.checks || [],
        troubleshoot: SPEC.troubleshoot || [],
        postInstall: SPEC.post_install || null,
      });
    }

    if (pathname === '/api/goto' && req.method === 'POST') {
      const b = await readBody(req);
      let s = b.sessionId ? sessions.get(b.sessionId) : null;
      if (!s) s = newSession();
      const st = stepById(String(b.stepId || ''));
      if (!st) return json(res, 404, { error: '没有这一步' });
      s.stepId = st.id;
      s.updatedAt = Date.now();
      if (b.sessionId) await saveSession(s);
      const payload = {
        stepId: st.id,
        index: stepIndex(st.id),
        total: SPEC_STEPS.length,
        step: st,
        wiring: (st.wiring || []).map((id) => SPEC.wiring.find((w) => w.id === id)).filter(Boolean),
        parts: st.parts || [],
        reason: '',
        checks: s.checks || [],
      };
      broadcast('step', payload);
      return json(res, 200, { ok: true, ...payload });
    }

    if (pathname === '/api/chat' && req.method === 'POST') {
      const b = await readBody(req);
      const text = String(b.text || '').trim();
      const image = typeof b.image === 'string' && b.image.startsWith('data:image/') ? b.image : '';
      if (!text && !image) return json(res, 400, { error: 'empty' });
      let s = b.sessionId ? sessions.get(b.sessionId) : null;
      if (!s) s = newSession();
      s.autoAllow = new Set();
      s.updatedAt = Date.now();

      // 先把照片落盘
      let savedPhoto = '';
      if (image) {
        const m = image.match(/^data:image\/([a-zA-Z0-9+.-]+);base64,(.+)$/);
        if (m) {
          try {
            const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase();
            const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;
            await fsp.writeFile(path.join(PHOTO_DIR, name), Buffer.from(m[2], 'base64'));
            savedPhoto = name;
          } catch (e) { console.error('[photo]', e.message); }
        }
      }

      const send = sse(res);
      send('session', { id: s.id, title: s.title });
      send('echo', { text, photo: savedPhoto });

      if (image) {
        const cur = stepById(s.stepId);
        const fallback = `（第 ${stepIndex(s.stepId) + 1} 步「${cur ? cur.title : ''}」拍的照片，帮我看看接得对不对）`;
        let seen = '';
        try {
          seen = await describePhoto(image, cur);
        } catch (e) {
          seen = `（看图失败：${e.message}）`;
          send('error', { message: '看不了这张图：' + e.message });
        }
        if (seen) send('photo_read', { text: seen });
        s.messages.push({
          role: 'user',
          content: `[学生发来一张照片]\n他说：${text || fallback}\n\n【转述：看图模型看到的画面】\n${seen}\n\n（以上是转述，可能有偏差。看不清楚就直说，让他重拍。）`,
        });
      } else {
        s.messages.push({ role: 'user', content: text });
      }

      const ac = new AbortController();
      const onClose = () => { if (!res.writableEnded) ac.abort(); };
      res.on('close', onClose);

      try {
        await runAgent(s, send, ac.signal);
      } catch (e) {
        if (!ac.signal.aborted) send('error', { message: e.message });
      } finally {
        res.off('close', onClose);
        s.updatedAt = Date.now();
        await saveSession(s);
        send('done', { sessionId: s.id, title: s.title });
        if (!res.writableEnded) res.end();
      }
      return;
    }

    if (req.method === 'GET') return serveStatic(req, res, pathname);
    json(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
    else res.end();
  }
});

// 朗读前把型号和脚位名换成好念的写法，不然会被念成字母串
const SPEAK_MAP = [
  [/\bGPIO\s?(\d+)/gi, (_, n) => ` G P I O ${n} `],
  [/\b3\.3\s?V\b|\b3V3\b/gi, ' 三点三伏 '],
  [/\b5\s?V\b|\b5VIN\b/gi, ' 五伏 '],
  [/\bGND\b/g, ' 接地 '],
  [/\bVDD\b/g, ' V D D '],
  [/\bI2S\b/gi, ' I 二 S '],
  [/\bI2C\b|\bIIC\b/gi, ' I 二 C '],
  [/\bINMP\s?441\b/gi, ' I N M P 四四一 '],
  [/\bMAX\s?98357\s?A?\b/gi, ' M A X 九八三五七 '],
  [/\bSSD\s?1306\b/gi, ' S S D 一三零六 '],
  [/\bCH\s?34[0-9]\s?[A-Z]?\b/gi, ' C H 三四三 '],
  [/\bUSB\b/gi, ' U S B '],
  [/\bWS\b/g, ' W S '],
  [/\bSCK\b/g, ' S C K '],
  [/\bSD\b/g, ' S D '],
  [/\bLRC\b/g, ' L R C '],
  [/\bBCLK\b/g, ' B C L K '],
  [/\bDIN\b/g, ' D I N '],
  [/\bSDA\b/g, ' S D A '],
  [/\bSCL\b/g, ' S C L '],
  [/\bBOOT\b/g, ' boot '],
  [/\bRST\b/g, ' reset '],
  [/\bCOM\s?(\d+)/gi, (_, n) => ` COM ${n} `],
];

function cleanForSpeech(t) {
  let out = t
    .replace(/```[\s\S]*?```/g, ' 我把图画在右边了 ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*_#>|]/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');

  for (const [re, to] of SPEAK_MAP) out = out.replace(re, to);

  return out
    .replace(/\s+([，。！？、；：）》」])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// 端口被占就往后顺延。注意：只能用 once('listening') 加显式解绑，
// 不能用 listen(port, host, cb)——失败的那次尝试注册的 cb 不会撤销，
// 下一次绑定成功时它也会被调用，于是打印出来的还是被占用的旧端口。
async function listen(port, tries = 0) {
  return new Promise((resolve, reject) => {
    const onError = (e) => {
      server.off('listening', onListening);
      if (e.code === 'EADDRINUSE' && tries < 12) resolve(listen(port + 1, tries + 1));
      else reject(e);
    };
    const onListening = () => {
      server.off('error', onError);
      state.port = port;
      resolve(port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

await loadSessionsFromDisk();
await cleanTtsDir();
state.ttsAvailable = checkTts();
if (state.ttsAvailable) startTts(); // 预热语音进程，第一句不用等启动
process.on('SIGINT', () => { try { ttsProc?.kill(); sttProc?.kill(); } catch {} process.exit(0); });
// 已经有实例在跑就直接用那个：避免端口漂移（7842 → 7843），地址就不会变来变去。
// 不止看首选端口——之前可能因为旧实例占着而顺延过，所以往后扫一段。
async function findRunning(basePort) {
  for (let p = basePort; p < basePort + 12; p++) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/ping`, { signal: AbortSignal.timeout(700) });
      const j = await r.json().catch(() => null);
      if (r.ok && j && j.ok) return p;
    } catch {}
  }
  return 0;
}

const runningOn = await findRunning(state.port);
if (runningOn) {
  const sameUrl = `http://127.0.0.1:${runningOn}/?t=${state.token}`;
  console.log('');
  console.log('  小智师傅已经在跑了，不用再开一个。');
  console.log('  ' + sameUrl);
  console.log('');
  openBrowser(sameUrl);
  await new Promise((r) => setTimeout(r, 700));
  process.exit(0);
}

const port = await listen(state.port);
const url = `http://127.0.0.1:${port}/?t=${state.token}`;
try { fs.writeFileSync(path.join(DATA_DIR, 'last-url.txt'), url + '\n', 'utf8'); } catch {}
console.log('');
console.log('  小智师傅 · 装机陪练 已启动');
console.log('  ' + url);
console.log('');
console.log(`  方案 ${SPEC.name} · 模型 ${state.model} · 音色 ${state.voice}`);
console.log(`  Key ${state.apiKey ? state.apiKey.slice(0, 6) + '…' + state.apiKey.slice(-4) : '未找到（设置 DEEPSEEK_API_KEY 或 config.json）'}`);
console.log('  按 Ctrl+C 停止');

function openBrowser(u) {
  if (process.argv.includes('--no-open')) return;
  const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find((p) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  const child = edge
    ? spawn(edge, ['--new-window', u], { detached: true, stdio: 'ignore' })
    : spawn('cmd.exe', ['/c', 'start', '', `"${u}"`], { detached: true, stdio: 'ignore' });
  child.unref();
}
setTimeout(() => openBrowser(url), 400);
