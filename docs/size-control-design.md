# 输出尺寸控件重设计（SizeControl）

> 背景：此前「生成 / 编辑」两个面板各自并列展示 **图片尺寸（1K/2K/4K 下拉）**、**自定义尺寸（文本框）**、**宽高比（下拉）** 三个设置。
> 三者语义互斥（最终只会有一个生效），却同时显示，且编辑模式下它们根本不参与请求，属于"看起来能调、实际不生效"的死控件。
> 本设计按 `docs/gpt-image-2.5-size-rules.md` 的调研结论重写这一块，只保留**一个**尺寸入口。

## 1. 旧实现的问题

| 问题 | 说明 |
| --- | --- |
| 三个互斥控件并列 | 用户不知道哪个生效；自定义尺寸会覆盖 `imageSize`，但 `aspectRatio` 又单独发送 |
| 编辑模式控件空转 | `editImage`（Images API）和 `editImageViaChatCompletions` 都没有传尺寸参数 |
| 4K 预设非法 | 旧 4K = `4096x4096`，对 GPT Image 2.5 同时违反「单边 ≤ 3840」与「像素 ≤ 8,294,400」 |
| 自定义尺寸被静默丢弃 | `api.js` 的 `COMMON_PIXEL_SIZES` 白名单只放行 5 个尺寸，其余 `size` 不发送 |
| 参数发错协议 | GPT Image 接口被塞入 `aspect_ratio`、`response_format`、`extra_body.google.image_config`（全是 Gemini 参数） |
| 模型能力未区分 | Gemini / nano-banana 只能给比例 + 档位，GPT Image 才能精确到像素，UI 却对所有模型一视同仁 |

## 2. 设计原则

1. **一个入口**：界面上只有一个「输出尺寸」区块，内部用互斥的模式切换：`沿用原图`（仅编辑）/ `按比例` / `自定义像素`。
2. **模型能力驱动**：选项随模型变化，模型做不到的事情不显示。
3. **规则内置**：GPT Image 的 5 条硬约束（16 倍数 / 单边 ≤ 3840 / 1:3～3:1 / 像素区间 / experimental 提示）在输入时实时校验，非法时禁用生成按钮，并给出最近合法尺寸。
4. **按协议下发**：GPT Image 只发 `size: "WIDTHxHEIGHT"`；Gemini / nano-banana 只发 `aspect_ratio` + `image_size` 档位。
5. **可回退**：旧 `localStorage` 的 `imageSize` / `aspectRatio` 自动迁移到新配置。

## 3. 状态模型

单一状态（`src/App.jsx`）：

```js
sizeConfig = {
  mode: 'preset' | 'custom' | 'source', // 按比例 / 自定义像素 / 沿用原图
  ratio: '16:9',   // preset 模式使用
  tier: '2K',      // preset 模式使用：1K / 2K / 4K
  width: 2816,     // custom 模式使用
  height: 1584,
}
```

`resolveOutputSize(config, model, mode, sourceSize)` 把它解析成接口参数：

默认 `mode = 'source'`：编辑模式默认沿用原图（旧版编辑其实也从不传尺寸），生成模式没有原图，会自动按 `ratio + tier` 解析成预设尺寸（默认 1:1 / 1K = `1024x1024`）。

| 模型类型 | 判定 | preset | custom | source（仅编辑） |
| --- | --- | --- | --- | --- |
| GPT Image 2 / 2.5（`gpt-image-2*`） | `kind = 'openai'`，严格校验 | `size: "WxH"`（查档位表） | `size: "WxH"`（按 R1～R4 校验） | 不传 `size`，由编辑接口沿用输入 |
| GPT Image 1 / 1.5 / mini（`gpt-image-1*`） | 只支持 3 个标准尺寸 | `size` 固定为 `1024x1024` / `1536x1024` / `1024x1536` | 不提供 | 不传 |
| Gemini / nano-banana（`gemini-*`、`nano-banana*`） | `kind = 'google'` | `extra_body.google.image_config.aspect_ratio` + `image_size: "1K"/"2K"/"4K"` | 不提供（无法精确到像素） | 不传，模型沿用原图 |
| 其他自定义模型 | `kind = 'openai'`，软校验 | `size: "WxH"` | 只拦非正整数，其余给出提示 | 不传 |

> `nano-banana-2-2k` / `nano-banana-2-4k` 的档位由模型名固定，档位按钮锁定并提示。

## 4. 界面结构

```
输出尺寸                            1024 × 1024 · 1:1      ← 当前实际值（不合法时显示「尺寸不合法」）
[沿用原图][按比例][自定义像素]                                ← 互斥模式，按模型/模式动态出现
比例  [1:1][4:3][3:4][16:9]                                   ← 11 个比例，带比例小图示
      [9:16][3:2][2:3][5:4]
      [4:5][21:9][9:21]
清晰度 [1K 1024×1024][2K 2048×2048][4K 2880×2880]             ← 直接展示解析后的像素
或 自定义：[ 1152 ] × [ 2048 ] px                             ← 实时校验 + 「使用最近的合法尺寸」
底部提示：GPT Image 2.5：宽高须为 16 的倍数，单边 ≤ 3840 …
```

