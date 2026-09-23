# 01 · 包结构与 manifest.json

## 1. 一个游戏 = 一个文件夹

```
mygame/                     文件夹名建议 = id（纯英文小写/数字/下划线）
├── manifest.json           【必填】元数据，平台据此识别与校验
├── index.html              【必填】入口页，名字须与 manifest.entry 一致
├── game.js                 你的逻辑（可拆多个 js）
├── cover.png               可选封面（建议 512×288），manifest.cover 指向它
└── img/…  audio/…          其它素材，用相对路径引用
```

- 入口页**不要** `<script src="dual-arena-sdk.js">` —— SDK 由平台在页面加载完成后自动注入并调用 `DualArena.boot()`。
- 入口页**必须**有一个 `<canvas id="c">`（没有则 SDK 会自动建一个并追加到 `<body>`），并让它铺满屏幕：
  ```html
  <style>
    html,body{margin:0;padding:0;height:100%;background:#05070f;overflow:hidden}
    #c{position:fixed;inset:0;width:100%;height:100%;display:block;touch-action:none}
  </style>
  <canvas id="c"></canvas>
  ```
- 引用素材一律**相对路径**（`cover.png`、`img/x.png`），平台已放开 `file://` 域互访。

---

## 2. manifest.json 全字段

对应平台的 `GameManifest`。**字段名区分大小写，未知字段会被忽略。**

| 字段 | 类型 | 必填 | 说明 |
|---|:--:|:--:|---|
| `id` | string | ✅ | 全局唯一，进网络包，**定下来就别改** |
| `name` | string | ✅ | 显示名（可中文） |
| `subtitle` | string | ✅ | 一句话副标题（卡片上显示） |
| `description` | string | ✅ | 较长玩法介绍（详情页），可用 `\n` 分段 |
| `version` | int | ✅ | 游戏自身版本，从 `1` 起。**改任何内容都要 +1**（见 §5） |
| `forceUpdate` | bool | ⬜ | **大版本更新标记**：`true` 时客户端必须更新（不可跳过，弹强制更新提示）；缺省 `false`（普通更新，可稍后）。用于"不强制就没人更"的大改版 |
| `apiVersion` | int | ✅ | 平台 SDK 版本。**必须 `1` 或 `2`**（当前支持区间 `1..2`）。新游戏一律写 `2` |
| `caps` | string[] | ⬜ | **v2**：声明需要的能力模块，见 `05`。只能取 `clock/streams/interp/ev/predict/assets` |
| `options` | array | ⬜ | **v2**：房主开局前可调参数（如回合时长），见 §3 |
| `assets` | string[] | ⬜ | **v2**：素材相对路径清单（供 `assets` cap 预载），见 §4 |
| `minPlayers` | int | ✅ | 支持最少人数：**1~12**。1=单机离线即可玩；2~12=多人（2 人=双机分屏，3~12=多机竖带拼接或单机多指）。**必须与 `maxPlayers` 配合且 `min ≤ max`** |
| `maxPlayers` | int | ✅ | 支持最多人数：**1~12**，且 `≥ minPlayers` |
| `crossScreen` | bool | ✅ | `false`=镜像同屏；`true`=分屏（见 `03` §2） |
| `orientation` | string | ⬜ | 画面方向（与 `crossScreen` 正交）：`"portrait"`(默认) / `"landscape"` / `"sensor"`(横竖皆可)。平台据此锁定 `GameActivity` 屏幕方向，多端经 `PluginManifestMsg` 同步一致；非法值回落竖屏 |
| `tags` | string[] | ⬜ | 标签，如 `["反应","对抗","休闲"]` |
| `runtime` | string | ✅ | Web 游戏固定 `"web"` |
| `entry` | string | ✅ | 入口文件，固定 `"index.html"` |
| `clazz` | string | ⬜ | 仅原生(dex)插件用，**Web 游戏留空** |
| `cover` | string | ✅ | 封面路径（相对包内）。**必填**——平台据此在游戏列表/详情展示，缺省视为不合格。格式支持 `svg`（矢量，**首选**）/`png`/`jpg`/`jpeg`/`webp`，建议 512×288；平台对 `svg` 会以 `image/svg+xml` 正确下发，客户端与管理端均能渲染。 |

