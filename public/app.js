// 小智师傅 · 装机陪练 — 前端
import { BuildScene } from './scene3d.js';

const $ = (id) => document.getElementById(id);
const token = new URLSearchParams(location.search).get('t') || '';
const q = (s) => (token ? s + (s.includes('?') ? '&' : '?') + 't=' + token : s);

const state = {
  spec: null,
  sessionId: null,
  stepId: null,
  checks: [],
  scene: null,
  speechOn: true,
  busy: false,
  photo: '',
  troubleshoot: [],
  postInstall: null,
  autoNext: false,
};

const CASE_COLOR = { pass: '#3fbf6f', fail: '#e0454a', unsure: '#e09a35' };

// ---------------------------------------------------------------- boot

async function boot() {
  const r = await fetch(q('/api/state'));
  const data = await r.json();
  state.spec = data.spec;
  state.sessionId = data.sessionId;
  state.stepId = data.stepId;
  state.checks = data.checks || [];
  state.troubleshoot = data.troubleshoot || [];
  state.postInstall = data.postInstall || null;
  $('specName').textContent = data.spec.name;

  state.scene = new BuildScene($('scene'), data.spec);
  new ResizeObserver(() => state.scene.resize()).observe($('scene'));
  state.scene.onStepEnd = () => {
    syncPlayerUI();
    if (state.autoNext) nextAndPlay();
  };
  state.scene.onUpdate = () => syncPlayerUI();
  startAnnotations();

  const first = data.spec.steps.find((s) => s.id === state.stepId) || data.spec.steps[0];
  renderStep({
    stepId: first.id,
    index: data.spec.steps.indexOf(first),
    total: data.spec.steps.length,
    step: first,
    wiring: (first.wiring || []).map((id) => data.spec.wiring.find((w) => w.id === id)).filter(Boolean),
    parts: first.parts || [],
    checks: state.checks,
  });

  subscribe();
  greet();
  bind();
  checkKey();
}

// ---------------------------------------------------------------- 播放器

function syncPlayerUI() {
  if (!state.scene) return;
  const s = state.scene.state();
  const btn = $('playBtn');
  if (btn) {
    btn.textContent = s.playing ? '❚❚' : '▶';
    btn.classList.toggle('on', s.playing);
  }
  const scrub = $('scrub');
  if (scrub && document.activeElement !== scrub) scrub.value = Math.round(s.progress * 1000);
}

async function nextAndPlay() {
  const i = state.spec.steps.findIndex((s) => s.id === state.stepId);
  const next = state.spec.steps[Math.min(i + 1, state.spec.steps.length - 1)];
  if (!next || next.id === state.stepId) return;
  await goto(next.id);
  if (state.scene) state.scene.play();
}

// 引线标注层：把每根可见的线投影到屏幕，贴上“谁接谁”
function startAnnotations() {
  const layer = $('annotations');
  const pool = new Map();
  const tick = () => {
    requestAnimationFrame(tick);
    if (!state.scene) return;
    syncPlayerUI();
    let anchors = [];
    try { anchors = state.scene.screenAnchors(); } catch { return; }
    const tooMany = anchors.length > 9;
    const seen = new Set();
    for (const a of anchors) {
      seen.add(a.id);
      let el = pool.get(a.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'anno';
        el.textContent = a.text;
        layer.appendChild(el);
        pool.set(a.id, el);
      }
      el.style.display = tooMany ? 'none' : '';
      el.style.left = a.x + '%';
      el.style.top = a.y + '%';
    }
    for (const [id, el] of pool) {
      if (!seen.has(id)) {
        el.remove();
        pool.delete(id);
      }
    }
  };
  requestAnimationFrame(tick);
}

