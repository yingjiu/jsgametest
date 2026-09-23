---
name: dual-arena-js-game
description: Develop, review, and debug HTML/Canvas games for the 双屏竞技场 (Dual-Arena) two-phone local-multiplayer platform. This skill should be used when creating or modifying a web game bundle (manifest.json + index.html + game.js), implementing the game-object hooks (init/onStart/tick/onInput/serialize/applyState/render/hud/isFinished/result), using SDK v2 capability modules (clock/streams/interp/ev/predict/assets), diagnosing two-player desync (Math.random or Date.now used in logic, logic running on the guest side), or validating and shipping a game (Node smoke test, browser preview, manifest version bump). Trigger on: 双屏竞技场, dual-arena, dualarena, jsgame, JS 游戏, web 游戏, 网页游戏, 新建游戏, 加一款游戏, manifest.json, game.js, dual-arena-sdk, 游戏插件, crossScreen, 镜像模式, 分屏模式, 房主/客人同步. HARD RULE: the only deliverable is exactly ONE self-contained offline single-page HTML/JS bundle (manifest.json + index.html + game.js + optional assets) — NO React/Vue/Svelte/TypeScript/Vite/Webpack/Express/Node, NO npm install / package.json / node_modules / bun.lock, NO CDN or third-party libs, NO custom DOM modals/toasts/hints/tutorials/rules-panels/combat-logs; all HUD/score/result UI MUST be returned via the platform hud()/result() hooks, never self-drawn. The game runs inside a phone WebView with no build step and no server.
---

# 双屏竞技场 · JS 游戏开发

## Overview

为「双屏竞技场」平台开发 HTML + JS 小游戏：两台手机组成一个房间（房主 HOST / 客人 GUEST），
游戏跑在 WebView 里自绘到 `<canvas>`，平台负责连接、世界坐标、双屏映射、房主权威同步、倒计时闸门、HUD 与结算。

**运行模型**：房主跑权威逻辑（`tick` 推进、`onInput` 处理触摸、`serialize` 出状态），平台按 ~30Hz 下发给客人；
客人只 `applyState` + `render`，并把本机触摸上报给房主。两端**共用同一份渲染代码**，所以只用「世界坐标」写逻辑即可。

**权威依据**是 `scripts/preview/dual-arena-sdk.js`（平台实际注入的 SDK 源码）。任何文档与它冲突，以代码为准。

## 交付物格式铁律（一票否决，优先级高于一切玩法描述）

你产出的**唯一交付物**是一个**自包含、纯前端、可离线运行**的游戏文件夹：

```
<id>/
├── manifest.json     # 必填：元数据，平台据此识别与校验
├── index.html        # 必填：入口页（含铺满屏幕的 <canvas id="c">）
├── game.js           # 必填：你的全部游戏逻辑（纯 JavaScript，ES5/ES6 均可）
├── cover.svg         # 必填：封面（矢量 SVG 首选，也可 png/jpg），`manifest.cover` 指向它
└── （可选）其它素材   用相对路径引用
```

它是跑在**手机 WebView 里的单页离线游戏**：没有构建步骤、没有后端服务、没有网络请求。
**不是网站、不是 Web 应用、不是服务端项目、不是 App 工程。**

**封面必填**：必须提供 `cover.svg`（矢量首选）或 `cover.png`/`cover.jpg`，并在 `manifest.cover` 指向它。平台用它展示在游戏列表/详情，客户端与管理端都依赖它渲染（平台对 SVG 以 `image/svg+xml` 正确下发）。

### 严禁清单（任意一条出现 = 废稿，必须重做）

- ❌ **任何框架 / 构建工具 / 服务**：React / Vue / Svelte / Angular、TypeScript（`.ts` / `.tsx`）、
  Vite / Webpack / esbuild / Rollup / tsc、`Express` / `Koa` / 任何 Node HTTP 服务、
  `npm install`、CDN `<script>`、`<link>` 在线字体/图标、`package.json`、`node_modules`、
  `bun.lock`、`tsconfig.json`、`vite.config.*`、`server.*`、`src/`、`components/`、`*.tsx`。
- ❌ **任何自建 DOM / HTML UI 覆盖层**：modal 弹窗、toast 卡片、drawer 抽屉、规则/帮助/教程弹窗、
  战况/战斗日志面板、设置页、联机大厅 UI、嘲讽/互动表情条、开始/等待遮罩。
