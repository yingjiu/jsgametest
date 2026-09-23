# 03 · `ctx` 与坐标系统

`ctx` 由 SDK 在 `boot()` 时创建，传给 `init` / `onStart` / `render`。它把「双屏差异」和「像素换算」都藏起来，
你只需用**世界坐标**写逻辑。

---

## 1. `ctx` 全字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `ctx.seat` | int | **本机座位**（`0` 或 `1`） |
| `ctx.otherSeat` | int | 对手座位（`= 1 - seat`） |
| `ctx.role` | string | `"HOST"` / `"GUEST"` |
| `ctx.authoritative` | bool | 本机是否跑权威逻辑（= 房主） |
| `ctx.crossScreen` | bool | `true`=分屏，`false`=镜像（见 §2） |
| `ctx.aspect` | float | 世界高度上限（`y ∈ [0, aspect]`），= 屏宽/屏高 |
| `ctx.seed` | int | 本局随机种子（**两端相同**） |
| `ctx.players` | array | `[{seat:0,nick:"…"},{seat:1,nick:"…"}]` |
| `ctx.options` | object | 房主配置的游戏参数，值均为**字符串**（见 `01` §3） |
| `ctx.assets` | string[] | manifest 声明的素材清单 |
| `ctx.apiVersion` | int | `1` 或 `2` |
| `ctx.caps` | string[] | 本局启用的能力清单 |
| `ctx.init` | object | 上面 init JSON 的原始对象（极少用） |
| `ctx.canvasW` / `ctx.canvasH` | int | **画布像素**尺寸（含 DPR，每帧刷新） |
| `ctx.unitPx` | float | 1 个世界单位 = 多少**画布像素**（横向） |
| `ctx.dt` | float | 上一帧到这一帧的毫秒数（仅渲染用，逻辑请用 `tick(dt)`） |
| `ctx.x(wx)` | fn | 世界 x → 画布像素 x |
| `ctx.y(wy)` | fn | 世界 y → 画布像素 y |
| `ctx.visible(wx,wy,r)` | fn | 实体（含半径 r）是否在本机可见范围内 → 决定要不要画 |
| `ctx.toWorld(px,py)` | fn | **页面 CSS 像素** → 世界坐标（`PointerEvent.clientX/Y` 可直接传入） |
| `ctx.rng()` | fn | 可复现随机数 `[0,1)`（**逻辑随机必须用它**） |
| `ctx.rng(name)` | fn | 命名随机流：`ctx.rng("animals")` 取一个数；同名同种子两端一致 |
| `ctx.rng.stream(name)` | fn | 取命名随机流**函数**本身（想要 `stream()` 反复调用时用） |

> `ctx.rng` 同时是「函数」和「带 `.stream` 方法的对象」：`ctx.rng()` 取默认流下一个数，`ctx.rng("x")` 取命名流下一个数。
> 还有全局的 `DualArena.makeRng(seed)` 可自建独立 PRNG。

---

## 2. 世界坐标与双屏模式

**世界坐标约定**：`x ∈ [0,1]`，`y ∈ [0, aspect]`，`aspect = 屏宽/屏高`（竖屏约 `1.7~2.0`）。

`crossScreen` 决定两块屏的关系：

| 值 | 模式 | 世界总宽 | 本机可见世界 | 适用玩法 |
|---|:--:|---|---|---|
| `false` | **镜像** | 1（`x∈[0,1]`） | `x∈[0,1]`，**两端画面完全一致** | 抢拍、共斗、同看一块棋盘 |
| `true` | **分屏** | 2（接缝在 `x=1`） | `x∈[originX, originX+1]` | 对射、球类等「空间连续」玩法 |

分屏时：座位 0 的 `originX = 0`（左半），座位 1 的 `originX = 1`（右半），接缝 `x=1`。
`ctx.x()` / `ctx.visible()` 已按本机 `originX` 处理好，所以——

> **写好一份逻辑，两种模式都能对**：你只管把实体放在世界坐标里，
> 分屏时超出本机半场的部分用 `ctx.visible()` 跳过绘制即可。

`init` JSON 里还给了 `originX / visibleMin / visibleMax / seamX`，一般用不到（`ctx` 已封装）。

---

## 3. 坐标换算（照抄即可）

```js
// 世界 → 画布像素
var px = ctx.x(worldX);
var py = ctx.y(worldY);

// 半径（世界单位）→ 像素
var pr = r * ctx.unitPx;

// 是否画（分屏时跳过本机看不到的实体）
if (!ctx.visible(worldX, worldY, r)) return;

// 页面坐标 → 世界坐标（自己接 DOM 事件时才需要；用 predict cap 时 SDK 已代劳）
var w = ctx.toWorld(e.clientX, e.clientY);   // {x, y}
```

**注意**：`ctx.toWorld` 吃的是 **CSS 像素**（`clientX/clientY`），内部用 `canvas.clientWidth/clientHeight`；
而 `ctx.canvasW/canvasH` 是**设备像素**（含 DPR，最高 2.5）。两者不要混用。

---

## 4. 画布与 DPR

- SDK 取 `<canvas id="c">`，按 `dpr = min(devicePixelRatio, 2.5)` 放大其 `width/height`，
  并在窗口 `resize` 时自动重设；
- 你的 `render` 里请按 `ctx.canvasW/canvasH` 作画（已含 DPR），**不要**自己去乘 dpr；
- 清屏用 `ctx.canvasW/H`：
  ```js
  c.fillStyle = "#05070f";
  c.fillRect(0, 0, ctx.canvasW, ctx.canvasH);
  ```

---

## 5. 举例：同一份逻辑跑镜像与分屏

```js
// 让一个球在世界里左右弹（世界宽 = crossScreen ? 2 : 1）
function worldWidth(ctx) { return ctx.crossScreen ? 2 : 1; }

tick: function (dt) {
  var w = worldWidth(this.ctx), r = 0.03;
  this.x += this.vx * dt / 1000;
  if (this.x < r) { this.x = r; this.vx = Math.abs(this.vx); }
  if (this.x > w - r) { this.x = w - r; this.vx = -Math.abs(this.vx); }
}

render: function (now, ctx, c) {
  if (!ctx.visible(this.x, this.y, 0.05)) return;   // 分屏时只画本机那半
  var px = ctx.x(this.x), py = ctx.y(this.y), pr = 0.03 * ctx.unitPx;
  c.fillStyle = "#4ff";
  c.beginPath(); c.arc(px, py, pr, 0, Math.PI * 2); c.fill();
}
```
