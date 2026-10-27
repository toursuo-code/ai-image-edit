/**
 * 本地图像工具：裁剪 / 拉伸（直接更改图片像素尺寸）
 *
 * 设计要点：
 *  - 全部走浏览器 Canvas 2D，不调用任何接口、不需要 API Key，也不消耗额度；
 *  - 只处理「一个图层」的像素：输入是图层的 dataURL，输出是新的 dataURL（PNG，保留透明通道）；
 *  - 校验函数（validateCropRect / validateTargetSize / clampCropRect）是纯函数，不碰 DOM，便于单元测试；
 *    真正做像素处理的 cropImageToDataUrl / resizeImageToDataUrl 才依赖 Image / Canvas。
 *
 * 与 AI 编辑的区别：这里不经过模型，尺寸/像素完全由本地计算决定，所见即所得。
 */

/** 浏览器 Canvas 的保守可用上限：超过后多数浏览器会画不出内容或占用巨量内存 */
export const IMAGE_TOOL_LIMITS = Object.freeze({
    maxEdge: 16384,
    // 40,000,000 像素 ≈ 8000×5000，画布约 160MB 内存；再大容易出现空白图/卡死
    maxPixels: 40_000_000,
    // 超过该像素数时提示处理较慢（不拦截）
    warnPixels: 20_000_000,
    // 放大超过该倍数时提示画质不会真正提升（不拦截）
    maxUpscaleWarn: 4,
});

const OUTPUT_MIME = 'image/png';

/** 取整并夹到 [min, max]；非法输入按 min 处理 */
const clampInt = (value, min, max) => {
    const number = Math.round(Number(value));
    if (!Number.isFinite(number)) return min;
    return Math.min(max, Math.max(min, number));
};

/** 由 dataURL 推导 mimeType / base64，供图层状态直接使用 */
export function splitDataUrl(dataUrl) {
    const value = String(dataUrl ?? '');
    const mimeType = value.split(';')[0].split(':')[1] || OUTPUT_MIME;
    const base64 = value.split(',')[1] || '';
    return { mimeType, base64 };
}

/**
 * 读取图片（dataURL / blobURL / https URL），返回解码完成的 HTMLImageElement
 * @param {string} source
 * @returns {Promise<HTMLImageElement>}
 */
export function loadImage(source) {
    return new Promise((resolve, reject) => {
        if (!source) {
            reject(new Error('缺少图片数据'));
            return;
        }

        const image = new Image();
        // dataURL / blobURL 不受跨域限制；远程图片尝试用 anonymous，尽量让画布可用
        if (!String(source).startsWith('data:') && !String(source).startsWith('blob:')) {
            image.crossOrigin = 'anonymous';
        }
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error('图片加载失败，请重新上传或生成图片'));
        image.src = source;
    });
}

/** 取图片的真实像素尺寸（naturalWidth 优先，缺失时退回 width） */
export function getImageSize(image) {
    return {
        width: Math.round(Number(image?.naturalWidth || image?.width) || 0),
        height: Math.round(Number(image?.naturalHeight || image?.height) || 0),
    };
}

/**
 * 校验裁剪区域（原图像素坐标）
 *
 * @param {{x:number,y:number,width:number,height:number}} rect
 * @param {{width:number,height:number}} sourceSize 原图尺寸
 * @returns {{ok:boolean, errors:string[], rect:({x:number,y:number,width:number,height:number}|null), source:{width:number,height:number}}}
 */
export function validateCropRect(rect, sourceSize) {
    const source = {
        width: Math.round(Number(sourceSize?.width) || 0),
        height: Math.round(Number(sourceSize?.height) || 0),
    };

    if (source.width < 1 || source.height < 1) {
        return { ok: false, errors: ['原图尺寸无效，请重新选择图层'], rect: null, source };
    }

    const crop = {
        x: Math.round(Number(rect?.x)),
        y: Math.round(Number(rect?.y)),
        width: Math.round(Number(rect?.width)),
        height: Math.round(Number(rect?.height)),
    };

    if (![crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)) {
        return { ok: false, errors: ['请填写有效的整数像素值'], rect: null, source };
    }

    const errors = [];
    if (crop.width < 1 || crop.height < 1) {
        errors.push('裁剪宽度和高度都必须大于 0');
    }
    if (crop.x < 0 || crop.y < 0) {
        errors.push('裁剪起点 X / Y 不能为负数');
    }
    if (crop.x + crop.width > source.width) {
        errors.push(`X + 宽度不能超过原图宽度 ${source.width}px（当前 ${crop.x + crop.width}px）`);
    }
    if (crop.y + crop.height > source.height) {
        errors.push(`Y + 高度不能超过原图高度 ${source.height}px（当前 ${crop.y + crop.height}px）`);
    }

    return { ok: errors.length === 0, errors, rect: crop, source };
}

