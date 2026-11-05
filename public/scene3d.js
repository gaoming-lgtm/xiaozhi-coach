// 3D 示意台：面包板 + 零件 + 彩色接线。
// 全部程序化生成，不加载任何外部模型/贴图。
// 场景由 spec 驱动：换板型只改 JSON，不改这里。

import * as THREE from './vendor/three.module.min.js';

// 零件在台面上的摆位（示意，不追求和实物 1:1）
const LAYOUT = {
  esp32s3: { pos: [56, 0, 0], size: [28, 6, 57], color: 0x1b1e26, label: 'ESP32-S3' },
  inmp441: { pos: [-48, 0, 0], size: [17, 3.5, 14], color: 0x2a7a63, label: 'INMP441' },
  max98357: { pos: [0, 0, -15], size: [23, 3.5, 17], color: 0x4a4a8c, label: 'MAX98357A' },
  oled: { pos: [4, 0, 16], size: [26, 4, 26], color: 0x141a2c, label: 'OLED 0.96″' },
  speaker: { pos: [32, 0, 60], size: [34, 34, 13], color: 0x26262b, label: '3W 8Ω 喇叭', shape: 'speaker' },
};

// 每个模块的引脚在局部坐标里的位置（沿一边等分）
const PINS = {
  inmp441: { at: 8.6, y: 3.5, from: -6, step: 2.3, order: ['VDD', 'GND', 'L/R', 'WS', 'SCK', 'SD'] },
  max98357: { at: 11.6, y: 3.5, from: -7, step: 2.3, order: ['VIN', 'GND', 'SD', 'GAIN', 'DIN', 'BCLK', 'LRC'] },
  oled: { at: 13.1, y: 4.2, from: -5, step: 3.2, order: ['VCC', 'GND', 'SDA', 'SCL'] },
};

// 主控板两边的“脚位标签”，示意用，不是实物排针位置
const BOARD_PADS = {
  left: ['3V3', 'GND', 'GPIO4', 'GPIO5', 'GPIO6', 'GPIO7'],
  right: ['GPIO15', 'GPIO16', 'GPIO41', 'GPIO42', 'GND', '5Vin'],
};

// 不在排针上的接点（喇叭端子）
const TERMINALS = {
  max98357: { '音频+': [0 - 12.5, 3.6, -15], '音频−': [0 - 12.5, 3.6, -11] },
  speaker: { '+': [32 - 17, 12, 60], '-': [32 - 17, 6, 60] },
};

const COLOR_MAP = { 红: 0xe0454a, 黑: 0x2b2b2f, 橙: 0xd2622a, 黄: 0xf2d45a, 蓝: 0x3f7fe0, 绿: 0x3fbf6f };

const colorOf = (name) => COLOR_MAP[name] ?? 0x9aa0aa;

// ---------------------------------------------------------------- helpers

function gradientTexture() {
  const c = document.createElement('canvas');
  c.width = 64;
  c.height = 256;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, '#2a3547');
  grad.addColorStop(0.45, '#151d29');
  grad.addColorStop(1, '#080b11');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 256);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeLabel(text) {
  const DPR = 2;
  const font = `600 ${15 * DPR}px "Microsoft YaHei", system-ui, sans-serif`;
  const padX = 9 * DPR;
  const h = 26 * DPR;
  const c = document.createElement('canvas');
  let g = c.getContext('2d');
  g.font = font;
  const tw = Math.ceil(g.measureText(text).width);
  c.width = tw + padX * 2;
  c.height = h;
  g = c.getContext('2d');
  g.font = font;
  g.fillStyle = 'rgba(10,14,20,0.72)';
  if (typeof g.roundRect === 'function') {
    g.beginPath();
    g.roundRect(0, 0, c.width, h, 8 * DPR);
    g.fill();
  } else {
    g.fillRect(0, 0, c.width, h);
  }
  g.strokeStyle = 'rgba(255,255,255,0.10)';
  g.lineWidth = 1 * DPR;
  g.strokeRect(0.5 * DPR, 0.5 * DPR, c.width - DPR, h - DPR);
  g.fillStyle = '#eef2f8';
  g.textBaseline = 'middle';
  g.fillText(text, padX, h / 2 + 1);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;

  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  const sp = new THREE.Sprite(mat);
  const worldH = 5.4;
  sp.scale.set((c.width / h) * worldH, worldH, 1);
  sp.renderOrder = 10;
  return sp;
}