- 比例与清晰度是**同一件事的两级**：`比例 × 档位 → 具体像素`，不再出现独立的"图片尺寸"下拉。
- 自定义像素单独占一屏，合法后显示「尺寸合法，可以生成」。
- 选择 2K / 4K 档位时提示「像素数超过 2560×1440，属于官方标注的 experimental 区间」；1K 档不提示（1K 的 11 个预设像素数都不超过阈值）。

## 5. 校验与兜底（`src/lib/imageSize.js`）

- `validateSize(w, h, { strict })`：R1 16 倍数、R2 单边 ≤ 3840、R3 比例 1:3～3:1、R4 像素 655,360～8,294,400、R5 experimental 提示；`strict=false` 时除非法整数外都降级为提示（供未验证的第三方模型使用）。
- `suggestLegalSize(w, h)`：在目标比例/目标像素附近搜索 16 倍数候选，返回最近合法尺寸（如 `1080×1920 → 1088×1936`），一键替换。
- `parseSize` 兼容 `800:800` / `800x800` / `800×800` / `800*800` / `1K` 等写法。
- `migrateLegacySizeConfig`：旧 `imageSize=2048x2048` → `{mode:'source', ratio:'1:1', tier:'2K'}`（生成模式按 1:1 / 2K 解析成 `2048x2048`，编辑模式沿用原图）；旧版 `4096x4096` 不在当前档位表里，会映射到 `1:1 / 4K`（`2880x2880`），避免老用户从 4K 静默掉到 1K；旧自定义尺寸同样会吸附到最接近的合法档位，想保留原像素可在界面切到「自定义像素」重填。

## 6. 文件改动

| 文件 | 改动 |
| --- | --- |
| `src/lib/imageSize.js` | 新增：档位表、校验、模型能力、请求参数解析、迁移 |
| `src/components/SizeControl.jsx` | 新增：单入口尺寸控件（比例宫格 + 档位 + 自定义像素 + 原图） |
| `src/components/ControlPanel.jsx` | 生成/编辑两个面板的 3 个尺寸控件 → 1 个 `SizeControl`；尺寸非法时禁用生成按钮 |
| `src/App.jsx` | `imageSize` + `aspectRatio` → 单个 `sizeConfig`；按模型解析请求参数；编辑模式真正下发尺寸；删除图层尺寸自动回填逻辑（改为"沿用原图"模式动态读取）；统一使用 `imageSize.js` 的 `isChatImageModel`（原路由与能力判定是两份实现） |
| `src/lib/api.js` | `generateImage` 只发 `prompt/model/n/size`；`editImage` 支持 `size`；Gemini chat 接口补 `extra_body`；移除 `response_format` 与白名单 |

## 7. 验证记录（2026-10-27）

- 33 个「比例 × 档位」预设尺寸逐个跑 `validateSize(strict)` 全部合法（独立于档位表按 R1～R4 复算）；
- 文档中的关键样例：`4096x4096`、`1080x1920`、`1024x512` 判非法；`1536x1024`、`1152x2048`、`2880x2880`、`3840x2160` 判合法；
- `suggestLegalSize` 对 `1080x1920` / `1000x1000` / `4096x4096` / `300x300` / `5000x1000` 均返回合法尺寸；
- 模型能力：`gpt-image-2.5` → `size`；`gemini-2.5-flash-image` → `aspect_ratio + image_size`；`gpt-image-1.5` → 仅 3 个标准尺寸；`nano-banana-2-4k` → 档位锁定 4K；
- 用 `react-dom/server` 渲染 `SizeControl` 的 7 种模型/模式组合 + 3 条交互路径，全部通过（检查了标签、当前值、错误提示、建议按钮等文案）；
- `npm run build` 通过；新增/修改文件 ESLint 无告警（仓库原有未使用变量告警与本次无关）。

## 8. 仍未验证 / 后续可做

1. 默认网关 `foxi-ai.top` 是否放行**任意**合法尺寸（部分第三方网关只开放 3 个标准尺寸）；失败时按 `docs/gpt-image-2.5-size-rules.md` §12 的方法回退。
2. `gpt-image-2.5` 是网关别名，官方 ID 为 `gpt-image-2.5-flare` / `-sunburst`；需要确认网关映射（代码里的兜底已改用官方 ID）。
3. 官方未定义 experimental 的判定口径与后果，UI 只是提示。
4. 编辑模式目前仍要求遮罩（`editImage` 必传 mask）；官方 edits 允许只传图片，可后续放开并同步改掉"当前模型仅支持有遮罩的编辑"的文案。
5. `size` 只是请求期望值，官方从未承诺输出像素严格等于请求值；UI 的「沿用原图」同理（不传 size 时 edits 默认 auto），需要真实 Key 验证。
6. 预设模型列表仍是网关别名 `gpt-image-2.5` / `gpt-image-2`；确认网关映射后再补官方 ID `gpt-image-2.5-flare` / `-sunburst`（代码兜底已改用官方 ID）。
