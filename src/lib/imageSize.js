/**
 * 输出尺寸规则与归一化（纯函数，无 React / DOM 依赖）
 *
 * 依据 docs/gpt-image-2.5-size-rules.md 中核验过的官方约束：
 *  R1 宽、高都必须能被 16 整除
 *  R2 单边上限 3840
 *  R3 宽高比（长边:短边）在 1:3 ～ 3:1 之间
 *  R4 总像素在 655,360 ～ 8,294,400 之间（= 1024×640 ～ 3840×2160）
 *  R5 超过 2560×1440 属于官方标注的 experimental（官方未定义判定口径与后果）
 *  R6 还需要满足模型当前的像素/边界限制
 *
 * 设计要点：
 *  - 界面只暴露「一个」尺寸选择：按比例（比例 + 清晰度档位）或自定义像素，二选一；
 *  - 不同模型走不同参数：GPT Image 走 `size: "WxH"`，Gemini / nano-banana 走
 *    `extra_body.google.image_config.{aspect_ratio,image_size}`；
 *  - 自定义像素按模型能力校验，非法尺寸会在调用接口前被拦下，并给出最近合法值。
 */

/** GPT Image 系列（gpt-image-2 / gpt-image-2.5）的硬约束 */
export const SIZE_LIMITS = Object.freeze({
    multipleOf: 16,
    maxEdge: 3840,
    minPixels: 655360, // 1024×640
    maxPixels: 8294400, // 3840×2160 / 2880×2880
    maxAspect: 3, // 长边 / 短边
    // 官方原文只说 “Resolutions above 2560x1440 are experimental”，未定义判定口径；
    // 这里沿用调研文档 §7.2 的像素数口径（> 2560×1440 = 3,686,400 像素），仅用于提示，不拦截。
    experimentalPixels: 2560 * 1440,
});

/** 比例选项（顺序即界面展示顺序） */
export const RATIO_OPTIONS = Object.freeze([
    { value: '1:1', label: '1:1', hint: '方形' },
    { value: '4:3', label: '4:3', hint: '横向' },
    { value: '3:4', label: '3:4', hint: '竖向' },
    { value: '16:9', label: '16:9', hint: '宽屏' },
    { value: '9:16', label: '9:16', hint: '手机竖屏' },
    { value: '3:2', label: '3:2', hint: '相机横向' },
    { value: '2:3', label: '2:3', hint: '相机竖向' },
    { value: '5:4', label: '5:4', hint: '近方形横向' },
    { value: '4:5', label: '4:5', hint: '近方形竖向' },
    { value: '21:9', label: '21:9', hint: '超宽屏' },
    { value: '9:21', label: '9:21', hint: '超长竖向' },
]);

/** 清晰度档位 */
export const TIERS = Object.freeze([
    { id: '1K', label: '1K', hint: '标准' },
    { id: '2K', label: '2K', hint: '高清' },
    { id: '4K', label: '4K', hint: '超大' },
]);

/**
 * 比例 × 档位 → 具体像素（全部满足 R1～R4，见 docs/gpt-image-2.5-size-rules.md 的档位表）
 */
const PRESET_TABLE = Object.freeze({
    '1:1': { '1K': [1024, 1024], '2K': [2048, 2048], '4K': [2880, 2880] },
    '4:3': { '1K': [1152, 864], '2K': [2368, 1776], '4K': [3264, 2448] },
    '3:4': { '1K': [864, 1152], '2K': [1776, 2368], '4K': [2448, 3264] },
    '16:9': { '1K': [1280, 720], '2K': [2816, 1584], '4K': [3840, 2160] },
    '9:16': { '1K': [720, 1280], '2K': [1584, 2816], '4K': [2160, 3840] },
    '3:2': { '1K': [1248, 832], '2K': [2496, 1664], '4K': [3504, 2336] },
    '2:3': { '1K': [832, 1248], '2K': [1664, 2496], '4K': [2336, 3504] },
    '5:4': { '1K': [1120, 896], '2K': [2320, 1856], '4K': [3200, 2560] },
    '4:5': { '1K': [896, 1120], '2K': [1856, 2320], '4K': [2560, 3200] },
    '21:9': { '1K': [1568, 672], '2K': [3136, 1344], '4K': [3808, 1632] },
    '9:21': { '1K': [672, 1568], '2K': [1344, 3136], '4K': [1632, 3808] },
});

