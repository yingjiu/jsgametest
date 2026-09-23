# 05 · 能力模块（caps）

SDK 分两层：**互联内核**（永远存在）+ **能力模块**（按 manifest 声明装配）。
**只有声明过的能力才会被启用**，没用到的能力不会给你增加负担，老游戏（`apiVersion:1`）不声明 caps 也照常运行。

## 声明与探测

```json
{ "apiVersion": 2, "caps": ["clock", "streams", "ev", "interp", "predict", "assets"] }
```

```js
DualArena.apiVersion      // 2
DualArena.caps            // ["clock", ...]
DualArena.cap("ev")       // true/false
DualArena.ev              // 未声明时为 undefined
```

可用取值：`clock` `streams` `interp` `ev` `predict` `assets`（写错的名字会被忽略并打日志 `unknown cap: xxx`）。

---

## 1. `clock` — 固定步长逻辑

| 接口 | 值 |
|---|---|
| `DualArena.clock` | `{ step: 1000/60, maxCatchUp: 5 }` |

**你不需要调用它。** 声明后内核会把 `tick(dt)` 改为以固定步长 `step` 调用（最多一次补 5 步），
逻辑与帧率解耦：30fps / 60fps / 120fps 下物理表现一致。

- 建议所有游戏都声明 `clock`；
- 未声明时 `tick(dt)` 是可变的渲染间隔，物理对帧率敏感。

---

## 2. `streams` — 命名确定性随机流

```js
DualArena.streams.stream(name)   // → rng 函数
// 等价写法（更常用）：
ctx.rng()               // 默认流取一个数 [0,1)
ctx.rng("animals")      // 命名流取一个数
ctx.rng.stream("animals") // 命名流函数（可反复调用）
```

同名 + 同种子 → 两端得到**完全相同**的序列。用途：把不同系统的随机分开，互不干扰。

```js
// 逻辑用“animals”流，特效抖动用“fx”流 —— 改动特效不会打乱逻辑随机
var a = ctx.rng("animals");
var jitter = ctx.rng.stream("fx")() * 2 - 1;
```

> ⚠️ 同一条流里"多取/少取一次数"都会让它**之后的所有值错位**。所以：**只在两端都会执行的代码里取数**
> （即只在 `tick`/`init` 里，不要在 `render` 里取逻辑随机）。

---

## 3. `interp` — 通用插值（客人端消除跳变）

```js
DualArena.interp.merge(cur, inc, opts)   // → 合并后的新列表
DualArena.interp.step(list, dt, opts)    // 就地逼近目标
```

`opts`：`{ key:'id', lerp:['x','y'], snap:0.25 }`
（`key` 默认 `'id'`；`lerp` 默认 `['x','y']`；`snap` 默认 `0.25`，位移超过它视为跳变→直接落点）

- `merge`：把权威列表 `inc` 并入本地列表 `cur`。命中同 `key` 的沿用**当前位置**，并把目标值写进 `it.__t[字段]`；
  未命中则原样加入；`inc` 里没有的条目被丢弃。
- `step`：每帧调用，用**与帧率无关的指数逼近**把 `list[i][字段]` 推向 `__t[字段]`。

```js
// 客人端
applyState: function (o) {
  this.ents = DualArena.interp.merge(this.ents || [], o.ents, { key: "id", lerp: ["x", "y"] });
},
render: function (now, ctx, c) {
  var dt = now - (this._t || now); this._t = now;
  if (!ctx.authoritative) DualArena.interp.step(this.ents, Math.min(dt, 100), { lerp: ["x", "y"] });
  // 画 this.ents（房主端 x/y 就是真值，客人端已被平滑）
}
```

**约束**：权威状态里每个实体的 `key` 字段必须存在且稳定（如 `id`）。

---

## 4. `ev` — 一次性事件通道（房主→客人）

```js
DualArena.ev.emit(type, data)    // 房主：本地立即触发一次，同时排队随快照下发
DualArena.ev.on(type, fn)        // 两端：订阅
```

