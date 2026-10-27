import React from 'react';
import { cn } from '../lib/utils';
import {
    GOOGLE_SIZE_HINT,
    RATIO_OPTIONS,
    SIZE_RULE_HINT,
    TIERS,
    formatOutputSize,
    getModelSizeCapability,
    getPresetSize,
    nearestRatio,
    normalizeSizeConfig,
    resolveOutputSize,
    suggestLegalSize,
} from '../lib/imageSize';

/**
 * 一个比例/尺寸的小图示，让「比例」比纯文字更直观
 */
function RatioGlyph({ ratio }) {
    const [w, h] = String(ratio).split(':').map(Number);
    const long = 16;
    const width = w >= h ? long : Math.max(6, Math.round((long * w) / h));
    const height = w >= h ? Math.max(6, Math.round((long * h) / w)) : long;
    return (
        <span
            aria-hidden="true"
            className="inline-block shrink-0 rounded-[2px] border border-current opacity-70"
            style={{ width, height }}
        />
    );
}

/**
 * 输出尺寸选择器
 *
 * 只暴露「一个」尺寸设置，三种入口互斥：
 *  - 沿用原图（仅编辑模式且有选中图层）
 *  - 按比例：比例 + 清晰度档位（1K/2K/4K）→ 自动解析成具体像素
 *  - 自定义像素：直接填宽高（仅 GPT Image 2 / 2.5 这类能精确指定像素的模型）
 *
 * 模型能力不同，展示的选项也不同：
 *  - Gemini / nano-banana 只能给 aspect_ratio + image_size 档位，不提供自定义像素；
 *  - gpt-image-1 系列只支持 3 个标准尺寸，不提供自定义像素；
 *  - GPT Image 2 / 2.5 走 size: "WxH"，按 16 倍数 / 单边 ≤3840 / 1:3~3:1 / 像素区间 做实时校验。
 */
