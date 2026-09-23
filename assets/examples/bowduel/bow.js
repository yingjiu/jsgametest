/*
 * 丛林弓箭对决 · 弓箭手感与弹道
 *
 * 操作：按下 → 开始拉弓；拖动 → 「拖到哪就射向哪」，拖动距离决定力度；松开 → 射出。
 * 之所以选"拖向目标"而不是"反向拉弹弓"：手机上"指哪打哪"最直觉，
 * 而且配合实时弹道虚线，玩家一眼就能判断这一箭会落在哪。
 *
 * 弹道：抛物线（重力恒定），两端用的都是同一份 simulate，所以预览和实际完全一致。
 */
(function () {
  "use strict";

  var C = {
    MAX_DRAG: 0.40,      // 满弓所需拖动距离（世界单位，1 = 一个屏宽）
    MIN_DRAG: 0.06,      // 小于这个距离视为误触，不发射
    SPEED_MIN: 0.80,     // 世界单位/秒
    SPEED_MAX: 2.00,
    G: 0.85,             // 重力加速度（世界单位/秒²，y 向下为正）
    FULL_POW: 0.92,      // 力度 ≥ 此值算"满蓄力"，伤害翻倍
    RELOAD_MS: 620,      // 装填冷却
    MAX_ARROWS: 12
  };

  /** 由弓箭手位置 + 手指位置算出瞄准角与力度（0~1） */
  function aim(ax, ay, tx, ty) {
    var dx = tx - ax, dy = ty - ay;
    var d = Math.sqrt(dx * dx + dy * dy);
    var pow = Math.max(0, Math.min(1, (d - C.MIN_DRAG) / (C.MAX_DRAG - C.MIN_DRAG)));
    return { ang: Math.atan2(dy, dx), pow: pow, dist: d };
  }

  function speedOf(pow) { return C.SPEED_MIN + (C.SPEED_MAX - C.SPEED_MIN) * pow; }

  function velocity(ang, pow) {
    var s = speedOf(pow);
    return { vx: Math.cos(ang) * s, vy: Math.sin(ang) * s };
  }

  /**
   * 预演弹道。返回像素点数组，遇地/出界即停。
   * 与真实箭矢用同一套积分（半隐式欧拉 + 固定步长），所以预览就是真轨迹。
   */
  function simulate(ctx, e, x0, y0, vx, vy, maxSec) {
    var pts = [];
    var dt = 1 / 60;
    var x = x0, y = y0;
    var steps = Math.floor((maxSec || 1.6) / dt);
    for (var i = 0; i < steps; i++) {
      vy += C.G * dt;
      x += vx * dt;
      y += vy * dt;
      if (y > e.groundY) { pts.push([x, e.groundY]); break; }
      if (y < -0.2 || x < -0.2 || x > 2.2) break;
      pts.push([x, y]);
      if (i % 2 === 0) pts[pts.length - 1].__slow = true;
    }
    return pts;
  }

  /** 把弹道画成虚线点；越远越淡，并标出落点 */
  function drawPreview(c, ctx, e, pts, mySeat) {
    if (!pts.length) return;
    var u = ctx.unitPx;
    var selfMin = ctx.init.originX, selfMax = ctx.init.originX + 1;
    c.save();
    for (var i = 0; i < pts.length; i += 2) {
      var p = pts[i];
      var k = 1 - i / pts.length;
      // 只有落在本机可见范围内才画（对面那半屏幕外，画了也看不见）
      if (p[0] < selfMin - 0.02 || p[0] > selfMax + 0.02) continue;
      c.globalAlpha = 0.18 + 0.55 * k;
      c.fillStyle = "#ffe9b0";
      c.beginPath();
      c.arc(ctx.x(p[0]), ctx.y(p[1]), Math.max(1.2, u * 0.006 * (0.6 + k)), 0, Math.PI * 2);
      c.fill();
    }
    // 落点标记
    var last = pts[pts.length - 1];
    var W = ctx.canvasW;
    var lx = ctx.x(last[0]), ly = ctx.y(last[1]);
    c.globalAlpha = 1;
    if (last[0] >= selfMin - 0.02 && last[0] <= selfMax + 0.02) {
      c.strokeStyle = "#FFD54F";
      c.lineWidth = Math.max(1.5, u * 0.005);
      c.beginPath();
      c.arc(lx, ly, u * 0.022, 0, Math.PI * 2);
      c.stroke();
      c.beginPath();
      c.moveTo(lx - u * 0.03, ly); c.lineTo(lx + u * 0.03, ly);
      c.moveTo(lx, ly - u * 0.03); c.lineTo(lx, ly + u * 0.03);
      c.stroke();
    } else {
      // 落点越过接缝：在屏幕边缘给一个"跨屏落点"箭头，配合对手指示就能主动狙击
      var edge = mySeat === 0 ? W - u * 0.03 : u * 0.03;
      c.fillStyle = "rgba(255,213,79,0.95)";
      var ay = Math.max(u * 0.05, Math.min(ctx.canvasH - u * 0.05, ly));
      c.beginPath();
      c.moveTo(edge, ay);
      c.lineTo(edge + (mySeat === 0 ? u * 0.05 : -u * 0.05), ay - u * 0.022);
      c.lineTo(edge + (mySeat === 0 ? u * 0.05 : -u * 0.05), ay + u * 0.022);
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  /** 一支箭：细长的杆 + 箭头 + 尾羽，按速度方向旋转 */
  function drawArrow(c, ctx, x, y, ang, alpha) {
    var u = ctx.unitPx;
    c.save();
    c.globalAlpha = alpha == null ? 1 : alpha;
    c.translate(ctx.x(x), ctx.y(y));
    c.rotate(ang);
    var L = u * 0.055, th = Math.max(1.4, u * 0.004);
    c.strokeStyle = "#e2d3ae";
    c.lineWidth = th;
    c.lineCap = "round";
    c.beginPath(); c.moveTo(-L, 0); c.lineTo(L * 0.7, 0); c.stroke();
    // 箭头
    c.fillStyle = "#e8eef3";
    c.beginPath();
    c.moveTo(L, 0); c.lineTo(L * 0.55, -th * 2.4); c.lineTo(L * 0.55, th * 2.4);
    c.fill();
    // 尾羽
    c.fillStyle = "rgba(255,138,101,0.95)";
    c.beginPath();
    c.moveTo(-L, 0); c.lineTo(-L * 0.55, -th * 2.6); c.lineTo(-L * 0.45, 0);
    c.fill();
    c.beginPath();
    c.moveTo(-L, 0); c.lineTo(-L * 0.55, th * 2.6); c.lineTo(-L * 0.45, 0);
    c.fill();
    c.restore();
  }

  /** 圆-圆命中判定（世界坐标）。房主端专用。 */
  function hitCircle(ax, ay, bx, by, r) {
    var dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy <= r * r;
  }

  window.BowBow = {
    C: C,
    aim: aim,
    velocity: velocity,
    speedOf: speedOf,
    simulate: simulate,
    drawPreview: drawPreview,
    drawArrow: drawArrow,
    hitCircle: hitCircle
  };
})();
