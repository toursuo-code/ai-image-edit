# GPT Image 2.5 固定宽高（自定义尺寸）支持调研与规则文档

> 关键词：gpt-image-2.5 / gpt-image-2.5-flare / gpt-image-2.5-sunburst / 固定宽高 / 自定义尺寸 / `WIDTHxHEIGHT` / Images API
>
> 文档版本：v1.1（2026-10-27 独立核验后修订） · 核查日期：2026-10-27 · 适用接口：OpenAI Images API（`/v1/images/generations`、`/v1/images/edits`）
>
> 一句话结论：**支持固定宽高。`size` 参数直接传 `"宽x高"`（如 `1536x1024`）即可；但不是任意宽高，必须同时满足 5 条硬约束，且超过 2560×1440 属于实验性分辨率。**
>
> 修订记录：v1.0 初稿 → v1.1 依据独立核验修正三处：① "experimental" 官方未定义判定口径与后果；② generate 接口的 `size` 默认值属官方文档缺口（只有 edits 写了 `Defaults to auto`）；③ 官方"常用尺寸"（2048x2048 等）出自 gpt-image-2 小节，原文明确不适用于 2.5。

---

## 目录

- [1. 调研问题与方法](#1-调研问题与方法)
- [2. 结论](#2-结论)
- [3. 模型与接口](#3-模型与接口)
- [4. `size` 参数规范](#4-size-参数规范)
- [5. 尺寸硬约束（核心规则）](#5-尺寸硬约束核心规则)
- [6. 判定与换算代码](#6-判定与换算代码)
- [7. 尺寸速查表](#7-尺寸速查表)
- [8. 编辑接口（/v1/images/edits）](#8-编辑接口v1imagesedits)
- [9. 在本项目（ai-image-edit）中的落地建议](#9-在本项目ai-image-edit中的落地建议)
- [10. 错误排查](#10-错误排查)
- [11. 验收清单](#11-验收清单)
- [12. 来源与核查记录](#12-来源与核查记录)
- [附录 A：官方原文摘录](#附录-a官方原文摘录)

---

## 1. 调研问题与方法

**问题**：gpt-image-2.5 在生成图片的时候，支不支持固定宽高（指定输出像素尺寸）？如果支持，规则是什么？

**方法**：以 OpenAI 一手文档为主，第三方网关/教程文档为旁证，逐条交叉核对。

| 来源层级 | 使用的材料 |
| --- | --- |
| 一手 | OpenAI《Image generation》指南、Images API 参考（generate / edit）、GPT-Image-2.5 模型页、OpenAI 官方 SDK（python / java / go）的参数注释 |
| 旁证 | Apidog 教程（2026-09-09）、Ofox 中文尺寸指南（2026-09-09）、Modelflare / gpt-best 网关文档、第三方 `gpt-image-2-skill` CLI 文档 |
| 复核 | 独立核验员按一手来源逐条复核（2026-10-27），明确标注"官方确认 / 第三方说法 / 无法核实"，指出 3 处文档缺口或矛盾（见修订记录与 §5.1、§4.2 注） |

**声明**：

1. 本次没有可用的 OpenAI API Key 做付费实跑，"规则"来自官方文档原文与官方 SDK 源码注释；第三方实测结论单独标注。
2. 官方文档会持续更新，本规则以 **2026-10-27** 抓取到的页面内容为准；上线前建议再对照 [1][2][3] 核对一次。
3. 第三方网关（如本项目默认的 `foxi-ai.top`）**可能只开放部分尺寸或改写尺寸**，规则合法不等于网关一定放行，见 §10。

---

## 2. 结论

### 2.1 支持固定宽高

在 `/v1/images/generations` 的请求体里传 `size` 字段，值写成 `"宽x高"`（小写字母 x，先宽后高），模型就会按该尺寸出图（官方把响应的 `size` 定义为实际出图尺寸，但没有逐字"保证输出等于请求"的承诺句，接入后请校验响应 `size`）：

```json
{
  "model": "gpt-image-2.5-flare",
  "prompt": "一张极简风格的茶叶品牌主视觉",
  "size": "1536x1024"
}
```

官方 API 参考对 `size` 的描述原文（[2]）：

> For `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`, and `gpt-image-2.5-flare-2026-09-08`, **arbitrary resolutions are supported as `WIDTHxHEIGHT` strings**, for example `1536x864`. Width and height must both be divisible by 16 and the requested aspect ratio must be between 1:3 and 3:1. Resolutions above `2560x1440` are experimental, and the maximum supported resolution is `3840x2160`. The requested size must also satisfy the model's current pixel and edge limits. The standard sizes `1024x1024`, `1536x1024`, and `1024x1536` are supported by the GPT image models; `auto` is supported for models that allow automatic sizing.

也就是说：**gpt-image-2 和 gpt-image-2.5（flare / sunburst）共用同一套"任意尺寸"规则**；更早的 gpt-image-1 / 1.5 / mini 只支持固定的三档尺寸。

### 2.2 一句话规则

> 宽、高都必须是 16 的倍数；任一边 ≤ 3840；长边/短边 ≤ 3:1；总像素在 655,360 ~ 8,294,400 之间；超过 2560×1440 属实验性分辨率。

### 2.3 对本项目最要紧的 4 个事实

1. 本项目 UI 的 **4K 预设 `4096x4096` 对 2.5 非法**（单边 4096 > 3840，且 16,777,216 像素超过上限）。
2. **`1080x1920` 不能直接传**（1080 不是 16 的倍数），微信/抖音竖版交付尺寸需要先生成合法尺寸再缩放。
3. 不传 `size`（或传 `auto`）时由模型自行决定尺寸，**不能保证固定宽高**。
4. 官方模型 ID 里**没有 `gpt-image-2.5`** 这个写法，官方是 `gpt-image-2.5-flare` 和 `gpt-image-2.5-sunburst`（含 `-2026-09-08` 快照）。`gpt-image-2.5` 只是部分网关的别名。

---

## 3. 模型与接口

### 3.1 官方模型 ID

| 模型 ID（官方） | 定位 | 固定宽高 | 说明 |
| --- | --- | --- | --- |
| `gpt-image-2.5-flare` | 最快、日常高质量生成 | ✅ 支持 | 官方定位"默认选择"，多数场景优先用 |
| `gpt-image-2.5-flare-2026-09-08` | 上述模型的日期快照 | ✅ 支持 | 生产环境建议锁快照 |
| `gpt-image-2.5-sunburst` | 生成+编辑能力最强、编辑精度最高 | ✅ 支持 | 局部编辑、精细控制优先用 |
| `gpt-image-2.5-sunburst-2026-09-08` | 上述模型的日期快照 | ✅ 支持 | 生产环境建议锁快照 |
| `gpt-image-2` / `gpt-image-2-2026-04-21` | 上一代主力 | ✅ 支持（同一套规则） | 仍可用，未被下线 |
| `gpt-image-1.5` / `gpt-image-1` / `gpt-image-1-mini` | 更早世代 | ❌ 仅 `1024x1024`、`1536x1024`、`1024x1536`、`auto` | 不要给它们传自定义尺寸；`gpt-image-1` 已于 2026-10-23 关闭 |
| `gpt-image-2.5` | **不是官方 ID** | — | 网关别名，映射到 flare 还是 sunburst 需向网关确认 |

> 官方模型页（[4]）明确给出：Sunburst 的模型 ID 为 `gpt-image-2.5-sunburst`，快照 `gpt-image-2.5-sunburst-2026-09-08`；Flare 同理。两家都支持 `low/medium/high/xhigh/max/auto` 质量档。

### 3.2 端点支持情况

| 端点 | 2.5 支持 | 用途 |
| --- | --- | --- |
| `POST /v1/images/generations` | ✅ | 文生图（JSON） |
| `POST /v1/images/edits` | ✅ | 图生图 / 局部重绘（multipart 或 JSON 引用） |
| Responses API 的 `image_generation` 工具 | ✅ | 在 `tools[].model` 里指定图像模型 |
| `POST /v1/chat/completions` | ❌ 官方不支持 | 不要用 Chat Completions 格式调 2.5 |

> 第三方网关可能"兼容"chat 格式转发到 2.5，但那是网关行为，不是官方契约，尺寸行为也不可控。
>
> 注：官方文档有一处不一致——2.5 模型页的 Endpoints 表把 `v1/responses` 标为 Not supported，而 image-generation 指南与 2026-09-08 更新日志都说它可作为 Responses `image_generation` 工具的 model。区别在于：它**不能**作为 `responses.create` 的顶层 `model`，**可以**作为工具里的 `model`。涉及此路径时以指南为准并实测。

### 3.3 不要发送的字段

| 字段 | 结论 |
| --- | --- |
| `aspect_ratio` | ❌ OpenAI Images API **没有**这个参数（它是 Gemini 原生接口的 `generationConfig.imageConfig.aspectRatio`）。要比例就换算成 `size`。 |
| `extra_body.google.image_config` | ❌ Gemini 专用；对 OpenAI 模型是无效字段 |
| `response_format` | ❌ 对 GPT Image 系列已弃用/不支持，模型固定返回 `b64_json` |
| `style`、`user` | ❌ DALL·E 遗留字段，GPT Image 系列不支持 |

网关对这些多余字段可能"静默忽略"，也可能直接 400，两种都会让"固定宽高"失效，建议按模型分流后再发。

---

## 4. `size` 参数规范

### 4.1 三种常见写法

```bash
# 1) 官方推荐尺寸（最稳）
curl https://api.openai.com/v1/images/generations \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-image-2.5-flare","prompt":"...","size":"1024x1024","quality":"medium"}'

# 2) 自定义固定宽高（满足 §5 规则）
#    "size":"1152x2048"  → 精确 9:16 竖图
#    "size":"2048x1152"  → 16:9 横图
#    "size":"2880x2880"  → 最大方图

# 3) 自动尺寸（不保证宽高）
#    "size":"auto" 或直接不传
```

### 4.2 参数表

| 字段 | 类型 / 取值 | 默认 | 说明 |
| --- | --- | --- | --- |
| `size` | `"auto"` 或 `"WIDTHxHEIGHT"` 字符串 | `auto`（edits 参考明确写 `Defaults to auto`；generate 参考未写默认值——这是文档缺口。省略/auto 时由模型决定，**不等于** 1024×1024） | 固定宽高就显式传具体 `宽x高` |
| `quality` | `low` / `medium` / `high` / `xhigh` / `max` / `auto` | `auto` | `xhigh`、`max` 仅 2.5 支持；gpt-image-2 只到 `high`；图像质量越高、token 越多 |
| `background` | `auto` / `opaque` / `transparent` | `auto` | 2.5 原生支持透明；透明必须配 `output_format` 为 `png` 或 `webp` |
| `output_format` | `png` / `jpeg` / `webp` | `png` | 官方说明 jpeg 比 png 更快 |
| `output_compression` | `0`–`100` | `100` | 仅对 jpeg / webp 生效，png 忽略 |
| `n` | `1`–`10` | `1` | 每张图使用同一个 `size` |
| `moderation` | `auto` / `low` | `auto` | 内容审核强度 |
| `partial_images` | `0`–`3` | `0` | 流式返回的中间帧数量，每帧额外计 100 image output tokens |

### 4.3 响应里的尺寸信息

| 字段 | 说明 |
| --- | --- |
| `data[].b64_json` | 图片 base64。GPT Image 系列**不返回 url**，别按 DALL·E 的 `url` 逻辑解析 |
| `size` | **实际输出的尺寸**，`WIDTHxHEIGHT` 格式（用于回写图层宽高、验收） |
| `quality` / `output_format` / `background` | 实际生效的值 |
| `usage` | token 用量，用于成本核算（按 token 计费，尺寸越大/质量越高越贵） |

> 实践建议：
>
> 1. **以响应里的 `size` 为准**，不要假定"请求什么就得到什么"（网关可能重写；实验性分辨率官方也未承诺成功）。官方没有 "output matches the requested size" 这类逐字保证，所以**接入后应断言 `response.size === request.size`**，不一致就告警/重试。
> 2. 不显式传 `size` 时不要指望固定宽高。第三方 Ofox 实测 auto 返回 `1254x1254`（第三方说法，仅供参考），并建议"要固定尺寸必须显式传 `size`"。
> 3. 流式响应（`partial_images`）的每个事件里也有 `size` 字段。

---

## 5. 尺寸硬约束（核心规则）

### 5.1 规则表

| 编号 | 规则 | 数值 | 合法示例 | 违反示例 |
| --- | --- | --- | --- | --- |
| **R1** | 格式：`宽x高`，小写字母 `x`，先宽后高 | 字符串 | `1536x1024` | `1536*1024`、`1024X1536`（网关可能不接受大写 X） |
| **R2** | 宽、高都必须是 **16 的倍数** | `W % 16 == 0` 且 `H % 16 == 0` | `1536x1024`（96 × 64） | `1080x1920`（1080 % 16 = 8）、`1366x768` |
| **R3** | 任一边不得超过 **3840** | `max(W,H) ≤ 3840` | `3840x2160` | `4096x4096`、`4032x1728` |
| **R4** | 长边/短边不得超过 **3:1** | `max/min ≤ 3` | `1024x3072`（恰好 3:1） | `4096x1024`（4:1） |
| **R5** | 总像素必须在 **655,360 ~ 8,294,400** 之间 | `655360 ≤ W×H ≤ 8294400` | `1024x1024`（1,048,576） | `800x800`（640,000）、`512x512` |
| **R6** | **> 2560×1440 属实验性分辨率** | 官方原文 "Resolutions above 2560x1440 are experimental"（判定口径未定义） | `3840x2160`、`2880x2880` | —（不是禁止；官方未说明具体后果） |
| **R7** | 兜底条款：还要满足"模型当前的像素与边缘限制" | 官方可能调整 | — | 以线上报错为准 |

> **R6 说明**：官方只写了 "experimental"，**没有定义**它按哪一边判定（任一边 vs 总像素），也**没有说明后果**（更慢 / 更贵 / 可能失败 / 后续取消）。因此：
>
> - 不要把它写成"不支持"或"必定失败"；
> - 本规则采用**保守口径**：`W×H > 3,686,400`（=2560×1440）或任一边 > 2560/1440 都按实验性处理，UI 加提示并准备降级；该口径需团队确认后固化。
> - 总像素上下限（655,360 / 8,294,400）这两个数字**只出现在官方指南**里，API 参考只写 "model's current pixel and edge limits"，引用时请注明出处。

### 5.2 边界值推导（便于记忆和写校验）

| 边界 | 推导 | 结果 |
| --- | --- | --- |
| 最小合法面积 | 655,360 = 1024×640 | `1024x640`（两边都是 16 的倍数） |
| 最大合法面积 | 8,294,400 = 3840×2160 = 2880×2880 | 横图满格 `3840x2160`；方图满格 `2880x2880` |
| 1:1 最大 | 受面积限制，边长 ≤ √8,294,400 = 2880 | `2880x2880` |
| 3:1 极限 | 长边 ≤ 3840，且短边 = 长边/3 | `3072x1024`、`1024x3072`（面积 3,145,728，合法） |
| 16:9 满格 | 3840×2160 | `3840x2160`（实验性） |
| 21:9 最大 | 受单边 3840 限制，16 倍数下最大约 3808 宽 | `3808x1632`（6,214,656 px，推导值） |
| 非实验性上限 | 2560×1440 | `2560x1440`（正好等于阈值，不算"高于"） |

### 5.3 判定示例

**合法（✅）**

| 尺寸 | 比例 | 总像素 | 说明 |
| --- | --- | --- | --- |
| `1024x1024` | 1:1 | 1,048,576 | 官方推荐 |
| `1536x1024` | 3:2 | 1,572,864 | 官方推荐（横） |
| `1024x1536` | 2:3 | 1,572,864 | 官方推荐（竖） |
| `2048x2048` | 1:1 | 4,194,304 | 2K 方图；算术合法，但超实验性阈值 |
| `2048x1152` | 16:9 | 2,359,296 | 2K 横图；算术合法（该值来自官方 gpt-image-2 的常用列表，非 2.5 推荐） |
| `1152x2048` | 9:16 | 2,359,296 | 精确 9:16 竖图，第三方常用 |
| `2560x1440` | 16:9 | 3,686,400 | 非实验性上限（含等于阈值） |
| `3840x2160` | 16:9 | 8,294,400 | 4K 横图；算术合法（该值来自官方 gpt-image-2 的常用列表，非 2.5 推荐） |
| `2160x3840` | 9:16 | 8,294,400 | 4K 竖图；算术合法（同上） |
| `2880x2880` | 1:1 | 8,294,400 | 面积满格方图（推导） |
| `1024x3072` | 1:3 | 3,145,728 | 比例极限仍合法 |
| `3072x1024` | 3:1 | 3,145,728 | 比例极限仍合法 |
| `1088x1920` | 17:30 | 2,088,960 | 接近 1080p 竖版的合法替代 |
| `1920x1088` | 30:17 | 2,088,960 | 接近 1080p 横版的合法替代 |
| `2000x2000` | 1:1 | 4,000,000 | 16 倍数，合法 |

**不合法（❌）**

| 尺寸 | 违反规则 | 原因 |
| --- | --- | --- |
| `4096x4096` | R3 + R5 | 单边 4096 > 3840；16,777,216 > 8,294,400 |
| `4096x2160` | R3 + R5 | 单边超限；8,847,360 > 8,294,400 |
| `3840x2560` | R5 | 9,830,400 > 8,294,400 |
| `4032x1728` | R3 | 单边 4032 > 3840 |
| `1080x1920` | R2 | 1080 % 16 = 8 |
| `1920x1080` | R2 | 1080 % 16 = 8 |
| `1366x768` | R2 | 1366 % 16 = 6 |
| `1000x1000` | R2 | 1000 % 16 = 8 |
| `800x800` | R5 | 640,000 < 655,360（800 本身是 16 倍数） |
| `512x512` | R5 | 262,144 < 655,360 |
| `768x768` | R5 | 589,824 < 655,360（768 本身是 16 倍数） |
| `1024x512` | R5 | 524,288 < 655,360（比例 2:1 本身没超） |
| `3200x1024` | R4 | 3.125:1，超过 3:1（与 16 倍数无关） |
| `3840x3840` | R5 | 单边合法、也是 16 倍数，但 14,745,600 > 8,294,400 |
| `4096x1024` | R3 + R4 | 单边 4096 超限；4:1 超比例（面积 4,194,304 本身合法） |

> 小技巧：任何"标准屏幕分辨率"（1920×1080、2560×1440、3840×2160、1080×1920）里，只有 **3840×2160 / 2160×3840 / 2560×1440** 天然合法，因为 1080 不是 16 的倍数。

### 5.4 "我就是要输出 1080×1920" 怎么办

模型不接受 `1080x1920`，正确做法是**先生成合法尺寸，再本地缩放/裁切**：

| 方案 | 生成尺寸 | 说明 |
| --- | --- | --- |
| A（推荐） | `1152x2048` | 精确 9:16，缩放后不变形，得到 1080×1920 |
| B | `1088x1920` | 宽度差 8px，裁掉/补边 8px 即可，无需缩放比例 |
| C | `2160x3840` | 需要 2 倍图（Retina）时用，属实验性分辨率 |

不要直接传 `1080x1920`：必然触发 400，且部分网关的错误信息很含糊（只说 "invalid size"）。

---

## 6. 判定与换算代码

以下代码已在本机用 Node 实测：所有输出尺寸都能通过校验，可直接放到 `src/lib/` 使用（示例文件名 `gptImageSize.js`）。

```js
// gptImageSize.js —— GPT Image 2 / 2.5 自定义尺寸校验与换算
export const LIMITS = {
  EDGE_MAX: 3840,                 // 单边上限
  PIXELS_MIN: 655360,             // 最小总像素
  PIXELS_MAX: 8294400,            // 最大总像素（= 3840×2160）
  PIXELS_EXPERIMENTAL: 2560 * 1440, // 3,686,400，超过即实验性
  RATIO_MIN: 1 / 3,
  RATIO_MAX: 3,
};

/**
 * 解析用户输入：'1024x1024' / '1024×1024' / '1024:1024' / '1K' / '2K' / '4K' / 'auto'
 * 返回 { size } 或 { error }
 */
export function parseSize(input) {
  if (input == null) return { size: null };
  const raw = String(input).trim().toLowerCase();
  if (!raw || raw === 'auto') return { size: 'auto' };
  const presets = { '1k': '1024x1024', '2k': '2048x2048', '4k': '3840x2160' };
  if (presets[raw]) return { size: presets[raw] };
  const m = raw.match(/^(\d+)\s*[x\u00d7:*]\s*(\d+)$/);
  if (!m) return { error: `无法识别的尺寸格式：${input}` };
  return { size: `${Number(m[1])}x${Number(m[2])}` };
}

/**
 * 按 §5 规则校验尺寸，返回 { ok, errors, warnings }
 */
export function validateSize(input) {
  const errors = [];
  const warnings = [];
  const parsed = parseSize(input);
  if (parsed.error) return { ok: false, errors: [parsed.error], warnings };
  if (parsed.size === 'auto' || parsed.size == null) {
    return { ok: true, errors, warnings: ['未指定固定尺寸：由模型自动决定（auto）'] };
  }
  const [w, h] = parsed.size.split('x').map(Number);
  if (!(w > 0) || !(h > 0)) {
    return { ok: false, errors: ['宽高必须是正整数'], warnings };
  }
  if (w % 16 || h % 16) errors.push(`宽高都必须是 16 的倍数（当前 ${w}x${h}）`);
  if (w > LIMITS.EDGE_MAX || h > LIMITS.EDGE_MAX) {
    errors.push(`单边不得超过 ${LIMITS.EDGE_MAX}px（当前 ${w}x${h}）`);
  }
  const ratio = Math.max(w, h) / Math.min(w, h);
  if (ratio > LIMITS.RATIO_MAX) {
    errors.push(`长边/短边不得超过 3:1（当前 ${ratio.toFixed(2)}:1）`);
  }
  const pixels = w * h;
  if (pixels < LIMITS.PIXELS_MIN || pixels > LIMITS.PIXELS_MAX) {
    errors.push(`总像素必须在 655,360–8,294,400 之间（当前 ${pixels.toLocaleString()}）`);
  }
  if (pixels > LIMITS.PIXELS_EXPERIMENTAL) {
    warnings.push('高于 2560x1440 属实验性分辨率（官方未定义具体影响）');
  }
  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 已知宽高比 + 目标像素档，换算出一个合法的 WIDTHxHEIGHT。
 * 只用于"UI 只给了比例"的场景；输出为推导值，不等于官方推荐尺寸。
 * @param {string} ratio  '16:9'、'9:16'、'1:1' ...
 * @param {number} targetPixels 目标总像素（1K≈1,048,576 / 4K≈8,294,400）
 */
export function resolveSize(ratio = '1:1', targetPixels = 1024 * 1024) {
  const [rw, rh] = String(ratio).split(':').map(Number);
  if (!rw || !rh) return null;
  const r = rw / rh;
  if (r < LIMITS.RATIO_MIN || r > LIMITS.RATIO_MAX) return null;

  const idealH = Math.sqrt(targetPixels / r);
  const maxH = r >= 1
    ? Math.floor(LIMITS.EDGE_MAX / r / 16) * 16
    : LIMITS.EDGE_MAX;
  const h0 = Math.min(Math.round(idealH / 16) * 16, maxH);
  const from = Math.max(16, Math.floor((h0 * 0.8) / 16) * 16);
  const to = Math.min(maxH, Math.ceil((h0 * 1.2) / 16) * 16);

  let best = null;
  for (let h = from; h <= to; h += 16) {
    const w = Math.max(16, Math.round((h * r) / 16) * 16);
    if (!validateSize(`${w}x${h}`).ok) continue;
    const deviation = Math.abs(w / h - r) / r;
    if (deviation > 0.02) continue;          // 允许最多 2% 的比例偏差
    const areaDiff = Math.abs(w * h - targetPixels);
    if (
      !best ||
      deviation < best.deviation - 1e-9 ||
      (Math.abs(deviation - best.deviation) <= 1e-9 && areaDiff < best.areaDiff)
    ) {
      best = { width: w, height: h, deviation, areaDiff };
    }
  }
  return best ? { width: best.width, height: best.height } : null;
}
```

按模型分流构造请求体（示意，接入时按现有 `generateImage` 改造）：

```js
// 官方 ID 与常见网关别名都覆盖：gpt-image-2 / gpt-image-2.5 / gpt-image-2.5-flare ...
const isGptImage2Family = (model) => /^gpt-image-2(\.5)?(-|$)/.test(String(model));

export function buildGenerationBody({
  model, prompt, size, aspectRatio,
  quality = 'auto', outputFormat = 'png', n = 1,
}) {
  if (!isGptImage2Family(model)) return null; // 其它模型（Gemini 等）保持原逻辑

  const body = { model, prompt, n, quality, output_format: outputFormat };
  const parsed = parseSize(size);
  if (parsed.error) throw new Error(parsed.error);

  let target = parsed.size;
  if (!target || target === 'auto') {
    const resolved = aspectRatio ? resolveSize(aspectRatio, 1024 * 1024) : null;
    target = resolved ? `${resolved.width}x${resolved.height}` : null;
  }
  if (target) {
    const check = validateSize(target);
    if (!check.ok) {
      throw new Error(`尺寸不符合 GPT Image 2 / 2.5 规则：${check.errors.join('；')}`);
    }
    body.size = target;
  }
  // 注意：不要带 aspect_ratio / extra_body / response_format
  return body;
}
```

---

## 7. 尺寸速查表

### 7.1 官方推荐尺寸（2.5）

| 尺寸 | 比例 | 总像素 | 说明 |
| --- | --- | --- | --- |
| `1024x1024` | 1:1 | 1,048,576 | 官方 Recommended sizes（最稳）[1] |
| `1536x1024` | 3:2 | 1,572,864 | 官方 Recommended sizes（横）[1] |
| `1024x1536` | 2:3 | 1,572,864 | 官方 Recommended sizes（竖）[1] |
| `auto` | — | — | 受支持；由模型决定，不保证固定宽高 |

### 7.1b 官方为 gpt-image-2 列出的"常用尺寸"（2.5 适用性提示）

> **重要**：官方指南里这段原文明确写 "The details below apply to earlier models, **not Sunburst or Flare**"——所以下面这些**不是 2.5 的官方推荐尺寸**。它们只是在 2.5 同一套约束下算术合法，可作参考，别当成 2.5 的官方保证。

| 尺寸 | 比例 | 总像素 | 备注 |
| --- | --- | --- | --- |
| `2048x2048` | 1:1 | 4,194,304 | 2K 方图（超过实验性阈值） |
| `2048x1152` | 16:9 | 2,359,296 | 2K 横图 |
| `3840x2160` | 16:9 | 8,294,400 | 4K 横图（实验性） |
| `2160x3840` | 9:16 | 8,294,400 | 4K 竖图（实验性） |
| `auto` | — | — | 该小节标注的默认值 |

### 7.2 本项目 UI 比例 → 合法尺寸（1K / 2K / 4K 三档，**推导值**）

> 下表由 §6 的 `resolveSize` 生成并逐个通过校验，只用于把"比例 + 档位"映射成合法尺寸；不是官方推荐值。需要绝对稳定时优先用 §7.1 的三个推荐尺寸。

| UI 比例 | 1K 档（≈1.05MP） | 2K 档（≈4.2MP） | 4K 档（≈8.29MP） |
| --- | --- | --- | --- |
| 1:1 | `1024x1024` | `2048x2048` | `2880x2880` |
| 16:9 | `1280x720` | `2816x1584` | `3840x2160` |
| 9:16 | `720x1280` | `1584x2816` | `2160x3840` |
| 4:3 | `1152x864` | `2368x1776` | `3264x2448` |
| 3:4 | `864x1152` | `1776x2368` | `2448x3264` |
| 21:9 | `1568x672` | `3136x1344` | `3808x1632` |
| 9:21 | `672x1568` | `1344x3136` | `1632x3808` |
| 3:2 | `1248x832` | `2496x1664` | `3504x2336` |
| 2:3 | `832x1248` | `1664x2496` | `2336x3504` |
| 5:4 | `1120x896` | `2320x1856` | `3200x2560` |
| 4:5 | `896x1120` | `1856x2320` | `2560x3200` |

说明：

- 表中的 1K/2K/4K 是"目标像素档"，不是官方术语；本项目现有 UI 的 `4K=4096x4096` 必须替换成上表对应值。
- 21:9 的 4K 档受单边 3840 限制，只能到 `3808x1632`（6.2MP），拿不到 8.29MP。
- 2K、4K 两档都落在实验性区间（像素 > 3,686,400），只有 1K 档不在；UI 已按此标注。

---

## 8. 编辑接口（`/v1/images/edits`）

- 2.5 的 **`size` 规则与生成接口完全一致**（官方 API 参考的 edit 页对 `size` 的描述与 generate 页逐字相同 [3]）。
- 支持两种入参：multipart（`image` / `image[]` + `mask` + `prompt` + `size`）或 JSON 引用（`images: [{ file_id | image_url }]`）。
- **可以不带遮罩**：只给原图 + prompt，模型自行决定改哪里；带遮罩时只重绘遮罩区域（官方模型页标注 Sunburst 支持 inpainting）。
- 遮罩要求（第三方网关文档口径，建议实测）：与第一张源图**同尺寸、同格式**、带 Alpha。
- 透明背景：`background: "transparent"` 必须配 `output_format: "png"` 或 `"webp"`。
- 编辑输出尺寸同样由 `size` 控制；不传则按原图/自动，可能不是你想要的固定宽高。

```bash
curl https://api.openai.com/v1/images/edits \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "model=gpt-image-2.5-sunburst" \
  -F "image=@product.png" \
  -F "mask=@mask.png" \
  -F "prompt=只把背景换成暖色渐变，产品主体不变" \
  -F "size=1536x1024" \
  -F "quality=high"
```

---

## 9. 在本项目（ai-image-edit）中的落地建议

> 以下是 2026-10-27 对重构前工作区代码的核对结论，保留作为问题溯源；其中 P0/P1/P2 已在 `docs/size-control-design.md` 对应的实现中落地，函数名已变化。

### 9.1 现状与影响

| 位置 | 现状 | 影响 |
| --- | --- | --- |
| `src/lib/api.js` → `normalizePixelSize` / `COMMON_PIXEL_SIZES` | 只有 `1024x1024`、`1536x1024`、`1024x1536`、`2048x2048`、`4096x4096` 在白名单内，**不在白名单的 size 直接不发送** | gpt-image-2.5 的自定义尺寸（如 `1152x2048`）永远传不出去，模型退化成自动尺寸，**固定宽高失效** |
| `src/lib/api.js` → `generateImage` | 请求体固定携带 `aspect_ratio` 和 `extra_body.google.image_config` | 对 OpenAI 模型是无效字段（网关可能忽略或 400）；且 `aspect_ratio` 本身不能固定像素宽高 |
| `src/components/ControlPanel.jsx` 预设 | `1K=1024x1024`、`2K=2048x2048`、`4K=4096x4096` | `2K` 合法；**`4K=4096x4096` 对 2.5 非法**（单边 + 像素双超限） |
| 自定义尺寸输入框 | 用户可输入任意 `宽:高`，无校验 | `1080x1920`、`800x800` 等会在请求时被 API 拒绝 |
| 编辑路径 `editImage` | 不传 `size`；gpt-image 编辑要求先画遮罩 | 编辑输出无法固定尺寸；2.5 的无遮罩编辑能力没用上 |
| 模型列表 | 含 `gpt-image-2.5`、`gpt-image-2` | `gpt-image-2.5` 是网关别名；官方无此 ID，需确认网关映射到 flare 还是 sunburst |

### 9.2 建议改法（按优先级）

**P0 — 让自定义尺寸真正发出去**

1. 把 `COMMON_PIXEL_SIZES` 白名单改为"按模型能力判断 + 规则校验"：`gpt-image-2` / `gpt-image-2.5*` 走 §6 的 `validateSize` 后**透传**，其它模型仍用白名单。
2. 对 OpenAI 图像模型不要发送 `aspect_ratio`、`extra_body`、`response_format`；需要比例时用 `resolveSize(ratio, 档位像素)` 换成 `size`。

**P1 — UI 与输入校验**

3. 4K 预设改为按比例解析：1:1 → `2880x2880`、16:9 → `3840x2160`、9:16 → `2160x3840`；或直接把"档位 + 比例"交给 `resolveSize`。
4. 自定义尺寸输入框接 `validateSize`，实时提示违反了哪条（16 倍数 / 单边 / 比例 / 像素），并在 4K 档标注"实验性"。

**P2 — 编辑与稳定性**

5. 编辑：2.5 走 `/v1/images/edits` 并带 `size`；支持无遮罩（只给 prompt）编辑，遮罩尺寸与首图对齐。
6. 失败降级：自定义尺寸返回 400 时，按方向回退 `1536x1024` / `1024x1536` / `1024x1024`（官方推荐尺寸），并提示"当前网关/账号可能只支持标准尺寸"。
7. 落库以响应 `size` 或图片实际像素为准（现有 `addLayer` 从 `img.width/height` 读取，已符合）。

### 9.3 建议的最小改动示意

```js
// api.js 生成分支（示意）
const isGptImage2Family = (model) => /^gpt-image-2(\.5)?(-|$)/.test(String(model));

const requestBody = { prompt, model, n: 1, response_format: undefined };

if (isGptImage2Family(model)) {
  const { ok, errors } = validateSize(size);
  if (!ok) throw new Error(`尺寸不合法：${errors.join('；')}`);
  requestBody.size = size;          // 自定义尺寸原样透传（已校验）
  requestBody.quality = 'auto';
  requestBody.output_format = 'png';
  // 删除 aspect_ratio / extra_body / response_format
} else {
  // 其它模型保持原有逻辑（Gemini 的 imageConfig 等）
}
```

---

## 10. 错误排查

| 症状 / 报错 | 可能原因 | 处理 |
| --- | --- | --- |
| `400 invalid size` / `size must be` | 违反 R2/R3/R5（如 `1080x1920`、`4096x4096`） | 用 §6 代码本地校验后重发 |
| `400 ... aspect ratio ...` | 超过 3:1（如 4:1 超宽） | 改比例或改用 `size` 换算 |
| `400 unknown/unsupported parameter: aspect_ratio` | 把 Gemini 参数发给了 OpenAI 模型 | 按模型分流，删掉该字段 |
| `400 response_format is not supported` | GPT Image 系列固定返回 b64 | 删掉 `response_format` |
| `404 model not found`（`gpt-image-2.5`） | 官方无此 ID，网关未提供别名 | 改用 `gpt-image-2.5-flare` / `gpt-image-2.5-sunburst`，或查网关 `/v1/models` |
| 返回 200，但尺寸不是请求值 | `size` 被白名单丢弃 / 网关重写 / 走了 auto | 打印请求体确认 `size` 已发送；以响应 `size` 为准并重试 |
| 返回 200，但全是 1:1 | 同上，`size` 未生效 | 同上 |
| 返回 200，尺寸约 1254×1254 之类"奇怪值" | 没传 `size` 或传了 `auto`，模型自选尺寸（第三方 Ofox 实测值） | 显式传 `size`；不要依赖 `auto` 固定宽高 |
| 大尺寸 + 高 quality 时超时 / 504 | 实验性分辨率（>2560×1440）+ `max` 档开销大 | 降档（`high`/`medium`）、降尺寸或提高超时（本项目当前 300s） |
| `429` | 限流 | 指数退避重试 |
| `image_generation_user_error` | 参数/输入图问题，重试无意义 | 按 `error.code` 修正请求；不要自动重试 |
| `moderation_blocked` | 内容审核拦截 | 修改提示词/输入图；不要自动重试 |
| 带遮罩编辑报尺寸/格式错误 | 遮罩与首图尺寸或格式不一致 | 先把遮罩对齐到首图同尺寸同格式 |

**关于第三方网关**：Ofox 的实测文章指出，第三方应用/网关"可能只开放其中一部分尺寸"；Modelflare 的模型页把尺寸下拉限制为 `auto / 1024x1024 / 1536x1024 / 1024x1536`。因此出现"按官方规则合法但网关仍报错"时，优先怀疑网关白名单，而不是规则本身。

---

## 11. 验收清单

上线前逐项打勾：

- [ ] 请求体里 `size` 是 `"宽x高"` 格式、小写 `x`、先宽后高
- [ ] 宽、高都通过 `% 16 === 0`
- [ ] `max(W, H) ≤ 3840`
- [ ] `max/min ≤ 3`
- [ ] `655,360 ≤ W×H ≤ 8,294,400`
- [ ] 像素 > 3,686,400 时，UI 有"实验性"提示，且失败有降级
- [ ] OpenAI 模型请求里没有 `aspect_ratio` / `extra_body` / `response_format`
- [ ] 4K 预设不再是 `4096x4096`
- [ ] 自定义尺寸输入框有即时校验与可读的错误提示
- [ ] 记录响应 `size`，并与生成图实际像素核对
- [ ] 编辑接口同样传 `size`，遮罩与首图同尺寸
- [ ] 网关不支持自定义尺寸时有回退方案（标准三尺寸）
- [ ] 生产环境锁定模型快照（`-2026-09-08`）而非浮动别名

---

## 12. 来源与核查记录

| 编号 | 来源 | 链接 | 用到的关键内容 | 抓取日期 |
| --- | --- | --- | --- | --- |
| [1] | OpenAI《Image generation》指南 | https://developers.openai.com/api/docs/guides/image-generation | 2.5 的 Size and quality options：任意 `WIDTHxHEIGHT`、16 倍数、1:3–3:1、单边 ≤3840、像素 655,360–8,294,400、>2560×1440 实验性、推荐尺寸；另含 gpt-image-2 的 Popular sizes（原文标注不适用于 2.5） | 2026-10-27 |
| [2] | OpenAI API Reference · Create image（generate） | https://developers.openai.com/api/reference/resources/images/methods/generate | `size` 字段完整描述与模型清单；`quality`、`response_format`、响应字段 | 2026-10-27 |
| [3] | OpenAI API Reference · Create image edit | https://developers.openai.com/api/reference/resources/images/methods/edit | edit 接口 `size` 规则与 generate 相同；`mask` 字段 | 2026-10-27 |
| [4] | OpenAI 模型页 · GPT-Image-2.5 Sunburst / Flare | https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst · https://developers.openai.com/api/docs/models/gpt-image-2.5-flare | 官方模型 ID、快照、质量档 `low/medium/high/xhigh/max/auto`、端点支持（generations/edits，Chat Completions 不支持）、定价 | 2026-10-27 |
| [5] | OpenAI 官方 Java SDK 的参数注释（由 OpenAPI 生成） | https://github.com/openai/openai-java/blob/main/openai-java-core/src/main/kotlin/com/openai/models/responses/Tool.kt | `size` 的 KDoc：同一套任意尺寸规则、`>2560x1440` 实验性、最大 `3840x2160` | 2026-10-27 |
| [6] | Apidog 教程《How to use the gpt-image-2.5 API》 | https://apidog.com/blog/gpt-image-2-5-api/ | 模型 ID、端点、质量档、尺寸规则（16 倍数 / 1:3–3:1 / 4K 总像素）、`b64_json`、Flare/Sunburst 定位 | 2026-10-27 |
| [7] | Ofox 中文《GPT Image 2.5 尺寸怎么填？4K 和竖图报错排查》 | https://ofox.ai/zh/blog/gpt-image-2-5-size-guide/ | 与官方一致的 5 条约束；`1080x1920` 不合法、`1152x2048` 精确 9:16；第三方网关可能只开放部分尺寸 | 2026-10-27 |
| [8] | Modelflare 文档 · gpt-image-2.5-sunburst | https://docs.modelflare.dev/zh/models/image/gpt-image-2-5-sunburst/ | 网关参数表（size 规则与官方一致）；响应字段含 `size`；质量档 xhigh/max；透明背景需 png/webp | 2026-10-27 |
| [9] | gpt-best（Apifox）· gpt-image-2.5-flare（文生图） | https://gpt-best.apifox.cn/api-515692647 | 转引官方 "Size and quality options"：常用尺寸与尺寸限制 | 2026-10-27 |
| [10] | Wangnov `gpt-image-2-skill` CLI 文档 | https://github.com/Wangnov/gpt-image-2-skill/blob/main/skills/gpt-image-2-skill/references/sizes-and-formats.md | 第三方 CLI 的尺寸别名与约束；实践提示方图高分辨率上限约 `2880x2880` | 2026-10-27 |
| [11] | OpenAI 官方 Python SDK · `image_model.py` / `image_generate_params.py` / `image_edit_params.py` | https://raw.githubusercontent.com/openai/openai-python/main/src/openai/types/image_model.py | 官方 `ImageModel` 枚举无裸 `gpt-image-2.5`；`size` KDoc 同文；edits 明确 `Defaults to auto` | 2026-10-27 |
| [12] | OpenAI 更新日志（2026-09-08） | https://developers.openai.com/api/docs/changelog | 2.5 双模型发布、新增 `xhigh`/`max`；可作为 Responses `image_generation` 工具 model | 2026-10-27 |
| [13] | 官方模型页（裸 ID，用于证伪） | https://developers.openai.com/api/docs/models/gpt-image-2.5 | 返回 **404**，证明不存在名为 `gpt-image-2.5` 的官方模型 ID | 2026-10-27 |
| [14] | Ofox 模型文档（第三方实测） | https://ofox.ai/docs/develop/models/gpt-image | 省略/auto 时尺寸不保证（实测返回 1254×1254），要固定必须显式传 `size` | 2026-10-27 |

**核查方式**：本环境 `web_fetch` 对所有域名返回"非公网 IP"错误，故改用 `pwsh` 的 `Invoke-WebRequest` 抓取页面并转纯文本核对；官方页面原文与第三方转引已逐条比对，5 条硬约束在 [1][2][5][6][7][8][9] 之间一致。随后由独立核验员按一手来源逐条复核（结果为"官方确认 / 第三方说法 / 无法核实"分级），据此修正了 v1.0 的三处表述。

**官方文档内部矛盾（与尺寸无关，但引用时需注意）**：

- 2.5 模型页 Endpoints 表把 `v1/responses` 标为 Not supported，而指南与更新日志说可作为 Responses `image_generation` 工具的 model（见 §3.2 注）。
- generate 参考未写 `size` 默认值，edits 参考写了 `Defaults to auto`（见 §4.2）。
- 总像素上下限数字只出现在指南，API 参考只写 "model's current pixel and edge limits"（见 §5.1 注）。

**无法核实 / 需实测**：

- "experimental" 的判定口径（单边 vs 总像素）与具体后果：官方**没有定义**，本规则的"按总像素 > 3,686,400 处理"是保守口径，需要团队确认。
- 官方是否会随模型迭代调整像素/边长上限（R7 兜底条款）；本规则是 2026-10-27 的值。
- 官方未逐字承诺"输出尺寸 = 请求尺寸"，只能以响应 `size` 校验（第三方实测 auto 返回 1254×1254）。
- 本项目实际使用的网关（默认 `foxi-ai.top`）是否放行任意尺寸、是否只支持标准尺寸——需用真实 Key 小成本实测：分别发 `1024x1024`、`1152x2048`、`3840x2160` 各 1 张，记录响应 `size`。
- 2.5 在大尺寸下的真实成功率与画质衰减（官方只标"实验性"，未给量化指标）。

---

## 附录 A：官方原文摘录

**A.1 Image generation 指南（Size and quality options）**

> gpt-image-2.5-sunburst and gpt-image-2.5-flare add `xhigh` and `max` quality settings. Both default to `auto`. Earlier GPT Image models support quality settings up to `high`.
>
> （推荐尺寸原文为表格：`1024x1024` square / `1536x1024` landscape / `1024x1536` portrait，此处按表格内容整理）
>
> Both models also support custom dimensions as `WIDTHxHEIGHT` strings, such as `1536x864`. Width and height must be multiples of 16, the aspect ratio must be between 1:3 and 3:1, and neither edge may exceed 3840 pixels. The total pixel count must be between 655,360 and 8,294,400 (4K). Resolutions above 2560x1440 are experimental.
>
> For transparent backgrounds with either model, set `background: "transparent"` and use `output_format: "png"` or `"webp"`.

**A.2 API 参考（`size` 字段）**

> For `gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-2.5-sunburst`, `gpt-image-2.5-sunburst-2026-09-08`, `gpt-image-2.5-flare`, and `gpt-image-2.5-flare-2026-09-08`, arbitrary resolutions are supported as `WIDTHxHEIGHT` strings, for example `1536x864`. Width and height must both be divisible by 16 and the requested aspect ratio must be between 1:3 and 3:1. Resolutions above `2560x1440` are experimental, and the maximum supported resolution is `3840x2160`. The requested size must also satisfy the model's current pixel and edge limits. The standard sizes `1024x1024`, `1536x1024`, and `1024x1536` are supported by the GPT image models; `auto` is supported for models that allow automatic sizing.

**A.3 旧模型（gpt-image-2）的 Popular sizes 与 Size constraints**

> gpt-image-2 accepts any resolution in the `size` parameter when it satisfies the constraints below. Square images are typically fastest to generate.
>
> Popular sizes: `1024x1024` (square), `1536x1024` (landscape), `1024x1536` (portrait), `2048x2048` (2K square), `2048x1152` (2K landscape), `3840x2160` (4K landscape), `2160x3840` (4K portrait), `auto` (default)
>
> Size constraints: Maximum edge length must be less than or equal to 3840px; Both edges must be multiples of 16px; Long edge to short edge ratio must not exceed 3:1; Total pixels must be at least 655,360 and no more than 8,294,400

**A.4 模型页（Sunburst）**

> GPT-Image-2.5 Sunburst — Our most capable model for image generation and editing. Model ID: `gpt-image-2.5-sunburst`. It supports `low`, `medium`, `high`, `xhigh`, `max`, and `auto` quality settings. … Image generation `v1/images/generations`: Supported. Image edit `v1/images/edits`: Supported. Chat Completions `v1/chat/completions`: Not supported.