export function SizeControl({
    config,
    onChange,
    modelName,
    mode = 'generate',
    sourceSize = null,
}) {
    const cfg = normalizeSizeConfig(config);
    const capability = getModelSizeCapability(modelName);
    const resolved = resolveOutputSize({ config: cfg, model: modelName, mode, sourceSize });
    const effectiveMode = resolved.mode;

    const hasSource = !!(sourceSize && sourceSize.width > 0 && sourceSize.height > 0);
    const canUseSource = mode === 'edit' && hasSource && capability.supportsSource;

    const tabs = [];
    if (canUseSource) tabs.push({ id: 'source', label: '沿用原图' });
    tabs.push({ id: 'preset', label: '按比例' });
    if (capability.supportsCustomPixels) tabs.push({ id: 'custom', label: '自定义像素' });

    const standardSizes = capability.standardSizes || null;
    const visibleRatios = standardSizes
        ? RATIO_OPTIONS.filter((option) => standardSizes.some((size) => size.ratio === option.value))
        : RATIO_OPTIONS;

    // custom → preset 退化（例如切到只能给比例的模型）后，把派生出来的比例当作当前选中项
    const activeTier = capability.fixedTier || cfg.tier;
    const activeRatio = standardSizes
        ? nearestRatio(resolved.width || cfg.width, resolved.height || cfg.height)
        : effectiveMode === 'preset'
            ? resolved.aspectRatio || cfg.ratio
            : cfg.ratio;

    // 自定义像素输入框的原始文本：避免输入过程中被 normalize 覆盖
    const [widthText, setWidthText] = React.useState(
        Number.isFinite(cfg.width) && cfg.width > 0 ? String(cfg.width) : ''
    );
    const [heightText, setHeightText] = React.useState(
        Number.isFinite(cfg.height) && cfg.height > 0 ? String(cfg.height) : ''
    );

    const update = (patch) => onChange?.({ ...cfg, ...patch });

    const applyPreset = (patch = {}) => {
        // custom → preset 时按当前像素退到最接近的比例；preset 内部切换时沿用派生比例
        const ratio =
            effectiveMode === 'preset'
                ? activeRatio
                : effectiveMode === 'custom'
                    ? nearestRatio(cfg.width, cfg.height)
                    : cfg.ratio;
        update({ mode: 'preset', ratio, ...patch });
    };

    const applyCustom = (width, height) => {
        setWidthText(String(width));
        setHeightText(String(height));
        update({ mode: 'custom', width, height });
    };

    const handleTabClick = (tabId) => {
        if (tabId === effectiveMode) return;
        if (tabId === 'custom') {
            applyCustom(resolved.width || cfg.width, resolved.height || cfg.height);
        } else if (tabId === 'preset') {
            applyPreset();
        } else {
            update({ mode: tabId });
        }
    };

    const handleInputChange = (nextWidthText, nextHeightText) => {
        setWidthText(nextWidthText);
        setHeightText(nextHeightText);
        // 空值/非法字符按 0 提交，让校验结果和界面保持一致（生成按钮会因此禁用）
        const toNumber = (text) => (/^\d+$/.test(String(text).trim()) ? Number(text) : 0);
        update({ mode: 'custom', width: toNumber(nextWidthText), height: toNumber(nextHeightText) });
    };

    const suggestion =
        effectiveMode === 'custom' && resolved.errors.length > 0
            ? suggestLegalSize(cfg.width, cfg.height)
            : null;

    const sizeHint = standardSizes
        ? `该模型只支持 ${standardSizes.map((size) => `${size.width}×${size.height}`).join(' / ')} 三种尺寸。`
        : capability.kind === 'google'
            ? GOOGLE_SIZE_HINT
            : capability.strictPixels
                ? SIZE_RULE_HINT
                : '建议宽高为 16 的倍数（GPT Image 系列有此硬性限制）。';

    return (
        <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
                <label className="text-xs font-bold uppercase tracking-widest text-slate-500">输出尺寸</label>
                <span
                    className={cn(
                        'truncate text-xs font-medium tabular-nums',
                        resolved.errors.length > 0 ? 'text-red-500' : 'text-slate-500'
                    )}
                    title={formatOutputSize(resolved)}
                >
                    {resolved.errors.length > 0 ? '尺寸不合法' : formatOutputSize(resolved)}
                </span>
            </div>

            {tabs.length > 1 && (
                <div className="flex p-1 bg-gray-200/50 rounded-lg">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            type="button"
                            onClick={() => handleTabClick(tab.id)}
                            className={cn(
                                'flex-1 py-1.5 text-xs font-medium rounded-md transition-all',
                                effectiveMode === tab.id
                                    ? 'bg-white shadow-sm text-slate-900'
                                    : 'text-slate-500 hover:text-slate-700'
                            )}
                        >
                            {tab.label}
                        </button>
                    ))}
                </div>
            )}

            {effectiveMode === 'source' && (
                <div className="px-3 py-2 bg-white/70 rounded-lg border border-gray-200">
                    <p className="text-xs text-slate-600">
                        沿用原图尺寸{' '}
                        <span className="font-semibold text-slate-800 tabular-nums">
                            {resolved.width} × {resolved.height}
                        </span>
                    </p>
                    <p className="mt-1 text-[11px] leading-snug text-slate-400">
                        不传 size（编辑接口默认 auto），输出尺寸可能被接口调整。
                    </p>
                    {resolved.warnings.map((message) => (
                        <p key={message} className="mt-1 text-[11px] leading-snug text-amber-600">
                            {message}
                        </p>
                    ))}
                </div>
            )}

            {effectiveMode === 'preset' && (
                <div className="space-y-1.5">
                    <div className={cn('grid gap-1.5', visibleRatios.length === 3 ? 'grid-cols-3' : 'grid-cols-4')}>
                        {visibleRatios.map((option) => {
                            const selected = activeRatio === option.value;
                            return (
                                <button
                                    key={option.value}
                                    type="button"
                                    title={`${option.label}（${option.hint}）`}
                                    onClick={() => applyPreset({ ratio: option.value })}
                                    className={cn(
                                        'flex items-center justify-center gap-1 px-1 py-1.5 rounded-lg border text-[11px] font-medium transition-all',
                                        selected
                                            ? 'border-transparent bg-gradient-to-br from-red-400 to-red-500 text-white shadow-md'
                                            : 'border-gray-200 bg-white/70 text-slate-600 hover:border-slate-300 hover:bg-white'
                                    )}
                                >
                                    <RatioGlyph ratio={option.value} />
                                    <span>{option.label}</span>
                                </button>
                            );
                        })}
                    </div>

                    {!standardSizes && (
                        <div className="grid grid-cols-3 gap-1.5">
                            {TIERS.map((tier) => {
                                const selected = activeTier === tier.id;
                                const size = getPresetSize(activeRatio, tier.id);
                                const locked = !!capability.fixedTier && !selected;
                                return (
                                    <button
                                        key={tier.id}
                                        type="button"
                                        disabled={locked}
                                        onClick={() => applyPreset({ tier: tier.id })}
                                        className={cn(
                                            'flex flex-col items-center gap-0.5 py-1.5 rounded-lg border transition-all',
                                            selected
                                                ? 'border-transparent bg-gradient-to-br from-red-400 to-red-500 text-white shadow-md'
                                                : 'border-gray-200 bg-white/70 text-slate-600 hover:border-slate-300 hover:bg-white',
                                            locked && 'cursor-not-allowed opacity-40 hover:border-gray-200 hover:bg-white/70'
                                        )}
                                    >
                                        <span className="text-xs font-semibold">{tier.label}</span>
                                        <span className="text-[10px] leading-none tabular-nums opacity-80">
                                            {capability.pixelExact ? `${size.width}×${size.height}` : tier.hint}
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    )}

                    {capability.fixedTier && (
                        <p className="text-[11px] leading-snug text-slate-400">
                            该模型固定按 {capability.fixedTier} 档输出，档位不可切换。
                        </p>
                    )}

                    {resolved.warnings.map((message) => (
                        <p key={message} className="text-[11px] leading-snug text-amber-600">
                            {message}
                        </p>
                    ))}
                </div>
            )}

            {effectiveMode === 'custom' && (
                <div className="space-y-1.5">
                    <div className="flex items-center gap-1.5">
                        <input
                            type="number"
                            min="16"
                            step="16"
                            inputMode="numeric"
                            aria-label="宽度（像素）"
                            value={widthText}
                            onChange={(e) => handleInputChange(e.target.value, heightText)}
                            className="w-full min-w-0 px-2 py-1.5 text-center text-sm tabular-nums bg-white/80 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-slate-400"
                        />
                        <span className="text-xs text-slate-400">×</span>
                        <input
                            type="number"
                            min="16"
                            step="16"
                            inputMode="numeric"
                            aria-label="高度（像素）"
                            value={heightText}
                            onChange={(e) => handleInputChange(widthText, e.target.value)}
                            className="w-full min-w-0 px-2 py-1.5 text-center text-sm tabular-nums bg-white/80 rounded-lg border border-gray-200 focus:outline-none focus:ring-2 focus:ring-slate-400"
                        />
                        <span className="text-xs text-slate-400">px</span>
                    </div>

                    {resolved.errors.length > 0 ? (
                        <ul className="space-y-0.5">
                            {resolved.errors.map((message) => (
                                <li key={message} className="text-[11px] leading-snug text-red-500">
                                    · {message}
                                </li>
                            ))}
                        </ul>
                    ) : resolved.warnings.length > 0 ? (
                        <ul className="space-y-0.5">
                            {resolved.warnings.map((message) => (
                                <li key={message} className="text-[11px] leading-snug text-amber-600">
                                    · {message}
                                </li>
                            ))}
                        </ul>
                    ) : (
                        <p className="text-[11px] leading-snug text-emerald-600">尺寸合法，可以生成。</p>
                    )}

                    {suggestion && (
                        <button
                            type="button"
                            onClick={() => applyCustom(suggestion.width, suggestion.height)}
                            className="text-[11px] text-blue-500 hover:text-blue-600 transition-colors"
                        >
                            使用最近的合法尺寸：{suggestion.width} × {suggestion.height}
                        </button>
                    )}
                </div>
            )}

            <p className="text-[10px] leading-snug text-slate-400">{sizeHint}</p>

            {effectiveMode === 'preset' && capability.pixelExact && capability.strictPixels && !standardSizes && activeTier !== '1K' && (
                <p className="text-[10px] leading-snug text-amber-600">
                    2K / 4K 档位的像素数超过 2560×1440，属官方标注的 experimental 区间。
                </p>
            )}
        </div>
    );
}
