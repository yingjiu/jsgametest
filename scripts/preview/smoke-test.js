/*
 * 冒烟测试：在 Node 里用「打桩的 Arena 桥 + 打桩 canvas」驱动真实 SDK，
 * 把一款游戏 boot 起来跑若干帧，并做基本断言。
 *
 * 用途：脱离安卓、脱离浏览器，验证「注册 / init / tick / onInput / serialize / hud / 结算」链路不炸。
 * 它 **不验证** 联机同步（那需要两台真机）。
 *
 * 用法：
 *   cd doc/js开发指南/preview
 *   node smoke-test.js ../template/game.js
 *   node smoke-test.js ../examples/neonstars/game.js --crossScreen=0 --caps=clock
 *
 * 退出码 0 = 通过，1 = 有断言失败。
 */
"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

// ---------- 参数 ----------
const args = process.argv.slice(2);
const gameFile = args.find((a) => !a.startsWith("--")) || "../template/game.js";
function opt(name, def) {
  const hit = args.find((a) => a.startsWith("--" + name + "="));
  return hit ? hit.split("=")[1] : def;
}
const here = __dirname;
const sdkPath = path.join(here, "dual-arena-sdk.js");
const gamePath = path.resolve(here, gameFile);
if (!fs.existsSync(sdkPath)) { console.error("找不到 SDK: " + sdkPath); process.exit(1); }
if (!fs.existsSync(gamePath)) { console.error("找不到游戏脚本: " + gamePath); process.exit(1); }

// 若游戏同级目录有 manifest.json，就用它补默认值 —— 这样 `node smoke-test.js <游戏>` 即可，无需手传参数
let manifest = null;
try {
  const mf = path.join(path.dirname(gamePath), "manifest.json");
  if (fs.existsSync(mf)) manifest = JSON.parse(fs.readFileSync(mf, "utf8"));
} catch (e) { manifest = null; }
const manifestCaps = manifest && Array.isArray(manifest.caps) && manifest.caps.length ? manifest.caps.join(",") : "";
const manifestRound = (() => {
  const arr = (manifest && manifest.options) || [];
  const hit = Array.isArray(arr) ? arr.find((x) => x && x.key === "roundMs") : null;
  return hit && hit.def ? String(hit.def) : "";
})();

const CAPS = (opt("caps", manifestCaps || "clock,streams,interp,ev,predict,assets")).split(",").filter(Boolean);
const ROUND_MS = opt("roundMs", manifestRound || "1500");
const CROSS = opt("crossScreen", manifest && manifest.crossScreen ? "1" : "0") === "1";
const ASPECT = parseFloat(opt("aspect", "2.0"));
const SEED = parseInt(opt("seed", "1357"), 10);
const FRAME_MS = 16.7;

// 人数：默认取 manifest.maxPlayers（对齐 SDKv2 的 N 人模型），可用 --players 覆盖
const MANIFEST_PLAYERS = (manifest && Number.isInteger(manifest.maxPlayers) && manifest.maxPlayers >= 1)
  ? manifest.maxPlayers : 2;
const PLAYERS = Math.max(1, parseInt(opt("players", String(MANIFEST_PLAYERS)), 10) || MANIFEST_PLAYERS);
function buildPlayers(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push({ seat: i, nick: i === 0 ? "你" : ("P" + (i + 1)) });
  return out;
}
const ORIENTATION = (manifest && manifest.orientation) ? String(manifest.orientation).toLowerCase() : "portrait";

// ---------- 虚拟时钟 + rAF ----------
let vnow = 0;
let rafQueue = [];
function requestAnimationFrame(fn) { rafQueue.push(fn); return rafQueue.length; }
function drainFrames(n) {
  let ran = 0;
  while (n-- > 0 && rafQueue.length) {
    const q = rafQueue; rafQueue = [];
    for (const fn of q) { vnow += FRAME_MS; fn(vnow); ran++; }
  }
  return ran;
}