function subscribe() {
  const es = new EventSource(q('/api/events'));
  es.addEventListener('step', (e) => renderStep(JSON.parse(e.data)));
  es.addEventListener('scene', (e) => state.scene.applySceneAction(JSON.parse(e.data)));
  es.addEventListener('check', (e) => {
    const d = JSON.parse(e.data);
    state.checks = d.checks || state.checks;
    renderProgress();
    const step = state.spec.steps.find((s) => s.id === d.rec.step);
    addLine('system', `${step ? step.title : d.rec.step}：${d.rec.result === 'pass' ? '通过' : d.rec.result === 'fail' ? '没过' : '待确认'}${d.rec.note ? ' · ' + d.rec.note : ''}`);
  });
  es.addEventListener('checklist', () => {
    addLine('system', '零件清单：' + state.spec.parts.map((p) => p.name).join('、'));
  });
  es.addEventListener('troubleshoot', (e) => {
    const d = JSON.parse(e.data);
    for (const t of d.items || []) addLine('system', '查故障表：' + t.symptom);
  });
  es.addEventListener('mark', (e) => {
    const d = JSON.parse(e.data);
    if (state.scene && Array.isArray(d.ids)) state.scene.mark(d.ids);
    addLine('system', '3D 里标红的地方有问题：' + (d.ids || []).join('、') + (d.reason ? '（' + d.reason + '）' : ''));
  });
}

function greet() {
  addLine('ai', '东西到了吧？先别插电。咱把零件摊开，一样一样数一遍。');
}

// ---------------------------------------------------------------- step card

function renderStep(p) {
  if (!p || !p.step) return;
  state.stepId = p.stepId;
  $('stepNo').textContent = `${p.index + 1} / ${p.total}`;
  $('stepTitle').textContent = p.step.title;
  $('stepGoal').textContent = p.step.goal || '';

  const ul = $('stepDo');
  ul.innerHTML = '';
  for (const line of p.step.do || []) {
    const li = document.createElement('li');
    li.textContent = line;
    ul.appendChild(li);
  }

  const check = $('stepCheck');
  check.innerHTML = '';
  if (p.step.check) {
    const span = document.createElement('span');
    span.textContent = '验收：' + p.step.check;
    check.appendChild(span);
  }

  const rec = (state.checks || []).find((c) => c.step === p.stepId);
  $('stepcard').dataset.result = rec ? rec.result : '';
  $('stepcard').classList.toggle('danger', p.step.safety === 'danger');

  if (state.scene) state.scene.applyStep(p);
  renderProgress();
}

function renderProgress() {
  const bar = $('progressbar');
  bar.innerHTML = '';
  for (const s of state.spec.steps) {
    const rec = (state.checks || []).find((c) => c.step === s.id);
    const dot = document.createElement('button');
    dot.className = 'pdot';
    dot.title = `${s.id} ${s.title}`;
    if (s.id === state.stepId) dot.classList.add('current');
    if (rec) dot.style.background = CASE_COLOR[rec.result];
    dot.onclick = () => goto(s.id);
    bar.appendChild(dot);
  }
}

async function goto(stepId) {
  const r = await fetch(q('/api/goto'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ stepId, sessionId: state.sessionId }),
  });
  const d = await r.json();
  if (d.ok) renderStep(d);
}

// ---------------------------------------------------------------- chat

function addLine(kind, text) {
  const el = document.createElement('div');
  el.className = 'msg ' + kind;
  el.textContent = text;
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
  return el;
}