function makeSilk(text) {
  // 板子上的丝印：名字 + 边线 + 几条走线，让方块看起来像块真板子
  const S = 4;
  const W = 256 * S;
  const H = 256 * S;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  g.strokeStyle = 'rgba(232,238,247,0.16)';
  g.lineWidth = 3 * S;
  g.strokeRect(10 * S, 10 * S, W - 20 * S, H - 20 * S);

  g.strokeStyle = 'rgba(232,238,247,0.10)';
  g.lineWidth = 1.6 * S;
  for (let i = 0; i < 4; i++) {
    const y = 40 * S + i * 22 * S;
    g.beginPath();
    g.moveTo(16 * S, y);
    g.lineTo(W - 60 * S, y);
    g.lineTo(W - 40 * S, y + 14 * S);
    g.stroke();
  }

  g.fillStyle = 'rgba(236,242,251,0.72)';
  g.font = `700 ${17 * S}px "Microsoft YaHei", system-ui, sans-serif`;
  g.textBaseline = 'alphabetic';
  g.fillText(text, 18 * S, H - 20 * S);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

const easeOutCubic = (x) => 1 - Math.pow(1 - x, 3);

function breadboardTexture() {
  const W = 1400;
  const H = 470;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');

  const base = g.createLinearGradient(0, 0, 0, H);
  base.addColorStop(0, '#f2f2ec');
  base.addColorStop(1, '#dededa');
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);

  // 电源轨
  const rail = (y, color) => {
    g.fillStyle = color;
    g.fillRect(30, y, W - 60, 2.5);
  };
  rail(16, '#d4695f');
  rail(26, '#5b7fc7');
  rail(H - 20, '#d4695f');
  rail(H - 30, '#5b7fc7');

  // 孔
  const cols = 63;
  const rowsTop = 4;
  const rowsBot = 4;
  const left = 52;
  const right = W - 52;
  const dot = (x, y) => {
    g.beginPath();
    g.arc(x, y, 4.4, 0, Math.PI * 2);
    g.fillStyle = '#c3c3b8';
    g.fill();
    g.beginPath();
    g.arc(x, y, 2.6, 0, Math.PI * 2);
    g.fillStyle = '#8d8d84';
    g.fill();
    g.beginPath();
    g.arc(x - 0.6, y - 0.6, 1.1, 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,255,0.55)';
    g.fill();
  };
  for (let i = 0; i < cols; i++) {
    const x = left + (i * (right - left)) / (cols - 1);
    for (let r = 0; r < rowsTop; r++) dot(x, 76 + r * 20);
    for (let r = 0; r < rowsBot; r++) dot(x, H - 76 - r * 20);
  }

  // 中间凹槽
  const mid = g.createLinearGradient(0, H / 2 - 9, 0, H / 2 + 9);
  mid.addColorStop(0, '#cfcfc6');
  mid.addColorStop(0.5, '#b9b9b0');
  mid.addColorStop(1, '#cfcfc6');
  g.fillStyle = mid;
  g.fillRect(0, H / 2 - 9, W, 18);

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

// ---------------------------------------------------------------- scene

export class BuildScene {
  constructor(canvas, spec) {
    this.spec = spec;
    this.canvas = canvas;
    this.visibleWires = new Set();
    this.pulseIds = new Set();

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;

    this.scene = new THREE.Scene();
    this.scene.background = gradientTexture();

    this.camera = new THREE.PerspectiveCamera(36, 1, 1, 2000);

    this.setupEnvironment();
    this.setupLights();

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this.parts = new Map();
    this.wires = new Map();
    this.labels = new Map();
    this.anims = [];

    // 播放器状态
    this.time = 0;
    this.duration = 1000;
    this.speed = 1;
    this.playing = false;
    this.lastFrame = 0;
    this.stepParts = [];
    this.stepWires = [];
    this.beats = { parts: [], wires: [], total: 1200 };
    this.onStepEnd = null;
    this.onUpdate = null;

    this.buildBoard();
    this.buildParts();
    this.buildWires();

    this.ideal = { theta: 0.66, phi: 0.76, radius: 340, target: new THREE.Vector3(2, -6, 14) };
    this.cur = { theta: 0.62, phi: 0.74, radius: 330, target: new THREE.Vector3(0, -4, 6) };

    this.bindPointer();
    this.resize();
    this.loop = this.loop.bind(this);
    this.running = true;
    requestAnimationFrame(this.loop);
  }

  setupEnvironment() {
    // 用一张渐变当环境光，材质才有反射质感（不加载任何外部 HDR）
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const eq = gradientTexture();
    eq.mapping = THREE.EquirectangularReflectionMapping;
    this.envRT = pmrem.fromEquirectangular(eq);
    this.scene.environment = this.envRT.texture;
    pmrem.dispose();
  }

  setupLights() {
    const hemi = new THREE.HemisphereLight(0xcfe0ff, 0x1a1f28, 0.5);
    this.scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff0dd, 2.7);
    key.position.set(110, 190, 95);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.left = -110;
    key.shadow.camera.right = 110;
    key.shadow.camera.top = 110;
    key.shadow.camera.bottom = -110;
    key.shadow.camera.near = 40;
    key.shadow.camera.far = 480;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.35;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x8fb6ff, 0.8);
    fill.position.set(-170, 90, -60);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xbfd4ff, 0.65);
    rim.position.set(-40, 60, -210);
    this.scene.add(rim);

    // 桌面反弹光：从前方低处打回来，压住正面死黑
    const bounce = new THREE.DirectionalLight(0xffd9b0, 0.45);
    bounce.position.set(30, -40, 160);
    this.scene.add(bounce);
  }

  buildBoard() {
    const g = new THREE.Group();

    const body = new THREE.Mesh(
      new THREE.BoxGeometry(165, 10, 55),
      new THREE.MeshStandardMaterial({ color: 0xdededa, roughness: 0.85, metalness: 0 })
    );
    body.position.y = -5;
    body.castShadow = true;
    body.receiveShadow = true;
    g.add(body);

    const top = new THREE.Mesh(
      new THREE.PlaneGeometry(165, 55),
      new THREE.MeshStandardMaterial({ map: breadboardTexture(), roughness: 0.72, metalness: 0.04 })
    );
    top.rotation.x = -Math.PI / 2;
    top.position.y = 0.06;
    top.receiveShadow = true;
    g.add(top);

    // 轮廓线，让边缘更利落
    const edge = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.BoxGeometry(165, 10, 55)),
      new THREE.LineBasicMaterial({ color: 0x9aa0aa, transparent: true, opacity: 0.28 })
    );
    edge.position.y = -5;
    g.add(edge);

    // 桌面：真正接收阴影，零件和板子才像放在桌上
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(1400, 1400),
      new THREE.MeshStandardMaterial({ color: 0x0a0e15, roughness: 0.96, metalness: 0 })
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -11;
    floor.receiveShadow = true;
    g.add(floor);

    this.root.add(g);
    this.boardGroup = g;
  }

  addChip(group, w, h, d, x, y, z, color = 0x1c1c22) {
    const chip = new THREE.Mesh(
      new THREE.BoxGeometry(w, h, d),
      new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.35 })
    );
    chip.position.set(x, y, z);
    chip.castShadow = true;
    group.add(chip);
    return chip;
  }

  buildParts() {
    for (const p of this.spec.parts) {
      const l = LAYOUT[p.id];
      if (!l) continue;
      const grp = new THREE.Group();
      grp.position.set(...l.pos);
      const [sx, sy, sz] = l.size;

      let body;
      if (l.shape === 'speaker') {
        const spkMat = new THREE.MeshStandardMaterial({ color: l.color, roughness: 0.72, metalness: 0.12 });
        spkMat.envMapIntensity = 0.22;
        body = new THREE.Mesh(new THREE.CylinderGeometry(sz / 2, sz / 2, sy, 48), spkMat);
        body.rotation.x = Math.PI / 2;
        body.position.y = sy / 2;
        // 喇叭盆
        const cone = new THREE.Mesh(
          new THREE.CylinderGeometry(sz / 2 - 4, sz / 2 - 10, 3.4, 48),
          new THREE.MeshStandardMaterial({ color: 0x2c2c30, roughness: 0.95, metalness: 0.1 })
        );
        cone.rotation.x = Math.PI / 2;
        cone.position.set(0, sy / 2 + 0.2, 6.2);
        grp.add(cone);
      } else {
        const bodyMat = new THREE.MeshStandardMaterial({ color: l.color, roughness: 0.62, metalness: 0.1 });
        bodyMat.envMapIntensity = 0.28;
        body = new THREE.Mesh(new THREE.BoxGeometry(sx, sy, sz), bodyMat);
        body.position.y = sy / 2;
        const edge = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(sx, sy, sz)),
          new THREE.LineBasicMaterial({ color: 0x8fa3bd, transparent: true, opacity: 0.22 })
        );
        edge.position.y = sy / 2;
        grp.add(edge);
      }
      body.castShadow = true;
      body.receiveShadow = true;
      body.userData.partId = p.id;
      grp.add(body);

      // 丝印层：让方块看起来像块真板子
      if (p.id !== 'speaker' && p.id !== 'oled') {
        const silk = new THREE.Mesh(
          new THREE.PlaneGeometry(sx * 0.94, sz * 0.94),
          new THREE.MeshBasicMaterial({ map: makeSilk(l.label), transparent: true, opacity: 0.5, depthWrite: false })
        );
        silk.rotation.x = -Math.PI / 2;
        silk.position.y = sy + 0.09;
        silk.renderOrder = 1;
        grp.add(silk);
      }

      // 每个零件的“长相”细节
      if (p.id === 'esp32s3') {
        this.addChip(grp, 18, 2.6, 24, 0, sy + 1.3, -6, 0xb9bec7); // 屏蔽罩
        this.addChip(grp, 10, 1.4, 8, 0, sy + 0.7, 20, 0x2a2a30); // 天线区
        for (const z of [18, 24]) {
          const usb = new THREE.Mesh(
            new THREE.BoxGeometry(9, 3.2, 7),
            new THREE.MeshStandardMaterial({ color: 0xc9ccd2, roughness: 0.35, metalness: 0.85 })
          );
          usb.position.set(0, sy + 1.4, z);
          grp.add(usb);
        }
        const led = new THREE.Mesh(
          new THREE.SphereGeometry(1.6, 16, 12),
          new THREE.MeshStandardMaterial({ color: 0x3ddc84, emissive: 0x22aa55, emissiveIntensity: 1.2 })
        );
        led.position.set(-9, sy + 1.2, 12);
        grp.add(led);
      }

      if (p.id === 'inmp441') {
        const can = new THREE.Mesh(
          new THREE.CylinderGeometry(4, 4, 2.4, 32),
          new THREE.MeshStandardMaterial({ color: 0xc8b47a, roughness: 0.3, metalness: 0.9 })
        );
        can.position.set(-1.5, sy + 1.2, 0);
        can.castShadow = true;
        grp.add(can);
        const port = new THREE.Mesh(
          new THREE.CylinderGeometry(1.1, 1.1, 2.6, 20),
          new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 1 })
        );
        port.position.set(-1.5, sy + 1.25, 0);
        grp.add(port);
      }

      if (p.id === 'max98357') {
        this.addChip(grp, 8, 1.6, 8, -4, sy + 0.8, 0, 0x14141a);
        const term = new THREE.Mesh(
          new THREE.BoxGeometry(5, 3.4, 7),
          new THREE.MeshStandardMaterial({ color: 0x2b6cbf, roughness: 0.6, metalness: 0.2 })
        );
        term.position.set(-10, sy / 2 + 0.4, 1.2);
        term.castShadow = true;
        grp.add(term);
      }

      if (p.id === 'oled') {
        const glass = new THREE.Mesh(
          new THREE.PlaneGeometry(22, 15),
          new THREE.MeshStandardMaterial({ color: 0x0a1630, roughness: 0.12, metalness: 0.6, emissive: 0x0a1c3a, emissiveIntensity: 0.55 })
        );
        glass.rotation.x = -Math.PI / 2;
        glass.position.set(0, sy + 0.08, -2.5);
        grp.add(glass);
      }

      // 排针
      const pinDef = PINS[p.id];
      if (pinDef) {
        const pinMat = new THREE.MeshStandardMaterial({ color: 0xd9b25f, roughness: 0.28, metalness: 0.95 });
        for (let i = 0; i < pinDef.order.length; i++) {
          const pg = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.6, 2.2), pinMat);
          pg.position.set(pinDef.at, pinDef.y + 1.2, pinDef.from + i * pinDef.step);
          pg.castShadow = true;
          grp.add(pg);
        }
      }

      const label = makeLabel(l.label);
      label.position.set(0, sy + 13, 0);
      label.userData.baseScale = { x: label.scale.x, y: label.scale.y };
      label.visible = false;
      grp.add(label);
      this.labels.set(p.id, label);

      grp.userData.body = body;
      grp.userData.baseY = sy + 13;
      grp.userData.basePos = grp.position.clone();
      this.parts.set(p.id, grp);
      this.root.add(grp);
    }
  }

  padWorld(name) {
    const l = LAYOUT.esp32s3;
    let side = 'left';
    let idx = BOARD_PADS.left.indexOf(name);
    if (idx < 0) {
      side = 'right';
      idx = BOARD_PADS.right.indexOf(name);
    }
    if (idx < 0) return null;
    const list = side === 'left' ? BOARD_PADS.left : BOARD_PADS.right;
    const z = -24 + idx * (48 / (list.length - 1));
    return new THREE.Vector3(l.pos[0] + (side === 'left' ? -l.size[0] / 2 : l.size[0] / 2), 6.4, l.pos[2] + z);
  }

  pinWorld(partId, pinName) {
    const term = TERMINALS[partId] && TERMINALS[partId][pinName];
    if (term) return new THREE.Vector3(...term);
    const def = PINS[partId];
    const l = LAYOUT[partId];
    if (!def || !l) return null;
    const i = def.order.indexOf(pinName);
    if (i < 0) return null;
    return new THREE.Vector3(l.pos[0] + def.at, def.y + 1.4, l.pos[2] + def.from + i * def.step);
  }

  buildWires() {
    for (const w of this.spec.wiring) {
      const [fromPart, fromPin] = w.from;
      const [toPart, toPin] = w.to;
      let a = this.pinWorld(fromPart, fromPin);
      let b = toPart === 'esp32s3' ? this.padWorld(toPin) : this.pinWorld(toPart, toPin);
      if (!a && fromPart === 'esp32s3') a = this.padWorld(fromPin);
      if (!b && toPart === 'esp32s3') b = this.padWorld(toPin);
      if (!a || !b) continue;

      const seq = this.wires.size;
      const span = Math.abs(a.x - b.x) + Math.abs(a.z - b.z);
      const lift = 8 + span * 0.055 + (seq % 6) * 2.4;
      const mid = a.clone().add(b).multiplyScalar(0.5);
      mid.y += lift;
      const c1 = a.clone();
      c1.y += lift * 0.85;
      const c2 = b.clone();
      c2.y += lift * 0.85;

      const curve = new THREE.CatmullRomCurve3([a, c1, mid, c2, b], false, 'catmullrom', 0.45);
      const geo = new THREE.TubeGeometry(curve, 56, 0.72, 8, false);
      const base = colorOf(w.color);
      const mat = new THREE.MeshStandardMaterial({
        color: base,
        roughness: 0.42,
        metalness: 0.18,
        emissive: base,
        emissiveIntensity: 0.05,
      });
      mat.envMapIntensity = 0.5;
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = true;
      mesh.userData.wireId = w.id;
      mesh.userData.baseEmissive = base;
      mesh.userData.curve = curve;
      mesh.userData.anchor = curve.getPoint(0.55).clone();
      mesh.userData.total = geo.index ? geo.index.count : 0;
      mesh.userData.tube = geo;
      mesh.visible = false;
      this.wires.set(w.id, mesh);
      this.root.add(mesh);
    }
  }

  // ---------------------------------------------------------------- 对外

  animate(dur, fn, delay = 0) {
    this.anims.push({ t0: performance.now() + delay, dur, fn });
  }

  applySceneAction(payload = {}) {
    if (payload.camera) this.focus(payload.camera);
    this.pulseIds = payload.pulse ? new Set([payload.pulse]) : new Set();
    if (Array.isArray(payload.parts) && payload.parts.length) this.highlight(payload.parts);
    if (Array.isArray(payload.wires) && payload.wires.length) this.showWires(payload.wires);
  }

  applyStep(payload) {
    const idx = typeof payload.index === 'number'
      ? payload.index
      : this.spec.steps.findIndex((s) => s.id === payload.stepId);
    const ids = (payload.wiring || []).map((w) => w.id);
    const parts = new Set(payload.parts || []);
    for (const w of payload.wiring || []) {
      parts.add(w.from[0]);
      parts.add(w.to[0]);
    }

    // 已经装完的步骤，线留在板上但压暗；这一步的线亮着
    const done = new Set();
    for (let i = 0; i < idx; i++) for (const id of this.spec.steps[i].wiring || []) done.add(id);

    this.activeWires = new Set(ids);
    this.visibleWires = new Set([...done, ...ids]);
    const dimOp = ids.length ? 0.15 : 1;
    for (const [id, mesh] of this.wires) {
      const on = this.visibleWires.has(id);
      const bright = this.activeWires.has(id) || dimOp === 1;
      mesh.visible = on;
      mesh.material.transparent = !bright;
      mesh.material.opacity = bright ? 1 : dimOp;
      mesh.material.depthWrite = bright;
      if (mesh.userData.tube) mesh.userData.tube.setDrawRange(0, on ? mesh.userData.total : 0);
    }

    this.highlight([...parts]);
    this.pulseIds = new Set();
    this.focusForStep(payload.stepId);

    // ---- 建时间轴（这一步的播放器）
    this.stepParts = [...parts].filter((id) => this.parts.has(id));
    this.stepWires = ids.filter((id) => this.wires.has(id));

    const partBeats = this.stepParts.map((_, i) => ({ start: 320 + i * 170, dur: 820 }));
    const wireBeats = this.stepWires.map((_, i) => ({ start: 1100 + i * 620, dur: 980 }));
    const lastEnd = Math.max(
      900,
      ...partBeats.map((b) => b.start + b.dur),
      ...wireBeats.map((b) => b.start + b.dur)
    );
    this.beats = { parts: partBeats, wires: wireBeats, total: lastEnd + 1100 };
    this.duration = this.beats.total;

    // 零件先回位，避免上一步的动画残留在半空
    for (const [, grp] of this.parts) {
      const base = grp.userData.basePos;
      grp.position.set(base.x, base.y, base.z);
      grp.scale.setScalar(1);
    }

    // 切步骤默认直接显示"装完的样子"，按播放键才从头演
    this.playing = false;
    this.seekTo(this.duration);
  }

  // ---------------------------------------------------------------- 播放器

  seekTo(t) {
    this.time = Math.max(0, Math.min(this.duration, t));

    this.stepParts.forEach((id, i) => {
      const grp = this.parts.get(id);
      const b = this.beats.parts[i];
      if (!grp || !b) return;
      const p = Math.max(0, Math.min(1, (this.time - b.start) / b.dur));
      const e = easeOutCubic(p);
      const base = grp.userData.basePos;
      grp.position.y = base.y + 34 * (1 - e);
      grp.scale.setScalar(0.88 + 0.12 * e);
    });

    this.stepWires.forEach((id, i) => {
      const mesh = this.wires.get(id);
      const b = this.beats.wires[i];
      if (!mesh || !b || !mesh.userData.total) return;
      const p = Math.max(0, Math.min(1, (this.time - b.start) / b.dur));
      mesh.userData.tube.setDrawRange(0, Math.floor(easeOutCubic(p) * mesh.userData.total));
    });
  }

  play() {
    if (this.time >= this.duration - 1) this.time = 0;
    this.playing = true;
    this.lastFrame = 0;
  }

  pause() {
    this.playing = false;
  }

  toggle() {
    if (this.playing) this.pause();
    else this.play();
    return this.playing;
  }

  setSpeed(v) {
    this.speed = Math.max(0.25, Math.min(4, Number(v) || 1));
  }

  state() {
    return {
      time: this.time,
      duration: this.duration,
      playing: this.playing,
      speed: this.speed,
      progress: this.duration ? this.time / this.duration : 1,
    };
  }

  // 验收没过：把可疑的线/零件标红闪一会儿
  mark(ids) {
    this.marked = new Set((ids || []).map(String));
    this.markUntil = performance.now() + 10000;
  }

  clearMark() {
    this.marked = null;
    for (const [, mesh] of this.wires) {
      if (mesh.userData.baseEmissive) mesh.material.emissive.setHex(mesh.userData.baseEmissive);
    }
    if (this.activeParts) this.highlight(this.activeParts);
  }

  showWires(ids) {
    this.activeWires = new Set(ids);
    this.visibleWires = new Set(ids);
    for (const [id, mesh] of this.wires) {
      const on = this.visibleWires.has(id);
      mesh.visible = on;
      mesh.material.transparent = false;
      mesh.material.opacity = 1;
      mesh.material.depthWrite = true;
      if (mesh.userData.tube) mesh.userData.tube.setDrawRange(0, mesh.userData.total);
    }
  }

  // 给 DOM 标注层用：只标注当前这一步的线
  screenAnchors() {
    const out = [];
    const v = new THREE.Vector3();
    const active = this.activeWires || this.visibleWires;
    const order = [...active];
    for (const [id, mesh] of this.wires) {
      if (!active.has(id) || !mesh.userData.curve) continue;
      const w = this.spec.wiring.find((x) => x.id === id);
      if (!w) continue;
      const lane = order.indexOf(id);
      const tOnCurve = 0.3 + ((lane < 0 ? 0 : lane) % 3) * 0.18;
      v.copy(mesh.userData.curve.getPoint(tOnCurve)).project(this.camera);
      if (v.z > 1) continue;
      const label = w.from[0] === 'esp32s3' ? `${w.to[1]} → ${w.from[1]}` : `${w.from[1]} → ${w.to[1]}`;
      out.push({
        id,
        text: label,
        x: (v.x * 0.5 + 0.5) * 100,
        y: (-v.y * 0.5 + 0.5) * 100,
      });
    }
    return out;
  }

  highlight(ids) {
    this.activeParts = ids.slice();
    const set = new Set(ids);
    const any = ids.length > 0;
    for (const [id, grp] of this.parts) {
      const body = grp.userData.body;
      const on = !any || set.has(id);
      if (body.material.emissive !== undefined) {
        body.material.emissive.setHex(on && any ? 0x1d3f6b : 0x000000);
        body.material.emissiveIntensity = on && any ? 0.9 : 0;
      }
      grp.userData.dim = any && !set.has(id);
      const label = this.labels.get(id);
      if (label) label.visible = on && any;
    }
    // 没有指定零件时（比如第一步），全部亮起并显示标签
    if (!any) {
      for (const [id, grp] of this.parts) {
        grp.userData.dim = false;
        const label = this.labels.get(id);
        if (label) label.visible = true;
      }
    }
  }

  focusForStep(stepId) {
    // 只在纯检查类步骤用俯视；接线步骤一律给全景，两头都要看得到
    const top = new Set(['s03', 's04', 's12']);
    this.focus(top.has(stepId) ? 'top' : 'iso');
  }

  focus(name) {
    const P = {
      iso: { theta: 0.66, phi: 0.76, radius: 340, target: [2, -6, 14] },
      top: { theta: 0.0, phi: 0.08, radius: 240, target: [0, 0, 6] },
      front: { theta: 0.0, phi: 1.34, radius: 300, target: [0, 0, 0] },
      left: { theta: -1.25, phi: 0.8, radius: 280, target: [-20, 0, 0] },
      mic: { theta: -0.8, phi: 0.78, radius: 108, target: [-48, 0, 0] },
      amp: { theta: -0.55, phi: 0.78, radius: 112, target: [0, 0, -15] },
      oled: { theta: -0.28, phi: 0.8, radius: 108, target: [4, 0, 14] },
      power: { theta: 0.85, phi: 0.78, radius: 145, target: [56, 0, 0] },
    };
    const p = P[name] || P.iso;
    this.ideal.theta = p.theta;
    this.ideal.phi = p.phi;
    this.ideal.radius = p.radius;
    this.ideal.target.set(...p.target);
  }

  bindPointer() {
    let down = false;
    let lx = 0;
    let ly = 0;
    const el = this.canvas;

    el.addEventListener('pointerdown', (e) => {
      down = true;
      lx = e.clientX;
      ly = e.clientY;
      try { el.setPointerCapture(e.pointerId); } catch {}
    });
    el.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - lx;
      const dy = e.clientY - ly;
      lx = e.clientX;
      ly = e.clientY;
      this.ideal.theta -= dx * 0.006;
      this.ideal.phi = Math.max(0.06, Math.min(1.45, this.ideal.phi - dy * 0.005));
    });
    const up = (e) => {
      down = false;
      try { el.releasePointerCapture(e.pointerId); } catch {}
    };
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.ideal.radius = Math.max(80, Math.min(560, this.ideal.radius + e.deltaY * 0.2));
      },
      { passive: false }
    );
  }

  resize() {
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // 3D 区域被挤窄时，横向视场会变小，板子两头会被裁掉——按宽高比补 fov
    const baseFov = 36;
    const wantAspect = 1.35;
    this.camera.fov =
      this.camera.aspect >= wantAspect
        ? baseFov
        : Math.min(78, baseFov * Math.pow(wantAspect / this.camera.aspect, 0.55));
    this.camera.updateProjectionMatrix();
  }

  loop(t) {
    if (!this.running) return;
    requestAnimationFrame(this.loop);

    // 播放器推进
    const nowMs = performance.now();
    const dt = this.lastFrame ? Math.min(120, nowMs - this.lastFrame) : 0;
    this.lastFrame = nowMs;
    if (this.playing) {
      this.time += dt * this.speed;
      if (this.time >= this.duration) {
        this.time = this.duration;
        this.playing = false;
        this.seekTo(this.duration);
        if (this.onStepEnd) this.onStepEnd();
      } else {
        this.seekTo(this.time);
      }
      if (this.onUpdate) this.onUpdate(this.state());
    }

    const k = 0.11;
    this.cur.theta += (this.ideal.theta - this.cur.theta) * k;
    this.cur.phi += (this.ideal.phi - this.cur.phi) * k;
    this.cur.radius += (this.ideal.radius - this.cur.radius) * k;
    this.cur.target.lerp(this.ideal.target, k);

    const { theta, phi, radius, target } = this.cur;
    this.camera.position.set(
      target.x + radius * Math.sin(phi) * Math.sin(theta),
      target.y + radius * Math.cos(phi),
      target.z + radius * Math.sin(phi) * Math.cos(theta)
    );
    this.camera.lookAt(target);

    // 动画队列
    if (this.anims.length) {
      const now = performance.now();
      this.anims = this.anims.filter((a) => {
        const raw = (now - a.t0) / a.dur;
        if (raw < 0) { a.fn(0); return true; }
        const p = Math.min(1, raw);
        a.fn(easeOutCubic(p));
        return p < 1;
      });
    }

    if (this.marked && performance.now() > this.markUntil) this.clearMark();
    const markPulse = 0.5 + 0.5 * Math.sin(t * 0.012);
    const pulse = 0.5 + 0.5 * Math.sin(t * 0.0055);

    for (const [id, mesh] of this.wires) {
      if (this.marked && this.marked.has(id)) {
        mesh.material.emissive.setHex(0xff2b2b);
        mesh.material.emissiveIntensity = 0.8 + 1.4 * markPulse;
        continue;
      }
      if (mesh.userData.baseEmissive) mesh.material.emissive.setHex(mesh.userData.baseEmissive);
      const on = this.pulseIds.has(id);
      const bright = this.activeWires ? this.activeWires.has(id) : this.visibleWires.has(id);
      const breathing = 0.16 + 0.08 * Math.sin(t * 0.002 + (mesh.userData.anchor ? mesh.userData.anchor.x : 0) * 0.1);
      mesh.material.emissiveIntensity = on ? 0.55 + 1.0 * pulse : bright ? breathing : 0.03;
    }

    for (const [id, grp] of this.parts) {
      const body = grp.userData.body;
      if (this.marked && this.marked.has(id)) {
        body.material.emissive.setHex(0xff2b2b);
        body.material.emissiveIntensity = 0.7 + 1.3 * markPulse;
      } else if (this.pulseIds.has(id) && body.material.emissive) {
        body.material.emissiveIntensity = 0.4 + 0.9 * pulse;
      }
      // 标签轻微上下浮动，并按距离缩放，屏幕上大小恒定
      const label = this.labels.get(id);
      if (label && label.visible) {
        label.position.y = grp.userData.baseY + Math.sin(t * 0.0018 + grp.position.x) * 0.7;
        const b = label.userData.baseScale;
        if (b) {
          const k = Math.max(0.42, Math.min(1.7, this.cur.radius / 340));
          label.scale.set(b.x * k, b.y * k, 1);
        }
      }
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.running = false;
    this.renderer.dispose();
  }
}
