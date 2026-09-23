/**
 * 双屏竞技场 · Web 游戏互联 SDK v2
 * （由平台注入到每个 Web 游戏页面，作者不要自己引入）
 *
 * ============================ 一句话定位 ============================
 * 本 SDK **只负责"互联"**：生命周期、世界坐标、房主权威、输入/快照收发、开始闸门。
 * **玩法一律由游戏自己实现** —— 需要新能力时按 §"能力模块"注册一个 cap，
 * 老游戏因为没声明该 cap 完全不受影响，所以「每加一款游戏就要改一次 SDK」在结构上不会发生。
 *
 * ============================ 两层结构 ============================
 *  1）互联内核（永远存在，不随游戏变）
 *     - 世界坐标映射、房主权威分流、开始闸门、输入/状态收发、结算上报。
 *  2）能力模块（caps，按 manifest 声明装配）
 *     clock   固定步长逻辑（与帧率解耦）
 *     streams 命名确定性随机流 ctx.rng("animals")
 *     interp  通用 id 键插值（取代每个游戏手写补间）
 *     ev      房主→客人一次性事件通道（搭在快照里下发）
 *     predict 本地指针 + 本地预测实体 + 对账（客人端零延迟手感）
 *     assets  通用素材加载器（缺失返回 null，游戏可回落矢量绘制）
 *
 * 新能力用 DualArena.defineCap(name, factory) 注册，**不必改本文件**
 * （作者在自己包里注册也算数，见 doc/07-SDKv2互联协议与扩展机制.md）。
 *
 * ============================ 核心约定（务必遵守） ============================
 *  - 坐标一律【世界坐标】：mirror 模式两端都是 x∈[0,1]；split 模式本机可见 x∈[originX, originX+1]，
 *    世界总宽恒为 2（接缝 seamX=1）；y ∈ [0, aspect]。
 *  - tick 里只推进逻辑，禁止用 Date.now()/performance.now() 做判定（两端不同步）。
 *  - 随机一律用 ctx.rng()（或命名流 ctx.rng("xxx")），禁止 Math.random() 参与逻辑。
 *  - 【开始闸门】平台播完「准备/1/开始」倒计时后 Arena.isStarted() 才为真，
 *    在此之前内核不调 tick/onInput、不判结算。
 *
 * 生命周期：init(ctx) →（倒计时）→ onStart(ctx) → 每帧 tick/onInput（仅房主）→ isFinished()/result()
 * 调试：DualArena.log("msg") → Android logcat（tag=duizhan）
 */
