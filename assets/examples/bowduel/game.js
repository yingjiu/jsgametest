/*
 * 丛林弓箭对决 v1（bowduel）—— 真分屏·跨缝对射·抢动物
 *
 * 【玩法】
 *  - 真分屏：世界宽 2，接缝在 x=1。你只看得到自己那半场（弓箭手站在靠缝的位置）。
 *  - 一群动物在【整个场地】来回游走、自由穿越接缝：在你这半时你能射，跑到对面就归对手射。
 *  - 谁把动物打死，分值就归谁（非致命命中只给 1 分安慰）—— 所以残血动物跑过缝去会被抢。
 *  - 射中对手 +15 分并扣 1 血（满蓄力扣 2）；把对手射死 = 立刻胜利；否则时间到比分高者胜。
 *  - 回合时长由房主在「创建房间」页设置（manifest 的 options.roundMs）。
 *
 * 【SDK v2 用法（本游戏声明的 caps）】
 *  - clock   ：固定步长逻辑，低端机掉帧也不会让弹道变形
 *  - streams ：ctx.rng.stream("animals") 独立随机流，不会被特效随机打乱
 *  - interp  ：动物/箭矢按 id 自动插值，不用手写补间
 *  - ev      ：击杀/命中这类"一次性事件"走事件通道，两端都能收到
 *  - predict ：客人端用 DOM 指针即时拉弓 + 本地预测箭，不用等一个 RTT
 *  - assets  ：若 animals/*.png 存在就用图，否则回落到矢量绘制
 *
 * 【铁律】逻辑只在房主端跑（tick/onInput）；随机只用 ctx.rng；计时只用 tick 的 dt。
 */
