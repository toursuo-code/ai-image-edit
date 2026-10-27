import { parseSize } from './imageSize.js';

export const API_CONFIG = {
    baseUrl: 'https://foxi-ai.top', // Default, can be overridden
    apiKey: '', // User must provide
    timeoutMs: 300_000, // 300 秒
};

/**
 * 本地代理路径：由 vite 开发服务器（dev-api-proxy.js）提供服务端转发，
 * 从而绕过第三方接口未开启 CORS 导致浏览器 fetch 直接失败的问题。
 */
const PROXY_PATH = '/api-proxy';

/**
 * 规范化用户填写的接口地址：
 * - 自动补全 https://
 * - 去掉结尾多余的 /
 * - 去掉误填的 /v1、/v1beta 后缀
 */
export const normalizeBaseUrl = (value) => {
    let base = String(value ?? '').trim();
    if (!base) return '';
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    return base.replace(/\/+$/, '').replace(/\/v1(beta)?$/i, '');
};

/** 从 URL 中取出主机名，用于错误提示 */
const describeHost = (url) => {
    try {
        return new URL(url, 'http://localhost').host || url;
    } catch {
        return url;
    }
};

const fetchWithTimeout = async (url, options = {}, timeoutMs = API_CONFIG.timeoutMs) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (err) {
        if (err?.name === 'AbortError') {
            throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}秒）`);
        }
        // 浏览器网络层错误（例如 net::ERR_CONNECTION_CLOSED / CORS 阻止 / 证书错误 / 断网）通常表现为 TypeError: Failed to fetch
        if (err instanceof TypeError) {
            throw new Error(
                `网络请求失败：无法连接接口服务（${describeHost(url)}）。` +
                '常见原因：接口地址填写错误、接口域名与 HTTPS 证书不匹配、接口服务未开启跨域(CORS)，或网络/代理中断。' +
                '请先在“设置”中确认接口地址；如果是静态部署，还需要为该地址配置同源反向代理。'
            );
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
};

/** 读取接口返回的错误信息（兼容 OpenAI / new-api / 自定义网关的多种格式） */
const readErrorMessage = async (response, fallback) => {
    let text = '';
    try {
        text = await response.text();
    } catch {
        // ignore
    }
    if (!text) return `${fallback}（HTTP ${response.status}）`;
    try {
        const data = JSON.parse(text);
        const message =
            data?.error?.message ||
            data?.message ||
            (typeof data?.error === 'string' ? data.error : '') ||
            data?.error?.code ||
            data?.code;
        if (message) return `${message}（HTTP ${response.status}）`;
    } catch {
        // 不是 JSON，继续按纯文本处理
    }
    return `${fallback}（HTTP ${response.status}）：${text.slice(0, 200)}`;
};

// 是否可以使用本地代理：undefined = 还没探测过，true = 可用，false = 不可用（回退直连）
let proxySupported;

/**
 * 判断响应是不是“静态托管把未知路径回退到了 index.html”。
 * 这种情况说明当前部署没有配置 /api-proxy 反向代理，需要回退为浏览器直连。
 */
const isSpaFallbackResponse = async (response) => {
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/html')) return false;
    try {
        const text = await response.clone().text();
        return /<div id="root">/i.test(text) || /\/src\/main\.jsx/.test(text);
    } catch {
        return false;
    }
};

/**
 * 统一的接口请求入口：
 * 1) 优先走本地代理（同源，无跨域问题）
 * 2) 如果当前环境没有代理（例如纯静态部署），自动回退为浏览器直连
 */
const fetchApi = async (path, { method = 'GET', headers = {}, body, baseUrl, timeoutMs } = {}) => {
    const base = normalizeBaseUrl(baseUrl || API_CONFIG.baseUrl);
    if (!base) {
        throw new Error('未配置接口地址：请先在“设置”中填写接口地址（例如 https://api.example.com）');
    }

    const direct = () => fetchWithTimeout(`${base}${path}`, { method, headers, body }, timeoutMs);

    if (proxySupported !== false) {
        let proxied;
        try {
            proxied = await fetchWithTimeout(
                `${PROXY_PATH}${path}`,
                { method, headers: { ...headers, 'X-Api-Base': base }, body },
                timeoutMs
            );
        } catch (err) {
            if (err?.message?.startsWith('请求超时')) throw err;
            // 同一个源下的代理路由都连不上，说明没有本地代理，退回直连
            if (proxySupported === undefined) {
                proxySupported = false;
                return direct();
            }
            throw err;
        }

        if (proxied.headers.get('x-api-proxy') === '1') {
            proxySupported = true;
            return proxied;
        }

        // 有代理标记，或返回的不是 SPA 回退页面，都说明请求确实经过了代理
        if (proxied.headers.get('x-api-proxy') === '1' || !(await isSpaFallbackResponse(proxied))) {
            proxySupported = true;
            return proxied;
        }

        // 说明该路径不存在（静态托管把未知路径回退成了 index.html）
        proxySupported = false;
    }

    return direct();
};

/** 代理一个绝对地址（主要用于把返回的图片 URL 下载成 base64，避免图片跨域） */
const proxyFetch = async (absoluteUrl) => {
    if (proxySupported !== false) {
        try {
            const response = await fetch(`${PROXY_PATH}?url=${encodeURIComponent(absoluteUrl)}`);
            if (response.headers.get('x-api-proxy') === '1' || !(await isSpaFallbackResponse(response))) {
                proxySupported = true;
                return response;
            }
            proxySupported = false;
        } catch {
            proxySupported = false;
        }
    }
    return fetch(absoluteUrl);
};

const isLikelyBase64 = (value) => {
    if (!value || typeof value !== 'string') return false;
    // very loose check: base64 chars, optional padding, no whitespace
    return /^[A-Za-z0-9+/]+={0,2}$/.test(value) && value.length > 64;
};

const parseDataUrl = (value) => {
    if (!value || typeof value !== 'string') return null;
    if (!value.startsWith('data:image/')) return null;
    const [meta, b64] = value.split(',');
    if (!b64) return null;
    const mimeType = meta.split(';')[0].slice('data:'.length) || 'image/png';
    return { mimeType, base64: b64 };
};

const base64ToBlob = (base64, mimeType = 'image/png') => {
    const byteString = atob(base64);
    const ab = new ArrayBuffer(byteString.length);
    const ia = new Uint8Array(ab);
    for (let i = 0; i < byteString.length; i++) {
        ia[i] = byteString.charCodeAt(i);
    }
    return new Blob([ab], { type: mimeType });
};

/**
 * Fetch image from URL and convert to base64
 */
const fetchImageAsBase64 = async (imageUrl) => {
    try {
        const response = await proxyFetch(imageUrl);
        if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`);

        const blob = await response.blob();
        const mimeType = blob.type || 'image/jpeg';

        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const dataUrl = reader.result;
                const base64 = dataUrl.split(',')[1];
                resolve({ mimeType, base64 });
            };
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    } catch (err) {
        throw new Error(`无法下载图片: ${err.message}`);
    }
};

