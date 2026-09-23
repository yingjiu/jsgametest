/*
 * 丛林弓箭对决 · 场景与角色绘制
 *
 * 分层景深（远 → 近）：天空渐变 → 夕阳 → 远山 → 林线 → 中景树 → 地面草丛 → 体积光 → 暗角。
 * 所有静态装饰的位置都由【种子】决定（不用 Math.random），保证两块屏、每一帧画出来的林子完全一致。
 *
 * 弓箭手：躯干/头/帽/双腿 + 一张会随拉弓变形的弓（弓臂弯曲、弓弦后拉、搭上箭）。
 */
(function () {
  "use strict";

  /** 由 ctx 推出本局世界参数。两端都一样（aspect 是握手协商出来的）。 */
  function env(ctx) {
    var aspect = ctx.aspect;
    var groundY = aspect * 0.74;               // 地平线（世界 y）
    return {
      aspect: aspect,
      groundY: groundY,
      xMin: 0.10,                              // 动物活动范围：横跨两屏，可自由穿越接缝 x=1
      xMax: 1.90,
      // 弓箭手站在【自己手机屏幕的外侧】：0 号(左机)在左端、朝右射；1 号(右机)在右端、朝左射。
      // 两台手机并排时，两人的弓手正好一左一右、隔着中间的接缝对射。
      archerX: [0.14, 1.86],
      hopScale: aspect / 2.0,                  // 跳跃/飞行幅度随屏幕比例缩放
      unit: ctx.unitPx
    };
  }

  /** 确定性生成林子装饰（同一 seed → 两端一模一样） */
  function decorate(seed) {
    var rng = window.DualArena.makeRng((seed ^ 0x5eed01) >>> 0);
    var trees = [], bushes = [], blades = [];
    var i;
    // 中景树：沿整个世界宽度铺，两块屏各看到自己那半
    for (i = 0; i < 26; i++) {
      trees.push({
        x: rng() * 2.0,
        h: 0.16 + rng() * 0.20,
        w: 0.05 + rng() * 0.06,
        kind: rng() < 0.35 ? 1 : 0,     // 0=圆冠 1=针叶
        sway: rng() * Math.PI * 2,
        tint: rng()
      });
    }
    for (i = 0; i < 34; i++) {
      bushes.push({ x: rng() * 2.0, w: 0.03 + rng() * 0.05, h: 0.018 + rng() * 0.026, tint: rng() });
    }
    for (i = 0; i < 150; i++) {
      blades.push({ x: rng() * 2.0, h: 0.012 + rng() * 0.03, lean: (rng() - 0.5) * 0.02, tint: rng() });
    }
    return { trees: trees, bushes: bushes, blades: blades };
  }

  function drawBg(c, ctx, e, dec, now) {
    var W = ctx.canvasW, H = ctx.canvasH;
    var gy = ctx.y(e.groundY);
    var t = now / 1000;

    // ---- 天空 ----
    var sky = c.createLinearGradient(0, 0, 0, gy);
    sky.addColorStop(0.00, "#1d2b44");
    sky.addColorStop(0.35, "#4a5a63");
    sky.addColorStop(0.68, "#c98a3e");
    sky.addColorStop(1.00, "#f0c07a");
    c.fillStyle = sky;
    c.fillRect(0, 0, W, gy + 2);

    // ---- 夕阳 ----
    var sunX = W * 0.78, sunY = gy - H * 0.30, sunR = Math.min(W, H) * 0.085;
    var sg = c.createRadialGradient(sunX, sunY, sunR * 0.15, sunX, sunY, sunR * 3.4);
    sg.addColorStop(0, "rgba(255,236,190,0.95)");
    sg.addColorStop(0.22, "rgba(255,196,110,0.42)");
    sg.addColorStop(1, "rgba(255,170,80,0)");
    c.fillStyle = sg;
    c.beginPath(); c.arc(sunX, sunY, sunR * 3.4, 0, Math.PI * 2); c.fill();
    c.fillStyle = "rgba(255,246,214,0.95)";
    c.beginPath(); c.arc(sunX, sunY, sunR * 0.62, 0, Math.PI * 2); c.fill();

    // ---- 云带 ----
    c.fillStyle = "rgba(226,150,110,0.20)";
    for (var i = 0; i < 4; i++) {
      var cy = gy - H * (0.16 + i * 0.055);
      var cw = W * (0.5 + i * 0.12);
      var cx0 = ((t * (6 + i * 3)) % (W + cw)) - cw;
      c.beginPath();
      c.ellipse(cx0, cy, cw * 0.5, H * 0.014, 0, 0, Math.PI * 2);
      c.fill();
    }

    // ---- 远山 ----
    var mtn = c.createLinearGradient(0, gy - H * 0.22, 0, gy);
    mtn.addColorStop(0, "#3d4f52");
    mtn.addColorStop(1, "#22383a");
    c.fillStyle = mtn;
    c.beginPath();
    c.moveTo(0, gy);
    var peaks = [0.05, 0.22, 0.38, 0.55, 0.72, 0.88, 1.0];
    var heights = [0.13, 0.20, 0.11, 0.17, 0.09, 0.15, 0.08];
    for (i = 0; i < peaks.length; i++) {
      c.lineTo(W * peaks[i], gy - H * heights[i]);
      if (i < peaks.length - 1) c.lineTo(W * (peaks[i] + peaks[i + 1]) / 2, gy - H * heights[i] * 0.45);
    }
    c.lineTo(W, gy);
    c.closePath();
    c.fill();

    // ---- 林线（剪影）----
    c.fillStyle = "#17301f";
    for (i = 0; i < dec.trees.length; i++) {
      var tr = dec.trees[i];
      var tx = ctx.x(tr.x);
      if (tx < -W * 0.2 || tx > W * 1.2) continue;
      var th = tr.h * ctx.unitPx * 1.35;
      if (tr.kind === 1) {
        c.beginPath();
        c.moveTo(tx - th * 0.22, gy);
        c.lineTo(tx, gy - th);
        c.lineTo(tx + th * 0.22, gy);
        c.closePath();
        c.fill();
      } else {
        c.beginPath();
        c.ellipse(tx, gy - th * 0.62, th * 0.30, th * 0.44, 0, 0, Math.PI * 2);
        c.fill();
        c.fillRect(tx - th * 0.05, gy - th * 0.55, th * 0.10, th * 0.55);
      }
    }

    // ---- 地面 ----
    var gg = c.createLinearGradient(0, gy, 0, H);
    gg.addColorStop(0, "#4e6b32");
    gg.addColorStop(0.35, "#3a5426");
    gg.addColorStop(1, "#20301a");
    c.fillStyle = gg;
    c.fillRect(0, gy, W, H - gy);

    // 地面纹理：一层横向暗带做出草地的体积感
    c.fillStyle = "rgba(0,0,0,0.16)";
    c.fillRect(0, gy, W, (H - gy) * 0.10);
    c.fillStyle = "rgba(150,190,110,0.10)";
    c.fillRect(0, gy + (H - gy) * 0.02, W, (H - gy) * 0.035);

    // ---- 草叶 ----
    var sway = Math.sin(t * 1.1) * 0.004;
    c.strokeStyle = "#6d8f42";
    c.lineWidth = Math.max(1, ctx.unitPx * 0.0035);
    c.lineCap = "round";
    c.beginPath();
    for (i = 0; i < dec.blades.length; i++) {
      var b = dec.blades[i];
      var bx = ctx.x(b.x);
      if (bx < -20 || bx > W + 20) continue;
      var bh = b.h * ctx.unitPx;
      c.moveTo(bx, gy + (H - gy) * 0.02);
      c.lineTo(bx + (b.lean + sway) * ctx.unitPx, gy + (H - gy) * 0.02 - bh);
    }
    c.stroke();

    // ---- 灌木 ----
    for (i = 0; i < dec.bushes.length; i++) {
      var bu = dec.bushes[i];
      var bx2 = ctx.x(bu.x);
      if (bx2 < -W * 0.1 || bx2 > W * 1.1) continue;
      var bw = bu.w * ctx.unitPx, bh2 = bu.h * ctx.unitPx;
      c.fillStyle = bu.tint > 0.5 ? "rgba(46,78,34,0.95)" : "rgba(58,92,40,0.95)";
      c.beginPath();
      c.ellipse(bx2, gy + bh2 * 0.2, bw, bh2, 0, 0, Math.PI * 2);
      c.fill();
      c.fillStyle = "rgba(126,166,78,0.35)";
      c.beginPath();
      c.ellipse(bx2 - bw * 0.25, gy + bh2 * 0.05, bw * 0.5, bh2 * 0.6, 0, 0, Math.PI * 2);
      c.fill();
    }

    // ---- 体积光（斜射的光柱）----
    c.save();
    c.globalCompositeOperation = "lighter";
    for (i = 0; i < 3; i++) {
      var lx = W * (0.55 + i * 0.16);
      var lg = c.createLinearGradient(lx, 0, lx - W * 0.22, gy);
      lg.addColorStop(0, "rgba(255,214,150,0.13)");
      lg.addColorStop(1, "rgba(255,214,150,0)");
      c.fillStyle = lg;
      c.beginPath();
      c.moveTo(lx, 0);
      c.lineTo(lx + W * 0.10, 0);
      c.lineTo(lx - W * 0.10, gy);
      c.lineTo(lx - W * 0.26, gy);
      c.closePath();
      c.fill();
    }
    c.restore();

    // ---- 暗角 ----
    var vg = c.createRadialGradient(W * 0.5, H * 0.5, Math.min(W, H) * 0.35, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
    vg.addColorStop(0, "rgba(0,0,0,0)");
    vg.addColorStop(1, "rgba(0,0,0,0.42)");
    c.fillStyle = vg;
    c.fillRect(0, 0, W, H);
  }

  /**
   * 弓箭手。st = { draw:0~1, ang:弧度, alive, hurt, strafe }
   * draw=拉弓量，ang=瞄准角（世界坐标系，y 向下为正）
   */
  function drawArcher(c, ctx, e, seat, st, now) {
    var px = ctx.x(e.archerX[seat] + (st.strafe || 0));
    var py = ctx.y(e.groundY);
    var u = ctx.unitPx * 0.135;    // 人物高度 ≈ 0.135 世界单位
    var face = seat === 0 ? 1 : -1;
    var t = now / 1000;

    c.save();
    c.translate(px, py);
    c.scale(face * u, u);

    // 影子
    c.fillStyle = "rgba(0,0,0,0.28)";
    c.beginPath(); c.ellipse(0.05, 0, 0.42, 0.10, 0, 0, Math.PI * 2); c.fill();

    // 两队外貌区分：0 号蓝队、1 号红队（衣/裤/帽/靴全部不同色，跨屏也一眼分得清谁是谁）
    var skin = "#e8b98c";
    var T = seat === 0
      ? { cloth: "#2E6FB0", cloth2: "#1E4E80", hat: "#1B4470", hat2: "#12314F", boot: "#2F3D4A" }
      : { cloth: "#C0503B", cloth2: "#8E3626", hat: "#7A2E1F", hat2: "#511D14", boot: "#4A2F28" };
    var cloth = T.cloth, cloth2 = T.cloth2, boot = T.boot;

    // 腿
    c.strokeStyle = cloth2; c.lineWidth = 0.14; c.lineCap = "round";
    c.beginPath(); c.moveTo(0, -0.42); c.lineTo(-0.13, -0.02); c.stroke();
    c.beginPath(); c.moveTo(0, -0.42); c.lineTo(0.15, -0.02); c.stroke();
    c.fillStyle = boot;
    c.beginPath(); c.ellipse(-0.13, 0, 0.11, 0.06, 0, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.ellipse(0.15, 0, 0.11, 0.06, 0, 0, Math.PI * 2); c.fill();

    // 躯干
    var bg = c.createLinearGradient(0, -0.95, 0, -0.40);
    bg.addColorStop(0, cloth);
    bg.addColorStop(1, cloth2);
    c.fillStyle = bg;
    c.beginPath();
    c.moveTo(-0.16, -0.40);
    c.quadraticCurveTo(-0.20, -0.80, -0.10, -0.92);
    c.lineTo(0.16, -0.92);
    c.quadraticCurveTo(0.26, -0.78, 0.20, -0.40);
    c.closePath();
    c.fill();
    // 腰带
    c.fillStyle = "#7a4a22";
    c.fillRect(-0.18, -0.56, 0.40, 0.07);

    // 头 + 帽
    c.fillStyle = skin;
    c.beginPath(); c.arc(0.06, -1.02, 0.145, 0, Math.PI * 2); c.fill();
    c.fillStyle = T.hat;
    c.beginPath();
    c.moveTo(-0.10, -1.08);
    c.quadraticCurveTo(0.06, -1.30, 0.24, -1.06);
    c.quadraticCurveTo(0.10, -1.14, -0.10, -1.08);
    c.fill();
    c.fillStyle = T.hat2;
    c.beginPath(); c.ellipse(0.10, -1.08, 0.20, 0.035, -0.08, 0, Math.PI * 2); c.fill();
    // 眼
    c.fillStyle = "#20201c";
    c.beginPath(); c.ellipse(0.15, -1.03, 0.022, 0.026, 0, 0, Math.PI * 2); c.fill();

    // 弓（在身前，随瞄准角旋转）
    var ang = st.ang == null ? (seat === 0 ? 0 : Math.PI) : st.ang;
    var draw = Math.max(0, Math.min(1, st.draw || 0));
    c.save();
    c.translate(0.24, -0.78);
    c.rotate(ang);
    var bowR = 0.46;
    // 弓臂
    c.strokeStyle = "#6b4a26";
    c.lineWidth = 0.055;
    c.lineCap = "round";
    c.beginPath();
    c.moveTo(0, -bowR);
    c.quadraticCurveTo(bowR * 0.55, 0, 0, bowR);
    c.stroke();
    // 弓弦
    var pull = draw * 0.30;
    c.strokeStyle = "rgba(240,240,230,0.9)";
    c.lineWidth = 0.016;
    c.beginPath();
    c.moveTo(0, -bowR);
    c.lineTo(-pull, 0);
    c.lineTo(0, bowR);
    c.stroke();
    // 搭箭（拉弓时可见）
    if (draw > 0.04) {
      c.strokeStyle = "#d9c9a3";
      c.lineWidth = 0.030;
      c.beginPath();
      c.moveTo(-pull, 0);
      c.lineTo(bowR * 0.72, 0);
      c.stroke();
      // 箭头
      c.fillStyle = "#cfd6dc";
      c.beginPath();
      c.moveTo(bowR * 0.72, 0);
      c.lineTo(bowR * 0.60, -0.05);
      c.lineTo(bowR * 0.60, 0.05);
      c.fill();
    }
    // 持弓手
    c.fillStyle = skin;
    c.beginPath(); c.arc(0, 0, 0.055, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.arc(-pull, 0, 0.05, 0, Math.PI * 2); c.fill();
    c.restore();

    // 受击闪红
    if (st.hurt > 0) {
      c.globalAlpha = Math.min(1, st.hurt / 300) * 0.6;
      c.fillStyle = "#ff5252";
      c.beginPath();
      c.moveTo(-0.16, -0.40);
      c.quadraticCurveTo(-0.20, -0.80, -0.10, -0.92);
      c.lineTo(0.16, -0.92);
      c.quadraticCurveTo(0.26, -0.78, 0.20, -0.40);
      c.closePath();
      c.fill();
      c.globalAlpha = 1;
    }
    // 呼吸起伏（纯视觉）
    c.globalAlpha = 0;
    c.restore();

    return { px: px, py: py };
  }

  /**
   * 对手在缝外看不见时，在屏幕边缘给一个可读的指示：
   * 剪影（自然被画布裁掉一半）+ 血量点 + 满弓警戒。
   * 没有它，"射对手"就真的只能靠运气了。
   */
  function drawFoeMarker(c, ctx, e, seat, foe, now) {
    var W = ctx.canvasW;
    var edge = seat === 0 ? W - 1 : 1;         // 接缝在本机的哪一侧
    var dirOut = seat === 0 ? 1 : -1;
    var py = ctx.y(e.groundY);
    var u = ctx.unitPx;
    var t = now / 1000;

    c.save();
    // 半剪影：画在真实世界位置上，超出画布的部分自然被裁掉
    c.globalAlpha = 0.55;
    drawArcher(c, ctx, e, 1 - seat, { draw: foe.draw, ang: foe.ang, strafe: foe.strafe }, now);
    c.restore();

    // 边缘指示三角
    var mx = edge - dirOut * u * 0.055;
    var my = py - u * 0.10;
    c.save();
    c.fillStyle = foe.draw > 0.85 ? "#FF5252" : "rgba(255,209,79,0.92)";
    c.beginPath();
    c.moveTo(mx + dirOut * u * 0.035, my);
    c.lineTo(mx - dirOut * u * 0.018, my - u * 0.045);
    c.lineTo(mx - dirOut * u * 0.018, my + u * 0.045);
    c.closePath();
    c.fill();
    if (foe.draw > 0.85) {
      // 满弓：脉冲警示，提醒你该躲/该抢先
      c.globalAlpha = 0.35 + 0.35 * Math.sin(t * 14);
      c.strokeStyle = "#FF5252";
      c.lineWidth = Math.max(2, u * 0.006);
      c.beginPath();
      c.arc(mx + dirOut * u * 0.05, my, u * 0.07 * (1 + 0.15 * Math.sin(t * 14)), 0, Math.PI * 2);
      c.stroke();
      c.globalAlpha = 1;
    }
    // 对手血量点
    var pips = foe.maxHp, i;
    for (i = 0; i < pips; i++) {
      var px2 = mx - dirOut * u * 0.035;
      var py2 = my - u * 0.075 - i * u * 0.030;
      c.fillStyle = i < foe.hp ? "#FF5252" : "rgba(255,255,255,0.18)";
      c.beginPath();
      c.arc(px2, py2, u * 0.010, 0, Math.PI * 2);
      c.fill();
    }
    c.restore();
  }

  /**
   * 底部左右移动按钮的世界坐标矩形（只在本机半场）。
   * 渲染(game.render) 与 命中判定(game.onInput/onLocalPointer) 共用这一份几何，避免对不上。
   */
  function moveRects(ctx, seat) {
    var asp = ctx.aspect;
    return {
      left:  { x0: seat + 0.045, x1: seat + 0.345, y0: asp * 0.80, y1: asp * 0.965 },
      right: { x0: seat + 0.655, x1: seat + 0.955, y0: asp * 0.80, y1: asp * 0.965 }
    };
  }

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w * 0.5, h * 0.5);
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawBtn(c, ctx, rect, dir, active, tint) {
    var x0 = ctx.x(rect.x0), x1 = ctx.x(rect.x1);
    var y0 = ctx.y(rect.y0), y1 = ctx.y(rect.y1);
    var w = x1 - x0, h = y1 - y0, rr = Math.min(w, h) * 0.30;

    c.save();
    c.globalAlpha = active ? 0.95 : 0.68;
    c.fillStyle = active ? tint : "rgba(10,24,14,0.72)";
    roundRect(c, x0, y0, w, h, rr); c.fill();
    c.globalAlpha = 1;
    c.lineWidth = Math.max(2, ctx.unitPx * 0.004);
    c.strokeStyle = active ? "rgba(255,255,255,0.92)" : "rgba(196,222,186,0.55)";
    roundRect(c, x0, y0, w, h, rr); c.stroke();

    // 三角箭头
    var cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, s = Math.min(w, h) * 0.24;
    c.fillStyle = active ? "#0B1A0F" : "rgba(232,244,224,0.92)";
    c.beginPath();
    if (dir < 0) { c.moveTo(cx - s, cy); c.lineTo(cx + s * 0.72, cy - s); c.lineTo(cx + s * 0.72, cy + s); }
    else { c.moveTo(cx + s, cy); c.lineTo(cx - s * 0.72, cy - s); c.lineTo(cx - s * 0.72, cy + s); }
    c.closePath(); c.fill();
    c.restore();
  }

  /** 画底部左右移动按钮。st:{ press:-1/0/+1 } 为本机按下态（仅用于高亮反馈，零延迟） */
  function drawMoveButtons(c, ctx, e, seat, st) {
    var r = moveRects(ctx, seat);
    var press = (st && st.press) || 0;
    drawBtn(c, ctx, r.left, -1, press === -1, "#7BB661");
    drawBtn(c, ctx, r.right, 1, press === 1, "#7BB661");
  }

  window.BowScene = {
    env: env,
    decorate: decorate,
    drawBg: drawBg,
    drawArcher: drawArcher,
    drawFoeMarker: drawFoeMarker,
    moveRects: moveRects,
    drawMoveButtons: drawMoveButtons
  };
})();
 