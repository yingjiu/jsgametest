/*
 * 模板游戏：抢点对决（镜像同屏，30 秒）
 *
 * 这是可直接跑的起点：复制本文件夹 → 改 manifest.json 的 id/name → 在这里实现你的玩法。
 * 严格遵守的约定（详见 ../02 ~ ../05）：
 *   - 只用世界坐标：x∈[0,1]，y∈[0,aspect]；世界总宽 = crossScreen ? 2 : 1
 *   - 逻辑推进只在 tick（仅房主）；客人端只 applyState + render
 *   - 逻辑随机只用 ctx.rng()；逻辑计时只用 dt（不用 Date.now()）
 */
(function () {
  "use strict";

  var DEFAULT_ROUND_MS = 30000;

  var G = {
    id: "mygame",
    name: "我的游戏",
    crossScreen: false,          // 分屏玩法改成 true，并在 render 里用 ctx.visible() 过滤

    // ============== 生命周期 ==============
    init: function (ctx) {
      this.ctx = ctx;
      this.roundMs = parseInt((ctx.options && ctx.options.roundMs) || DEFAULT_ROUND_MS, 10);
      this.t = this.roundMs;
      this.score = [0, 0];
      this.fx = [];                                  // 纯视觉特效（不参与胜负）
      this._acc = 0;
      // 目标点初始位置：两端同种子 → 同一序列
      this.dot = { x: 0.15 + ctx.rng() * 0.7, y: (0.15 + ctx.rng() * 0.7) * ctx.aspect, r: 0.07 };
      DualArena.log("template init seat=" + ctx.seat + " auth=" + ctx.authoritative);
    },

    onStart: function (ctx) {
      DualArena.log("template onStart");
    },

    // ============== 仅房主：推进权威逻辑 ==============
    tick: function (dt) {
      this.t -= dt;

      // 每 1.2 秒挪一次目标点（用 dt 累加，绝不用 Date.now()）
      this._acc += dt;
      if (this._acc >= 1200) {
        this._acc = 0;
        this.moveDot();
      }
    },

    // ============== 仅房主：处理触摸（世界坐标）==============
    onInput: function (seat, x, y, a, id) {
      if (a !== 0) return;                           // 只处理「按下」，忽略 MOVE/UP
      var dx = x - this.dot.x, dy = y - this.dot.y, hit = this.dot.r + 0.06;
      if (dx * dx + dy * dy > hit * hit) return;      // 没点中

      this.score[seat]++;
      // 一次性表现：用 ev 通道（房主本地立即触发 + 随快照下发给客人）
      if (DualArena.ev) {
        DualArena.ev.emit("hit", { seat: seat, x: this.dot.x, y: this.dot.y });
      } else {
        this.spawnFx(this.dot.x, this.dot.y, seat);
      }
      this.moveDot();
    },

    moveDot: function () {
      var c = this.ctx;
      this.dot.x = 0.15 + c.rng() * 0.7;
      this.dot.y = (0.15 + c.rng() * 0.7) * c.aspect;
    },

    spawnFx: function (x, y, seat) {
      this.fx.push({ x: x, y: y, seat: seat, age: 0 });
      if (this.fx.length > 24) this.fx.shift();
    },

    // ============== 同步：房主 → 状态；客人 ← 状态 ==============
    serialize: function () {
      return {
        t: Math.max(0, this.t | 0),
        sc: this.score,
        d: [+this.dot.x.toFixed(4), +this.dot.y.toFixed(4)]
      };
    },

    applyState: function (o) {
      this.t = o.t;
      this.score = o.sc;
      this.dot.x = o.d[0];
      this.dot.y = o.d[1];
    },

    // ============== 两端：绘制（只读状态，不改状态）==============
    render: function (now, ctx, c) {
      var dt = now - (this._last || now);
      this._last = now;
      if (dt > 100) dt = 100;

      // 特效老化放这里：render 两端都跑，房主/客人各自推进视觉即可
      for (var j = this.fx.length - 1; j >= 0; j--) {
        this.fx[j].age += dt;
        if (this.fx[j].age > 500) this.fx.splice(j, 1);
      }

      // 背景
      c.fillStyle = "#05070f";
      c.fillRect(0, 0, ctx.canvasW, ctx.canvasH);

      // 目标点（含廉价光晕，别用 shadowBlur）
      if (ctx.visible(this.dot.x, this.dot.y, this.dot.r)) {
        var px = ctx.x(this.dot.x), py = ctx.y(this.dot.y), pr = this.dot.r * ctx.unitPx;
        c.fillStyle = "#39e6ff";
        c.beginPath(); c.arc(px, py, pr, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 0.22;
        c.beginPath(); c.arc(px, py, pr * 1.8, 0, Math.PI * 2); c.fill();
        c.globalAlpha = 1;
      }

      // 命中特效
      for (var i = 0; i < this.fx.length; i++) {
        var f = this.fx[i], k = 1 - f.age / 500;
        if (k <= 0) continue;
        c.globalAlpha = k;
        c.strokeStyle = f.seat === 0 ? "#39e6ff" : "#ff5ec4";
        c.lineWidth = 3;
        c.beginPath();
        c.arc(ctx.x(f.x), ctx.y(f.y), (1 - k) * ctx.unitPx * 0.15 + 8, 0, Math.PI * 2);
        c.stroke();
        c.globalAlpha = 1;
      }

      // 倒计时条（比分由原生 HUD 显示，这里只画进度）
      var frac = Math.max(0, Math.min(1, this.t / this.roundMs));
      var bw = ctx.canvasW * 0.5, bx = (ctx.canvasW - bw) / 2;
      var by = ctx.canvasH * 0.03, bh = Math.max(4, ctx.canvasH * 0.008);
      c.fillStyle = "rgba(255,255,255,0.18)";
      c.fillRect(bx, by, bw, bh);
      c.fillStyle = frac < 0.25 ? "#ff4d5e" : "#7cf0ff";
      c.fillRect(bx, by, bw * frac, bh);
    },

    // ============== 原生 HUD（按座位索引！）==============
    hud: function () {
      return { hp: [1, 1], scores: [this.score[0], this.score[1]], tip: "点击蓝点得分" };
    },

    // ============== 结算 ==============
    isFinished: function () { return this.t <= 0; },

    result: function () {
      var w = this.score[0] > this.score[1] ? 0 : (this.score[1] > this.score[0] ? 1 : -1);
      return {
        winner: w,
        scores: [this.score[0], this.score[1]],
        summary: this.score[0] + " : " + this.score[1],
        stats: [["座位 0 得分", String(this.score[0])], ["座位 1 得分", String(this.score[1])]]
      };
    }
  };

  // 订阅 ev 事件要早于任何 emit：包一层 init 完成订阅（两端都执行）
  var _init = G.init;
  G.init = function (ctx) {
    if (DualArena.ev) {
      var self = this;
      DualArena.ev.on("hit", function (d) { self.spawnFx(d.x, d.y, d.seat); });
    }
    _init.call(this, ctx);
  };

  window.__DUAL_GAME__ = G;
})();