export const DEFAULT_SIZE_CONFIG = Object.freeze({
    // 默认「沿用原图」：编辑模式保留原图尺寸；生成模式没有原图，会按 ratio+tier 解析成预设尺寸
    mode: 'source', // 'preset' | 'custom' | 'source'
    ratio: '1:1',
    tier: '1K',
    width: 1024,
    height: 1024,
});

/** 界面提示文案（与官方原文保持一致，不做“更慢/失败”之类的推断） */
export const SIZE_RULE_HINT =
    'GPT Image 2.5：宽高须为 16 的倍数，单边 ≤ 3840，宽高比 1:3～3:1，总像素 65.5 万～829 万。';

export const isPresetRatio = (value) => Object.prototype.hasOwnProperty.call(PRESET_TABLE, String(value));
export const isTier = (value) => TIERS.some((tier) => tier.id === value);
export const isChatImageModel = (model) => /^(gemini-|nano-banana)/i.test(String(model || ''));
/** gpt-image-2 / gpt-image-2.5 才支持任意合法像素尺寸 */
export const isGptImage2Model = (model) => /^gpt-image-2(?:\.\d+)?(?:-|$)/i.test(String(model || ''));
/** gpt-image-1 / 1.5 / mini 只支持 3 个标准尺寸（见 docs/gpt-image-2.5-size-rules.md §3.1） */
export const isGptImage1Model = (model) => /^gpt-image-1(?:[.-]|$)/i.test(String(model || ''));

/** gpt-image-1 系列仅支持的标准尺寸 */
export const GPT_IMAGE_1_STANDARD_SIZES = Object.freeze([
    { width: 1024, height: 1024, ratio: '1:1' },
    { width: 1536, height: 1024, ratio: '3:2' },
    { width: 1024, height: 1536, ratio: '2:3' },
]);

export const getPresetSize = (ratio, tier) => {
    const byTier = PRESET_TABLE[ratio] || PRESET_TABLE['1:1'];
    const [width, height] = byTier[tier] || byTier['1K'];
    return { width, height };
};

const roundTo = (value, step) => Math.round(value / step) * step;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/**
 * 解析尺寸字符串，兼容 "800:800" / "800x800" / "800×800" / "800*800" 以及旧版预设值 "1K"
 * @returns {{width:number,height:number}|null}
 */
export function parseSize(input) {
    if (input && typeof input === 'object') {
        const width = Number(input.width);
        const height = Number(input.height);
        return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
            ? { width: Math.round(width), height: Math.round(height) }
            : null;
    }
    const value = String(input ?? '').trim();
    if (!value) return null;

    const match = value.match(/^(\d{2,5})\s*(?:x|×|\*|:|：)\s*(\d{2,5})$/i);
    if (match) return { width: Number(match[1]), height: Number(match[2]) };

    const alias = { '1k': 1024, '2k': 2048, '4k': 2880 }[value.toLowerCase()];
    return alias ? { width: alias, height: alias } : null;
}

/**
 * 校验像素尺寸
 * @param {number} width
 * @param {number} height
 * @param {{strict?: boolean, experimental?: boolean}} options strict=true 时按 GPT Image 的硬约束全部校验（硬错误），
 *        strict=false 时只拦截非整数/非正数，其余降级为提示（适用于未经验证的第三方模型）；
 *        experimental 默认跟随 strict（未经验证的模型不提示 experimental）
 */
export function validateSize(width, height, { strict = true, experimental = strict } = {}) {
    const errors = [];
    const warnings = [];
    const w = Number(width);
    const h = Number(height);
    const normalized = { width: Math.round(w), height: Math.round(h) };

    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
        errors.push('宽和高必须是大于 0 的整数');
        return { ok: false, errors, warnings, normalized, experimental: false };
    }
    if (!Number.isInteger(w) || !Number.isInteger(h)) {
        errors.push('宽和高必须是整数像素');
    }

    const multipleOf = strict ? SIZE_LIMITS.multipleOf : 2;
    const pushIssue = (message) => (strict ? errors : warnings).push(message);

    if (Number.isInteger(w) && w % multipleOf !== 0) {
        pushIssue(`宽需为 ${multipleOf} 的倍数（当前 ${w}）`);
    }
    if (Number.isInteger(h) && h % multipleOf !== 0) {
        pushIssue(`高需为 ${multipleOf} 的倍数（当前 ${h}）`);
    }

    const longEdge = Math.max(w, h);
    const shortEdge = Math.max(Math.min(w, h), 1);
    const aspect = longEdge / shortEdge;

    if (longEdge > SIZE_LIMITS.maxEdge) {
        pushIssue(`单边需 ≤ ${SIZE_LIMITS.maxEdge}（当前长边 ${longEdge}）`);
    }
    if (aspect > SIZE_LIMITS.maxAspect + 1e-9) {
        pushIssue(`宽高比需在 1:${SIZE_LIMITS.maxAspect} ～ ${SIZE_LIMITS.maxAspect}:1 之间（当前 ${aspect.toFixed(2)}:1）`);
    }

    const pixels = w * h;
    if (pixels < SIZE_LIMITS.minPixels || pixels > SIZE_LIMITS.maxPixels) {
        pushIssue(
            `总像素需在 ${SIZE_LIMITS.minPixels.toLocaleString('en-US')} ～ ${SIZE_LIMITS.maxPixels.toLocaleString('en-US')} 之间（当前 ${pixels.toLocaleString('en-US')}）`
        );
    }

    const isExperimental = experimental && pixels > SIZE_LIMITS.experimentalPixels;
    if (isExperimental) {
        warnings.push('超过 2560×1440 属于官方标注的 experimental 分辨率');
    }

    return { ok: errors.length === 0, errors, warnings, normalized, experimental: isExperimental };
}