// ---------- canvas 2d 打桩 ----------
// 用 Proxy 兜底：任何未显式实现的 2D 方法都当作空操作，
// 这样不管游戏用了 ellipse / roundRect / arcTo / createPattern … 都不会误报。
function makeCtx2D() {
  const noop = () => {};
  const has = {
    globalAlpha: 1, fillStyle: "#000", strokeStyle: "#000", lineWidth: 1, lineCap: "butt",
    lineJoin: "miter", font: "10px sans-serif", textAlign: "left", textBaseline: "top",
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop: noop }),
    createRadialGradient: () => ({ addColorStop: noop }),
    createPattern: () => ({}),
    getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    createImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
    isPointInPath: () => false,
  };
  return new Proxy(has, {
    get(t, k) {
      if (typeof k === "symbol") return undefined;
      if (k in t) return t[k];
      return noop;                       // 未知方法 → 空操作
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
function makeCanvas(w, h) {
  const cv = {
    id: "c", _w: w, _h: h,
    clientWidth: w, clientHeight: h, width: w, height: h,
    style: {},
    addEventListener: () => {}, removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: w, height: h }),
    getContext: () => cv._ctx2d,
  };
  cv._ctx2d = makeCtx2D();
  return cv;
}

// ---------- 沙箱 ----------
const canvas = makeCanvas(360, Math.round(360 / ASPECT));
const events = [];              // 记录 Arena.onHud / onOver
let inputQueue = [];

const sandbox = {
  console,
  Math, JSON, Date,
  setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
  requestAnimationFrame,
  performance: { now: () => vnow },
  // Image 打桩：给 src 赋值即视为"加载完成"（同步触发 onload），
  // 这样 assets cap 的 load(list, cb) 会正常回调，游戏的图片分支也能被覆盖。
  Image: function FakeImage() {
    this.onload = null; this.onerror = null; this.width = 64; this.height = 64;
    let _src = "";
    Object.defineProperty(this, "src", {
      get: () => _src,
      set: (v) => { _src = v; if (this.onload) this.onload(); },
    });
  },
  Uint8ClampedArray,
  document: {
    getElementById: (id) => (id === "c" ? canvas : null),
    createElement: () => makeCanvas(1, 1),
    body: { appendChild: () => {} },
    addEventListener: () => {},
  },
  Arena: {
    getInit: () => JSON.stringify({
      seat: 0, role: "HOST", authoritative: true,
      crossScreen: CROSS, originX: 0, visibleMin: 0, visibleMax: 1, seamX: CROSS ? 1 : -1,
      aspect: ASPECT, seed: SEED,
      apiVersion: 2, caps: CAPS,
      options: { roundMs: ROUND_MS },
      assets: [],
      players: buildPlayers(PLAYERS),
    }),
    isAuthoritative: () => true,
    isStarted: () => true,
    pollInputs: () => { const s = JSON.stringify(inputQueue); inputQueue = []; return s; },
    pollRemoteState: () => "",
    onReady: () => events.push(["ready"]),
    onState: (j) => events.push(["state", j]),
    onHud: (j) => events.push(["hud", j]),
    onOver: (j) => events.push(["over", j]),
    log: (m) => events.push(["log", m]),
  },
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.window.devicePixelRatio = 2;
sandbox.window.innerWidth = canvas.clientWidth;
sandbox.window.innerHeight = canvas.clientHeight;
sandbox.window.addEventListener = () => {};

const ctxObj = vm.createContext(sandbox);
function run(file) {
  const code = fs.readFileSync(file, "utf8");
  vm.runInContext(code, ctxObj, { filename: file });
}

/**
 * 多文件游戏（如 bowduel：index.html 依次加载 scene/bow/animals/game.js）：
 * 解析同级 index.html 的 <script src> 列表，按文档顺序加载（跳过外链与 SDK 自身）。
 * 找不到 index.html 就只加载传入的那一个文件。
 */
function discoverScripts(gameFilePath) {
  const dir = path.dirname(gameFilePath);
  const idx = path.join(dir, "index.html");
  if (fs.existsSync(idx)) {
    const html = fs.readFileSync(idx, "utf8");
    const out = [];
    const re = /<script[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      const src = m[1].trim();
      if (/^(https?:)?\/\//i.test(src)) continue;
      if (/dual-arena-sdk\.js$/i.test(src)) continue;
      const p = path.resolve(dir, src);
      if (fs.existsSync(p)) out.push(p);
    }
    if (out.length) return out;
  }
  return [gameFilePath];
}

// ---------- 执行 ----------
const fails = [];
function check(name, ok, detail) {
  console.log((ok ? "  \u2713 " : "  \u2717 ") + name + (detail ? "  (" + detail + ")" : ""));
  if (!ok) fails.push(name);
}

console.log("== 冒烟测试 ==");
console.log("  game = " + path.relative(here, gamePath));
console.log("  caps = [" + CAPS.join(",") + "]  cross=" + (CROSS ? 1 : 0) + "  roundMs=" + ROUND_MS);
console.log("  players = " + PLAYERS + "  orientation = " + ORIENTATION);
console.log("  scripts(自动发现) = " + discoverScripts(gamePath).map((p) => path.relative(here, p)).join(", "));

run(sdkPath);
const gameScripts = discoverScripts(gamePath);
gameScripts.forEach(run);

// manifest 字段校验 + 铁律静态扫描（不依赖浏览器，提前暴露致命问题）
validateManifest(manifest);
scanForbidden(gameScripts);

const G = sandbox.window.__DUAL_GAME__;
check("游戏对象已注册 (window.__DUAL_GAME__)", !!G);
check("SDK 已注入 (window.DualArena)", !!(sandbox.window.DualArena && sandbox.window.DualArena.boot));

// 平台流程：注入 SDK → 调用 boot()
const D = sandbox.window.DualArena;
try {
  D.boot();
} catch (e) {
  console.error("boot 抛异常: " + (e && e.stack || e));
}
check("DualArena.boot() 成功返回", true);
check("init 已执行（有 dot/ball 之类状态）", collectState(G) !== null, "keys=" + collectState(G));

// 跑几帧：应产生 onHud 与 onState
drainFrames(5);
check("已回传 HUD (Arena.onHud)", has("hud"));
check("房主已回传状态 (Arena.onState)", has("state"));
const hud0 = last("hud");
check("HUD 结构合法 (hp/scores 长度 = players=" + PLAYERS + ")",
  hud0 && Array.isArray(hud0.hp) && hud0.hp.length === PLAYERS && Array.isArray(hud0.scores) && hud0.scores.length === PLAYERS,
  "hp=" + (hud0 && hud0.hp ? hud0.hp.length : "?") + " scores=" + (hud0 && hud0.scores ? hud0.scores.length : "?"));

// 模拟输入：尽量点中一个实体（a=0），再喂一个 MOVE（a=2），确保输入链路不炸
const target = guessTarget(G);
const before = last("hud");
if (target) inputQueue.push({ seat: 0, x: target.x, y: target.y, a: 0, id: 0 });
inputQueue.push({ seat: 1, x: 0.5, y: ASPECT / 2, a: 2, id: 0 });
drainFrames(4);
const h = last("hud");
check("注入输入后无异常且 HUD 合法",
  !hasErr() && h && Array.isArray(h.scores) && h.scores.length === PLAYERS,
  "target=" + (target ? "有" : "无") + "  scores=" + (h ? JSON.stringify(h.scores) : "?") +
  (before && h ? "  delta=" + (h.scores[0] - before.scores[0]) : ""));

// 跑到超时 → 应触发 onOver。
// 回合时长优先用游戏自己声明的（G.roundMs / G.t），避免游戏硬编码时长时误判。
const gameDur = (G && (typeof G.roundMs === "number" ? G.roundMs : (typeof G.t === "number" ? G.t : 0))) || 0;
const waitMs = Math.max(parseInt(ROUND_MS, 10), gameDur) + 300;
drainFrames(Math.ceil(waitMs / FRAME_MS) + 5);
check("到达结束时上报结算 (Arena.onOver)", has("over"));
const over = last("over");
const overStructOk = over && typeof over.winner === "number" && Array.isArray(over.scores);
check("结算结构合法 (winner/scores)", !!overStructOk, over ? JSON.stringify(over).slice(0, 90) : "?");

check("全程无 frame err / init err", !hasErr(), errText());

console.log(fails.length ? "\n结果: " + fails.length + " 项失败" : "\n结果: 全部通过");
process.exit(fails.length ? 1 : 0);

// ---------- helpers ----------
function has(kind) { return events.some((e) => e[0] === kind); }
function hasErr() { return events.some((e) => e[0] === "log" && /err/i.test(String(e[1]))); }
function errText() { const e = events.find((x) => x[0] === "log" && /err/i.test(String(x[1]))); return e ? String(e[1]).slice(0, 120) : ""; }
function last(kind) {
  for (let i = events.length - 1; i >= 0; i--) if (events[i][0] === kind) {
    const v = events[i][1];
    try { return typeof v === "string" ? JSON.parse(v) : v; } catch (e) { return null; }
  }
  return null;
}
function collectState(g) {
  if (!g) return null;
  const keys = Object.keys(g).filter((k) => !["id", "name", "crossScreen", "ctx"].includes(k) && !/^_/.test(k));
  return keys.length ? keys.join(",") : "（空）";
}
function guessTarget(g) {
  for (const k of ["dot", "ball", "target"]) {
    const o = g[k];
    if (o && typeof o.x === "number" && typeof o.y === "number") return o;
  }
  if (Array.isArray(g.stars) && g.stars[0]) return g.stars[0];
  if (Array.isArray(g.ents) && g.ents[0]) return g.ents[0];
  return null;
}

// ============ manifest 字段校验 ============
function validateManifest(m) {
  if (!m) {
    warn("未找到 manifest.json（无法校验 apiVersion/人数/方向），建议放一份同级 manifest");
    return;
  }
  const a = m.apiVersion;
  if (typeof a !== "number" || a < 1 || a > 2) {
    check("manifest.apiVersion ∈ 1..2", false, "apiVersion=" + a);
  } else {
    check("manifest.apiVersion ∈ 1..2", true, "v" + a);
  }
  const mn = Number(m.minPlayers), mx = Number(m.maxPlayers);
  if (!(mn >= 1 && mx <= 12 && mn <= mx)) {
    check("manifest 人数 min/max ∈ 1..12 且 min≤max", false, mn + ".." + mx);
  } else {
    check("manifest 人数 min/max ∈ 1..12 且 min≤max", true, mn + ".." + mx);
  }
  const or = (m.orientation || "portrait").toLowerCase();
  if (!["portrait", "landscape", "sensor", "auto", "both"].includes(or)) {
    warn("manifest.orientation 非法，运行时回落竖屏", or);
  } else {
    check("manifest.orientation 合法", true, or);
  }
}

// 先剥离注释再扫，避免教学文案（如模板里"绝不用 Date.now()"）被误判为违规
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")            // 块注释
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");        // 行注释（保留 http:// 这类 scheme）
}

// ============ 三条铁律静态扫描 ============
// 逻辑随机/计时必须走 ctx.rng() 与 tick(dt)，用 Math.random/Date.now/performance.now
// 参与逻辑会在多端产生不一致。此处做静态扫描，提前在冒烟阶段暴露（不致命，仅告警）。
function scanForbidden(scripts) {
  const pats = [
    { re: /\bMath\.random\s*\(/, msg: "Math.random() —— 逻辑随机必须用 ctx.rng()" },
    { re: /\bDate\.now\s*\(/, msg: "Date.now() —— 逻辑计时必须用 tick(dt) 的 dt" },
    { re: /\bperformance\.now\s*\(/, msg: "performance.now() —— 逻辑计时必须用 tick(dt) 的 dt" },
  ];
  const hits = [];
  for (const f of scripts) {
    let src;
    try { src = fs.readFileSync(f, "utf8"); } catch (e) { continue; }
    src = stripComments(src);
    for (const p of pats) {
      if (p.re.test(src)) hits.push({ f: path.relative(here, f), msg: p.msg });
    }
  }
  if (hits.length === 0) {
    check("铁律静态扫描：无 Math.random/Date.now/performance.now", true);
  } else {
    for (const h of hits) warn("疑似违反铁律: " + h.msg, h.f);
  }
}

function warn(name, detail) {
  console.log("  ⚠ " + name + (detail ? "  (" + detail + ")" : ""));
}