export async function uploadFile({ dataUrl, apiKey, baseUrl, filename = 'upload.png' }) {
    // 支持传入 data:image/... 或 https://...
    if (typeof dataUrl !== 'string' || dataUrl.length === 0) {
        throw new Error('上传失败：缺少文件数据');
    }
    if (/^https?:\/\//i.test(dataUrl)) {
        return { url: dataUrl };
    }

    const parsed = parseDataUrl(dataUrl);
    if (!parsed) throw new Error('上传失败：仅支持图片 dataURL');

    const formData = new FormData();
    formData.append('file', base64ToBlob(parsed.base64, parsed.mimeType), filename);

    const response = await fetchApi('/v1/files', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey || API_CONFIG.apiKey}`
        },
        body: formData,
        baseUrl
    });

    if (!response.ok) {
        throw new Error(await readErrorMessage(response, '文件上传失败'));
    }

    const data = await response.json();
    if (!data?.url) throw new Error('文件上传失败：响应中缺少 url');
    return data; // { id, url, ... }
}

const extractBase64ImageFromChat = (payload) => {
    // Try common shapes (provider variations)
    const candidates = [];

    // 1) OpenAI-like images API passthrough
    const directB64 = payload?.data?.[0]?.b64_json;
    if (typeof directB64 === 'string') candidates.push({ mimeType: 'image/png', base64: directB64 });

    // 2) chat.completions: choices[0].message.content (string or array)
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content === 'string') {
        const asDataUrl = parseDataUrl(content);
        if (asDataUrl) return asDataUrl;

        // Check for markdown image link: ![alt](url)
        const markdownMatch = content.match(/!\[.*?\]\((https?:\/\/[^)]+)\)/);
        if (markdownMatch) {
            const imageUrl = markdownMatch[1];
            // Return the URL directly, we'll handle fetching in the caller
            return { mimeType: 'image/jpeg', base64: null, url: imageUrl };
        }

        // maybe it is a raw base64 string
        if (isLikelyBase64(content)) return { mimeType: 'image/png', base64: content };

        // maybe it is JSON in string
        try {
            const obj = JSON.parse(content);
            const b64 = obj?.b64_json || obj?.image || obj?.data?.b64_json;
            const dataUrl = obj?.data_url || obj?.image_url || obj?.url;
            const parsed = parseDataUrl(dataUrl);
            if (parsed) return parsed;
            if (typeof b64 === 'string' && isLikelyBase64(b64)) return { mimeType: obj?.mime_type || 'image/png', base64: b64 };
        } catch {
            // ignore
        }
    }

    if (Array.isArray(content)) {
        for (const part of content) {
            const url = part?.image_url?.url || part?.image_url || part?.url;
            const parsed = parseDataUrl(url);
            if (parsed) return parsed;
            const b64 = part?.b64_json || part?.b64 || part?.image?.b64_json;
            if (typeof b64 === 'string' && isLikelyBase64(b64)) return { mimeType: part?.mime_type || 'image/png', base64: b64 };
        }
    }

    // 3) some providers place images in a separate field
    const maybeImages = payload?.images || payload?.output?.images || payload?.choices?.[0]?.message?.images;
    if (Array.isArray(maybeImages)) {
        for (const img of maybeImages) {
            const parsed = parseDataUrl(img?.data_url || img?.url);
            if (parsed) return parsed;
            const b64 = img?.b64_json || img?.b64;
            if (typeof b64 === 'string' && isLikelyBase64(b64)) return { mimeType: img?.mime_type || 'image/png', base64: b64 };
        }
    }

    // fallback to candidates
    if (candidates.length > 0) return candidates[0];
    return null;
};

/**
 * Helper to convert Blob/File to Base64
 */
export const fileToBase64 = (file) => {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result.split(',')[1]); // Remove data:image/...;base64,
        reader.onerror = error => reject(error);
    });
};

/** 把 "800:800" / "800x800" / "800×800" / "1K" 等写法统一成 { width, height } */
const normalizePixelSize = (size) => parseSize(size);

/**
 * Call the image generation API (OpenAI-compatible format)
 *
 * GPT Image 系列（gpt-image-2 / gpt-image-2.5）只接受 `size: "WIDTHxHEIGHT"`，
 * 不接受 `aspect_ratio` / `response_format`，也不认 Gemini 的 `extra_body.google`，
 * 所以这里只发 prompt / model / n / size，避免被网关以“未知参数”拒绝。
 */
export async function generateImage({ prompt, apiKey, baseUrl, model, size }) {
    const pixelSize = normalizePixelSize(size);

    // Build request body
    const requestBody = {
        prompt,
        // 兜底用官方 ID（`gpt-image-2.5` 只是网关别名，见 docs/gpt-image-2.5-size-rules.md）
        model: model || 'gpt-image-2.5-flare',
        n: 1,
    };

    if (pixelSize) {
        requestBody.size = `${pixelSize.width}x${pixelSize.height}`;
    }

    const response = await fetchApi('/v1/images/generations', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || API_CONFIG.apiKey}`
        },
        body: JSON.stringify(requestBody),
        baseUrl
    });

    if (!response.ok) {
        throw new Error(await readErrorMessage(response, '生成失败'));
    }

    const data = await response.json();

    // 有些服务商返回的是图片 URL 而不是 b64_json，这里统一转换成 base64
    const first = data?.data?.[0];
    const imageUrl = first?.url || first?.image_url;
    if (first && !first.b64_json && imageUrl) {
        const fetched = await fetchImageAsBase64(imageUrl);
        return { ...data, data: [{ ...first, b64_json: fetched.base64 }] };
    }

    return data;
}

