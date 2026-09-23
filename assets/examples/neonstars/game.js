/*
 * 霓虹星星 v2（neonstars）—— 镜像同屏·连击抢星大作战
 *
 * 玩法：40 秒内两人抢同一片星空里的星星。点中即得分，连续命中会累积连击与倍率；
 *       金色星 3 分；误点炸弹扣 2 分并清空连击；吃到冰冻星可冻结对手 1.6 秒。
 *
 * 规则要点：
 *  - 时间越往后弹速越快、炸弹越多 —— 后半程更刺激，翻盘全靠几次高倍连击。
 *  - 连击倍率 = 1 + floor(连击/3)，最高 x5；2.6 秒不中即断连。
 *
 * 架构（严格遵守平台 SDK 约定，见 doc/JS游戏开发规范.md）：
 *  - 坐标全用「世界坐标」：x∈[0,1]，y∈[0,aspect]；平台映射到各自画布，作者不碰像素。
 *  - 逻辑只在房主端（authoritative）跑：tick / onInput 改状态；客人端只 applyState 渲染。
 *  - 随机一律用 ctx.rng()（平台 seed 驱动的可复现 PRNG），绝不用 Math.random()。
 *  - 计时一律用 tick 的 dt，不用 Date.now()。
 */
(function () {
  "use strict";

  // ===== 调参 =====
  var ROUND_MS = 40000;     // 一局时长
  var TAP_R = 0.055;        // 点击额外命中半径（世界单位）
  var COMBO_WINDOW = 2600;  // 连击保持窗口(ms)
  var FREEZE_MS = 1600;     // 冰冻时长(ms)
  var BASE_COUNT = 7;       // 场上基础实体数
  var MAX_FX = 48;          // 特效上限
  var FX_SYNC_MAX = 14;     // 同步给对端的特效上限（特效纯视觉，少发点能显著减小快照体积）

  var T = { STAR: 0, GOLD: 1, BOMB: 2, FREEZE: 3 };
  var K = { HIT: 0, PARTICLE: 1 };           // 特效种类（序列化用下标）
  var COL = ["#39e6ff", "#ff5ec4", "#ffd23f", "#ff4d5e", "#8ff0ff", "#ffffff"]; // 特效配色下标
  var CI = { P0: 0, P1: 1, GOLD: 2, BOMB: 3, FREEZE: 4, WHITE: 5 };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function rr(rng, a, b) { return a + rng() * (b - a); }
  // 难度系数：开局 0，结束 1
  function ramp(t) { return clamp(1 - t / ROUND_MS, 0, 1); }

  function pickType(rng, r) {
    var bomb = 0.09 + r * 0.15;      // 炸弹随时间变多
    var gold = 0.14;
    var freeze = 0.04 + r * 0.03;
    var u = rng();
    if (u < bomb) return T.BOMB;
    if (u < bomb + gold) return T.GOLD;
    if (u < bomb + gold + freeze) return T.FREEZE;
    return T.STAR;
  }

  function newEnt(ctx, r) {
    var type = pickType(ctx.rng, r);
    var rad = type === T.GOLD ? 0.048
      : type === T.FREEZE ? 0.044
        : type === T.BOMB ? 0.046
          : rr(ctx.rng, 0.030, 0.044);
    var spd = (0.085 + r * 0.13) * (type === T.GOLD ? 1.4 : 1);
    var ang = ctx.rng() * Math.PI * 2;
    return {
      x: rr(ctx.rng, 0.12, 0.88),
      y: rr(ctx.rng, 0.16, 0.84) * ctx.aspect,
      vx: Math.cos(ang) * spd,
      vy: Math.sin(ang) * spd,
      r: rad, t: type,
      hue: 170 + ctx.rng() * 170,
      life: type === T.GOLD ? rr(ctx.rng, 3600, 5200)
        : type === T.FREEZE ? rr(ctx.rng, 4800, 6500) : 0
    };
  }

  var G = {
    id: "neonstars",
    name: "霓虹星星",
    crossScreen: false,

    init: function (ctx) {
      this.ctx = ctx;
      this.t = ROUND_MS;
      this.score = [0, 0];
      this.combo = [0, 0];
      this.comboT = [0, 0];
      this.frozen = [0, 0];
      this.maxCombo = [0, 0];
      this.stars = [];
      for (var i = 0; i < BASE_COUNT; i++) this.stars.push(newEnt(ctx, 0));
      this.fx = [];
      this.shake = 0;
      this._rn = 0;
      DualArena.log("neonstars v2 init, seat=" + ctx.seat + " auth=" + ctx.authoritative);
    },

    onStart: function (ctx) {
      this.shake = 0;
      DualArena.log("neonstars v2 onStart seat=" + ctx.seat + " auth=" + ctx.authoritative);
    },

    /**
     * 廉价光晕：用两层半透明大圆代替 canvas 的 shadowBlur。
     * shadowBlur 在移动端 WebView 里极其昂贵（每个实体都要做一次高斯模糊），
     * 7 个实体 + 粒子一起画会直接把帧率砍到 20~30fps，画面就会"不流畅"。
     */
    glow: function (c, px, py, pr, col, alpha) {
      c.globalAlpha = alpha * 0.15;
      c.fillStyle = col;
      c.beginPath(); c.arc(px, py, pr * 2.1, 0, Math.PI * 2); c.fill();
      c.globalAlpha = alpha * 0.20;
      c.beginPath(); c.arc(px, py, pr * 1.5, 0, Math.PI * 2); c.fill();
      c.globalAlpha = alpha;
    },

    // ---- 特效 ----
    addFx: function (kind, x, y, ci, txt, life) {
      this.fx.push({ k: kind, x: x, y: y, ci: ci, txt: txt || "", age: 0, life: life || 650, vx: 0, vy: 0 });
      if (this.fx.length > MAX_FX) this.fx.shift();
    },
    burst: function (x, y, ci, n) {
      for (var q = 0; q < n; q++) {
        var ang = this.ctx.rng() * Math.PI * 2;
        var sp = 0.10 + this.ctx.rng() * 0.24;
        this.fx.push({
          k: K.PARTICLE, x: x, y: y, ci: ci, txt: "", age: 0, life: 620,
          vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp
        });
      }
      if (this.fx.length > MAX_FX) this.fx.splice(0, this.fx.length - MAX_FX);
    },

    // ---- 逻辑（仅房主） ----
    tick: function (dt) {
      var ctx = this.ctx, asp = ctx.aspect, r = ramp(this.t), i;
      this.t -= dt;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);

      for (var s = 0; s < 2; s++) {
        if (this.comboT[s] > 0) {
          this.comboT[s] -= dt;
          if (this.comboT[s] <= 0) { this.comboT[s] = 0; this.combo[s] = 0; }
        }
        if (this.frozen[s] > 0) this.frozen[s] = Math.max(0, this.frozen[s] - dt);
      }

      for (i = 0; i < this.stars.length; i++) {
        var e = this.stars[i];
        e.x += e.vx * dt / 1000;
        e.y += e.vy * dt / 1000;
        if (e.x < e.r) { e.x = e.r; e.vx = Math.abs(e.vx); }
        if (e.x > 1 - e.r) { e.x = 1 - e.r; e.vx = -Math.abs(e.vx); }
        if (e.y < e.r) { e.y = e.r; e.vy = Math.abs(e.vy); }
        if (e.y > asp - e.r) { e.y = asp - e.r; e.vy = -Math.abs(e.vy); }
        if (e.life > 0) {
          e.life -= dt;
          if (e.life <= 0) this.stars[i] = newEnt(ctx, r);
        }
      }
      while (this.stars.length < BASE_COUNT) this.stars.push(newEnt(ctx, r));
      if (this.stars.length > BASE_COUNT + 2) this.stars.length = BASE_COUNT + 2;

      // 偶发「金星光临」
      if (ctx.rng() < (dt / 1000) * 0.35) {
        var idx = Math.floor(ctx.rng() * this.stars.length);
        var ne = newEnt(ctx, r);
        ne.t = T.GOLD; ne.r = 0.05; ne.life = 4200;
        this.stars[idx] = ne;
      }

      for (var k = this.fx.length - 1; k >= 0; k--) {
        var f = this.fx[k];
        f.age += dt;
        if (f.k === K.PARTICLE) { f.x += f.vx * dt / 1000; f.y += f.vy * dt / 1000; }
        if (f.age >= f.life) this.fx.splice(k, 1);
      }
    },

    /** 房主收到某座位的一次触摸（按下 a=0）。世界坐标。 */
    onInput: function (seat, x, y, a) {
      if (a !== 0) return;
      if (this.frozen[seat] > 0) { this.addFx(K.HIT, x, y, CI.FREEZE, "", 300); return; }
      for (var i = 0; i < this.stars.length; i++) {
        var e = this.stars[i];
        var dx = x - e.x, dy = y - e.y, hit = e.r + TAP_R;
        if (dx * dx + dy * dy > hit * hit) continue;

        if (e.t === T.BOMB) {
          this.score[seat] = Math.max(0, this.score[seat] - 2);
          this.combo[seat] = 0; this.comboT[seat] = 0;
          this.shake = 260;
          this.addFx(K.HIT, e.x, e.y, CI.BOMB, "-2", 760);
          this.burst(e.x, e.y, CI.BOMB, 14);
        } else if (e.t === T.FREEZE) {
          // 冰冻是【陷阱】：只冻住点到它的那个人，绝不影响对手，
          // 所以谁手快点了它，谁自己吃亏（和炸弹一样属于风险点）。
          this.frozen[seat] = FREEZE_MS;
          this.addFx(K.HIT, e.x, e.y, CI.FREEZE, "中招!", 900);
          this.burst(e.x, e.y, CI.FREEZE, 12);
        } else {
          this.combo[seat]++;
          this.comboT[seat] = COMBO_WINDOW;
          if (this.combo[seat] > this.maxCombo[seat]) this.maxCombo[seat] = this.combo[seat];
          var mult = 1 + Math.min(4, Math.floor(this.combo[seat] / 3));
          var base = e.t === T.GOLD ? 3 : 1;
          var gain = base * mult;
          this.score[seat] += gain;
          var gold = e.t === T.GOLD;
          this.addFx(K.HIT, e.x, e.y, gold ? CI.GOLD : (seat === 0 ? CI.P0 : CI.P1), "+" + gain, 760);
          this.burst(e.x, e.y, gold ? CI.GOLD : (seat === 0 ? CI.P0 : CI.P1), gold ? 14 : 9);
        }
        this.stars[i] = newEnt(this.ctx, ramp(this.t));
        break;
      }
    },

    // ---- 同步（房主 → 快照；客人 ← 快照） ----
    serialize: function () {
      var e = [];
      for (var i = 0; i < this.stars.length; i++) {
        var s = this.stars[i];
        e.push([+s.x.toFixed(4), +s.y.toFixed(4), +s.r.toFixed(4), s.t, s.hue | 0, s.life > 0 ? (s.life | 0) : 0]);
      }
      var fx = [];
      var start = Math.max(0, this.fx.length - FX_SYNC_MAX);
      for (var j = start; j < this.fx.length; j++) {
        var f = this.fx[j];
        fx.push([f.k, +f.x.toFixed(3), +f.y.toFixed(3), f.ci, Math.round(f.age), f.life, f.txt || "", +(f.vx || 0).toFixed(3), +(f.vy || 0).toFixed(3)]);
      }
      return JSON.stringify({
        t: Math.max(0, this.t | 0),
        sc: this.score,
        cb: this.combo,
        mc: this.maxCombo,
        ct: [Math.round(this.comboT[0]), Math.round(this.comboT[1])],
        fz: [Math.round(this.frozen[0]), Math.round(this.frozen[1])],
        sh: Math.round(this.shake),
        e: e, fx: fx
      });
    },

    applyState: function (o) {
      this.t = o.t; this.score = o.sc; this.combo = o.cb; this.frozen = o.fz; this.shake = o.sh || 0;
      this.comboT = o.ct;
      if (o.mc) this.maxCombo = o.mc;
      var old = this.stars, arr = [];
      for (var i = 0; i < o.e.length; i++) {
        var a = o.e[i], prev = old[i];
        var s = { tx: a[0], ty: a[1], r: a[2], t: a[3], hue: a[4], life: a[5] };
        // 位置没跳变就沿用当前位置，逐帧插值补间；跳变（重生）则直接落点
        if (prev && prev.tx != null && Math.abs(a[0] - prev.tx) < 0.25 && Math.abs(a[1] - prev.ty) < 0.25) {
          s.x = prev.x; s.y = prev.y;
        } else { s.x = a[0]; s.y = a[1]; }
        arr.push(s);
      }
      this.stars = arr;
      this.fx = [];
      for (var j = 0; j < o.fx.length; j++) {
        var b = o.fx[j];
        this.fx.push({ k: b[0], x: b[1], y: b[2], ci: b[3], age: b[4], life: b[5], txt: b[6], vx: b[7], vy: b[8] });
      }
    },

    // ---- 渲染（两端都跑） ----
    render: function (now, ctx, c) {
      var W = ctx.canvasW, H = ctx.canvasH, asp = ctx.aspect, i;
      var dt = now - (this._rn || now); this._rn = now;
      if (dt > 100) dt = 100;

      // 客人端：把插值/特效老化在本地补间，抵消 30Hz 快照的跳变
      var anim = !ctx.authoritative;
      if (anim) {
        // 与帧率无关的指数逼近：30fps / 60fps 收敛速度一致，
        // 低帧率时不会因为固定系数(0.35)而"追不上"目标，画面更顺。
        var kk = 1 - Math.exp(-dt / 45);
        for (i = 0; i < this.stars.length; i++) {
          var se = this.stars[i];
          if (se.tx != null) { se.x += (se.tx - se.x) * kk; se.y += (se.ty - se.y) * kk; }
        }
        for (i = 0; i < this.fx.length; i++) {
          var ff = this.fx[i];
          ff.age += dt;
          if (ff.k === K.PARTICLE) { ff.x += ff.vx * dt / 1000; ff.y += ff.vy * dt / 1000; }
        }
      }

      c.save();
      if (this.shake > 0) {
        // 屏幕抖动是纯视觉，用 Math.random 即可（不影响逻辑随机流/同步）
        var sh = this.shake / 260 * 6;
        c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
      }

      // 背景
      c.fillStyle = "#05070f";
      c.fillRect(-20, -20, W + 40, H + 40);
      c.globalAlpha = 0.20; c.fillStyle = "#9fd8ff";
      for (i = 0; i < 54; i++) c.fillRect((i * 97) % W, (i * 53) % H, 1, 1);
      c.globalAlpha = 1;

      // 实体
      for (i = 0; i < this.stars.length; i++) {
        var s = this.stars[i];
        if (!ctx.visible(s.x, s.y, s.r)) continue;
        var px = ctx.x(s.x), py = ctx.y(s.y), pr = s.r * ctx.unitPx;
        var blink = (s.life > 0 && s.life < 1200) ? (0.35 + 0.65 * Math.abs(Math.sin(now / 90))) : 1;
        var col = s.t === T.GOLD ? "#ffd23f"
          : s.t === T.BOMB ? "#ff4d5e"
            : s.t === T.FREEZE ? "#8ff0ff"
              : "hsl(" + (s.hue || 300) + ",90%,66%)";
        c.save();
        this.glow(c, px, py, pr, col, blink);
        c.fillStyle = col;
        if (s.t === T.BOMB) {
          // 炸弹：带尖刺的红色球
          c.beginPath();
          for (var k2 = 0; k2 < 12; k2++) {
            var ang2 = k2 / 12 * Math.PI * 2;
            var rad2 = pr * (k2 % 2 === 0 ? 1.25 : 0.8);
            var xx = px + Math.cos(ang2) * rad2, yy = py + Math.sin(ang2) * rad2;
            k2 === 0 ? c.moveTo(xx, yy) : c.lineTo(xx, yy);
          }
          c.closePath(); c.fill();
        } else {
          c.beginPath(); c.arc(px, py, pr, 0, Math.PI * 2); c.fill();
          c.fillStyle = "rgba(255,255,255,0.85)";
          c.beginPath(); c.arc(px, py, pr * 0.42, 0, Math.PI * 2); c.fill();
          if (s.t === T.FREEZE) {
            c.strokeStyle = "#eaffff"; c.lineWidth = 2;
            c.beginPath();
            c.moveTo(px - pr, py); c.lineTo(px + pr, py);
            c.moveTo(px, py - pr); c.lineTo(px, py + pr);
            c.stroke();
          }
        }
        if (s.t === T.GOLD || s.t === T.BOMB || s.t === T.FREEZE) {
          c.strokeStyle = "rgba(255,255,255,0.75)"; c.lineWidth = 2;
          c.beginPath(); c.arc(px, py, pr + 4, 0, Math.PI * 2); c.stroke();
        }
        c.restore();
      }

      // 特效
      for (i = 0; i < this.fx.length; i++) {
        var f = this.fx[i];
        var life = f.life || 600, age = Math.min(f.age, life), k = 1 - age / life;
        if (k <= 0) continue;
        var fx2 = ctx.x(f.x), fy2 = ctx.y(f.y), color = COL[f.ci] || "#fff";
        c.save();
        c.globalAlpha = Math.max(0, k);
        if (f.k === K.PARTICLE) {
          c.fillStyle = color;
          c.beginPath(); c.arc(fx2, fy2, 1 + 3 * k, 0, Math.PI * 2); c.fill();
        } else {
          c.strokeStyle = color; c.lineWidth = 3;
          c.beginPath(); c.arc(fx2, fy2, (1 - k) * ctx.unitPx * 0.12 + 8, 0, Math.PI * 2); c.stroke();
          if (f.txt) {
            c.globalAlpha = Math.max(0, k);
            c.fillStyle = color;
            c.font = "bold " + Math.floor(W * 0.05) + "px sans-serif";
            c.textAlign = "center"; c.textBaseline = "middle";
            c.fillText(f.txt, fx2, fy2 - (1 - k) * 40);
          }
        }
        c.restore();
      }

      // 顶部 HUD：这里只画【原生 HUD 没有的】东西 —— 倒计时条 + 本机连击倍率。
      // 分数统一由原生 HUD（"你 · 昵称" / "对手 · 昵称" + A:B）显示，画布不再重复画一遍，
      // 否则屏幕上同时出现两处分数，反而分不清哪个是自己的。
      var me = ctx.seat;
      c.textBaseline = "top";

      // 连击倍率（居中，用本机颜色，一眼知道是"我的"连击）
      var cb = this.combo[me] || 0, mult = 1 + Math.min(4, Math.floor(cb / 3));
      if (cb >= 2) {
        c.font = "bold " + Math.floor(W * 0.042) + "px sans-serif";
        c.fillStyle = me === 0 ? COL[CI.P0] : COL[CI.P1];
        c.textAlign = "center";
        c.fillText("连击 " + cb + "  x" + mult, W * 0.5, H * 0.055);
      }

      // 倒计时条
      var frac = clamp(this.t / ROUND_MS, 0, 1);
      var barW = W * 0.5, barX = (W - barW) / 2, barY = H * 0.028, barH = Math.max(4, H * 0.008);
      c.fillStyle = "rgba(255,255,255,0.18)";
      c.fillRect(barX, barY, barW, barH);
      c.fillStyle = frac < 0.25 ? "#ff4d5e" : "#7cf0ff";
      c.fillRect(barX, barY, barW * frac, barH);
      c.fillStyle = "#ffffff"; c.textAlign = "center";
      c.font = "bold " + Math.floor(W * 0.03) + "px sans-serif";
      c.fillText(Math.ceil(this.t / 1000) + "s", W * 0.5, barY + barH + 4);

      // 被冻结遮罩
      if (this.frozen[me] > 0) {
        c.fillStyle = "rgba(140,240,255," + (0.18 + 0.12 * Math.sin(now / 60)) + ")";
        c.fillRect(0, 0, W, H);
        c.fillStyle = "#eaffff"; c.textAlign = "center"; c.textBaseline = "middle";
        c.font = "bold " + Math.floor(W * 0.09) + "px sans-serif";
        c.fillText("冻结!", W / 2, H / 2);
      }
      c.restore();
    },

    hud: function () {
      var me = this.ctx.seat, tip = "抢星星 · 连击有加成 · 别踩炸弹";
      if (this.frozen[me] > 0) tip = "被冻结了！动不了";
      else if (this.combo[me] >= 3) tip = "连击 x" + (1 + Math.min(4, Math.floor(this.combo[me] / 3))) + " 保持住！";
      return { hp: [1, 1], scores: [this.score[0], this.score[1]], tip: tip };
    },

    isFinished: function () { return this.t <= 0; },

    result: function () {
      var w = this.score[0] > this.score[1] ? 0 : (this.score[1] > this.score[0] ? 1 : -1);
      return {
        winner: w,
        scores: [this.score[0], this.score[1]],
        summary: "蓝 " + this.score[0] + " : " + this.score[1] + " 粉",
        stats: [
          ["蓝方得分", String(this.score[0])],
          ["粉方得分", String(this.score[1])],
          ["蓝方最高连击", String(this.maxCombo[0])],
          ["粉方最高连击", String(this.maxCombo[1])]
        ]
      };
    }
  };

  window.__DUAL_GAME__ = G;
})();
