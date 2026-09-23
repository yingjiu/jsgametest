# dual-arena-js-game

「双屏竞技场」(Dual-Arena) 的 **HTML/JS 小游戏开发 Agent Skill** —— 两台手机本地联机对战平台的游戏开发规范、
SDK 契约、示例、模板与自测工具，自包含、不依赖宿主工程源码。

## 安装

放到技能目录即可（二选一）：

```bash
# 用户级：所有项目可用
~/.codebuddy/skills/dual-arena-js-game/

# 项目级：随仓库共享
<项目>/.codebuddy/skills/dual-arena-js-game/
```

Windows 用户级目录：`%USERPROFILE%\.codebuddy\skills\dual-arena-js-game\`

## 内容

| 路径 | 说明 |
|---|---|
| `SKILL.md` | 技能入口：三条铁律 + 开发工作流 + 资源索引（agent 自动加载） |
| `references/01..10` | 规范细节：清单、钩子契约、坐标、同步、caps、HUD/结算、性能、调试、坑、自检 |
| `scripts/preview/` | `smoke-test.js`（Node 冒烟测试）、`index.html`（浏览器预览壳）、`dual-arena-sdk.js`（**权威 SDK 源码**） |
| `assets/template/` | 新游戏骨架（`manifest.json` + `index.html` + `game.js`） |
| `assets/examples/` | 完整示例：`neonstars`（镜像·无 caps）、`bowduel`（分屏·全部 6 个 caps） |

## 快速验证

```bash
cd scripts/preview
node smoke-test.js ../../assets/template/game.js
node smoke-test.js ../../assets/examples/bowduel/game.js
# 退出码 0 = 通过
```

浏览器预览（无需安卓）：

```bash
cd scripts/preview
python -m http.server 8000     # 打开 http://localhost:8000/
# 可用参数：?seat=1（分屏看右半场）、?cross=1、?aspect=1.6、?seed=123
```

## 一句话运行模型

房主端跑权威逻辑（`tick` / `onInput` / `serialize`），平台按 ~30Hz 下发给客人；
客人端只 `applyState` + `render`。两端共用同一份渲染代码，所以只用**世界坐标**写逻辑即可。

**三条铁律**：逻辑随机只用 `ctx.rng()`、逻辑计时只用 `tick(dt)` 的 `dt`、客人端不推进逻辑。

---

`references/*` 与 `assets/examples/*` 里出现的「doc/JS游戏开发规范.md」等路径是历史引用，可忽略。