function addPhoto(src) {
  const el = document.createElement('div');
  el.className = 'msg me photo';
  const img = document.createElement('img');
  img.src = src;
  img.onclick = () => openLightbox(src);
  el.appendChild(img);
  $('messages').appendChild(el);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function addAiBubble() {
  const el = document.createElement('div');
  el.className = 'msg ai';
  el.textContent = '';
  $('messages').appendChild(el);
  return el;
}

async function send(text, image) {
  if (state.busy) return;
  const msg = (text || '').trim();
  if (!msg && !image) return;
  state.busy = true;
  setBusy(true);

  if (image) addPhoto(image);
  if (msg) addLine('me', msg);

  const bubble = addAiBubble();
  let acc = '';

  try {
    const r = await fetch(q('/api/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: msg, image: image || '', sessionId: state.sessionId }),
    });
    if (!r.ok || !r.body) throw new Error('HTTP ' + r.status);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let speaking = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const da = /^data: (.+)$/m.exec(block);
        if (!ev || !da) continue;
        let d;
        try { d = JSON.parse(da[1]); } catch { continue; }

        if (ev[1] === 'delta') {
          acc += d.text || '';
          bubble.textContent = acc;
          $('messages').scrollTop = $('messages').scrollHeight;
        } else if (ev[1] === 'session' && d.id) {
          state.sessionId = d.id;
        } else if (ev[1] === 'photo_read') {
          addLine('system', '我看图：' + String(d.text || '').slice(0, 200));
        } else if (ev[1] === 'error') {
          bubble.textContent = acc + '\n[出错了：' + d.message + ']';
        } else if (ev[1] === 'done') {
          if (state.sessionId) history.replaceState(null, '', `?t=${token}`);
        }
        if (ev[1] === 'delta' && state.speechOn) {
          speaking += d.text || '';
          if (/[。！？!?\n]/.test(d.text || '')) { speak(speaking); speaking = ''; }
        }
      }
    }
    if (speaking && state.speechOn) speak(speaking);
  } catch (e) {
    bubble.textContent = acc + '\n[连不上服务：' + e.message + ']';
  } finally {
    state.busy = false;
    setBusy(false);
  }
}

// ---------------------------------------------------------------- tts

let audioEl = null;

async function speak(text) {
  const clean = String(text).replace(/[*_#>|`]/g, '').trim();
  if (!clean) return;
  try {
    const r = await fetch(q('/api/tts?text=' + encodeURIComponent(clean.slice(0, 700))));
    if (r.ok) {
      const blob = await r.blob();
      if (audioEl) { audioEl.pause(); URL.revokeObjectURL(audioEl.src); }
      audioEl = new Audio(URL.createObjectURL(blob));
      await audioEl.play();
      return;
    }
  } catch {}
  if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = 'zh-CN';
    speechSynthesis.speak(u);
  }
}

// ---------------------------------------------------------------- stt

// 优先用浏览器自带的语音识别（不用下载模型），失败再退回服务端
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let sr = null;
let srActive = false;

function startSR() {
  sr = new SR();
  sr.lang = 'zh-CN';
  sr.continuous = false;
  sr.interimResults = true;
  sr.maxAlternatives = 1;

  sr.onresult = (e) => {
    let finalText = '';
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript;
      else interim += r[0].transcript;
    }
    if (interim) $('input').value = interim;
    if (finalText.trim()) {
      $('input').value = '';
      send(finalText.trim());
    }
  };
  sr.onerror = (e) => {
    srActive = false;
    $('micBtn').classList.remove('rec');
    $('statusText').textContent = '在线';
    if (e.error === 'not-allowed') toast('麦克风被拒绝了，点地址栏左边的小锁允许一下');
    else if (e.error === 'network') toast('浏览器语音要联网，连不上就打字吧');
    else if (e.error === 'no-speech') toast('没听到声音，再按一次');
    else if (e.error !== 'aborted') toast('语音识别出错：' + e.error);
  };
  sr.onend = () => {
    srActive = false;
    $('micBtn').classList.remove('rec');
    $('statusText').textContent = '在线';
    if ($('input').value.trim()) {
      const t = $('input').value.trim();
      $('input').value = '';
      send(t);
    }
  };

  try {
    sr.start();
    srActive = true;
    $('micBtn').classList.add('rec');
    $('statusText').textContent = '听着…';
    return true;
  } catch {
    srActive = false;
    return false;
  }
}

function stopSR() {
  if (sr && srActive) {
    try { sr.stop(); } catch {}
  }
}