(function () {
  "use strict";

  var G = {
    id: "bowduel",
    name: "丛林弓箭对决",
    crossScreen: true,

    // ==================== 初始化 ====================
    init: function (ctx) {
      this.ctx = ctx;
      this.e = window.BowScene.env(ctx);
      this.dec = window.BowScene.decorate(ctx.seed);
      this.B = window.BowBow;

      // 房主可调的回合时长（manifest options）
      var ms = parseInt(ctx.options.roundMs || "90000", 10);
      this.roundMs = (ms > 0) ? ms : 90000;
      this.t = this.roundMs;

      this.me = ctx.seat;
      this.foe = 1 - ctx.seat;

      this.maxHp = 5;
      this.hp = [5, 5];
      this.score = [0, 0];
      this.kills = [0, 0];
      this.stolen = [0, 0];      // 被对手抢走的击杀数
      this.best = 0;

      this.animals = [];
      this.arrows = [];
      this.fx = [];
      this.reload = [0, 0];
      this.hurt = [0, 0];
      this.strafe = [0, 0];              // 相对出生点的位移（底部移动按钮控制，房主权威）
      this.axis = [0, 0];                // 房主：每人当前移动方向 -1/0/+1
      this.localAxis = 0;                // 本机按钮按下态（仅点亮按钮，零延迟反馈）
      this.ptrMode = {};                 // 指针 id -> "aim" | "move"
      this.MOVE_SPEED = 0.55;            // 移动速度（世界单位/秒）
      this.MOVE_PAD = 0.06;              // 距自己屏幕左右边缘的留白，避免走出本机屏幕
      this.drawAmt = [0, 0];
      this.ang = [0, Math.PI];           // 0 号朝右、1 号朝左（都朝着接缝）
      this.aiming = {};
      this.clock = 0;
      this.animalSeq = 0;
      this.arrowSeq = 0;
      this.over = false;
      this.winner = -1;
      this.shake = 0;
      this.lastAuthArrowId = 0;
      this.local = null;          // 本地拖拽（DOM 指针，两端即时）

      // 独立随机流：动物生成/走位一条，特效一条，互不干扰
      this.rngA = ctx.rng.stream("animals");
      this.rngF = ctx.rng.stream("fx");

      // 只有房主建初始动物群；客人一律等快照（否则会造出两套互不相干的 id）
      if (ctx.authoritative) {
        for (var i = 0; i < 6; i++) this.animals.push(this.spawnAnimal());
      }

      // 素材：有 PNG 就用图，没有就矢量绘制（见 render 里的 img 分支）
      this.imgs = {};
      var D = window.DualArena;
      if (D.assets && ctx.assets && ctx.assets.length) {
        var self = this;
        D.assets.load(ctx.assets, function (map) { self.imgs = map || {}; });
      }

      // 本地指针（cap:predict）—— 拉弓的即时反馈全靠它，客人端零延迟
      if (D.predict) {
        var g = this;
        D.predict.onPointer(function (p, phase) { g.onLocalPointer(p, phase); });
      }

      // 事件通道（cap:ev）—— 击杀/命中这类一次性反馈
      if (D.ev) {
        D.ev.on("kill", function (d) { G.onKillEv(d); });
        D.ev.on("hitFoe", function (d) { G.onHitFoeEv(d); });
        D.ev.on("steal", function (d) { G.onStealEv(d); });
      }

      D.log("bowduel init seat=" + ctx.seat + " auth=" + ctx.authoritative + " roundMs=" + this.roundMs);
    },

    /** 弓的出手点（与 drawArcher 里弓的位置对齐，箭才会"从弦上飞出去"而不是从脚下冒出来） */
    bowPos: function (seat) {
      var face = seat === 0 ? 1 : -1;
      return {
        x: this.e.archerX[seat] + this.strafe[seat] + face * 0.032,
        y: this.e.groundY - 0.105
      };
    },

    /** 命中底部移动按钮？返回 -1=左移、+1=右移、0=不在按钮上（与 BowScene.moveRects 共用几何） */
    hitBtn: function (seat, x, y) {
      var r = window.BowScene.moveRects(this.ctx, seat);
      if (y < r.left.y0 || y > r.left.y1) return 0;
      if (x >= r.left.x0 && x <= r.left.x1) return -1;
      if (x >= r.right.x0 && x <= r.right.x1) return 1;
      return 0;
    },

    spawnAnimal: function () {
      return window.BowAnimals.spawn(this.ctx, this.rngA, this.e, ++this.animalSeq);
    },

    onStart: function () {
      this.shake = 0;
      window.DualArena.log("bowduel start");
    },

    // ==================== 本地指针（两端即时） ====================
    onLocalPointer: function (p, phase) {
      if (this.over) { this.local = null; this.localAxis = 0; return; }
      var me = this.me;
      // 底部按钮：本机按下态即时高亮；落在按钮上的按压不进入拉弓（真实位移仍由房主权威同步）
      var btn = this.hitBtn(me, p.x, p.y);
      if (btn !== 0) {
        this.localAxis = (phase === "up" || phase === "cancel") ? 0 : btn;
        this.local = null;
        return;
      }
      this.localAxis = 0;
      if (phase === "down") {
        this.local = { x: p.x, y: p.y };
      } else if (phase === "move") {
        if (this.local) { this.local.x = p.x; this.local.y = p.y; }
      } else if (phase === "up" || phase === "cancel") {
        if (this.local && phase === "up" && !this.ctx.authoritative && this.reload[me] <= 0) {
          // 客人端：本地预测一支箭，立刻看到自己射出去了；等房主快照到达再对账丢弃
          var bp = this.bowPos(me);
          var a = this.B.aim(bp.x, bp.y, p.x, p.y);
          if (a.dist > this.B.C.MIN_DRAG) {
            var v = this.B.velocity(a.ang, a.pow);
            window.DualArena.predict.spawn("arrow", {
              x: bp.x, y: bp.y, vx: v.vx, vy: v.vy, ang: a.ang, life: 300
            });
            this.reload[me] = this.B.C.RELOAD_MS;   // 本地也上冷却，避免连点
          }
        }
        this.local = null;
      }
    },

    // ==================== 逻辑（仅房主） ====================
    tick: function (dt) {
      if (this.over) return;
      var sec = dt / 1000, i, s, a;
      this.clock += dt;
      this.t -= dt;
      if (this.shake > 0) this.shake = Math.max(0, this.shake - dt);

      for (s = 0; s < 2; s++) {
        if (this.reload[s] > 0) this.reload[s] = Math.max(0, this.reload[s] - dt);
        if (this.hurt[s] > 0) this.hurt[s] = Math.max(0, this.hurt[s] - dt);
        // 底部按钮控制走位：只允许在自己手机屏幕对应的世界区间 [s+pad, s+1-pad] 内移动
        if (this.axis[s]) {
          var nx = this.e.archerX[s] + this.strafe[s] + this.axis[s] * this.MOVE_SPEED * sec;
          var lo = s + this.MOVE_PAD, hi = s + 1 - this.MOVE_PAD;
          if (nx < lo) nx = lo;
          else if (nx > hi) nx = hi;
          this.strafe[s] = nx - this.e.archerX[s];
        }
      }

      // ---- 动物 ----
      for (i = this.animals.length - 1; i >= 0; i--) {
        a = this.animals[i];
        if (a.dying > 0) {
          a.dying -= dt;
          if (a.dying <= 0) this.animals[i] = this.spawnAnimal();   // 倒地消散后补一只新的
          continue;
        }
        window.BowAnimals.step(a, dt, this.rngA, this.e);
        // 跑出边界（理论上 step 已折返，这里兜底）
        if (a.x < this.e.xMin) a.x = this.e.xMin;
        if (a.x > this.e.xMax) a.x = this.e.xMax;
      }
      // 数量维持
      var alive = 0;
      for (i = 0; i < this.animals.length; i++) if (this.animals[i].dying <= 0) alive++;
      while (alive < 6) { this.animals.push(this.spawnAnimal()); alive++; }

      // ---- 箭矢 ----
      for (i = this.arrows.length - 1; i >= 0; i--) {
        a = this.arrows[i];
        a.vy += this.B.C.G * sec;
        a.x += a.vx * sec;
        a.y += a.vy * sec;
        a.ang = Math.atan2(a.vy, a.vx);

        if (this.resolveArrow(a, i)) continue;
        if (a.y > this.e.groundY) { this.addFx(2, a.x, this.e.groundY, "", "#e2d3ae"); this.arrows.splice(i, 1); continue; }
        if (a.x < -0.15 || a.x > 2.15 || a.y < -0.3) { this.arrows.splice(i, 1); continue; }
      }

      // ---- 特效 ----
      for (i = this.fx.length - 1; i >= 0; i--) {
        var f = this.fx[i];
        f.age += dt;
        f.y -= (dt / 1000) * 0.10;
        if (f.age >= f.life) this.fx.splice(i, 1);
      }

      // ---- 结算 ----
      if (this.t <= 0) {
        this.t = 0;
        this.over = true;
        this.winner = this.score[0] > this.score[1] ? 0 : (this.score[1] > this.score[0] ? 1 : -1);
      }
    },

    /** 命中判定。返回 true 表示这支箭已消耗。 */
    resolveArrow: function (a, idx) {
      var i, d, r;
      // 1) 对手（不能射自己）—— 对手在缝的另一侧，所以这是"跨屏狙击"
      var D = window.DualArena;
      var foeSeat = 1 - a.seat;
      var fx = this.e.archerX[foeSeat] + this.strafe[foeSeat];
      var fy = this.e.groundY - 0.105;
      if (this.B.hitCircle(a.x, a.y, fx, fy, 0.050)) {
        var dmg = a.pow >= this.B.C.FULL_POW ? 2 : 1;
        this.hp[foeSeat] -= dmg;
        this.hurt[foeSeat] = 320;
        this.score[a.seat] += 15;
        this.arrows.splice(idx, 1);
        var dead = this.hp[foeSeat] <= 0;
        if (dead) { this.hp[foeSeat] = 0; this.over = true; this.winner = a.seat; }
        if (D.ev) D.ev.emit("hitFoe", { seat: a.seat, foe: foeSeat, x: fx, y: fy, kill: dead ? 1 : 0 });
        return true;
      }

      // 2) 动物
      for (i = 0; i < this.animals.length; i++) {
        var an = this.animals[i];
        if (an.dying > 0) continue;
        var sp = window.BowAnimals.byKey[an.sp];
        r = sp.size * 0.42 + 0.012;
        if (!this.B.hitCircle(a.x, a.y, an.x, an.y - sp.size * 0.42, r)) continue;

        var dmg2 = a.pow >= this.B.C.FULL_POW ? 2 : 1;
        an.hurt = 260;
        this.arrows.splice(idx, 1);
        if (an.hp - dmg2 <= 0) {
          an.hp = 0;
          an.dying = 420;
          this.score[a.seat] += sp.value;
          this.kills[a.seat]++;
          if (sp.value > this.best) this.best = sp.value;
          var stolenFrom = (an.lastHit != null && an.lastHit !== a.seat) ? an.lastHit : -1;
          if (D.ev) {
            D.ev.emit("kill", { seat: a.seat, x: an.x, y: an.y, v: sp.value, sp: an.sp });
            // 身上有别人的伤口却被你打死 = 抢杀，给被抢的人一个明确提示
            if (stolenFrom >= 0) {
              this.stolen[stolenFrom]++;
              D.ev.emit("steal", { seat: a.seat, victim: stolenFrom, x: an.x, y: an.y, v: sp.value });
            }
          }
        } else {
          // 非致命：只给安慰分，动物带着伤口跑到对面去 → 就可能被对手抢走击杀
          an.hp -= dmg2;
          this.score[a.seat] += 1;
          an.lastHit = a.seat;
          if (D.ev) D.ev.emit("hit", { seat: a.seat, x: an.x, y: an.y });
        }
        return true;
      }
      return false;
    },

    /** 以下三个由 ev 事件驱动：房主本地即时触发、客人随快照到达时触发，两端反馈一致 */
    onKillEv: function (d) {
      this.addFx(0, d.x, d.y - 0.08, "+" + d.v, "#FFD54F");
      this.addFx(1, d.x, d.y - 0.04, "", "#FFD54F");
      this.shake = Math.max(this.shake, 150);
    },
    onHitFoeEv: function (d) {
      this.addFx(0, d.x, d.y - 0.06, "+15", "#FF5252");
      this.shake = d.kill ? 420 : 220;
    },
    onStealEv: function (d) {
      if (d.victim !== this.me) return;      // 只有被抢的那个人看到，避免信息噪音
      this.addFx(0, d.x, d.y - 0.12, "被抢走!", "#FF5252");
    },

    addFx: function (k, x, y, txt, col) {
      this.fx.push({ k: k, x: x, y: y, txt: txt || "", col: col || "#fff", age: 0, life: k === 0 ? 900 : 520 });
      if (this.fx.length > 40) this.fx.shift();
    },

    // ==================== 输入（仅房主收到） ====================
    onInput: function (seat, x, y, a, id) {
      if (this.over) return;
      id = (id | 0);
      this.ptrMode = this.ptrMode || {};
      var bp = this.bowPos(seat);
      if (a === 0) {                      // 按下
        var btn = this.hitBtn(seat, x, y);
        if (btn !== 0) {                  // 落在底部移动按钮上 → 走位，不拉弓
          this.ptrMode[id] = "move";
          this.axis[seat] = btn;
          return;
        }
        this.ptrMode[id] = "aim";
        this.aiming = this.aiming || {};
        this.aiming[seat] = true;
        this.updateAim(seat, x, y);
      } else if (a === 2) {               // 移动
        if (this.ptrMode[id] === "move") {
          this.axis[seat] = this.hitBtn(seat, x, y);   // 手指划出按钮就停下
          return;
        }
        if (this.aiming && this.aiming[seat]) this.updateAim(seat, x, y);
      } else if (a === 1) {               // 抬起
        if (this.ptrMode[id] === "move") {
          this.axis[seat] = 0;
          delete this.ptrMode[id];
          return;
        }
        if (this.aiming && this.aiming[seat]) {
          this.updateAim(seat, x, y);
          this.fire(seat, bp.x, bp.y);
        }
        this.aiming[seat] = false;
        delete this.ptrMode[id];
      } else {                            // 取消
        this.axis[seat] = 0;
        this.ptrMode[id] = null;
        this.aiming = this.aiming || {};
        this.aiming[seat] = false;
        this.drawAmt[seat] = 0;
      }
    },

    updateAim: function (seat, x, y) {
      var bp = this.bowPos(seat);
      var r = this.B.aim(bp.x, bp.y, x, y);
      this.ang[seat] = r.ang;
      this.drawAmt[seat] = r.pow;
    },

    fire: function (seat, bx, by) {
      if (this.reload[seat] > 0) { this.drawAmt[seat] = 0; return; }
      var pow = this.drawAmt[seat];
      if (pow <= 0.02) { this.drawAmt[seat] = 0; return; }
      var v = this.B.velocity(this.ang[seat], pow);
      // id 按座位步进 2，客人端据此对账本地预测箭（见 applyState）
      this.arrows.push({
        id: (++this.arrowSeq) * 2 + seat,
        seat: seat,
        x: bx + Math.cos(this.ang[seat]) * 0.05,
        y: by + Math.sin(this.ang[seat]) * 0.05,
        vx: v.vx, vy: v.vy, ang: this.ang[seat], pow: pow
      });
      if (this.arrows.length > this.B.C.MAX_ARROWS) this.arrows.shift();
      this.reload[seat] = this.B.C.RELOAD_MS;
      this.drawAmt[seat] = 0;
      this.addFx(2, bx, by, "", "rgba(255,233,176,0.9)");
    },

    // ==================== 同步 ====================
    serialize: function () {
      var an = [], i;
      for (i = 0; i < this.animals.length; i++) {
        var a = this.animals[i];
        an.push([a.id, a.sp, +a.x.toFixed(4), +a.y.toFixed(4), a.hp, a.dir, +a.phase.toFixed(2),
          Math.round(a.pause), Math.round(a.dying)]);
      }
      var ar = [];
      var start = Math.max(0, this.arrows.length - this.B.C.MAX_ARROWS);
      for (i = start; i < this.arrows.length; i++) {
        var b = this.arrows[i];
        ar.push([b.id, b.seat, +b.x.toFixed(4), +b.y.toFixed(4), +b.ang.toFixed(3)]);
      }
      var fx = [];
      var fs = Math.max(0, this.fx.length - 10);
      for (i = fs; i < this.fx.length; i++) {
        var f = this.fx[i];
        fx.push([f.k, +f.x.toFixed(3), +f.y.toFixed(3), f.txt || "", f.col, Math.round(f.age), f.life]);
      }
      return {
        t: Math.round(this.t), sc: this.score, hp: this.hp, k: this.kills, bs: this.best,
        ov: this.over ? 1 : 0, wn: this.winner, sh: Math.round(this.shake),
        ay: [+this.strafe[0].toFixed(3), +this.strafe[1].toFixed(3)],
        dw: [+this.drawAmt[0].toFixed(2), +this.drawAmt[1].toFixed(2)],
        ag: [+this.ang[0].toFixed(2), +this.ang[1].toFixed(2)],
        rl: [Math.round(this.reload[0]), Math.round(this.reload[1])],
        an: an, ar: ar, fx: fx
      };
    },

    applyState: function (o) {
      this.t = o.t;
      this.score = o.sc;
      this.hp = o.hp;
      if (o.k) this.kills = o.k;
      this.over = !!o.ov;
      this.winner = o.wn;
      this.shake = o.sh || 0;
      this.strafe = o.ay || [0, 0];
      this.drawAmt = o.dw || [0, 0];
      if (o.ag) this.ang = o.ag;
      if (o.rl) this.reload = [o.rl[0] || 0, o.rl[1] || 0];
      if (o.bs != null) this.best = o.bs;

      var D = window.DualArena, i, arr = [];
      for (i = 0; i < o.an.length; i++) {
        var a = o.an[i];
        arr.push({
          id: a[0], sp: a[1], x: a[2], y: a[3], hp: a[4], dir: a[5],
          phase: a[6], pause: a[7], dying: a[8], groundY: this.e.groundY, baseY: a[3], hurt: 0
        });
      }
      this.animals = D.interp ? D.interp.merge(this.animals, arr, { key: "id", lerp: ["x", "y"], snap: 0.28 })
        : arr;

      var brr = [];
      for (i = 0; i < o.ar.length; i++) {
        var b = o.ar[i];
        brr.push({ id: b[0], seat: b[1], x: b[2], y: b[3], ang: b[4] });
      }
      this.arrows = D.interp ? D.interp.merge(this.arrows, brr, { key: "id", lerp: ["x", "y"], snap: 0.35 })
        : brr;

      // 本地预测箭对账：权威侧出现了我射的箭，就按 FIFO 丢掉最早的本地预测
      if (D.predict) {
        var maxId = 0;
        for (i = 0; i < brr.length; i++) if (brr[i].seat === this.me && brr[i].id > maxId) maxId = brr[i].id;
        if (maxId > this.lastAuthArrowId) {
          var n = Math.floor((maxId - this.lastAuthArrowId) / 2);
          if (n > 0) D.predict.ack("arrow", n);
          this.lastAuthArrowId = maxId;
        }
      }

      this.fx = [];
      for (i = 0; i < o.fx.length; i++) {
        var f = o.fx[i];
        this.fx.push({ k: f[0], x: f[1], y: f[2], txt: f[3], col: f[4], age: f[5], life: f[6] });
      }
    },

    // ==================== 渲染（两端共用同一份代码） ====================
    render: function (now, ctx, c) {
      var W = ctx.canvasW, H = ctx.canvasH, i;
      var dt = ctx.dt || 16;
      var S = window.BowScene, A = window.BowAnimals, B = this.B;
      var auth = ctx.authoritative;

      // 客人端没有 tick，装填冷却要在本地按帧递减（否则会永远卡在"装填中"，弓再也拉不开）
      if (!auth) {
        this.reload[0] = Math.max(0, this.reload[0] - dt);
        this.reload[1] = Math.max(0, this.reload[1] - dt);
      }

      // 客人端把插值与特效老化在本地补间，抵消 30Hz 快照的跳变
      if (!auth && window.DualArena.interp) {
        window.DualArena.interp.step(this.animals, dt, { lerp: ["x", "y"] });
        window.DualArena.interp.step(this.arrows, dt, { lerp: ["x", "y"] });
        for (i = 0; i < this.fx.length; i++) { this.fx[i].age += dt; this.fx[i].y -= (dt / 1000) * 0.10; }
      }
      // 本地预测箭：自己推进，等权威箭到达后被对账掉
      if (window.DualArena.predict) {
        var preds = window.DualArena.predict.list("arrow");
        for (i = preds.length - 1; i >= 0; i--) {
          var p = preds[i];
          p.vy += B.C.G * dt / 1000;
          p.x += p.vx * dt / 1000;
          p.y += p.vy * dt / 1000;
          p.ang = Math.atan2(p.vy, p.vx);
          p.life -= dt;
          if (p.life <= 0 || p.y > this.e.groundY) preds.splice(i, 1);
        }
      }

      c.save();
      if (this.shake > 0) {
        var sh = this.shake / 420 * 7;
        c.translate((Math.random() - 0.5) * sh, (Math.random() - 0.5) * sh);
      }

      // ---- 场景 ----
      S.drawBg(c, ctx, this.e, this.dec, now);

      // ---- 对手（在缝外，画布自然裁切，只露出一点剪影）+ 边缘指示 ----
      S.drawFoeMarker(c, ctx, this.e, ctx.seat, {
        draw: this.drawAmt[this.foe], ang: this.ang[this.foe], strafe: this.strafe[this.foe],
        hp: this.hp[this.foe], maxHp: this.maxHp
      }, now);

      // ---- 动物 ----
      for (i = 0; i < this.animals.length; i++) {
        var an = this.animals[i];
        var sp = A.byKey[an.sp];
        if (!sp) continue;
        if (!ctx.visible(an.x, an.y, sp.size)) continue;
        var px = ctx.x(an.x), py = ctx.y(an.y);
        var img = this.imgs["animals/" + an.sp + ".png"];
        A.draw(c, an, now, { unit: ctx.unitPx, px: px, py: py, img: img });
        // 受伤血条（只在掉过血时显示）
        if (an.hp < an.maxHp && an.dying <= 0) {
          var bw = ctx.unitPx * 0.075, bh = Math.max(2, ctx.unitPx * 0.008);
          var bx2 = px - bw / 2, by2 = py - ctx.unitPx * (sp.size * 0.95 + 0.02);
          c.fillStyle = "rgba(0,0,0,0.55)";
          c.fillRect(bx2, by2, bw, bh);
          c.fillStyle = "#81C784";
          c.fillRect(bx2, by2, bw * (an.hp / an.maxHp), bh);
        }
      }

      // ---- 箭矢 ----
      for (i = 0; i < this.arrows.length; i++) {
        var b = this.arrows[i];
        if (!ctx.visible(b.x, b.y, 0.02)) continue;
        B.drawArrow(c, ctx, b.x, b.y, b.ang, 1);
      }
      if (window.DualArena.predict) {
        var pr = window.DualArena.predict.list("arrow");
        for (i = 0; i < pr.length; i++) {
          B.drawArrow(c, ctx, pr[i].x, pr[i].y, pr[i].ang, 0.6);
        }
      }

      // ---- 我 ----
      var me = ctx.seat;
      var myDraw = 0, myAng = this.ang[me];
      if (this.local && this.reload[me] <= 0) {
        var bp0 = this.bowPos(me);
        var r = B.aim(bp0.x, bp0.y, this.local.x, this.local.y);
        myDraw = r.pow; myAng = r.ang;
        // 弹道预览（用真实积分，所见即所得）
        var v = B.velocity(r.ang, r.pow);
        var pts = B.simulate(ctx, this.e, bp0.x, bp0.y, v.vx, v.vy, 1.8);
        B.drawPreview(c, ctx, this.e, pts, me);
      }
      S.drawArcher(c, ctx, this.e, me, {
        draw: myDraw, ang: myAng, strafe: this.strafe[me], hurt: this.hurt[me]
      }, now);

      // ---- 装填冷却环 ----
      if (this.reload[me] > 0) {
        var k = 1 - this.reload[me] / B.C.RELOAD_MS;
        var cx = ctx.x(this.e.archerX[me] + this.strafe[me]);
        var cy = ctx.y(this.e.groundY) - ctx.unitPx * 0.19;
        var rr = ctx.unitPx * 0.045;
        c.strokeStyle = "rgba(255,255,255,0.18)";
        c.lineWidth = Math.max(2, ctx.unitPx * 0.006);
        c.beginPath(); c.arc(cx, cy, rr, 0, Math.PI * 2); c.stroke();
        c.strokeStyle = "#4FC3F7";
        c.beginPath();
        c.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * k);
        c.stroke();
      }

      // ---- 特效 ----
      for (i = 0; i < this.fx.length; i++) {
        var f = this.fx[i];
        var life = f.life || 700, age = Math.min(f.age, life), kk = 1 - age / life;
        if (kk <= 0) continue;
        c.save();
        c.globalAlpha = Math.max(0, kk);
        if (f.k === 0) {
          c.fillStyle = f.col;
          c.font = "bold " + Math.floor(W * 0.045) + "px sans-serif";
          c.textAlign = "center"; c.textBaseline = "middle";
          c.fillText(f.txt, ctx.x(f.x), ctx.y(f.y));
        } else if (f.k === 1) {
          c.strokeStyle = f.col; c.lineWidth = Math.max(2, ctx.unitPx * 0.005);
          c.beginPath();
          c.arc(ctx.x(f.x), ctx.y(f.y), (1 - kk) * ctx.unitPx * 0.10 + ctx.unitPx * 0.02, 0, Math.PI * 2);
          c.stroke();
        } else {
          c.fillStyle = f.col;
          c.beginPath();
          c.arc(ctx.x(f.x), ctx.y(f.y), ctx.unitPx * 0.012 * kk, 0, Math.PI * 2);
          c.fill();
        }
        c.restore();
      }

      // ---- 画布内只画原生 HUD 没有的东西：倒计时条 + 操作提示 ----
      var barW = W * 0.46, barX = (W - barW) / 2, barY = H * 0.028;
      var barH = Math.max(4, H * 0.008);
      var frac = Math.max(0, Math.min(1, this.t / this.roundMs));
      c.fillStyle = "rgba(255,255,255,0.16)";
      c.fillRect(barX, barY, barW, barH);
      c.fillStyle = frac < 0.2 ? "#FF5252" : "#FFD54F";
      c.fillRect(barX, barY, barW * frac, barH);
      c.fillStyle = "#F2E7D0";
      c.textAlign = "center"; c.textBaseline = "top";
      c.font = "bold " + Math.floor(W * 0.032) + "px sans-serif";
      c.fillText(Math.ceil(this.t / 1000) + "s", W * 0.5, barY + barH + 5);

      c.restore();

      // ---- 底部左右移动按钮（放在抖动 restore 之后，所以永远钉死在最下方、不跟着抖）----
      S.drawMoveButtons(c, ctx, this.e, me, { press: this.localAxis });

      // 开场操作引导（用"已过去多少毫秒"判断，两端口径一致）
      var elapsed = this.roundMs - this.t;
      if (elapsed < 5200) {
        c.save();
        c.globalAlpha = Math.max(0, 1 - elapsed / 5200);
        c.fillStyle = "#F2E7D0";
        c.textAlign = "center"; c.textBaseline = "middle";
        c.font = "600 " + Math.floor(W * 0.036) + "px sans-serif";
        c.fillText("按住拖动瞄准，松手射出 · 拖得越远越有力", W * 0.5, H * 0.44);
        c.font = "600 " + Math.floor(W * 0.032) + "px sans-serif";
        c.fillStyle = "#FFD54F";
        c.fillText("底部 ◀ ▶ 左右移动 · 射中对手 +15 并扣血，射死即胜", W * 0.5, H * 0.50);
        c.restore();
      }
    },

    hud: function () {
      var me = this.me;
      var tip = "拖动瞄准 · 松手射出";
      if (this.over) tip = this.winner < 0 ? "平局" : (this.winner === me ? "你赢了！" : "你输了");
      else if (this.reload[me] > 0) tip = "装填中…";
      else if (this.hp[me] <= 2) tip = "血量告急！注意躲箭";
      return {
        hp: [this.hp[0] / this.maxHp, this.hp[1] / this.maxHp],
        scores: [this.score[0], this.score[1]],
        tip: tip
      };
    },

    isFinished: function () { return this.over; },

    result: function () {
      var w = this.winner;
      var summary = w < 0
        ? "势均力敌，平局收场"
        : (w === this.me ? "你赢下了这片林子" : "对手技高一筹");
      return {
        winner: w,
        scores: [this.score[0], this.score[1]],
        summary: summary,
        stats: [
          ["你的得分", String(this.score[this.me])],
          ["对手得分", String(this.score[this.foe])],
          ["击杀动物", String(this.kills[this.me])],
          ["剩余血量", this.hp[this.me] + " / " + this.maxHp],
          ["最值钱的一只", "+" + this.best]
        ]
      };
    }
  };

  window.__DUAL_GAME__ = G;
})();