/**
 * 使用 OpenAI Chat Completions 格式的"绘图模型"（例如 gemini-3-pro-image-preview）
 * 说明：不同服务商返回图片的字段可能不同，这里做了尽可能兼容的解析。
 */
export async function generateImageViaChatCompletions({ prompt, apiKey, baseUrl, model, aspectRatio = '1:1', imageSize = '', referenceImages = [] }) {
    const url = '/v1/chat/completions';

    // Build content array with prompt and reference images
    const content = [{ type: 'text', text: prompt }];

    // Add reference images
    referenceImages.forEach(ref => {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${ref.mimeType};base64,${ref.base64}` }
        });
    });

    // Build request body
    const requestBody = {
        model,
        stream: false,
        messages: [
            {
                role: 'user',
                content: content
            }
        ]
    };

    // Add extra_body for Google image config
    if (aspectRatio || imageSize) {
        requestBody.extra_body = {
            google: {
                image_config: {}
            }
        };

        if (aspectRatio) {
            requestBody.extra_body.google.image_config.aspect_ratio = aspectRatio;
        }

        if (imageSize) {
            requestBody.extra_body.google.image_config.image_size = imageSize;
        }
    }

    const response = await fetchApi(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || API_CONFIG.apiKey}`
        },
        body: JSON.stringify(requestBody),
        baseUrl
    });

    if (!response.ok) {
        throw new Error(await readErrorMessage(response, '生成失败'));
    }

    const data = await response.json();
    const extracted = extractBase64ImageFromChat(data);
    if (!extracted) throw new Error('生成失败：未从响应中解析到图片数据');

    // If extracted contains a URL instead of base64, fetch and convert it
    if (extracted.url && !extracted.base64) {
        const fetched = await fetchImageAsBase64(extracted.url);
        return fetched; // { mimeType, base64 }
    }

    return extracted; // { mimeType, base64 }
}

