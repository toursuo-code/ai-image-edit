/**
 * 画布图像工具的坐标换算与尺寸计算
 *
 * 这些函数只做纯计算，不依赖 DOM，供 CanvasEditor 的「裁剪 / 拉伸」模式使用：
 *  - 裁剪框是画布场景坐标，需要借助图层自身的变换矩阵换算回图片像素坐标；
 *  - 拉伸的目标像素尺寸由图层当前的 scaleX / scaleY 推导。
 */
import { util } from 'fabric';
import { validateTargetSize } from './imageTools';

/** 归一化角度差（0°～180°），用于判断图层是否被旋转 */
export const normalizeAngleDelta = (angle) => {
    const value = (((Number(angle) || 0) % 360) + 360) % 360;
    return Math.min(value, 360 - value);
};

/** 两个场景矩形求交集；没有交集时返回 null */
export const intersectBounds = (a, b) => {
    const left = Math.max(a.left, b.left);
    const top = Math.max(a.top, b.top);
    const right = Math.min(a.left + a.width, b.left + b.width);
    const bottom = Math.min(a.top + a.height, b.top + b.height);
    if (right - left <= 0.5 || bottom - top <= 0.5) return null;
    return { left, top, width: right - left, height: bottom - top };
};

/**
 * 把画布场景坐标里的裁剪框换算成图层图片的像素矩形。
 *
 * Fabric 的 calcTransformMatrix 以「对象中心」为原点，且包含缩放 / 翻转 / 旋转；
 * 求逆后即可把场景角点映射回图片局部坐标，再加回半宽半高得到左上角像素坐标。
 * 调用方需保证图层没有旋转 / 翻转（这两种情况裁剪语义不明确）。
 *
 * @param {{width:number,height:number,calcTransformMatrix:Function}} layerObj
 * @param {{left:number,top:number,width:number,height:number}} sceneBounds
 * @returns {{x:number,y:number,width:number,height:number}|null}
 */
export function sceneBoundsToImageRect(layerObj, sceneBounds) {
    const width = Math.round(Number(layerObj?.width) || 0);
    const height = Math.round(Number(layerObj?.height) || 0);
    if (!width || !height) return null;

    const inverse = util.invertTransform(layerObj.calcTransformMatrix());
    const corners = [
        { x: sceneBounds.left, y: sceneBounds.top },
        { x: sceneBounds.left + sceneBounds.width, y: sceneBounds.top },
        { x: sceneBounds.left, y: sceneBounds.top + sceneBounds.height },
        { x: sceneBounds.left + sceneBounds.width, y: sceneBounds.top + sceneBounds.height },
    ].map((point) => {
        const local = util.transformPoint(point, inverse);
        return { x: local.x + width / 2, y: local.y + height / 2 };
    });

    const xs = corners.map((point) => point.x);
    const ys = corners.map((point) => point.y);
    const minX = Math.max(0, Math.min(...xs));
    const maxX = Math.min(width, Math.max(...xs));
    const minY = Math.max(0, Math.min(...ys));
    const maxY = Math.min(height, Math.max(...ys));
    if (maxX - minX < 1 || maxY - minY < 1) return null;

    const x = Math.min(width - 1, Math.round(minX));
    const y = Math.min(height - 1, Math.round(minY));
    return {
        x,
        y,
        width: Math.max(1, Math.min(Math.round(maxX - minX), width - x)),
        height: Math.max(1, Math.min(Math.round(maxY - minY), height - y)),
    };
}

/**
 * 根据图层当前的缩放计算「拉伸后」的目标像素尺寸与校验结果。
 *
 * @param {{width:number,height:number,scaleX:number,scaleY:number}} layerObj
 */
export function computeStretchInfo(layerObj) {
    const baseWidth = Math.max(1, Math.round(Number(layerObj?.width) || 0));
    const baseHeight = Math.max(1, Math.round(Number(layerObj?.height) || 0));
    const width = Math.max(1, Math.round(baseWidth * Math.abs(Number(layerObj?.scaleX) || 1)));
    const height = Math.max(1, Math.round(baseHeight * Math.abs(Number(layerObj?.scaleY) || 1)));
    const check = validateTargetSize({ width, height }, { sourceSize: { width: baseWidth, height: baseHeight } });
    const baseRatio = baseWidth / baseHeight;
    const ratio = width / height;

    return {
        width,
        height,
        changed: width !== baseWidth || height !== baseHeight,
        ok: check.ok,
        errors: check.errors,
        warnings: check.warnings,
        ratioChanged: Math.abs(ratio - baseRatio) > 0.005,
    };
}
