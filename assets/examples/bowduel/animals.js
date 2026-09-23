/*
 * 丛林弓箭对决 · 动物系统
 *
 * 职责：物种数值表 + 生成/游走 AI（仅房主端调用）+ 矢量造型绘制（两端共用）。
 *
 * 【为什么 AI 只在房主端跑】
 * 平台是「房主权威」模型：客人的动物位置一律来自快照。这里所有随机都用传入的 rng
 * （= ctx.rng.stream("animals")，两端同种子），但只要不在客人端调用就不会破坏一致性。
 *
 * 【为什么不用色块】
 * 每个物种都是由躯干/头/耳/四肢/尾分层绘制，并带步态相位驱动的骨骼摆动，
 * 皮毛用渐变 + 斑点/条纹细节，远看是"一只鹿"而不是"一个圆"。
 */
(function () {
  "use strict";

  /**
   * 物种表。
   * hp = 要几箭才倒（也是"会不会被对手抢走击杀"的张力来源）
   * value = 击杀得分；speed = 巡航速度（世界单位/秒）；size = 体长（世界单位）
   * w = 刷新权重（越值钱越稀有）
   */
  var SPECIES = [
    { k: "rabbit", name: "野兔", hp: 1, value: 2, speed: 0.30, size: 0.058, mode: "hop", w: 30,
      fur: ["#e3d0b4", "#a98863"], belly: "#fff4e4", dark: "#5a4432" },
    { k: "bird", name: "山雀", hp: 1, value: 3, speed: 0.36, size: 0.050, mode: "fly", w: 24,
      fur: ["#8fd0ef", "#3d7ba6"], belly: "#f3fbff", dark: "#234b66" },
    { k: "fox", name: "赤狐", hp: 2, value: 5, speed: 0.23, size: 0.072, mode: "trot", w: 20,
      fur: ["#ef8c42", "#b4551d"], belly: "#fff1dd", dark: "#5e2c0d" },
    { k: "deer", name: "梅花鹿", hp: 3, value: 8, speed: 0.15, size: 0.098, mode: "graze", w: 16,
      fur: ["#cf9559", "#8a5b30"], belly: "#fff6e6", dark: "#4a2f16" },
    { k: "boar", name: "野猪", hp: 4, value: 12, speed: 0.25, size: 0.088, mode: "charge", w: 10,
      fur: ["#7b6650", "#3c3025"], belly: "#cdbfa9", dark: "#241c14" }
  ];

  var byKey = {};
  for (var i = 0; i < SPECIES.length; i++) byKey[SPECIES[i].k] = SPECIES[i];
  var totalW = 0;
  for (i = 0; i < SPECIES.length; i++) totalW += SPECIES[i].w;

  function pick(rng) {
    var r = rng() * totalW;
    for (var j = 0; j < SPECIES.length; j++) {
      r -= SPECIES[j].w;
      if (r <= 0) return SPECIES[j];
    }
    return SPECIES[0];
  }

  /**
   * 生成一只动物。env 提供世界边界与地面高度。
   * 注意：只在房主端调用（用到 rng，客人端调用会污染随机流）。
   */
  function spawn(ctx, rng, env, id) {
    var s = pick(rng);
    var xMin = env.xMin, xMax = env.xMax;
    var x = 0, tries = 0;
    // 别刷在弓箭手脸上（离任一弓箭手至少 0.18）
    do {
      x = xMin + rng() * (xMax - xMin);
      tries++;
    } while (tries < 12 && (Math.abs(x - env.archerX[0]) < 0.18 || Math.abs(x - env.archerX[1]) < 0.18));

    var groundY = env.groundY;
    var baseY = groundY;
    if (s.mode === "fly") baseY = groundY - (0.22 + rng() * 0.30) * ctx.aspect;

    return {
      id: id,
      sp: s.k,
      x: x,
      y: baseY,
      baseY: baseY,
      groundY: groundY,
      hp: s.hp,
      maxHp: s.hp,
      dir: rng() < 0.5 ? -1 : 1,
      phase: rng() * Math.PI * 2,
      gait: 2 + rng() * 1.6,
      pause: 0,          // graze 低头吃草 / charge 蓄力的计时
      burst: 0,          // charge 冲刺剩余时间
      hurt: 0,           // 受击闪白（毫秒，仅视觉）
      dying: 0           // 倒地消散（毫秒）
    };
  }

  /** 房主端推进一只动物（dt 毫秒）。rng 必须是 ctx.rng.stream("animals")。 */
  function step(a, dt, rng, env) {
    var s = byKey[a.sp];
    var sec = dt / 1000;

    if (a.dying > 0) { a.dying -= dt; return; }
    if (a.hurt > 0) a.hurt -= dt;

    // 偶尔改变方向 —— 用时间归一化的概率，保证不同帧率下行为一致
    if (rng() < sec * 0.18) a.dir = -a.dir;

    var vx = s.speed * a.dir;

    if (s.mode === "charge") {
      // 野猪：走走停停，然后突然冲一段
      if (a.burst > 0) {
        a.burst -= dt;
        vx *= 2.6;
      } else {
        a.pause -= dt;
        if (a.pause > 0) vx = 0;
        else if (rng() < sec * 0.5) { a.burst = 700 + rng() * 600; a.pause = 0; }
        else if (rng() < sec * 0.6) a.pause = 500 + rng() * 900;
      }
    } else if (s.mode === "graze") {
      // 鹿：时不时低头吃草
      if (a.pause > 0) { a.pause -= dt; vx = 0; }
      else if (rng() < sec * 0.35) a.pause = 800 + rng() * 1600;
    }

    a.x += vx * sec;
    a.phase += sec * a.gait * (Math.abs(vx) > 0.001 ? 1 : 0.25);

    // 边界折返（"来回活动"），并且会自由穿越两屏接缝 x=1
    if (a.x < env.xMin) { a.x = env.xMin; a.dir = 1; }
    if (a.x > env.xMax) { a.x = env.xMax; a.dir = -1; }

    // 垂直运动：每种动物轨迹不同
    if (s.mode === "hop") {
      var h = Math.abs(Math.sin(a.phase * Math.PI));
      a.y = a.groundY - h * 0.055 * env.hopScale;
    } else if (s.mode === "fly") {
      a.y = a.baseY + Math.sin(a.phase * 1.7) * 0.045 * env.hopScale;
    } else {
      a.y = a.groundY;
    }
  }

  // ==================== 绘制 ====================
  // 局部坐标：原点在"蹄子着地点"，动物朝 +x 方向，体长约 1.0，高约 0.7。

  function grad(c, x0, y0, x1, y1, a, b) {
    var g = c.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    return g;
  }

  function ellipse(c, x, y, rx, ry, rot) {
    c.beginPath();
    c.ellipse(x, y, rx, ry, rot || 0, 0, Math.PI * 2);
    c.fill();
  }

  /** 一条腿：两段 + 膝关节，走起来才不像棍子 */
  function leg(c, x, y, ph, len, thick, col, hoof) {
    var knee = 0.45 * len;
    var swing = Math.sin(ph) * 0.38;
    var kx = x + Math.sin(ph) * 0.10 * len;
    var ky = y + knee * Math.cos(swing * 0.5);
    var fx = x + swing * 0.34 * len;
    var fy = y + len;
    c.strokeStyle = col;
    c.lineWidth = thick;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(x, y);
    c.quadraticCurveTo(kx, ky, fx, fy);
    c.stroke();
    if (hoof) {
      c.fillStyle = hoof;
      ellipse(c, fx, fy, thick * 0.62, thick * 0.45);
    }
  }

  function draw(c, a, now, opts) {
    var s = byKey[a.sp];
    var scale = opts.unit * s.size;   // 世界单位 → 像素
    var dying = a.dying > 0 ? Math.max(0, a.dying / 420) : 1;

    // 【素材接口】若 animals/<sp>.png 存在就用图，否则走下面的矢量绘制。
    // 这样以后补了真实素材，不用改任何绘制代码就能直接替换掉矢量造型。
    if (opts.img && opts.img.width > 0) {
      var iw = opts.img.width, ih = opts.img.height;
      var k = scale / iw;
      c.save();
      c.globalAlpha = dying;
      c.translate(opts.px, opts.py);
      if (a.dir < 0) c.scale(-1, 1);
      c.drawImage(opts.img, -iw * k * 0.5, -ih * k, iw * k, ih * k);
      c.restore();
      return;
    }

    c.save();
    c.globalAlpha = dying;
    c.translate(opts.px, opts.py);
    if (a.dir < 0) c.scale(-1, 1);     // 朝左就镜像
    c.scale(scale, scale);
    if (dying < 1) c.rotate((1 - dying) * 1.1);   // 倒地

    var body = grad(c, 0, -0.62, 0, -0.16, s.fur[0], s.fur[1]);
    var t = now / 1000;
    var walk = a.phase * Math.PI;
    var moving = true;
    if (a.pause > 0) moving = false;
    var ph = moving ? walk : walk * 0.15;

    // ---- 阴影 ----
    c.globalAlpha = dying * 0.22;
    c.fillStyle = "#000";
    ellipse(c, 0.05, 0.01, 0.52 * (s.mode === "fly" ? 0.55 : 1), 0.09);
    c.globalAlpha = dying;

    // ---- 后腿（先画，压在躯干下）----
    var legLen = 0.30;
    leg(c, -0.24, -0.34, ph + Math.PI, legLen, 0.075, s.fur[1], s.dark);
    leg(c, -0.16, -0.34, ph, legLen, 0.075, s.fur[1], s.dark);

    // ---- 尾巴 ----
    c.fillStyle = s.fur[1];
    if (s.k === "fox") {
      c.beginPath();
      c.moveTo(-0.34, -0.48);
      c.quadraticCurveTo(-0.72, -0.52 + Math.sin(t * 6) * 0.05, -0.80, -0.24);
      c.quadraticCurveTo(-0.58, -0.34, -0.34, -0.36);
      c.fill();
      c.fillStyle = s.belly;
      ellipse(c, -0.76, -0.27, 0.07, 0.06);
    } else if (s.k === "deer") {
      c.beginPath();
      c.moveTo(-0.34, -0.50);
      c.quadraticCurveTo(-0.52, -0.56, -0.54, -0.40);
      c.quadraticCurveTo(-0.42, -0.40, -0.34, -0.42);
      c.fill();
    } else if (s.k === "boar") {
      c.strokeStyle = s.dark; c.lineWidth = 0.05; c.lineCap = "round";
      c.beginPath();
      c.moveTo(-0.34, -0.46);
      c.quadraticCurveTo(-0.50, -0.50, -0.44, -0.32);
      c.stroke();
    } else if (s.k === "rabbit") {
      c.fillStyle = s.belly;
      ellipse(c, -0.38, -0.44, 0.075, 0.075);
    }

    // ---- 躯干 ----
    c.fillStyle = body;
    if (s.mode === "fly") {
      ellipse(c, 0, -0.48, 0.30, 0.24, -0.18);
    } else {
      ellipse(c, -0.02, -0.47, 0.36, 0.22, -0.06);
    }
    // 肚皮高光
    c.globalAlpha = dying * 0.55;
    c.fillStyle = s.belly;
    ellipse(c, -0.02, -0.36, 0.26, 0.10, -0.06);
    c.globalAlpha = dying;

    // ---- 皮毛细节 ----
    if (s.k === "deer") {
      c.fillStyle = "rgba(255,250,235,0.75)";
      var spots = [[-0.12, -0.55], [0.02, -0.60], [0.14, -0.52], [-0.20, -0.50]];
      for (var i = 0; i < spots.length; i++) ellipse(c, spots[i][0], spots[i][1], 0.035, 0.028);
    } else if (s.k === "boar") {
      c.strokeStyle = "rgba(20,14,8,0.5)"; c.lineWidth = 0.022;
      for (i = 0; i < 3; i++) {
        c.beginPath();
        c.moveTo(-0.18 + i * 0.12, -0.62);
        c.lineTo(-0.22 + i * 0.12, -0.40);
        c.stroke();
      }
      // 鬃毛
      c.strokeStyle = s.dark; c.lineWidth = 0.03;
      for (i = 0; i < 4; i++) {
        c.beginPath();
        c.moveTo(0.02 + i * 0.05, -0.62);
        c.lineTo(0.0 + i * 0.05, -0.72);
        c.stroke();
      }
    } else if (s.k === "bird") {
      // 翅膀：扇动
      var flap = Math.sin(t * 14) * 0.28;
      c.fillStyle = s.fur[1];
      c.save();
      c.translate(0.02, -0.50);
      c.rotate(-0.3 + flap);
      ellipse(c, -0.06, 0, 0.26, 0.11, 0);
      c.restore();
      c.fillStyle = s.fur[0];
      c.save();
      c.translate(0.02, -0.50);
      c.rotate(0.15 - flap * 0.7);
      ellipse(c, -0.04, 0, 0.20, 0.09, 0);
      c.restore();
    }

    // ---- 前腿 ----
    if (s.mode !== "fly") {
      leg(c, 0.14, -0.34, ph, legLen, 0.07, s.fur[1], s.dark);
      leg(c, 0.22, -0.34, ph + Math.PI, legLen, 0.07, s.fur[1], s.dark);
    } else {
      c.strokeStyle = "#e8a33f"; c.lineWidth = 0.035; c.lineCap = "round";
      c.beginPath(); c.moveTo(0.05, -0.30); c.lineTo(0.02, -0.20); c.stroke();
      c.beginPath(); c.moveTo(0.09, -0.30); c.lineTo(0.06, -0.20); c.stroke();
    }

    // ---- 颈 / 头 ----
    var headDown = (a.pause > 0 && s.mode === "graze") ? 0.42 : 0;
    var hx = 0.34, hy = -0.60 + headDown;
    c.strokeStyle = s.fur[1];
    c.lineWidth = 0.15;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(0.20, -0.52);
    c.lineTo(hx - 0.04, hy + 0.06);
    c.stroke();

    c.fillStyle = grad(c, 0, hy - 0.12, 0, hy + 0.08, s.fur[0], s.fur[1]);
    if (s.k === "rabbit") ellipse(c, hx, hy, 0.135, 0.115, -0.25);
    else if (s.k === "bird") ellipse(c, hx, hy, 0.125, 0.115, 0);
    else if (s.k === "boar") ellipse(c, hx, hy, 0.155, 0.125, 0.12);
    else ellipse(c, hx, hy, 0.145, 0.115, -0.12);

    // 口鼻
    c.fillStyle = s.dark;
    if (s.k === "boar") {
      ellipse(c, hx + 0.15, hy + 0.06, 0.07, 0.055);
      // 獠牙
      c.fillStyle = "#f6efdd";
      c.beginPath();
      c.moveTo(hx + 0.14, hy + 0.04);
      c.quadraticCurveTo(hx + 0.24, hy - 0.02, hx + 0.20, hy - 0.10);
      c.quadraticCurveTo(hx + 0.17, hy - 0.02, hx + 0.12, hy + 0.01);
      c.fill();
    } else if (s.k === "bird") {
      c.fillStyle = "#f0a33c";
      c.beginPath();
      c.moveTo(hx + 0.10, hy);
      c.lineTo(hx + 0.24, hy + 0.02);
      c.lineTo(hx + 0.10, hy + 0.05);
      c.fill();
    } else {
      ellipse(c, hx + 0.13, hy + 0.05, 0.05, 0.04);
    }

    // 耳朵 / 鹿角
    c.fillStyle = s.fur[1];
    if (s.k === "rabbit") {
      for (i = 0; i < 2; i++) {
        var ex = hx - 0.02 + i * 0.05, ew = 0.042 - i * 0.006;
        c.save();
        c.translate(ex, hy - 0.08);
        c.rotate(-0.35 + i * 0.30 + Math.sin(t * 3 + i) * 0.06);
        ellipse(c, 0, -0.13, ew, 0.15);
        c.restore();
      }
      c.fillStyle = "#f0b8bf";
      c.save();
      c.translate(hx - 0.01, hy - 0.08);
      c.rotate(-0.35);
      ellipse(c, 0, -0.13, 0.02, 0.10);
      c.restore();
    } else if (s.k === "deer") {
      c.strokeStyle = "#e6d3ae"; c.lineWidth = 0.032; c.lineCap = "round";
      for (i = 0; i < 2; i++) {
        var sx = hx - 0.03 + i * 0.07;
        c.beginPath();
        c.moveTo(sx, hy - 0.09);
        c.quadraticCurveTo(sx + 0.02, hy - 0.30, sx + 0.10 + i * 0.03, hy - 0.34);
        c.stroke();
        c.beginPath();
        c.moveTo(sx + 0.02, hy - 0.22);
        c.lineTo(sx - 0.06 + i * 0.02, hy - 0.28);
        c.stroke();
      }
      c.fillStyle = s.fur[1];
      ellipse(c, hx - 0.10, hy - 0.06, 0.05, 0.032, -0.5);
    } else if (s.k === "fox") {
      for (i = 0; i < 2; i++) {
        var fx2 = hx - 0.06 + i * 0.10;
        c.beginPath();
        c.moveTo(fx2 - 0.04, hy - 0.06);
        c.lineTo(fx2 + 0.02, hy - 0.22);
        c.lineTo(fx2 + 0.07, hy - 0.05);
        c.fill();
      }
    } else if (s.k === "boar") {
      c.beginPath();
      c.moveTo(hx - 0.06, hy - 0.05);
      c.lineTo(hx - 0.02, hy - 0.18);
      c.lineTo(hx + 0.05, hy - 0.04);
      c.fill();
    }

    // 眼睛
    c.fillStyle = "#1a1410";
    ellipse(c, hx + 0.06, hy - 0.02, 0.026, 0.026);
    c.fillStyle = "rgba(255,255,255,0.9)";
    ellipse(c, hx + 0.075, hy - 0.035, 0.010, 0.010);

    // 受击闪白
    if (a.hurt > 0) {
      c.globalAlpha = dying * Math.min(1, a.hurt / 260) * 0.75;
      c.fillStyle = "#fff";
      ellipse(c, 0, -0.47, 0.38, 0.24, -0.06);
      c.globalAlpha = dying;
    }
    c.restore();
  }

  window.BowAnimals = {
    SPECIES: SPECIES,
    byKey: byKey,
    spawn: spawn,
    step: step,
    draw: draw
  };
})();