- ❌ **任何"提示 / 引导 / 教程"浮层或长文案**：开场说明、操作教学、实时伤害结算卡片、
  飘字伤害数字、暴击提示、喊话气泡——这些都**不要自己画**，会让画面盖满、干扰对战观感。
- ❌ **把 `dual-arena-sdk.js` 放进游戏包或自己 `<script>` 引入**：SDK 由平台注入，自带会冲突/重复加载。
- ❌ **依赖任何外部库 / 网络**：无 `import` 第三方包、无 `fetch` 外部资源、无在线字体/图标 CDN、无 WebSocket 自建服务。
- ❌ **多文件复杂工程或"开发版/预览版/交付版"多套目录**：只交**一份**
  `manifest.json + index.html + game.js（+ 可选素材）`。

> ⚠️ **反例（禁止）**：不要产出 `src/App.tsx`、`server.ts`、`package.json`、`node_modules`、
> Vite 配置、Express 联机服务，也不要在页面里堆 modal/toast/规则弹窗/战况面板/飘字嘲讽。
> 那类"完整前端工程 + 一堆提示浮层"正是本技能要杜绝的跑偏产物。

### 平台已经替你画好的 UI（你只返回数据，绝不再画一遍）

| 你想要的表现 | 正确做法（返回数据） | 错误做法 |
|---|---|---|
| 血条、比分 `A:B`、一行提示 | `hud()` 返回 `hp[]` / `scores[]` / `tip` | 在 canvas 或 DOM 自建血条/比分/提示条 |
| 回合结束结算、再来一局 | `isFinished()` + `result()` 返回数据 | 自建结算弹窗 |
| 倒计时 / 连击 / 瞄准线 / 准星 / 特效 | 画在 `render()` 的 canvas 上 | —— |

> 一句话：**你的代码只负责 canvas 渲染 + 逻辑 + 通过 `hud()`/`result()` 返回 HUD/结算数据。**
> 凡是要"画 UI 控件"的冲动，都改用上面三种平台机制。详见 `references/06`。

## 三条铁律（违反必出双端不一致）

1. 逻辑随机**必须**用 `ctx.rng()`（或 `ctx.rng("name")`），**禁止** `Math.random()` 参与逻辑。
2. 逻辑计时**必须**用 `tick(dt)` 的 `dt`，**禁止** `Date.now()` / `performance.now()` 做判定。
3. **客人端不得推进逻辑**：只 `applyState` + `render`；一切"推进"都写在 `tick` 里。

## 开发工作流

1. **复制骨架**：把 `assets/template/` 复制成新游戏目录，改 `manifest.json` 的 `id`/`name`。
   （参照 `assets/examples/` 里最接近目标玩法的一款，不要自创架构：镜像看 `neonstars`，分屏看 `bowduel`。）
2. **实现钩子**：按 `references/02-游戏对象契约.md` 实现十个钩子；用 `references/03-ctx与坐标.md` 的 `ctx` 写坐标；
   需要的能力先写进 `manifest.caps`，再按 `references/05-能力模块-caps.md` 使用。
3. **冒烟测试**（必做，秒级）：
   ```bash
   cd <skill根目录>/scripts/preview
   node smoke-test.js ../../assets/template/game.js
   ```
   自动读同级 `manifest.json` 取 caps/crossScreen/回合时长；退出码 0 通过、1 有失败。
4. **浏览器预览**（看画面与手感）：
   ```bash
   cd <skill根目录>/scripts/preview
   python -m http.server 8000     # 打开 http://localhost:8000/
   ```
   - 单人/单座：`http://localhost:8000/`（默认 seat=0）。
   - **多人开测（无需真机互联）**：`http://localhost:8000/preview-multi.html?players=4` —— 一页内用 iframe 跑 N 个「设备」（座位 0..N-1），父页面当迷你中继在座位间转发输入/快照，**等价真机互联**，可本地验证多人同步/开局。详见 `references/12-网页多人自测.md`。
   - 单座调试参数：`?seat=1`（分屏看右半场）、`?cross=1`、`?aspect=1.6`、`?seed=123`。
5. **交付**：产出 = 一个游戏文件夹（`manifest.json` + `index.html` + js/素材）。
   **必须严格符合上方「交付物格式铁律」**：纯 `game.js`、零框架、零构建、零自建 UI、零外部依赖。
   **改动任何文件都必须把 `manifest.version` 加 1**，否则设备上不更新（见 `references/01` §5）。
   人数范围填 `1~12`（`minPlayers ≤ maxPlayers`，1=单机离线、2~12=多人，见 `references/01`）；大改版在 manifest 设 `"forceUpdate": true` 触发客户端强制更新。