let rec = null;
let chunks = [];
let recording = false;

async function startRec() {
  if (recording) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    rec = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '' });
    chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      if (blob.size < 1200) return;
      $('statusText').textContent = '识别中…';
      try {
        const r = await fetch(q('/api/stt'), { method: 'POST', body: blob });
        const d = await r.json();
        if (d.text) { $('input').value = ''; send(d.text); }
        else if (r.status === 503) addLine('system', '本地语音识别没装模型。直接打字就行，或者换个浏览器再试麦克风。');
        else if (d.error) addLine('system', '没听清：' + d.error);
      } catch (e) {
        addLine('system', '语音识别失败：' + e.message);
      }
      $('statusText').textContent = '在线';
    };
    rec.start();
    recording = true;
    $('micBtn').classList.add('rec');
    $('statusText').textContent = '说话中…';
  } catch (e) {
    toast('打不开麦克风：' + e.message);
  }
}

function stopRec() {
  if (!recording || !rec) return;
  recording = false;
  $('micBtn').classList.remove('rec');
  try { rec.stop(); } catch {}
}

// ---------------------------------------------------------------- ui

function setBusy(v) {
  $('sendBtn').disabled = v;
  $('statusPill').classList.toggle('busy', v);
  $('statusText').textContent = v ? '想着…' : '在线';
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._h);
  t._h = setTimeout(() => (t.hidden = true), 2600);
}

function openLightbox(src) {
  $('lightboxImg').src = src;
  $('lightbox').hidden = false;
}

// ---------------------------------------------------------------- 排障

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function renderHelp() {
  const list = $('helpList');
  const post = $('helpPost');
  if (!list) return;

  list.innerHTML = '';
  for (const t of state.troubleshoot || []) {
    const item = document.createElement('details');
    item.className = 'help-item';
    item.innerHTML =
      `<summary>${esc(t.symptom)}</summary>` +
      `<div class="help-body">` +
      `<b>可能原因</b><ul>${(t.causes || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` +
      `<b>让他检查</b><ul>${(t.check || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` +
      `<b>怎么修</b><ul>${(t.fix || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` +
      `</div>`;
    list.appendChild(item);
  }

  if (state.postInstall) {
    post.classList.add('on');
    post.innerHTML =
      `<b>${esc(state.postInstall.title)}</b><ul>` +
      (state.postInstall.items || []).map((x) => `<li>${esc(x)}</li>`).join('') +
      `</ul>`;
  }
}

function openHelp() {
  renderHelp();
  $('helpDlg').hidden = false;
}

// ---------------------------------------------------------------- key dialog

async function checkKey() {
  try {
    const s = await fetch(q('/api/settings')).then((r) => r.json());
    if (!s.hasKey) {
      addLine('system', '还没填 Key —— 右上角 🔑 点一下，粘进去就行。不填也能看 3D，但 AI 不会说话。');
      $('keyBtn').classList.add('hot');
    } else {
      $('keyBtn').textContent = '🔑 ' + s.keyHint;
    }
  } catch {}
}

function openKeyDlg() {
  $('keyDlg').hidden = false;
  $('keyMsg').textContent = '';
  $('keyMsg').className = 'dialog-msg';
  setTimeout(() => $('keyInput').focus(), 30);
}

async function saveKey() {
  const v = $('keyInput').value.trim();
  const msg = $('keyMsg');
  if (!v) {
    msg.className = 'dialog-msg err';
    msg.textContent = '还没填东西';
    return;
  }
  const r = await fetch(q('/api/settings'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey: v }),
  });
  const d = await r.json();
  if (!r.ok) {
    msg.className = 'dialog-msg err';
    msg.textContent = d.error || '保存失败';
    return;
  }
  msg.className = 'dialog-msg ok';
  msg.textContent = '存好了：' + d.keyHint;
  $('keyBtn').textContent = '🔑 ' + d.keyHint;
  $('keyBtn').classList.remove('hot');
  $('keyInput').value = '';
  addLine('system', 'Key 存好了。现在可以说一句试试。');
  setTimeout(() => ($('keyDlg').hidden = true), 800);
}

