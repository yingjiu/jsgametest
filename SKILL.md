---
name: dual-arena-js-game
description: Develop, review, and debug HTML/Canvas games for the 双屏竞技场 (Dual-Arena) two-phone local-multiplayer platform. This skill should be used when creating or modifying a web game bundle (manifest.json + index.html + game.js), implementing the game-object hooks (init/onStart/tick/onInput/serialize/applyState/render/hud/isFinished/result), using SDK v2 capability modules (clock/streams/interp/ev/predict/assets), diagnosing two-player desync (Math.random or Date.now used in logic, logic running on the guest side), or validating and shipping a game (Node smoke test, browser preview, manifest version bump). Trigger on: 双屏竞技场, dual-arena, dualarena, jsgame, JS 游戏, web 游戏, 网页游戏, 新建游戏, 加一款游戏, manifest.json, game.js, dual-arena-sdk, 游戏插件, crossScreen, 镜像模式, 分屏模式, 房主/客人同步.
---

# 双屏竞技场 · JS 游戏开发

## Overview

为「双屏竞技场」平台开发 HTML + JS 小游戏：两台手机组成一个房间（房主 HOST / 客人 GUEST），
游戏跑在 WebView 里自绘到 `<canvas>`，平台负责连接、世界坐标、双屏映射、房主权威同步、倒计时闸门、HUD 与结算。

**运行模型**：房主跑权威逻辑（`tick` 推进、`onInput` 处理触摸、`serialize` 出状态），平台按 ~30Hz 下发给客人；
客人只 `applyState` + `render`，并把本机触摸上报给房主。两端**共用同一份渲染代码**，所以只用「世界坐标」写逻辑即可。

**权威依据**是 `scripts/preview/dual-arena-sdk.js`（平台实际注入的 SDK 源码）。任何文档与它冲突，以代码为准。

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
   支持 `?seat=1`（分屏看右半场）、`?cross=1`、`?aspect=1.6`、`?seed=123`。
5. **交付**：产出 = 一个游戏文件夹（`manifest.json` + `index.html` + js/素材）。
   **改动任何文件都必须把 `manifest.version` 加 1**，否则设备上不更新（见 `references/01` §5）。
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

## 交付约定

游戏文件夹（`manifest.json` + `index.html` + js/素材）交给平台方集成；集成方将其内置进 App
（`assets/bundles/<id>/`），App 启动时按 `manifest.version` 决定是否覆盖设备上那份。
因此**版本号 +1 是唯一的"更新开关"**，同时也要在房间里确认：倒计时后两端同刻开跑、比分一致、无 `applyState err:`。

> `assets/examples/*` 的注释里出现的「doc/JS游戏开发规范.md」等路径是历史引用，可忽略。