6. **过自检**：逐条核对 `references/10-交付前自检CHECKLIST.md`。

## 资源位置

| 路径 | 用途 |
|---|---|
| `scripts/preview/smoke-test.js` | Node 冒烟测试：打桩 Arena + canvas，驱动真实 SDK 跑帧并断言 |
| `scripts/preview/index.html` | 浏览器预览壳（打桩 `Arena`），无需安卓即可看画面 |
| `scripts/preview/dual-arena-sdk.js` | 平台注入的 SDK —— **权威 API 源码**（只读参考，不要在自己页面里引用） |
| `assets/template/` | 新游戏骨架（`manifest.json` + `index.html` + `game.js`），直接复制改名 |
| `assets/examples/neonstars/` | 完整示例：镜像同屏、无 caps、客人端本地插值 |
| `assets/examples/bowduel/` | 完整示例：分屏对射、v2 全部 6 个 caps（多文件游戏） |
| `references/01..10` | 规范细节（见下表） |

## 参考资料索引（按需读取）

| 主题 | 文档 |
|---|---|
| 文件夹结构、`manifest.json` 全字段与校验、`version` 规则 | `references/01-包结构与清单-manifest.md` |
| 十个钩子的签名与调用时机、生命周期时序、输入参数 | `references/02-游戏对象契约.md` |
| `ctx` 全字段、世界坐标、镜像/分屏、像素与 DPR 换算 | `references/03-ctx与坐标.md` |
| 房主权威、随机、时间、开始闸门、本地插值 | `references/04-同步铁律.md` |
| `clock/streams/interp/ev/predict/assets` 的精确 API | `references/05-能力模块-caps.md` |
| `hud()` / `result()` 结构与原生 UI 分工 | `references/06-HUD与结算.md` |
| 素材回落、`shadowBlur` 陷阱、快照体积 | `references/07-素材与性能.md` |
| 预览壳与冒烟测试用法、真机 logcat 排障 | `references/08-调试与自测.md` |
| 症状 → 原因 → 正确做法速查 | `references/09-常见坑清单.md` |
| 交付前逐条核对 | `references/10-交付前自检CHECKLIST.md` |

## 写代码时的硬性约束（易漏）

- `index.html` **不要**自己引用 `dual-arena-sdk.js`（平台注入）；画布必须是 `<canvas id="c">` 且铺满屏幕。
- `manifest.apiVersion` 新游戏写 `2`；只有 `caps` 里声明过的能力才会被启用（未声明时 `DualArena.ev` 等为 `undefined`）。
- `hud()` 的 `hp`/`scores` **按座位索引**（`[座位0, 座位1]`），不要按"我/对手"排，否则客人端左右颠倒。
- `onInput` 判定类玩法只处理 `a === 0`；`seat` 是**事件来源座位**，直接用它索引状态。
- `serialize()` 只管必要字段并压缩浮点；纯视觉粒子限量同步，否则对端会卡（见 `references/07`）。
- `assets` 里的素材缺失会返回 `null`，**必须**回落到矢量绘制，保证"没素材也能跑"。
- **严禁自建任何 DOM / HTML UI**（modal / toast / 规则·帮助·教程弹窗 / 战况·战斗日志面板 / 联机大厅 / 嘲讽表情条）。HUD 用 `hud()`、结算用 `result()`、倒计时/连击/瞄准线画在 canvas 上。凡要"画 UI 控件"的冲动都改用这三种平台机制（见 `references/06`）。
- `manifest.orientation`（`portrait` / `landscape` / `sensor`）只决定客户端锁定的屏幕方向，**与坐标逻辑无关**——游戏一律用世界坐标写，横屏分屏游戏把手机横过来并排即可，`ctx.players.length` 仍按座位数取竖带（见 `references/01`）。

## 交付约定

游戏文件夹（`manifest.json` + `index.html` + js/素材）交给平台方集成；集成方将其内置进 App
（`assets/bundles/<id>/`），App 启动时按 `manifest.version` 决定是否覆盖设备上那份。
因此**版本号 +1 是唯一的"更新开关"**，同时也要在房间里确认：倒计时后两端同刻开跑、比分一致、无 `applyState err:`。

> `assets/examples/*` 的注释里出现的「doc/JS游戏开发规范.md」等路径是历史引用，可忽略。