/**
 * 校验目标尺寸（拉伸输出）
 *
 * @param {{width:number,height:number}} target
 * @param {{sourceSize?:{width:number,height:number}|null}} [options]
 * @returns {{ok:boolean, errors:string[], warnings:string[], size:({width:number,height:number}|null)}}
 */
export function validateTargetSize(target, { sourceSize = null } = {}) {
    const size = {
        width: Math.round(Number(target?.width)),
        height: Math.round(Number(target?.height)),
    };
    const errors = [];
    const warnings = [];

    if (!Number.isFinite(size.width) || !Number.isFinite(size.height)) {
        return { ok: false, errors: ['请填写有效的整数像素值'], warnings, size: null };
    }

    if (size.width < 1 || size.height < 1) {
        errors.push('目标宽度和高度都必须大于 0');
    }
    if (size.width > IMAGE_TOOL_LIMITS.maxEdge || size.height > IMAGE_TOOL_LIMITS.maxEdge) {
        errors.push(`单边不能超过 ${IMAGE_TOOL_LIMITS.maxEdge}px`);
    }
    if (size.width * size.height > IMAGE_TOOL_LIMITS.maxPixels) {
        errors.push(
            `总像素不能超过 ${IMAGE_TOOL_LIMITS.maxPixels.toLocaleString('en-US')}（约 ${IMAGE_TOOL_LIMITS.maxPixels / 1_000_000} 百万像素）`
        );
    }
    if (size.width * size.height > IMAGE_TOOL_LIMITS.warnPixels) {
        warnings.push('输出像素较多，处理与导出可能需要几秒钟');
    }

    const source = {
        width: Math.round(Number(sourceSize?.width) || 0),
        height: Math.round(Number(sourceSize?.height) || 0),
    };
    if (source.width > 0 && source.height > 0 && size.width > 0 && size.height > 0) {
        const scale = Math.max(size.width / source.width, size.height / source.height);
        if (scale >= IMAGE_TOOL_LIMITS.maxUpscaleWarn) {
            warnings.push(`放大倍数约 ${scale.toFixed(1)}×，像素是插值出来的，清晰度不会真正提升`);
        }
    }

    return { ok: errors.length === 0, errors, warnings, size };
}

/**
 * 把裁剪矩形夹到图片范围内（防御性兜底，正常执行前已通过 validateCropRect）
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function clampCropRect(rect, sourceSize) {
    const source = {
        width: Math.round(Number(sourceSize?.width) || 0),
        height: Math.round(Number(sourceSize?.height) || 0),
    };
    if (source.width < 1 || source.height < 1) return null;

    const x = clampInt(rect?.x, 0, source.width - 1);
    const y = clampInt(rect?.y, 0, source.height - 1);
    return {
        x,
        y,
        width: clampInt(rect?.width, 1, source.width - x),
        height: clampInt(rect?.height, 1, source.height - y),
    };
}

/** 创建指定像素尺寸的离屏 canvas */
function createCanvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器不支持 Canvas 2D，无法处理图片');
    return { canvas, context };
}

/**
 * 裁剪图片：只保留 rect 指定的区域，不缩放（像素 1:1 复制）
 *
 * @param {string} source 图片 dataURL / URL
 * @param {{x:number,y:number,width:number,height:number}} rect 原图像素坐标
 * @returns {Promise<{dataUrl:string,width:number,height:number,x:number,y:number}>}
 */
export async function cropImageToDataUrl(source, rect) {
    const image = await loadImage(source);
    const sourceSize = getImageSize(image);
    const safe = clampCropRect(rect, sourceSize);
    if (!safe) throw new Error('图片尺寸无效，无法裁剪');

    const { canvas, context } = createCanvas(safe.width, safe.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, safe.x, safe.y, safe.width, safe.height, 0, 0, safe.width, safe.height);

    return {
        dataUrl: canvas.toDataURL(OUTPUT_MIME),
        width: safe.width,
        height: safe.height,
        x: safe.x,
        y: safe.y,
    };
}

/**
 * 拉伸图片：把整张图直接缩放到目标宽高（不保持比例，允许变形）
 *
 * @param {string} source 图片 dataURL / URL
 * @param {{width:number,height:number}} target 目标像素尺寸
 * @returns {Promise<{dataUrl:string,width:number,height:number}>}
 */
export async function resizeImageToDataUrl(source, target) {
    const check = validateTargetSize(target);
    if (!check.ok) {
        throw new Error(`目标尺寸不合法：${check.errors.join('；')}`);
    }

    const image = await loadImage(source);
    const { canvas, context } = createCanvas(check.size.width, check.size.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(image, 0, 0, check.size.width, check.size.height);

    return {
        dataUrl: canvas.toDataURL(OUTPUT_MIME),
        width: check.size.width,
        height: check.size.height,
    };
}