- 专治「一次性表现」：命中特效、爆炸、扣血提示、音效触发——**不该放进每帧状态**的东西。
- `emit` 在**房主端会立即在本机触发一次**（保证房主自己也看到），随后随快照下发到客人；
- 客人端收到时自动触发（搭在状态载荷里，与快照**天然同序**）；
- `data` 必须可 JSON 序列化（数字/字符串/数组/对象）；队列上限 64，超出丢弃最旧的。

```js
init: function (ctx) {
  var self = this;
  DualArena.ev.on("hit", function (d) { self.burst(d.x, d.y, 12); });
},
onInput: function (seat, x, y, a) {
  if (a !== 0) return;
  // …判定命中…
  DualArena.ev.emit("hit", { x: x, y: y, seat: seat });
}
```

> ⚠️ `ev` 只在 **apiVersion ≥ 2 且声明了 `ev`** 时生效；未声明时 `DualArena.ev` 为 `undefined`。

---

## 5. `predict` — 客人端零延迟手感

```js
DualArena.predict.onPointer(fn)      // fn(pointer, phase)
DualArena.predict.pointer            // {active,id,x,y,sx,sy,phase,t}
DualArena.predict.spawn(tag, obj)    // 新建"仅本机可见"的预测实体
DualArena.predict.list(tag)          // 该 tag 的数组
DualArena.predict.ack(tag, n)        // 权威已确认前 n 个 → FIFO 丢弃
DualArena.predict.clear(tag)
```

- 声明后 SDK **自动**给画布挂上 `pointerdown/move/up/cancel`（老 WebView 自动回落 touch），
  并把坐标换算成**世界坐标**写进 `pointer`：
  `phase` ∈ `"down" | "move" | "up" | "cancel"`；`pointer.active` 在按下到抬起之间为 `true`；
  `sx/sy` 是本次拖拽起点（适合"拉弓/划线"）。
- 这是客人端"点下去就有反馈"的关键：DOM 事件当帧可拿，**不必等一个 RTT**。

```js
init: function (ctx) {
  var self = this;
  DualArena.predict.onPointer(function (p, phase) {
    if (phase === "down") self.aim = { x: p.x, y: p.y, sx: p.sx, sy: p.sy };
    else if (phase === "up" && self.aim) {
      // 立刻本地生成一支"预测箭"，手感即时；权威箭随后由快照带来
      DualArena.predict.spawn("arrow", { x: self.aim.sx, y: self.aim.sy, tx: p.x, ty: p.y, a: 0 });
    }
  });
}
```

**注意**：
- 画布需可接收指针事件（`touch-action:none`，且不要被全屏遮罩盖住）；
- 预测实体是**纯本地表现**，不要用它判定胜负；权威状态到达后用 `ack(tag, n)` 按 FIFO 对账丢弃；
- 若玩法不需要即时反馈（如抢拍点选），可以不声明 `predict`。

---

## 6. `assets` — 素材加载（缺失回落）

```js
DualArena.assets.load(list, cb)   // 加载一批相对路径；全部完成（含失败）后 cb(map)
DualArena.assets.get(url)         // Image | null
DualArena.assets.isReady()        // 是否已全部加载完
```

- `map[url]` 为 `Image` 或 **`null`**（路径不存在/被拦）；
- **硬性要求**：`null` 时必须回落到矢量绘制，保证"没素材也能跑"。

```js
init: function (ctx) {
  this.imgs = DualArena.assets.load(ctx.assets, function (m) {
    DualArena.log("assets ready: " + Object.keys(m).filter(function (k) { return m[k]; }).length);
  });
},
render: function (now, ctx, c) {
  var img = DualArena.assets.get("animals/rabbit.png");
  if (img) c.drawImage(img, px - w / 2, py - h / 2, w, h);
  else { c.fillStyle = "#8fc31f"; c.beginPath(); c.arc(px, py, r, 0, 7); c.fill(); }  // 回落矢量
}
```

---

## 7. 扩展（了解即可）

SDK 提供 `DualArena.defineCap(name, factory)` 用于新增能力模块（`factory(ctx, D)` 返回该模块的 API）。
但**平台在页面加载完成后才注入 SDK 并立即 `boot()`**，因此游戏自身很难在 boot 前完成注册。
实际做法是**向平台方申请新增 cap**；已装好的 6 个能力一般够用。