(function () {
  "use strict";
  var D = (window.DualArena = {});
  D.VERSION = 2;
  D._game = null;
  D.registerGame = function (g) { D._game = g; };

  // 未捕获异常也上报到 logcat，真机排障时不必连 Chrome DevTools
  window.addEventListener("error", function (e) {
    try { if (D.log) D.log("JS ERROR: " + (e && e.message) + " @" + (e && e.filename) + ":" + (e && e.lineno)); } catch (x) {}
  });
  window.addEventListener("unhandledrejection", function (e) {
    try { if (D.log) D.log("JS REJECT: " + (e && e.reason)); } catch (x) {}
  });

  /** 打到原生 logcat 的调试日志（页面 console 在真机上看不到） */
  D.log = function (m) {
    try { if (typeof Arena !== "undefined" && Arena.log) Arena.log(String(m)); } catch (e) {}
  };

  /** 简单可复现 PRNG（mulberry32），保证房主/客人用同一种子得到同一串随机 */
  D.makeRng = function (seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  function hashStr(s) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  // ==================================================================
  // 能力模块注册表（caps）
  // ==================================================================
  var CAPS = {};

  /**
   * 注册一个能力模块。factory(ctx, D) 返回该模块对外 API，挂到 D[name] 上。
   * 任何人（平台或游戏作者）都能调它扩展 SDK，而不必修改本文件。
   */
  D.defineCap = function (name, factory) { CAPS[name] = factory; };

  // ---- cap: clock 固定步长 ----
  D.defineCap("clock", function () {
    return { step: 1000 / 60, maxCatchUp: 5 };
  });

  // ---- cap: streams 命名确定性随机流 ----
  D.defineCap("streams", function (ctx) {
    var made = {};
    return {
      /** 取（或惰性创建）一条命名随机流；同名同种子 → 两端完全一致 */
      stream: function (name) {
        if (!made[name]) made[name] = D.makeRng((ctx.seed ^ hashStr(name)) >>> 0);
        return made[name];
      }
    };
  });

  // ---- cap: interp 通用插值 ----
  D.defineCap("interp", function () {
    /**
     * 把权威列表并入本地列表：按 key 匹配，命中则记下目标值（__t）并沿用当前值，
     * 未命中则新建；权威里没有的直接丢弃。
     * opts: { key:'id', lerp:['x','y'], snap:0.25 }  snap=跳变阈值，超过直接落点
     */
    function merge(cur, inc, opts) {
      opts = opts || {};
      var key = opts.key || "id";
      var lerp = opts.lerp || ["x", "y"];
      var snap = opts.snap == null ? 0.25 : opts.snap;
      var out = [];
      for (var i = 0; i < inc.length; i++) {
        var it = inc[i];
        var old = null;
        for (var j = 0; j < cur.length; j++) { if (cur[j][key] === it[key]) { old = cur[j]; break; } }
        if (!old) { out.push(it); continue; }
        it.__t = {};
        for (var k = 0; k < lerp.length; k++) {
          var f = lerp[k];
          var from = (old[f] == null) ? it[f] : old[f];
          var to = it[f];
          if (to == null) continue;
          // 跳变（重生/传送）直接落点，不要补间出一条横穿全屏的假轨迹
          if (Math.abs(to - from) > snap) from = to;
          it[f] = from;
          it.__t[f] = to;
        }
        out.push(it);
      }
      return out;
    }
    /** 每帧逼近目标值。与帧率无关的指数逼近（30/60/120fps 收敛速度一致） */
    function step(list, dt, opts) {
      var lerp = (opts && opts.lerp) || ["x", "y"];
      var k = 1 - Math.exp(-dt / 45);
      for (var i = 0; i < list.length; i++) {
        var o = list[i];
        if (!o || !o.__t) continue;
        for (var j = 0; j < lerp.length; j++) {
          var f = lerp[j];
          if (o.__t[f] == null) continue;
          o[f] += (o.__t[f] - o[f]) * k;
        }
      }
    }
    return { merge: merge, step: step };
  });

  // ---- cap: ev 事件通道（房主→客人，搭在快照里下发）----
  D.defineCap("ev", function () {
    var handlers = {};
    var out = [];
    function deliver(list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i][0], data = list[i][1];
        var hs = handlers[t];
        if (!hs) continue;
        for (var j = 0; j < hs.length; j++) {
          try { hs[j](data); } catch (e) { D.log("ev handler err " + t + ": " + e); }
        }
      }
    }
    return {
      /** 房主调用：本地立刻触发一次（保证两端渲染一致），同时排队随快照下发 */
      emit: function (type, data) {
        deliver([[type, data]]);
        out.push([type, data]);
        if (out.length > 64) out.shift();   // 上限保护，别让快照无限涨
      },
      /** 两端都可订阅（房主本地即时触发，客人随快照到达时触发） */
      on: function (type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
      /** 内核用：取走待发事件 */
      _drain: function () { var a = out; out = []; return a; },
      /** 内核用：投递收到的事件 */
      _deliver: deliver,
      _pending: function () { return out.length; }
    };
  });

  // ---- cap: predict 本地指针 + 本地预测实体 ----
  D.defineCap("predict", function (ctx) {
    var tags = {};
    var p = { active: false, id: 0, x: 0, y: 0, sx: 0, sy: 0, phase: null, t: 0 };
    var listeners = [];

    function toWorld(cx, cy) { return ctx.toWorld(cx, cy); }
    function fire(phase, cx, cy) {
      var w = toWorld(cx, cy);
      p.x = w.x; p.y = w.y; p.phase = phase; p.t = performance.now();
      if (phase === "down") { p.active = true; p.sx = w.x; p.sy = w.y; p.id++; }
      if (phase === "up" || phase === "cancel") p.active = false;
      for (var i = 0; i < listeners.length; i++) {
        try { listeners[i](p, phase); } catch (e) { D.log("pointer err: " + e); }
      }
    }
    // 客人端的手感全靠这条本地链路：DOM 事件当帧就能拿到，不用等一个 RTT。
    // 用 PointerEvent 统一鼠标/触摸，桌面预览（preview.html）也能直接玩。
    function attach(el) {
      if (!el) return;
      var down = false;
      el.addEventListener("pointerdown", function (e) { down = true; fire("down", e.clientX, e.clientY); });
      el.addEventListener("pointermove", function (e) { if (down) fire("move", e.clientX, e.clientY); });
      el.addEventListener("pointerup", function (e) { if (down) { down = false; fire("up", e.clientX, e.clientY); } });
      el.addEventListener("pointercancel", function (e) { down = false; fire("cancel", e.clientX, e.clientY); });
      // 老 WebView 没有 PointerEvent 时退回 touch
      if (typeof window.PointerEvent === "undefined") {
        el.addEventListener("touchstart", function (e) { var t = e.changedTouches[0]; fire("down", t.clientX, t.clientY); });
        el.addEventListener("touchmove", function (e) { var t = e.changedTouches[0]; fire("move", t.clientX, t.clientY); });
        el.addEventListener("touchend", function (e) { var t = e.changedTouches[0]; fire("up", t.clientX, t.clientY); });
        el.addEventListener("touchcancel", function (e) { fire("cancel", 0, 0); });
      }
    }

    return {
      _attach: attach,
      /** 本地指针状态（世界坐标，即时更新，不经过网络） */
      pointer: p,
      onPointer: function (fn) { listeners.push(fn); },
      /** 生成本地预测实体（仅本机可见，用于"射出去那一下"的即时反馈） */
      spawn: function (tag, obj) { (tags[tag] = tags[tag] || []).push(obj); return obj; },
      list: function (tag) { return tags[tag] || (tags[tag] = []); },
      /** 权威侧已确认前 n 个，按 FIFO 丢掉最早的 n 个本地预测 */
      ack: function (tag, n) {
        var l = tags[tag]; if (!l) return;
        for (var i = 0; i < n && l.length; i++) l.shift();
      },
      clear: function (tag) { tags[tag] = []; }
    };
  });

  // ---- cap: assets 素材加载器 ----
  D.defineCap("assets", function (ctx) {
    var map = {};
    var ok = false;
    return {
      /**
       * 加载相对路径素材。缺失（或 file 域被拦）一律返回 null，
       * 游戏必须能在 null 时回落到矢量绘制 —— 保证"没素材也能跑"。
       */
      load: function (list, cb) {
        var n = list && list.length ? list.length : 0;
        if (!n) { ok = true; cb && cb(map); return map; }
        for (var i = 0; i < list.length; i++) (function (u) {
          var img = new Image();
          img.onload = function () { map[u] = img; if (--n === 0) { ok = true; cb && cb(map); } };
          img.onerror = function () { map[u] = null; if (--n === 0) { ok = true; cb && cb(map); } };
          img.src = u;
        })(list[i]);
        return map;
      },
      get: function (u) { return map[u] || null; },
      isReady: function () { return ok; }
    };
  });

  // ==================================================================
  // 互联内核
  // ==================================================================
  D.boot = function () {
    var g = D._game || window.__DUAL_GAME__;
    if (!g) { console.log("[dual-arena] no game registered"); return; }
    if (typeof Arena === "undefined") { console.log("[dual-arena] Arena bridge missing"); return; }

    var init = JSON.parse(Arena.getInit());
    var cross = !!init.crossScreen;
    var originX = init.originX || 0;
    var aspect = init.aspect || 1.6;

    // apiVersion：1 = 旧内核行为（可变 dt / 裸状态 / 无 caps），>=2 = 启用 caps 装配
    var api = init.apiVersion || 1;
    var caps = init.caps || [];
    D.apiVersion = api;
    D.caps = caps;
    D.cap = function (n) { return caps.indexOf(n) >= 0; };

    // 画布：填满 WebView，按 DPR 放大分辨率
    var cv = document.getElementById("c");
    if (!cv) { cv = document.createElement("canvas"); cv.id = "c"; document.body.appendChild(cv); }
    var dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    function resize() {
      var w = cv.clientWidth || window.innerWidth;
      var h = cv.clientHeight || window.innerHeight;
      cv.width = Math.max(1, Math.floor(w * dpr));
      cv.height = Math.max(1, Math.floor(h * dpr));
    }
    resize();
    window.addEventListener("resize", resize);

    // 世界坐标 ↔ 画布像素
    var ctx = {
      init: init,
      seed: init.seed || 1,
      seat: init.seat || 0,
      otherSeat: 1 - (init.seat || 0),
      role: init.role || "GUEST",
      authoritative: !!init.authoritative,
      crossScreen: cross,
      aspect: aspect,
      apiVersion: api,
      caps: caps,
      /** 房主在游戏卡片上配置的游戏选项（如回合时长），两端一致 */
      options: init.options || {},
      /** manifest 声明的素材清单（相对路径） */
      assets: init.assets || [],
      players: init.players || [{ seat: 0, nick: "P0" }, { seat: 1, nick: "P1" }],
      canvasW: 0, canvasH: 0,
      /** 上一帧到这一帧的毫秒数（渲染用，逻辑判定请用 tick 的 dt） */
      dt: 16,
      x: function (wx) { return (wx - (cross ? originX : 0)) * cv.width; },
      y: function (wy) { return (wy / aspect) * cv.height; },
      unitPx: cv.width,
      visible: function (wx, wy, r) {
        var minX = cross ? originX : 0, maxX = cross ? originX + 1 : 1;
        return wx + r >= minX && wx - r <= maxX && wy + r >= 0 && wy - r <= aspect;
      },
      toWorld: function (px, py) {
        var w = cv.clientWidth || window.innerWidth;
        var h = cv.clientHeight || window.innerHeight;
        var wx = (cross ? originX : 0) + (px / w);
        var wy = (py / h) * aspect;
        return { x: wx, y: wy };
      }
    };

    // 命名随机流：ctx.rng() 默认流；ctx.rng("animals") 命名流（两端同种子同顺序）
    var defaultRng = D.makeRng(ctx.seed || 1);
    var named = {};
    ctx.rng = function (name) {
      if (!name) return defaultRng();
      if (!named[name]) named[name] = D.makeRng(((ctx.seed ^ hashStr(name)) >>> 0) || 1);
      return named[name]();
    };
    ctx.rng.stream = function (name) {
      if (!named[name]) named[name] = D.makeRng(((ctx.seed ^ hashStr(name)) >>> 0) || 1);
      return named[name];
    };
    function syncCtx() { ctx.canvasW = cv.width; ctx.canvasH = cv.height; ctx.unitPx = cv.width; }
    syncCtx();

    // ---- 装配 caps ----
    for (var ci = 0; ci < caps.length; ci++) {
      var cname = caps[ci], fac = CAPS[cname];
      if (!fac) { D.log("unknown cap: " + cname); continue; }
      try { D[cname] = fac(ctx, D) || {}; } catch (e) { D.log("cap install err " + cname + ": " + e); D[cname] = {}; }
    }
    var useEv = api >= 2 && caps.indexOf("ev") >= 0 && D.ev;
    var clock = (api >= 2 && caps.indexOf("clock") >= 0 && D.clock) ? D.clock : null;
    var STEP = clock ? clock.step : 0;
    if (caps.indexOf("predict") >= 0 && D.predict && D.predict._attach) D.predict._attach(cv);

    var c = cv.getContext("2d");
    if (g.init) { try { g.init(ctx); } catch (e) { D.log("init err: " + e); } }
    Arena.onReady();
    D.log("boot ok v" + api + " seat=" + ctx.seat + " auth=" + ctx.authoritative + " aspect=" + aspect
      + " cross=" + cross + " caps=[" + caps.join(",") + "] css=" + cv.clientWidth + "x" + cv.clientHeight
      + " px=" + cv.width + "x" + cv.height + " dpr=" + dpr);

    var last = performance.now();
    var signaled = false;   // onStart 是否已触发
    var overSent = false;   // 结算是否已上报
    var lastStateMs = 0;    // 状态回传节流
    var acc = 0;            // 固定步长累加器

    function sendState() {
      var st = g.serialize ? g.serialize() : (g.state ? g.state() : null);
      if (st == null) return;
      var payload = (typeof st === "string") ? st : JSON.stringify(st);
      if (useEv) {
        var evs = D.ev._drain();
        // 事件搭在状态载荷里下发：零原生改动，且与快照天然同序
        if (evs.length) payload = JSON.stringify({ __v: 2, s: st, e: evs });
      }
      Arena.onState(payload);
    }

    function recvState(obj) {
      if (obj && obj.__v === 2) {
        if (obj.e && obj.e.length && useEv) D.ev._deliver(obj.e);
        obj = obj.s;
        if (typeof obj === "string") { try { obj = JSON.parse(obj); } catch (e) { return; } }
      }
      if (g.applyState) { try { g.applyState(obj); } catch (e) { D.log("applyState err: " + e); } }
    }

    function frame(now) {
      var dt = now - last; last = now;
      if (dt > 120) dt = 120; // 卡顿夹紧，避免一帧推进太多
      syncCtx();
      ctx.dt = dt;

      try {
        // 【开始闸门】倒计时结束前 live=false：只渲染、不推进逻辑、不接受输入
        var live = (typeof Arena.isStarted === "function") ? Arena.isStarted() : true;
        if (live && !signaled) {
          signaled = true;
          if (g.onStart) { try { g.onStart(ctx); } catch (e) { D.log("onStart err: " + e); } }
        }

        if (ctx.authoritative) {
          if (live) {
            var ins = JSON.parse(Arena.pollInputs() || "[]");
            for (var i = 0; i < ins.length; i++) {
              if (g.onInput) g.onInput(ins[i].seat, ins[i].x, ins[i].y, ins[i].a, ins[i].id);
            }
            if (g.tick) {
              if (clock) {
                acc += dt;
                var n = 0, maxN = clock.maxCatchUp || 5;
                while (acc >= STEP && n < maxN) { g.tick(STEP); acc -= STEP; n++; }
                if (acc > STEP * maxN) acc = 0; // 长时间卡顿后不要疯狂追帧
              } else {
                g.tick(dt);                     // v1 行为：可变步长
              }
            }
          }
          // 状态回传节流到 ~30Hz：按渲染帧(60Hz)反复 JSON 序列化再跨桥回传是纯浪费
          if (now - lastStateMs >= 30) { lastStateMs = now; sendState(); }
        } else {
          var rs = Arena.pollRemoteState();
          if (rs && rs.length > 1) { try { recvState(JSON.parse(rs)); } catch (e) { D.log("state parse err: " + e); } }
        }

        if (g.render) g.render(now, ctx, c);
        if (g.hud) { var h = g.hud(); if (h) Arena.onHud(JSON.stringify(h)); }
        if (live && !overSent && g.isFinished && g.isFinished() && g.result) {
          overSent = true;
          Arena.onOver(JSON.stringify(g.result()));
        }
      } catch (e) {
        D.log("frame err: " + e);
      }
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  };

  // 兼容：页面 <script> 早于 SDK 注入时，作者直接 window.__DUAL_GAME__ = {...}
  window.__DUAL_GAME__ = window.__DUAL_GAME__ || null;
})();

/*
 * ===================== 最小模板（v2） =====================
 * index.html 里这么写即可（平台会自动注入本 SDK 并调用 boot）：
 *
 * <canvas id="c" style="position:fixed;inset:0;width:100%;height:100%;background:#05070f"></canvas>
 * <script>
 * window.__DUAL_GAME__ = {
 *   id: "demo", name: "示例", crossScreen: false,
 *   init:      function (ctx) { this.ball = { x: 0.5, y: ctx.aspect / 2, vx: 0.4 }; },
 *   onStart:   function (ctx) { },
 *   tick:      function (dt)  { this.ball.x += this.ball.vx * dt / 1000; },  // 仅房主
 *   serialize: function ()    { return { bx: this.ball.x, by: this.ball.y }; },
 *   applyState:function (s)   { this.ball.x = s.bx; this.ball.y = s.by; },
 *   onInput:   function (seat, x, y, a, id) { },   // 世界坐标；a=动作码；id=指针 id
 *   render:    function (t, ctx, c) {
 *     var px = ctx.x(this.ball.x), py = ctx.y(this.ball.y);
 *     c.fillStyle = "#4ff"; c.beginPath(); c.arc(px, py, ctx.unitPx * 0.03, 0, 7); c.fill();
 *   },
 *   hud:       function () { return { hp: [1, 1], scores: [0, 0], tip: "拖动控制" }; },
 *   isFinished:function () { return false; },
 *   result:    function () { return { winner: -1, scores: [0, 0], summary: "", stats: [] }; }
 * };
 * </script>
 *
 * manifest.json 里声明要用的能力（没声明的能力不会启用，老游戏零影响）：
 *   { "apiVersion": 2, "caps": ["ev","interp","predict","assets","streams","clock"], ... }
 */