> **方向正交性**：`orientation` 与 `crossScreen` 互不影响。镜像(`false`)和分屏(`true`)游戏都能声明横屏/竖屏/自适应；横屏分屏游戏由两台手机各自横过来并排，`crossScreen` 的世界映射只认世界坐标、不认物理朝向，逻辑不受影响。

> ⚠️ 没有 `sha256` 字段：分发哈希由平台自动计算，**不要手写**。

### 校验规则（平台安装时执行，任一不过整包被拒）

1. `id` 不能为空；
2. `apiVersion` 必须落在 `1 ~ 2`；
3. `runtime = "web"` 时，`entry` 指向的文件必须存在；
4. `minPlayers`/`maxPlayers` 必须落在 `1 ~ 12`，且 `minPlayers ≤ maxPlayers`（超出则服务端拒收）。

其余字段即使缺失也只会走默认值（不会拒绝安装），但**强烈建议全部填齐**以免列表/详情页显示异常。

---

## 3. `options`：房主可调的玩法参数

房主在「创建房间」页调整 → 随房间广播 → 注入游戏的 `ctx.options`（**两端一致**，晚加入的客人也能拿到）。
目前 `type` 只支持 `"enum"`（下拉选择）。

```json
"options": [
  {
    "key": "roundMs",
    "type": "enum",
    "label": "回合时长",
    "def": "90000",
    "choices": [
      { "value": "60000", "label": "60 秒" },
      { "value": "90000", "label": "90 秒" },
      { "value": "120000", "label": "120 秒" }
    ]
  }
]
```

| 字段 | 说明 |
|---|---|
| `key` | 取值键，游戏里用 `ctx.options[key]` 读 |
| `type` | 固定 `"enum"` |
| `label` | 界面显示名 |
| `def` | 默认值（**字符串**） |
| `choices[]` | 选项：`value`（字符串，游戏自己解析）、`label`（显示名） |

**取值永远是字符串**，游戏侧自己转数字：

```js
var roundMs = parseInt(ctx.options.roundMs || "90000", 10);
```

---

## 4. `assets`：素材清单（配合 `assets` cap）

```json
"assets": ["animals/rabbit.png", "animals/deer.png"]
```

- 仅声明在 `assets` 里的路径会被 `DualArena.assets.load()` 预加载；
- **路径不存在也没关系**：加载失败返回 `null`，游戏必须能在 `null` 时回落到矢量绘制（这是硬性要求，保证"没素材也能跑"）。
- 清单同时下发到 `ctx.assets`，便于游戏自行遍历。

---

## 5. 【最高频踩坑】改了文件不升 `version` = 没改

平台决定「是否覆盖设备上那份内置包」的**唯一依据是 `manifest.version`**（不是文件内容、不是修改时间）：

- 你改了 `game.js / index.html / 素材 / 说明` 任意一项，只要 `version` 没变 → 安装时判定「内置版本不高于已装」→ **跳过**；
- 现象：重新打包、重装 App、重启手机……**画面/逻辑"还是没变"**。

> **规则：每次改动游戏文件夹里的任何文件，都必须把 `manifest.json` 的 `version` 加 1。**
> 连只改 `name`/`description` 也必须 +1，否则游戏列表里也看不到。

### 5.1 服务端「同版本重传 = 覆盖更新」

分发服务端支持**同一 `version` 再次上传**即覆盖更新：包体与版本行的 `size`/`sha256` 会被刷新。
**客户端用内容指纹 `sha256` 判断**，而非只看版本号——已装 `sha256` 与服务端下发的 `sha256` 不一致即视为「重新上传」，从而自动更新并提示（toast）。
因此「想让设备立刻拿到新内容」可以重传同版本，但**更规范的做法仍是升 `version`**（便于回滚与历史记录）。

### 5.2 大版本强制更新

当你做了不兼容的大改版、希望所有客户端**必须**更新时，在 manifest 里写 `"forceUpdate": true`：
服务端会在索引里把它下发给客户端，客户端遇到 `forceUpdate && 本地 sha256 ≠ 服务端` 即弹**不可跳过**的强制更新提示（多人开局前也会据此拦截版本不一致的玩家）。普通小更新保持 `false`（可稍后）。