export async function editImageViaChatCompletions({ imageDataUrl, maskDataUrl, prompt, apiKey, baseUrl, model, referenceImages = [], aspectRatio = null, imageSize = null }) {
    const url = '/v1/chat/completions';

    // 根据是否有遮罩，构建不同的指令和内容
    let instruction;
    let content;

    if (maskDataUrl) {
        // 有遮罩：使用遮罩编辑指令，直接发送 base64 数据
        instruction =
            `你将收到两张图片：第一张为原图，第二张为遮罩。\n` +
            `编辑规则（必须严格遵守）：\n` +
            `1) 只允许修改遮罩中【白色】区域的内容；遮罩中【黑色】区域必须与原图保持完全一致（像素级不变）。\n` +
            `2) 不要改动黑色区域的任何内容：包括但不限于构图、背景、人物/物体位置、轮廓、大小、颜色、光照、阴影、清晰度、对比度、风格、文字水印等。\n` +
            `3) 白色区域的边缘要自然融合，避免溢出到黑色区域；不要产生新的改动区域或额外元素。\n` +
            `4) 如果指令与"仅修改白色区域/黑色区域完全不变"冲突，优先保证黑色区域不变。\n` +
            `编辑要求：\n${prompt}\n` +
            `仅输出一张编辑后的图片，不要输出任何解释文字。`;

        content = [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: imageDataUrl } },
            { type: 'image_url', image_url: { url: maskDataUrl } },
        ];
    } else {
        // 无遮罩：直接对整张图片进行编辑，直接发送 base64 数据
        instruction =
            `你将收到一张图片。请根据以下要求对图片进行修改：\n` +
            `${prompt}\n` +
            `仅输出一张编辑后的图片，不要输出任何解释文字。`;

        content = [
            { type: 'text', text: instruction },
            { type: 'image_url', image_url: { url: imageDataUrl } },
        ];
    }

    // 添加参考图到 content 数组
    referenceImages.forEach(ref => {
        content.push({
            type: 'image_url',
            image_url: { url: `data:${ref.mimeType};base64,${ref.base64}` }
        });
    });

    // Gemini / nano-banana 通过 chat.completions 的 extra_body 传比例与档位；
    // 不传（例如界面里的“沿用原图”）时由模型自行决定
    const requestBody = {
        model,
        stream: false,
        messages: [
            {
                role: 'user',
                content: content
            }
        ]
    };

    if (aspectRatio || imageSize) {
        requestBody.extra_body = {
            google: {
                image_config: {}
            }
        };
        if (aspectRatio) requestBody.extra_body.google.image_config.aspect_ratio = aspectRatio;
        if (imageSize) requestBody.extra_body.google.image_config.image_size = imageSize;
    }

    const response = await fetchApi(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey || API_CONFIG.apiKey}`
        },
        body: JSON.stringify(requestBody),
        baseUrl
    });

    if (!response.ok) {
        throw new Error(await readErrorMessage(response, '编辑失败'));
    }

    const data = await response.json();
    const extracted = extractBase64ImageFromChat(data);
    if (!extracted) throw new Error('编辑失败：未从响应中解析到图片数据');

    // 如果返回的是外部 URL，需要下载并转换为 base64
    if (extracted.url && !extracted.base64) {
        const fetched = await fetchImageAsBase64(extracted.url);
        return fetched; // { mimeType, base64 }
    }

    return extracted; // { mimeType, base64 }
}

/**
 * Call the Image Edit API using OpenAI-compatible format
 * According to API docs: /v1/images/edits with multipart/form-data
 * Sends image and mask as separate file uploads
 *
 * `size` 可选：不传则由接口按原图/auto 输出（对应界面里的“沿用原图”）。
 * 注意 GPT Image 的编辑接口不支持 response_format，图片始终以 b64_json 返回。
 */
export async function editImage({ imageBase64, maskBase64, prompt, apiKey, baseUrl, model, imageMimeType = 'image/png', size }) {
    const url = '/v1/images/edits';

    // Create FormData
    const formData = new FormData();
    formData.append('model', model || 'gpt-image-2.5-flare');
    formData.append('prompt', prompt);

    // Append image files
    const imageBlob = base64ToBlob(imageBase64, imageMimeType);
    const maskBlob = base64ToBlob(maskBase64);

    formData.append('image', imageBlob, 'image.png');
    formData.append('mask', maskBlob, 'mask.png');

    const pixelSize = normalizePixelSize(size);
    if (pixelSize) {
        formData.append('size', `${pixelSize.width}x${pixelSize.height}`);
    }

    const response = await fetchApi(url, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey || API_CONFIG.apiKey}`
            // Don't set Content-Type - browser will set it with boundary
        },
        body: formData,
        baseUrl
    });

    if (!response.ok) {
        throw new Error(await readErrorMessage(response, '编辑失败'));
    }

    const data = await response.json();

    // 有的服务商返回 url 而不是 b64_json，这里兼容成 b64_json（调用方只认 b64_json）
    const first = data?.data?.[0];
    const imageUrl = first?.url || first?.image_url;
    if (first && !first.b64_json && imageUrl) {
        const fetched = await fetchImageAsBase64(imageUrl);
        return { ...data, data: [{ ...first, b64_json: fetched.base64 }] };
    }

    return data;
}