/** 找出与给定宽高最接近的预设比例 */
export function nearestRatio(width, height) {
    const target = Math.log(Math.max(Number(width) || 1, 1) / Math.max(Number(height) || 1, 1));
    let best = RATIO_OPTIONS[0].value;
    let bestDiff = Infinity;
    for (const option of RATIO_OPTIONS) {
        const [w, h] = option.value.split(':').map(Number);
        const diff = Math.abs(Math.log(w / h) - target);
        if (diff < bestDiff) {
            bestDiff = diff;
            best = option.value;
        }
    }
    return best;
}

/** 在所有预设尺寸里找最接近的一个（比例与像素数综合） */
export function nearestPresetSize(width, height) {
    const w0 = Math.max(Number(width) || 1, 1);
    const h0 = Math.max(Number(height) || 1, 1);
    let best = null;
    let bestScore = Infinity;
    for (const option of RATIO_OPTIONS) {
        for (const tier of TIERS) {
            const size = getPresetSize(option.value, tier.id);
            const ratioScore = Math.abs(Math.log(size.width / size.height) - Math.log(w0 / h0));
            const areaScore = Math.abs(Math.log((size.width * size.height) / (w0 * h0)));
            const score = ratioScore * 2 + areaScore;
            if (score < bestScore) {
                bestScore = score;
                best = { ...size, ratio: option.value, tier: tier.id };
            }
        }
    }
    return best;
}

/**
 * 给非法自定义尺寸兜底一个最近合法尺寸。
 * 返回目标比例、目标像素数附近的合法像素（全部满足 R1～R4）。
 */
export function suggestLegalSize(width, height) {
    const w0 = Math.max(Number(width) || 1, 1);
    const h0 = Math.max(Number(height) || 1, 1);
    const targetAspect = clamp(w0 / h0, 1 / SIZE_LIMITS.maxAspect, SIZE_LIMITS.maxAspect);
    const targetPixels = clamp(w0 * h0, SIZE_LIMITS.minPixels, SIZE_LIMITS.maxPixels);

    const candidates = [];
    const baseWidth = Math.sqrt(targetPixels * targetAspect);
    for (let step = -8; step <= 8; step += 1) {
        const width_ = roundTo(baseWidth, SIZE_LIMITS.multipleOf) + step * SIZE_LIMITS.multipleOf;
        if (width_ < SIZE_LIMITS.multipleOf || width_ > SIZE_LIMITS.maxEdge) continue;
        const height_ = roundTo(width_ / targetAspect, SIZE_LIMITS.multipleOf);
        if (height_ < SIZE_LIMITS.multipleOf || height_ > SIZE_LIMITS.maxEdge) continue;

        const check = validateSize(width_, height_, { strict: true });
        if (!check.ok) continue;

        const score =
            Math.abs(Math.log((width_ * height_) / targetPixels)) +
            Math.abs(Math.log((width_ / height_) / targetAspect)) * 2;
        candidates.push({ width: width_, height: height_, score });
    }

    if (candidates.length === 0) {
        const fallback = nearestPresetSize(w0, h0);
        return { width: fallback.width, height: fallback.height };
    }

    candidates.sort((a, b) => a.score - b.score);
    return { width: candidates[0].width, height: candidates[0].height };
}