// 手机原图太大，先缩到 1600px 再发：传得快，看图也便宜
function shrinkImage(dataUrl, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
      if (scale >= 1 && dataUrl.length < 700000) return resolve(dataUrl);
      try {
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/jpeg', quality));
      } catch {
        resolve(dataUrl);
      }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function bind() {
  $('sendBtn').onclick = () => {
    const v = $('input').value;
    $('input').value = '';
    send(v, state.photo);
  };

  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      $('sendBtn').click();
    }
  });

  $('photoBtn').onclick = () => $('fileInput').click();
  $('fileInput').onchange = (e) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = async () => {
      const small = await shrinkImage(reader.result);
      send('', small);
    };
    reader.readAsDataURL(f);
    e.target.value = '';
  };

  const mic = $('micBtn');
  mic.addEventListener('click', () => {
    if (SR) {
      if (srActive) stopSR();
      else startSR();
      return;
    }
    if (recording) stopRec();
    else startRec();
  });

  $('nextStep').onclick = async () => {
    const i = state.spec.steps.findIndex((s) => s.id === state.stepId);
    const next = state.spec.steps[Math.min(i + 1, state.spec.steps.length - 1)];
    if (!next || next.id === state.stepId) return;
    await goto(next.id);
    if (state.scene) state.scene.play();
  };
  $('prevStep').onclick = () => {
    const i = state.spec.steps.findIndex((s) => s.id === state.stepId);
    const prev = state.spec.steps[Math.max(i - 1, 0)];
    goto(prev.id);
  };

  $('playBtn').onclick = () => {
    if (!state.scene) return;
    state.scene.toggle();
    syncPlayerUI();
  };
  $('replayBtn').onclick = () => {
    if (!state.scene) return;
    state.scene.seekTo(0);
    state.scene.play();
    syncPlayerUI();
  };
  $('scrub').oninput = (e) => {
    if (!state.scene) return;
    state.scene.pause();
    state.scene.seekTo((Number(e.target.value) / 1000) * state.scene.duration);
    syncPlayerUI();
  };
  $('speeds').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b || !state.scene) return;
    [...$('speeds').children].forEach((x) => x.classList.toggle('on', x === b));
    state.scene.setSpeed(Number(b.dataset.speed));
  };
  $('autoNext').onchange = (e) => {
    state.autoNext = e.target.checked;
  };

  $('viewSeg').onclick = (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    [...$('viewSeg').children].forEach((x) => x.classList.toggle('on', x === b));
    state.scene.focus(b.dataset.view);
  };
  $('resetView').onclick = () => state.scene.focus('iso');

  $('voiceToggle').onclick = () => {
    state.speechOn = !state.speechOn;
    $('voiceToggle').textContent = state.speechOn ? '🔊 朗读' : '🔇 静音';
    if (!state.speechOn) { if (audioEl) audioEl.pause(); speechSynthesis.cancel(); }
  };

  $('newChatBtn').onclick = () => {
    state.sessionId = null;
    $('messages').innerHTML = '';
    greet();
  };

  $('lightbox').onclick = () => ($('lightbox').hidden = true);

  $('keyBtn').onclick = openKeyDlg;
  $('keyCancel').onclick = () => ($('keyDlg').hidden = true);
  $('helpBtn').onclick = openHelp;
  $('helpClose').onclick = () => ($('helpDlg').hidden = true);
  $('printBtn').onclick = () => window.open(q('/print'), '_blank');
  $('keySave').onclick = saveKey;
  $('keyInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); saveKey(); }
    if (e.key === 'Escape') $('keyDlg').hidden = true;
  });
}

boot();
