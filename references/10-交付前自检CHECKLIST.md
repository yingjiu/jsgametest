# 10 · 交付前自检 CHECKLIST

交付物 = 一个游戏文件夹。逐条核对后再交付。

## A. 文件与清单

- [ ] 文件夹含 `manifest.json` + `index.html` + 你的 js（必要时素材）
- [ ] `manifest.id` 唯一、纯英文小写/数字/下划线，且与文件夹名一致（建议）
- [ ] `manifest.apiVersion = 2`（新游戏）；`runtime = "web"`；`entry = "index.html"`
- [ ] `manifest.crossScreen` 与实际玩法匹配（镜像 `false` / 分屏 `true`）
- [ ] `manifest.orientation` ∈ `portrait`(默认)/`landscape`/`sensor`（横屏/竖屏/自适应，与 `crossScreen` 无关，详见 `01`）
- [ ] `manifest.minPlayers` / `maxPlayers` ∈ `1~12` 且 `min ≤ max`（1=单机离线、2~12=多人；见 `01`）
- [ ] `manifest.version` 是本次交付的新版本号（**改过就 +1**，见 `01` §5）
- [ ] `caps` 只列出真正用到的能力；用到的能力都声明了
- [ ] 用到的 `options` 都在 manifest 里声明，且游戏侧按**字符串**解析默认值
- [ ] `assets` 列出的路径确实存在（**或者**游戏能在 `null` 时回落矢量绘制）
- [ ] `index.html` **没有**自己引用 `dual-arena-sdk.js`
- [ ] `index.html` 有铺满屏幕的 `<canvas id="c">`
- [ ] **封面必填**：提供了 `cover.svg`（矢量首选）或 `cover.png`/`cover.jpg`，且 `manifest.cover` 指向它（客户端与管理端都靠它展示）

## B. 契约正确性

- [ ] `window.__DUAL_GAME__ = G` 已注册
- [ ] `init(ctx)` 里建好全部初始状态，并保存 `this.ctx = ctx`
- [ ] 逻辑推进**只在** `tick(dt)`；`render` 不改状态
- [ ] 客人端只 `applyState` + `render`，不推进逻辑
- [ ] 逻辑随机全部用 `ctx.rng()`（无 `Math.random()`）
- [ ] 逻辑计时全部用 `dt`（无 `Date.now()` / `performance.now()`）
- [ ] `onInput` 判了 `a`（判定类只处理 `a === 0`），并用 `seat` 索引状态
- [ ] `serialize()` 返回精简结构；`applyState` 能完整还原
- [ ] `hud()` 的 `hp/scores` 长度 = `ctx.players.length`（按座位索引，不再写死 2）
- [ ] `isFinished()` / `result()` 正确，`winner` 用座位号（`-1` 平局）
- [ ] 所有随机/插值实体都有稳定的 `key`（用 `interp` 时）

## C. 坐标与双屏

- [ ] 全部使用世界坐标（`x∈[0,1]`，`y∈[0,aspect]`）；分屏时世界总宽 = `ctx.players.length`（每座位一条竖带，不再写死 2）
- [ ] 绘制前用 `ctx.visible()` 过滤；换算用 `ctx.x()/ctx.y()`/`ctx.unitPx`
- [ ] 分屏模式下已用 `?seat=0` 与 `?seat=1` 分别预览过（左右半场都对）

## D. 性能

- [ ] 无 `shadowBlur` / `filter`
- [ ] `serialize()` 体积小（浮点压缩、粒子限量）
- [ ] 没有自己起 `setInterval` 推进逻辑
- [ ] 60fps 下电脑预览顺畅；真机联调无明显掉帧

## E. 自测记录（写下来）

- [ ] 桌面预览跑通：`boot ok …`，无 `frame err:`，玩法与手感符合设计
- [ ] 真机双端联调：倒计时后**同刻开跑**、比分一致、无 `applyState err:`
- [ ] 覆盖过边界：有人掉线 / 中途返回 / 再来一局，均无异常
- [ ] `adb logcat -s duizhan` 全程无 `err`

## F. 严禁项（任意一条命中 = 废稿，必须重做）

- [ ] 交付物只有 `manifest.json` + `index.html` + `game.js`（+ 可选素材），**没有** `src/`、`components/`、`*.ts` / `*.tsx`
- [ ] **没有** `package.json` / `node_modules` / `bun.lock` / `tsconfig.json` / `vite.config.*` / `server.*`
- [ ] **没有** React / Vue / Svelte / Angular / Express / 任何 Node 服务 / 任何 `npm install`
- [ ] **没有** 自建 DOM/HTML UI：modal、toast、规则/帮助/教程弹窗、战况/战斗日志面板、联机大厅、嘲讽表情条
- [ ] **没有** 飘字伤害数字、暴击提示、喊话气泡等"提示/教程"浮层（这些用 `hud().tip` 或 canvas 表达）
- [ ] 游戏包内**没有** `dual-arena-sdk.js`（不自带、不 `<script>` 引入，由平台注入）
- [ ] **没有** 任何 CDN `<script>` / `<link>` 在线字体图标、`fetch` 外网、`import` 第三方包
- [ ] 血条/比分走 `hud()`、结算走 `result()`、倒计时/连击/瞄准线画在 canvas——**没有重复自绘**

## G. 多人 / 版本一致性 / 强制更新

- [ ] 用 `preview-multi.html?players=N`（见 `12`）在网页里跑过 N 座，多人同步正确、比分对齐、无 `frame err:`
- [ ] `ctx.players.length` 等于 `maxPlayers`；游戏按座位数初始化与渲染，不写死 2
- [ ] `manifest` 的 `minPlayers..maxPlayers` 覆盖了目标玩法（1=单机离线、2=双机、3~12=多机/多指）
- [ ] 大改版需要强制更新时，manifest 写了 `"forceUpdate": true`（否则保持 `false`）
- [ ] 知道「同版本重传 = 服务端覆盖更新」：客户端靠对比 `sha256` 感知重传并自动更新（见 `01` §5.1）

---

## 交付说明模板

> 游戏 id：`xxxx`　版本：`vN`　模式：镜像 / 分屏
> 玩法：一句话
> 用到的 caps：`clock, streams, ev, …`
> 自测：桌面预览（通过）／真机双端（通过）