/** 模型使用哪套尺寸参数：google = Gemini 原生（比例+档位），openai = Images API（size: WxH） */
export function getModelSizeCapability(model) {
    const name = String(model || '');
    if (isChatImageModel(name)) {
        const fixedTier = /-2k$/i.test(name) ? '2K' : /-4k$/i.test(name) ? '4K' : '';
        return {
            kind: 'google',
            name,
            supportsPreset: true,
            supportsCustomPixels: false,
            supportsSource: true,
            fixedTier,
            /** 像素由模型决定，接口只能给比例和档位 */
            pixelExact: false,
            /** 是否按 GPT Image 硬约束强校验 */
            strictPixels: false,
            standardSizes: null,
        };
    }

    const standardSizes = isGptImage1Model(name) ? GPT_IMAGE_1_STANDARD_SIZES : null;
    return {
        kind: 'openai',
        name,
        supportsPreset: true,
        // gpt-image-1 / 1.5 / mini 只支持 3 个标准尺寸，不能填任意像素
        supportsCustomPixels: !standardSizes,
        supportsSource: true,
        fixedTier: '',
        pixelExact: true,
        strictPixels: isGptImage2Model(name),
        standardSizes,
    };
}

/** 归一化尺寸配置（容错旧数据 / 手写 localStorage） */
export function normalizeSizeConfig(config) {
    const source = config && typeof config === 'object' ? config : {};
    const mode = ['preset', 'custom', 'source'].includes(source.mode) ? source.mode : 'source';
    const ratio = isPresetRatio(source.ratio) ? String(source.ratio) : '1:1';
    const tier = isTier(source.tier) ? source.tier : '1K';
    const preset = getPresetSize(ratio, tier);
    // 只对“从未填写过”做预设回退；0 / NaN 要保留给 validateSize 报错，
    // 否则清空输入框会被静默替换成预设值、并在界面显示“尺寸合法”。
    const widthValue = source.width;
    const heightValue = source.height;
    const width = widthValue === undefined || widthValue === null || widthValue === ''
        ? preset.width
        : Math.round(Number(widthValue));
    const height = heightValue === undefined || heightValue === null || heightValue === ''
        ? preset.height
        : Math.round(Number(heightValue));
    return { mode, ratio, tier, width, height };
}

/** 旧版 localStorage（imageSize / aspectRatio）迁移到新的单一配置 */
export function migrateLegacySizeConfig({ imageSize, aspectRatio } = {}) {
    const parsed = parseSize(imageSize);
    if (!parsed) {
        const ratio = isPresetRatio(aspectRatio) ? aspectRatio : '1:1';
        return normalizeSizeConfig({ ...DEFAULT_SIZE_CONFIG, ratio });
    }

    // 旧版编辑模式其实从不传尺寸（等于「沿用原图」），所以迁移后默认也是 source；
    // 生成模式没有原图，会按 ratio + tier 解析成预设尺寸。
    for (const option of RATIO_OPTIONS) {
        for (const tier of TIERS) {
            const size = getPresetSize(option.value, tier.id);
            if (size.width === parsed.width && size.height === parsed.height) {
                return normalizeSizeConfig({ mode: 'source', ratio: option.value, tier: tier.id, ...size });
            }
        }
    }

    // 旧值不在当前档位表里（如旧版 4K=4096×4096）时，映射到最接近的合法档位，
    // 避免老用户从 4K 静默掉到 1K
    const nearest = nearestPresetSize(parsed.width, parsed.height);
    return normalizeSizeConfig({
        mode: 'source',
        ratio: nearest.ratio,
        tier: nearest.tier,
        width: parsed.width,
        height: parsed.height,
    });
}

/**
 * 把界面上的「一个」尺寸配置解析成接口真正需要的参数。
 *
 * @param {object} args
 * @param {object} args.config 尺寸配置 { mode, ratio, tier, width, height }
 * @param {string} args.model 模型名
 * @param {'generate'|'edit'} [args.mode] 当前模式（编辑模式才允许“沿用原图”）
 * @param {{width:number,height:number}|null} [args.sourceSize] 编辑目标图层的像素尺寸
 * @returns {{
 *   mode: string, width: number, height: number,
 *   pixelSize: (string|null), aspectRatio: (string|null), imageSize: (string|null),
 *   errors: string[], warnings: string[], experimental: boolean,
 *   capability: object,
 * }}
 */
export function resolveOutputSize({ config, model, mode = 'generate', sourceSize = null } = {}) {
    const capability = getModelSizeCapability(model);
    const cfg = normalizeSizeConfig(config);
    const hasSource = !!(sourceSize && sourceSize.width > 0 && sourceSize.height > 0);
    const isEdit = mode === 'edit';

    let effectiveMode = cfg.mode;
    let presetRatio = cfg.ratio;
    if (effectiveMode === 'source' && (!isEdit || !hasSource)) effectiveMode = 'preset';
    if (effectiveMode === 'custom' && !capability.supportsCustomPixels) {
        // 当前模型只能给比例：从自定义像素退化到最接近的比例，而不是无意义地回到 1:1
        presetRatio = nearestRatio(cfg.width, cfg.height);
        effectiveMode = 'preset';
    }

    const resolved = {
        mode: effectiveMode,
        width: 0,
        height: 0,
        pixelSize: null,
        aspectRatio: null,
        imageSize: null,
        errors: [],
        warnings: [],
        experimental: false,
        capability,
    };

    if (cfg.mode === 'custom' && effectiveMode === 'preset' && capability.standardSizes) {
        resolved.warnings.push(
            `该模型只支持 ${capability.standardSizes.map((size) => `${size.width}×${size.height}`).join(' / ')}，已自动选择最接近的尺寸`
        );
    }

    if (effectiveMode === 'source') {
        resolved.width = Math.round(sourceSize.width);
        resolved.height = Math.round(sourceSize.height);
        // 原图模式不显式传 size：编辑接口的 size 默认 auto，交给接口沿用输入尺寸
        if (capability.strictPixels) {
            const check = validateSize(resolved.width, resolved.height, { strict: true });
            if (!check.ok) {
                resolved.warnings.push(
                    `原图尺寸 ${resolved.width}×${resolved.height} 不满足 GPT Image 尺寸约束，编辑结果尺寸可能被接口调整`
                );
            }
            resolved.experimental = check.experimental;
        }
        return resolved;
    }

    if (effectiveMode === 'preset') {
        // gpt-image-1 系列只支持 3 个标准尺寸：按最接近的比例挑一个
        if (capability.standardSizes) {
            const size = pickStandardSize(capability.standardSizes, presetRatio);
            resolved.width = size.width;
            resolved.height = size.height;
            resolved.pixelSize = `${size.width}x${size.height}`;
            return resolved;
        }

        const tier = capability.fixedTier || cfg.tier;
        const size = getPresetSize(presetRatio, tier);
        resolved.width = size.width;
        resolved.height = size.height;
        resolved.experimental = validateSize(size.width, size.height, { strict: true }).experimental;

        if (capability.kind === 'google') {
            resolved.aspectRatio = presetRatio;
            resolved.imageSize = tier;
        } else {
            resolved.pixelSize = `${size.width}x${size.height}`;
        }
        return resolved;
    }

    // 自定义像素
    resolved.width = cfg.width;
    resolved.height = cfg.height;
    const check = validateSize(cfg.width, cfg.height, { strict: capability.strictPixels });
    resolved.errors.push(...check.errors);
    resolved.warnings.push(...check.warnings);
    resolved.experimental = check.experimental;

    if (resolved.errors.length === 0) {
        resolved.pixelSize = `${cfg.width}x${cfg.height}`;
    }

    return resolved;
}

/** 在给定尺寸集合里挑与比例最接近的一个 */
function pickStandardSize(sizes, ratio) {
    const [w, h] = String(ratio).split(':').map(Number);
    const target = w / h;
    let best = sizes[0];
    let bestDiff = Infinity;
    for (const size of sizes) {
        const diff = Math.abs(Math.log(size.width / size.height / target));
        if (diff < bestDiff) {
            bestDiff = diff;
            best = size;
        }
    }
    return best;
}

/** 展示用文案，例如「1024 × 1024 · 1:1」 */
export function formatOutputSize(resolved) {
    if (!resolved) return '';
    const size = `${resolved.width} × ${resolved.height}`;
    if (resolved.mode === 'source') return `原图 ${size}`;
    if (resolved.mode === 'custom') return `自定义 ${size}`;
    // Gemini / nano-banana 只能选比例和档位，具体像素由模型决定，不要展示假像素
    if (resolved.capability.kind === 'google') {
        return `${resolved.aspectRatio} · ${resolved.imageSize}`;
    }
    return `${size} · ${nearestRatio(resolved.width, resolved.height)}`;
}

/** 模型不支持精确像素时（Gemini / nano-banana）的说明 */
export const GOOGLE_SIZE_HINT = '该模型只能选择比例与清晰度档位，具体像素由模型决定。';
