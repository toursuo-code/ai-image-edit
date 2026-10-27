import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { Canvas, Image as FabricImage, Path, PencilBrush, Rect } from 'fabric';
import { Crop, Eraser, MousePointer2, Pencil, Redo2, Scaling, Square, Trash2, Undo2, Lasso, ChevronDown, X, Sparkles } from 'lucide-react';
import { Button } from './ui/Button';
import { findNearestEdge } from '../lib/edgeDetection';
import {
    computeStretchInfo,
    intersectBounds,
    normalizeAngleDelta,
    sceneBoundsToImageRect,
} from '../lib/canvasImageTools';

const CROP_DIM_COLOR = 'rgba(15, 23, 42, 0.5)';

/** 创建画布叠加层对象（裁剪框 / 遮暗区域），统一打上标记，避免被当成遮罩或进入撤销历史 */
function createOverlayRect(options = {}) {
    const rect = new Rect({
        originX: 'left',
        originY: 'top',
        left: 0,
        top: 0,
        width: 0,
        height: 0,
        strokeWidth: 0,
        selectable: false,
        evented: false,
        objectCaching: false,
        ...options,
    });
    rect.isCanvasOverlay = true;
    return rect;
}

export function CanvasEditor({
    layers = [],
    onLayersChange,
    isDrawing,
    setIsDrawing,
    drawMode,
    setDrawMode,
    brushSize = 30,
    setBrushSize,
    onCanvasReady,
    onRegionsChange,
    onRemoveBackground,
    selectedLayerId,
    onSelectLayer,
    onDeleteLayer,
    onAddLayer,
    isSelectingReference,
    onAddReferenceImage,
    onCropLayer,
    onStretchLayer,
}) {
    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);

    const historyRef = useRef([]);
    const historyStepRef = useRef(-1);
    const [historyStep, setHistoryStep] = useState(-1);
    const [historyLength, setHistoryLength] = useState(0);
    const restoreTokenRef = useRef(0);
    const [isRestoring, setIsRestoring] = useState(false);

    const isRectDrawingRef = useRef(false);
    const rectStartPointRef = useRef(null);
    const currentRectRef = useRef(null);

    const pointerRafRef = useRef(0);
    const lastPointerRef = useRef(null);
    const [pointer, setPointer] = useState(null);
    const [zoom, setZoom] = useState(1);

    const viewModeRef = useRef('fit'); // 'fit' | 'manual' | '1:1'

    const spacePressedRef = useRef(false);
    const isPanningRef = useRef(false);
    const lastPanClientRef = useRef(null);

    const rectInfoRafRef = useRef(0);
    const lastRectInfoRef = useRef(null);
    const [rectInfo, setRectInfo] = useState(null);

    const nextRegionIdRef = useRef(1);
    const nextLayerIdRef = useRef(1);
    const layersMapRef = useRef(new Map()); // layerId -> FabricImage object

    // 画布图像工具：裁剪（裁剪框 + 遮暗层）与拉伸（拖拽缩放后固化像素尺寸）
    const [cropInfo, setCropInfo] = useState(null);
    const cropStateRef = useRef(null);

    const [stretchInfo, setStretchInfo] = useState(null);
    const stretchStateRef = useRef(null);
    const stretchCommitRef = useRef(false);

    // Lasso tool state
    const [showLassoDropdown, setShowLassoDropdown] = useState(false);
    const [lassoMode, setLassoMode] = useState('free'); // 'free' | 'polygonal' | 'magnetic' | 'ai'
    const [lassoSelection, setLassoSelection] = useState(null); // Current lasso selection path
    const lassoPointsRef = useRef([]); // For polygonal lasso
    const currentLassoPathRef = useRef(null); // Current drawing path

    const handlersRef = useRef({
        mouseDown: null,
        mouseMove: null,
        mouseUp: null,
        pathCreated: null,
    });

    const setAllObjectsSelectable = (canvas, selectable) => {
        canvas.getObjects().forEach(obj => obj.set({ selectable, evented: selectable }));
    };

    const schedulePointerUpdate = (pt) => {
        lastPointerRef.current = pt;
        if (pointerRafRef.current) return;
        pointerRafRef.current = requestAnimationFrame(() => {
            pointerRafRef.current = 0;
            setPointer(lastPointerRef.current);
        });
    };

    const scheduleRectInfoUpdate = (info) => {
        lastRectInfoRef.current = info;
        if (rectInfoRafRef.current) return;
        rectInfoRafRef.current = requestAnimationFrame(() => {
            rectInfoRafRef.current = 0;
            setRectInfo(lastRectInfoRef.current);
        });
    };

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    // 获取所有图层的包围盒
    const getAllLayersBounds = useCallback(() => {
        if (!fabricCanvas) return null;
        const imageObjects = fabricCanvas.getObjects().filter(obj => obj.layerId);
        if (imageObjects.length === 0) return null;

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        imageObjects.forEach(obj => {
            const bounds = obj.getBoundingRect();
            minX = Math.min(minX, bounds.left);
            minY = Math.min(minY, bounds.top);
            maxX = Math.max(maxX, bounds.left + bounds.width);
            maxY = Math.max(maxY, bounds.top + bounds.height);
        });

        return {
            left: minX,
            top: minY,
            width: maxX - minX,
            height: maxY - minY
        };
    }, [fabricCanvas]);

    // 将场景坐标转换为相对于图层包围盒的坐标
    const sceneToRelativeCoords = useCallback((scenePoint) => {
        const bounds = getAllLayersBounds();
        if (!bounds) return scenePoint;

        return {
            x: scenePoint.x - bounds.left,
            y: scenePoint.y - bounds.top
        };
    }, [getAllLayersBounds]);

    // 将相对坐标转换回场景坐标
    const relativeToSceneCoords = useCallback((relativePoint) => {
        const bounds = getAllLayersBounds();
        if (!bounds) return relativePoint;

        return {
            x: relativePoint.x + bounds.left,
            y: relativePoint.y + bounds.top
        };
    }, [getAllLayersBounds]);

    const fitToView = () => {
        if (!fabricCanvas) return;
        const bounds = getAllLayersBounds();
        if (!bounds) return;

        const viewW = fabricCanvas.getWidth();
        const viewH = fabricCanvas.getHeight();
        if (!viewW || !viewH) return;

        const nextZoom = Math.min(1, Math.min(viewW / bounds.width, viewH / bounds.height) * 0.9);
        const tx = (viewW - bounds.width * nextZoom) / 2 - bounds.left * nextZoom;
        const ty = (viewH - bounds.height * nextZoom) / 2 - bounds.top * nextZoom;
        fabricCanvas.setViewportTransform([nextZoom, 0, 0, nextZoom, tx, ty]);
        fabricCanvas.requestRenderAll();
        fabricCanvas.calcOffset();
        setZoom(nextZoom);
        viewModeRef.current = 'fit';
    };

    const resetTo1to1 = () => {
        if (!fabricCanvas) return;
        const bounds = getAllLayersBounds();
        if (!bounds) return;

        const viewW = fabricCanvas.getWidth();
        const viewH = fabricCanvas.getHeight();
        const tx = bounds.width < viewW ? (viewW - bounds.width) / 2 - bounds.left : -bounds.left;
        const ty = bounds.height < viewH ? (viewH - bounds.height) / 2 - bounds.top : -bounds.top;
        fabricCanvas.setViewportTransform([1, 0, 0, 1, tx, ty]);
        fabricCanvas.requestRenderAll();
        fabricCanvas.calcOffset();
        setZoom(1);
        viewModeRef.current = '1:1';
    };

    const copyToClipboard = async (text) => {
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            try {
                const el = document.createElement('textarea');
                el.value = text;
                el.style.position = 'fixed';
                el.style.left = '-9999px';
                document.body.appendChild(el);
                el.focus();
                el.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(el);
                return ok;
            } catch {
                return false;
            }
        }
    };

    const snapshotObjects = (canvas) =>
        canvas.getObjects()
            .filter((obj) => !obj.isCanvasOverlay)
            .map(obj => obj.toObject(['selectable', 'evented', 'regionId', 'layerId', 'maskLayerId']));

    const syncRegions = () => {
        if (!fabricCanvas) return;

        // 获取选中图层的原始尺寸用于归一化计算
        const selectedLayer = layers.find(l => l.id === selectedLayerId);
        if (!selectedLayer) {
            // 没有选中图层，清空区域
            onRegionsChange?.([]);
            return;
        }

        const imgWidth = selectedLayer.width || 1000;
        const imgHeight = selectedLayer.height || 1000;

        // 获取选中图层的 Fabric 对象，用于计算相对坐标
        const layerObj = fabricCanvas.getObjects().find(obj => obj.layerId === selectedLayerId);
        if (!layerObj) {
            // 图层对象还未创建完成（例如刚复制的图层），暂时不处理
            // 不报错，等待下次同步
            return;
        }

        const layerLeft = layerObj.left;
        const layerTop = layerObj.top;

        let maxId = 0;
        const regions = fabricCanvas
            .getObjects()
            .filter(obj => obj?.type === 'rect' && !obj.layerId && !obj.isCanvasOverlay) // 只同步绘制的矩形，不包括图层/工具叠加层
            .map((obj) => {
                if (!obj.regionId) {
                    obj.regionId = nextRegionIdRef.current++;
                }
                maxId = Math.max(maxId, obj.regionId);
                const bounds = obj.getBoundingRect();

                // 转换为相对于选中图层的坐标（像素坐标）
                const x_min = bounds.left - layerLeft;
                const y_min = bounds.top - layerTop;
                const x_max = x_min + bounds.width;
                const y_max = y_min + bounds.height;

                // 归一化到 0-1000 坐标系
                // 公式: N = round((P / ImageSize) * 1000)
                const normalized_x_min = Math.round((x_min / imgWidth) * 1000);
                const normalized_y_min = Math.round((y_min / imgHeight) * 1000);
                const normalized_x_max = Math.round((x_max / imgWidth) * 1000);
                const normalized_y_max = Math.round((y_max / imgHeight) * 1000);

                // 确保坐标在 0-1000 范围内
                const clamp = (val) => Math.max(0, Math.min(1000, val));

                return {
                    id: obj.regionId,
                    // 保留像素坐标用于显示
                    x: x_min,
                    y: y_min,
                    width: bounds.width,
                    height: bounds.height,
                    // 归一化坐标 [y_min, x_min, y_max, x_max]
                    box_2d: [
                        clamp(normalized_y_min),
                        clamp(normalized_x_min),
                        clamp(normalized_y_max),
                        clamp(normalized_x_max)
                    ]
                };
            })
            .sort((a, b) => a.id - b.id);

        if (maxId >= nextRegionIdRef.current) nextRegionIdRef.current = maxId + 1;
        onRegionsChange?.(regions);
    };

    // 同步图层信息到父组件
    const syncLayers = () => {
        if (!fabricCanvas) return;

        const imageObjects = fabricCanvas.getObjects().filter(obj => obj.layerId);
        const layerData = imageObjects.map(obj => {
            const bounds = obj.getBoundingRect();
            return {
                id: obj.layerId,
                x: obj.left,
                y: obj.top,
                scaleX: obj.scaleX,
                scaleY: obj.scaleY,
                angle: obj.angle,
                width: obj.width,
                height: obj.height,
                visible: obj.visible,
                locked: !obj.selectable
            };
        });

        onLayersChange?.(layerData);
    };

    const resetHistory = () => {
        historyRef.current = [[]];
        historyStepRef.current = 0;
        setHistoryLength(1);
        setHistoryStep(0);
    };

    const pushHistory = () => {
        if (!fabricCanvas) return;
        const snapshot = snapshotObjects(fabricCanvas);
        let next = historyRef.current.slice(0, historyStepRef.current + 1);
        next.push(snapshot);

        const MAX_HISTORY = 80;
        if (next.length > MAX_HISTORY) next = next.slice(next.length - MAX_HISTORY);

        historyRef.current = next;
        historyStepRef.current = next.length - 1;
        setHistoryLength(next.length);
        setHistoryStep(historyStepRef.current);
    };

    const fromObjectAsync = (klass, obj) => {
        try {
            const result = klass.fromObject(obj);
            if (result && typeof result.then === 'function') return result;
            return new Promise((resolve) => klass.fromObject(obj, resolve));
        } catch (err) {
            return Promise.reject(err);
        }
    };

    const restoreObjectsFromSnapshot = async (snapshot, selectable) => {
        if (!fabricCanvas) return;

        const objectsJson = Array.isArray(snapshot) ? snapshot : [];
        const prevRenderOnAddRemove = fabricCanvas.renderOnAddRemove;
        fabricCanvas.renderOnAddRemove = false;
        fabricCanvas.discardActiveObject();

        // 只移除非图层对象（绘制的路径和矩形）
        fabricCanvas.getObjects().slice().forEach(obj => {
            if (!obj.layerId) {
                fabricCanvas.remove(obj);
            }
        });

        const instances = await Promise.all(
            objectsJson.map(async (objJson) => {
                if (objJson?.type === 'rect') return fromObjectAsync(Rect, objJson);
                if (objJson?.type === 'path' || objJson?.type === 'Path') return fromObjectAsync(Path, objJson);
                if (objJson?.type === 'image') return fromObjectAsync(FabricImage, objJson);
                return null;
            })
        );

        instances.filter(Boolean).forEach(obj => {
            obj.set({ selectable, evented: selectable });
            fabricCanvas.add(obj);
        });

        fabricCanvas.renderOnAddRemove = prevRenderOnAddRemove;
        fabricCanvas.requestRenderAll();
        syncRegions();
        syncLayers();
    };

    const undo = () => {
        const nextStep = historyStepRef.current - 1;
        if (!fabricCanvas || nextStep < 0) return;

        const token = ++restoreTokenRef.current;
        historyStepRef.current = nextStep;
        setHistoryStep(nextStep);
        setIsRestoring(true);

        // 让出一帧，先把“回撤中…”等 UI 渲染出来，避免用户感知为“画面消失/卡死”
        requestAnimationFrame(() => {
            if (token !== restoreTokenRef.current) return;
            Promise.resolve(restoreObjectsFromSnapshot(historyRef.current[nextStep], drawMode === 'select')).finally(() => {
                if (token === restoreTokenRef.current) setIsRestoring(false);
            });
        });
    };

    const redo = () => {
        const nextStep = historyStepRef.current + 1;
        if (!fabricCanvas || nextStep >= historyRef.current.length) return;

        const token = ++restoreTokenRef.current;
        historyStepRef.current = nextStep;
        setHistoryStep(nextStep);
        setIsRestoring(true);

        requestAnimationFrame(() => {
            if (token !== restoreTokenRef.current) return;
            Promise.resolve(restoreObjectsFromSnapshot(historyRef.current[nextStep], drawMode === 'select')).finally(() => {
                if (token === restoreTokenRef.current) setIsRestoring(false);
            });
        });
    };

    const clearCanvas = () => {
        if (!fabricCanvas) return;

        // Get the currently selected object
        const activeObject = fabricCanvas.getActiveObject();

        if (activeObject && activeObject.layerId) {
            const layerId = activeObject.layerId;

            // Remove from canvas
            fabricCanvas.remove(activeObject);

            // Remove all mask objects associated with this layer
            fabricCanvas.getObjects().slice().forEach(obj => {
                if (obj.maskLayerId === layerId) {
                    fabricCanvas.remove(obj);
                }
            });

            fabricCanvas.discardActiveObject();
            fabricCanvas.requestRenderAll();

            // Remove from layers list using the callback
            if (onDeleteLayer) {
                onDeleteLayer(layerId);
            }

            pushHistory();
            syncRegions();
        } else {
            // If no layer is selected, show a message or do nothing
            console.log('No layer selected to delete');
        }
    };

    // 键盘快捷键：撤销/重做、删除选中、取消框选
    useEffect(() => {
        if (!fabricCanvas) return;

        const isTypingTarget = (target) => {
            const el = target;
            if (!el) return false;
            if (el.isContentEditable) return true;
            const tag = (el.tagName || '').toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select';
        };

        const onKeyDown = (e) => {
            if (isTypingTarget(e.target)) return;
            // 裁剪 / 拉伸模式由各自的面板处理 Enter / Esc，避免撤销、删除等快捷键误操作
            if (drawMode === 'crop' || drawMode === 'stretch') return;

            const isMod = e.ctrlKey || e.metaKey;
            const key = (e.key || '').toLowerCase();

            if (key === 'escape') {
                if (currentRectRef.current) {
                    fabricCanvas.remove(currentRectRef.current);
                    currentRectRef.current = null;
                }
                if (currentLassoPathRef.current) {
                    fabricCanvas.remove(currentLassoPathRef.current);
                    currentLassoPathRef.current = null;
                }
                isRectDrawingRef.current = false;
                rectStartPointRef.current = null;
                lassoPointsRef.current = [];
                scheduleRectInfoUpdate(null);
                fabricCanvas.requestRenderAll();
                return;
            }

            // Complete polygonal/magnetic lasso with Enter
            if (key === 'enter' && (drawMode === 'lasso-polygonal' || drawMode === 'lasso-magnetic') && lassoPointsRef.current.length > 2) {
                e.preventDefault();
                const points = lassoPointsRef.current;
                const pathData = `M ${points[0].x} ${points[0].y} ${points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')} Z`;

                if (currentLassoPathRef.current) {
                    fabricCanvas.remove(currentLassoPathRef.current);
                }

                const path = new Path(pathData, {
                    stroke: 'rgba(0, 120, 255, 0.8)',
                    strokeWidth: 2,
                    fill: 'rgba(0, 120, 255, 0.2)',
                    selectable: false,
                    evented: false,
                });
                // 关联到当前选中的图层
                if (selectedLayerId) {
                    path.maskLayerId = selectedLayerId;
                }
                fabricCanvas.add(path);
                setLassoSelection(path);
                lassoPointsRef.current = [];
                currentLassoPathRef.current = null;
                fabricCanvas.requestRenderAll();
                pushHistory();
                return;
            }

            if (isMod && key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (!isRestoring) undo();
                return;
            }

            if ((isMod && key === 'y') || (isMod && key === 'z' && e.shiftKey)) {
                e.preventDefault();
                if (!isRestoring) redo();
                return;
            }

            if ((key === 'delete' || key === 'backspace') && drawMode === 'select') {
                const active = fabricCanvas.getActiveObjects();
                if (!active || active.length === 0) return;
                e.preventDefault();

                // Delete from canvas and sync with layer list
                active.forEach(obj => {
                    fabricCanvas.remove(obj);

                    // If this is a layer object, also delete from layer list and associated masks
                    if (obj.layerId && onDeleteLayer) {
                        // Remove all mask objects associated with this layer
                        fabricCanvas.getObjects().slice().forEach(maskObj => {
                            if (maskObj.maskLayerId === obj.layerId) {
                                fabricCanvas.remove(maskObj);
                            }
                        });
                        onDeleteLayer(obj.layerId);
                    }
                });

                fabricCanvas.discardActiveObject();
                fabricCanvas.requestRenderAll();
                pushHistory();
            }
        };

        window.addEventListener('keydown', onKeyDown, { passive: false });
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [fabricCanvas, drawMode, isRestoring, onDeleteLayer, pushHistory, redo, undo]);

    // 空格拖拽平移（不影响场景坐标，只改变 viewportTransform）
    useEffect(() => {
        if (!fabricCanvas) return;

        const isTypingTarget = (target) => {
            const el = target;
            if (!el) return false;
            if (el.isContentEditable) return true;
            const tag = (el.tagName || '').toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select';
        };

        const updateCursor = () => {
            if (isPanningRef.current) {
                fabricCanvas.defaultCursor = 'grabbing';
                return;
            }
            if (spacePressedRef.current) {
                fabricCanvas.defaultCursor = 'grab';
                return;
            }
            fabricCanvas.defaultCursor = 'default';
        };

        const onKeyDown = (e) => {
            if (isTypingTarget(e.target)) return;
            if (e.code !== 'Space') return;
            if (spacePressedRef.current) return;
            e.preventDefault();
            spacePressedRef.current = true;
            if (fabricCanvas.isDrawingMode) fabricCanvas.isDrawingMode = false;
            updateCursor();
        };

        const onKeyUp = (e) => {
            if (e.code !== 'Space') return;
            spacePressedRef.current = false;
            isPanningRef.current = false;
            lastPanClientRef.current = null;
            // 释放空格后恢复当前工具的绘制状态
            fabricCanvas.isDrawingMode = (drawMode === 'brush' || drawMode === 'eraser') && !!isDrawing;
            updateCursor();
        };

        const onMouseUp = (e) => {
            // 鼠标中键释放时停止拖动
            if (e.button === 1 && isPanningRef.current) {
                isPanningRef.current = false;
                lastPanClientRef.current = null;
                updateCursor();
            }
        };

        window.addEventListener('keydown', onKeyDown, { passive: false });
        window.addEventListener('keyup', onKeyUp);
        window.addEventListener('mouseup', onMouseUp);
        updateCursor();
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
            window.removeEventListener('mouseup', onMouseUp);
        };
    }, [fabricCanvas, drawMode, isDrawing]);

    // 初始化 fabric canvas
    useEffect(() => {
        if (!canvasRef.current || !containerRef.current) return;

        const canvas = new Canvas(canvasRef.current, {
            isDrawingMode: false,
            selection: false,
            backgroundColor: 'transparent',
            preserveObjectStacking: true,
            enableRetinaScaling: false,
        });

        setFabricCanvas(canvas);
        onCanvasReady?.(canvas);

        // 开发模式下暴露 Fabric 实例，供 E2E 测试与控制台调试使用（生产构建中会被移除）
        if (import.meta.env.DEV) {
            window.__fabricCanvasForTest = canvas;
        }

        return () => {
            if (pointerRafRef.current) cancelAnimationFrame(pointerRafRef.current);
            if (import.meta.env.DEV && window.__fabricCanvasForTest === canvas) {
                delete window.__fabricCanvasForTest;
            }
            canvas.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 让画布始终填满容器（视口），图片通过 viewportTransform 居中/缩放显示
    useEffect(() => {
        if (!fabricCanvas) return;

        const container = containerRef.current;
        if (!container) return;

        const resizeToContainer = () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (!w || !h) return;
            fabricCanvas.setDimensions({ width: w, height: h }, { cssOnly: false });
            fabricCanvas.calcOffset();
            if (viewModeRef.current === 'fit') fitToView();
            if (viewModeRef.current === '1:1') resetTo1to1();
        };

        resizeToContainer();
        const ro = new ResizeObserver(() => resizeToContainer());
        ro.observe(container);
        window.addEventListener('resize', resizeToContainer);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', resizeToContainer);
        };
    }, [fabricCanvas]);

    // 加载和同步图层
    useEffect(() => {
        if (!fabricCanvas) return;

        // 移除不在 layers 中的图层对象
        const currentLayerIds = new Set(layers.map(l => l.id));
        fabricCanvas.getObjects().forEach(obj => {
            if (obj.layerId && !currentLayerIds.has(obj.layerId)) {
                fabricCanvas.remove(obj);
                layersMapRef.current.delete(obj.layerId);
            }
        });

        // 添加或更新图层
        layers.forEach(layer => {
            const existingObj = layersMapRef.current.get(layer.id);

            if (existingObj) {
                // 检查 URL 是否改变（编辑后图片会改变）
                const currentUrl = existingObj._originalElement?.src || existingObj._element?.src;
                const needsReload = layer.url && currentUrl !== layer.url;

                if (needsReload) {
                    // URL 改变了，需要重新加载图片
                    console.log('图层 URL 已改变，重新加载:', layer.id);
                    const oldProps = {
                        left: existingObj.left,
                        top: existingObj.top,
                        scaleX: existingObj.scaleX,
                        scaleY: existingObj.scaleY,
                        angle: existingObj.angle,
                    };

                    // 移除旧对象
                    fabricCanvas.remove(existingObj);
                    layersMapRef.current.delete(layer.id);

                    // 加载新图片
                    FabricImage.fromURL(layer.url, { crossOrigin: 'anonymous' })
                        .then((img) => {
                            console.log('图层重新加载成功:', layer.id);
                            img.set({
                                layerId: layer.id,
                                left: layer.x !== undefined ? layer.x : oldProps.left,
                                top: layer.y !== undefined ? layer.y : oldProps.top,
                                scaleX: layer.scaleX !== undefined ? layer.scaleX : oldProps.scaleX,
                                scaleY: layer.scaleY !== undefined ? layer.scaleY : oldProps.scaleY,
                                angle: layer.angle !== undefined ? layer.angle : oldProps.angle,
                                originX: 'left',
                                originY: 'top',
                                visible: layer.visible !== false,
                                selectable: !layer.locked && drawMode === 'select',
                                evented: !layer.locked && drawMode === 'select',
                            });

                            fabricCanvas.add(img);
                            layersMapRef.current.set(layer.id, img);
                            fabricCanvas.requestRenderAll();
                        })
                        .catch((err) => {
                            console.error('重新加载图层失败:', layer.id, err);
                        });
                } else {
                    // URL 没变，只更新属性
                    existingObj.set({
                        left: layer.x !== undefined ? layer.x : existingObj.left,
                        top: layer.y !== undefined ? layer.y : existingObj.top,
                        scaleX: layer.scaleX !== undefined ? layer.scaleX : existingObj.scaleX,
                        scaleY: layer.scaleY !== undefined ? layer.scaleY : existingObj.scaleY,
                        angle: layer.angle !== undefined ? layer.angle : existingObj.angle,
                        visible: layer.visible !== undefined ? layer.visible : existingObj.visible,
                        selectable: !layer.locked && drawMode === 'select',
                        evented: !layer.locked && drawMode === 'select',
                    });
                    existingObj.setCoords();
                }
            } else if (layer.url) {
                // 加载新图层
                console.log('开始加载图层:', layer.id, 'URL长度:', layer.url?.length);
                FabricImage.fromURL(layer.url, { crossOrigin: 'anonymous' })
                    .then((img) => {
                        console.log('图层加载成功:', layer.id, '尺寸:', img.width, 'x', img.height);
                        img.set({
                            layerId: layer.id,
                            left: layer.x || 0,
                            top: layer.y || 0,
                            scaleX: layer.scaleX || 1,
                            scaleY: layer.scaleY || 1,
                            angle: layer.angle || 0,
                            originX: 'left',
                            originY: 'top',
                            visible: layer.visible !== false,
                            selectable: !layer.locked && drawMode === 'select',
                            evented: !layer.locked && drawMode === 'select',
                        });

                        fabricCanvas.add(img);
                        layersMapRef.current.set(layer.id, img);
                        console.log('图层已添加到画布，当前对象数:', fabricCanvas.getObjects().length);
                        fabricCanvas.requestRenderAll();

                        // 如果是第一个图层，自动适应窗口
                        if (layers.length === 1) {
                            requestAnimationFrame(() => fitToView());
                        }
                    })
                    .catch((err) => {
                        console.error('加载图层失败:', layer.id, err);
                    });
            }
        });

        fabricCanvas.requestRenderAll();
    }, [fabricCanvas, layers, drawMode]);

    // 滚轮缩放：以鼠标位置为中心缩放，保持场景坐标不漂移
    useEffect(() => {
        if (!fabricCanvas) return;

        const onWheel = (opt) => {
            const e = opt.e;
            if (!e) return;
            e.preventDefault();

            const currentZoom = fabricCanvas.getZoom();
            const factor = Math.pow(1.0015, -e.deltaY);
            const nextZoom = clamp(currentZoom * factor, 0.05, 32);
            const vpPoint = fabricCanvas.getViewportPoint(e);
            fabricCanvas.zoomToPoint(vpPoint, nextZoom);
            fabricCanvas.requestRenderAll();
            fabricCanvas.calcOffset();
            setZoom(nextZoom);
            viewModeRef.current = 'manual';
        };

        fabricCanvas.on('mouse:wheel', onWheel);
        return () => fabricCanvas.off('mouse:wheel', onWheel);
    }, [fabricCanvas]);

    // 工具模式切换与事件绑定
    useEffect(() => {
        if (!fabricCanvas) return;

        const prev = handlersRef.current;
        if (prev.mouseDown) fabricCanvas.off('mouse:down', prev.mouseDown);
        if (prev.mouseMove) fabricCanvas.off('mouse:move', prev.mouseMove);
        if (prev.mouseUp) fabricCanvas.off('mouse:up', prev.mouseUp);
        if (prev.pathCreated) fabricCanvas.off('path:created', prev.pathCreated);

        isRectDrawingRef.current = false;
        rectStartPointRef.current = null;
        scheduleRectInfoUpdate(null);
        if (currentRectRef.current) {
            fabricCanvas.remove(currentRectRef.current);
            currentRectRef.current = null;
        }

        const startPanning = (nativeEvent) => {
            isPanningRef.current = true;
            lastPanClientRef.current = { x: nativeEvent.clientX, y: nativeEvent.clientY };
            fabricCanvas.defaultCursor = 'grabbing';
        };

        const stopPanning = () => {
            isPanningRef.current = false;
            lastPanClientRef.current = null;
            fabricCanvas.defaultCursor = spacePressedRef.current ? 'grab' : 'default';
        };

        const selectable = drawMode === 'select';
        fabricCanvas.isDrawingMode = false;
        fabricCanvas.selection = selectable;
        setAllObjectsSelectable(fabricCanvas, selectable);

        let toolMouseDown = null;
        let toolMouseMove = null;
        let toolMouseUp = null;
        const nextHandlers = { mouseDown: null, mouseMove: null, mouseUp: null, pathCreated: null };

        if (drawMode === 'brush') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = !!isDrawing;

            if (isDrawing) {
                const brush = new PencilBrush(fabricCanvas);
                brush.color = 'rgba(255, 0, 0, 0.5)';
                brush.width = brushSize;
                fabricCanvas.freeDrawingBrush = brush;

                nextHandlers.pathCreated = (e) => {
                    const path = e.path;
                    // 关联到当前选中的图层
                    if (selectedLayerId) {
                        path.set({ maskLayerId: selectedLayerId });
                    }
                    pushHistory();
                };
            }
        }

        if (drawMode === 'eraser') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = !!isDrawing;

            if (isDrawing) {
                const brush = new PencilBrush(fabricCanvas);
                brush.width = brushSize;
                brush.color = 'rgba(255, 255, 255, 0.8)'; // Semi-transparent white for visibility
                fabricCanvas.freeDrawingBrush = brush;

                nextHandlers.pathCreated = (e) => {
                    const erasePath = e.path;

                    // 关联到当前选中的图层
                    if (selectedLayerId) {
                        erasePath.set({ maskLayerId: selectedLayerId });
                    }

                    // Get all objects on canvas
                    const objects = fabricCanvas.getObjects().slice();

                    // Find paths that intersect with the eraser path
                    objects.forEach(obj => {
                        // Skip the eraser path itself
                        if (obj === erasePath) return;

                        // Only erase drawn paths (not images or layers)
                        if (obj.type === 'path' && !obj.layerId) {
                            // Check if the eraser path intersects with this path
                            if (obj.intersectsWithObject(erasePath)) {
                                // Remove the intersecting path
                                fabricCanvas.remove(obj);
                            }
                        }
                    });

                    // Remove the eraser path itself
                    fabricCanvas.remove(erasePath);
                    fabricCanvas.requestRenderAll();
                    pushHistory();
                };
            }
        }

        if (drawMode === 'rectangle') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = false;

            toolMouseDown = (e) => {
                if (!isDrawing) return;
                const pt = fabricCanvas.getScenePoint(e.e);
                schedulePointerUpdate(pt);

                rectStartPointRef.current = pt;
                isRectDrawingRef.current = true;

                const rect = new Rect({
                    left: pt.x,
                    top: pt.y,
                    width: 0,
                    height: 0,
                    originX: 'left',
                    originY: 'top',
                    centeredScaling: false,
                    fill: 'rgba(255, 0, 0, 0.3)',
                    stroke: 'rgba(255, 0, 0, 0.8)',
                    strokeWidth: 2,
                    selectable: false,
                    evented: false,
                });
                rect.regionId = nextRegionIdRef.current++;
                // 关联到当前选中的图层
                if (selectedLayerId) {
                    rect.maskLayerId = selectedLayerId;
                }

                currentRectRef.current = rect;
                fabricCanvas.add(rect);
                scheduleRectInfoUpdate({ x: rect.left, y: rect.top, width: 0, height: 0 });
                fabricCanvas.requestRenderAll();
            };

            toolMouseMove = (e) => {
                const pt = fabricCanvas.getScenePoint(e.e);
                schedulePointerUpdate(pt);
                if (!isRectDrawingRef.current || !currentRectRef.current || !rectStartPointRef.current) return;

                const start = rectStartPointRef.current;
                let width = Math.abs(pt.x - start.x);
                let height = Math.abs(pt.y - start.y);

                if (e.e.shiftKey) {
                    const size = Math.max(width, height);
                    width = size;
                    height = size;
                }

                const left = Math.min(pt.x, start.x);
                const top = Math.min(pt.y, start.y);

                currentRectRef.current.set({ left, top, width, height });
                currentRectRef.current.setCoords();
                scheduleRectInfoUpdate({ x: left, y: top, width, height });
                fabricCanvas.requestRenderAll();
            };

            toolMouseUp = () => {
                if (!isRectDrawingRef.current) return;
                isRectDrawingRef.current = false;

                const rect = currentRectRef.current;
                currentRectRef.current = null;
                rectStartPointRef.current = null;

                if (!rect || rect.width < 1 || rect.height < 1) {
                    if (rect) fabricCanvas.remove(rect);
                    scheduleRectInfoUpdate(null);
                    fabricCanvas.requestRenderAll();
                    syncRegions();
                    return;
                }

                scheduleRectInfoUpdate({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
                pushHistory();
                syncRegions();
            };
        }

        // Free Lasso Tool
        if (drawMode === 'lasso-free') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = !!isDrawing;

            if (isDrawing) {
                const brush = new PencilBrush(fabricCanvas);
                brush.color = 'rgba(0, 120, 255, 0.8)';
                brush.width = 2;
                fabricCanvas.freeDrawingBrush = brush;

                nextHandlers.pathCreated = (e) => {
                    const path = e.path;
                    path.set({
                        stroke: 'rgba(0, 120, 255, 0.8)',
                        strokeWidth: 2,
                        fill: 'rgba(0, 120, 255, 0.2)',
                        selectable: false,
                        evented: false,
                    });
                    // 关联到当前选中的图层
                    if (selectedLayerId) {
                        path.maskLayerId = selectedLayerId;
                    }
                    setLassoSelection(path);
                    fabricCanvas.requestRenderAll();
                    pushHistory();
                };
            }
        }

        // Polygonal Lasso Tool
        if (drawMode === 'lasso-polygonal') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = false;

            toolMouseDown = (e) => {
                if (!isDrawing) return;
                const pt = fabricCanvas.getScenePoint(e.e);
                lassoPointsRef.current.push(pt);

                // Draw temporary lines
                if (lassoPointsRef.current.length > 1) {
                    const points = lassoPointsRef.current;
                    const pathData = `M ${points[0].x} ${points[0].y} ${points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')}`;

                    if (currentLassoPathRef.current) {
                        fabricCanvas.remove(currentLassoPathRef.current);
                    }

                    const path = new Path(pathData, {
                        stroke: 'rgba(0, 120, 255, 0.8)',
                        strokeWidth: 2,
                        fill: 'transparent',
                        selectable: false,
                        evented: false,
                    });
                    currentLassoPathRef.current = path;
                    fabricCanvas.add(path);
                    fabricCanvas.requestRenderAll();
                }
            };

            toolMouseMove = (e) => {
                if (!isDrawing || lassoPointsRef.current.length === 0) return;
                const pt = fabricCanvas.getScenePoint(e.e);

                // Show preview line to cursor
                if (currentLassoPathRef.current) {
                    fabricCanvas.remove(currentLassoPathRef.current);
                }

                const points = lassoPointsRef.current;
                const pathData = `M ${points[0].x} ${points[0].y} ${points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')} L ${pt.x} ${pt.y}`;

                const path = new Path(pathData, {
                    stroke: 'rgba(0, 120, 255, 0.8)',
                    strokeWidth: 2,
                    fill: 'transparent',
                    selectable: false,
                    evented: false,
                });
                currentLassoPathRef.current = path;
                fabricCanvas.add(path);
                fabricCanvas.requestRenderAll();
            };
        }

        // Magnetic Lasso Tool - with edge detection
        if (drawMode === 'lasso-magnetic') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = false;

            toolMouseDown = (e) => {
                if (!isDrawing) return;
                const pt = fabricCanvas.getScenePoint(e.e);

                // Snap to nearest edge
                const canvasEl = fabricCanvas.getElement();
                const edge = findNearestEdge(canvasEl, Math.round(pt.x), Math.round(pt.y), 15, 30);

                lassoPointsRef.current.push({ x: edge.x, y: edge.y });

                // Draw points
                if (lassoPointsRef.current.length > 1) {
                    const points = lassoPointsRef.current;
                    const pathData = `M ${points[0].x} ${points[0].y} ${points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')}`;

                    if (currentLassoPathRef.current) {
                        fabricCanvas.remove(currentLassoPathRef.current);
                    }

                    const path = new Path(pathData, {
                        stroke: 'rgba(0, 120, 255, 0.8)',
                        strokeWidth: 2,
                        fill: 'transparent',
                        selectable: false,
                        evented: false,
                    });
                    currentLassoPathRef.current = path;
                    fabricCanvas.add(path);
                    fabricCanvas.requestRenderAll();
                }
            };

            toolMouseMove = (e) => {
                if (!isDrawing || lassoPointsRef.current.length === 0) return;
                const pt = fabricCanvas.getScenePoint(e.e);

                // Snap to edge for preview
                const canvasEl = fabricCanvas.getElement();
                const edge = findNearestEdge(canvasEl, Math.round(pt.x), Math.round(pt.y), 15, 30);

                if (currentLassoPathRef.current) {
                    fabricCanvas.remove(currentLassoPathRef.current);
                }

                const points = lassoPointsRef.current;
                const pathData = `M ${points[0].x} ${points[0].y} ${points.slice(1).map(p => `L ${p.x} ${p.y}`).join(' ')} L ${edge.x} ${edge.y}`;

                const path = new Path(pathData, {
                    stroke: 'rgba(0, 120, 255, 0.8)',
                    strokeWidth: 2,
                    fill: 'transparent',
                    selectable: false,
                    evented: false,
                });
                currentLassoPathRef.current = path;
                fabricCanvas.add(path);
                fabricCanvas.requestRenderAll();
            };
        }

        nextHandlers.mouseDown = (e) => {
            // 鼠标中键（滚轮按下）或空格键 + 左键：拖动画布
            if (e.e.button === 1 || spacePressedRef.current) {
                e.e.preventDefault(); // 阻止中键的默认行为（滚动）
                startPanning(e.e);
                viewModeRef.current = 'manual';
                return;
            }
            toolMouseDown?.(e);
        };

        nextHandlers.mouseMove = (e) => {
            const pt = fabricCanvas.getScenePoint(e.e);
            schedulePointerUpdate(pt);

            if (isPanningRef.current) {
                const last = lastPanClientRef.current;
                if (!last) {
                    lastPanClientRef.current = { x: e.e.clientX, y: e.e.clientY };
                    return;
                }
                const dx = e.e.clientX - last.x;
                const dy = e.e.clientY - last.y;
                lastPanClientRef.current = { x: e.e.clientX, y: e.e.clientY };

                const vpt = [...fabricCanvas.viewportTransform];
                vpt[4] += dx;
                vpt[5] += dy;
                fabricCanvas.setViewportTransform(vpt);
                fabricCanvas.requestRenderAll();
                fabricCanvas.calcOffset();
                setZoom(fabricCanvas.getZoom());
                viewModeRef.current = 'manual';
                return;
            }

            toolMouseMove?.(e);
        };

        nextHandlers.mouseUp = (e) => {
            if (isPanningRef.current) {
                stopPanning();
                return;
            }
            toolMouseUp?.(e);
        };

        handlersRef.current = nextHandlers;
        if (nextHandlers.mouseDown) fabricCanvas.on('mouse:down', nextHandlers.mouseDown);
        if (nextHandlers.mouseMove) fabricCanvas.on('mouse:move', nextHandlers.mouseMove);
        if (nextHandlers.mouseUp) fabricCanvas.on('mouse:up', nextHandlers.mouseUp);
        if (nextHandlers.pathCreated) fabricCanvas.on('path:created', nextHandlers.pathCreated);
    }, [fabricCanvas, drawMode, isDrawing, brushSize]);

    // ===== 画布图像工具：裁剪 / 拉伸 =====

    const cancelImageTool = React.useCallback(() => {
        setIsDrawing?.(false);
        setDrawMode('select');
    }, [setDrawMode, setIsDrawing]);

    const applyCropFromCanvas = React.useCallback(() => {
        const state = cropStateRef.current;
        if (!state) return;

        const { layerObj, cropRect, layerBounds } = state;
        if (normalizeAngleDelta(layerObj.angle) > 0.01) {
            alert('裁剪暂不支持旋转后的图层：请先把图层旋转回 0° 再裁剪');
            return;
        }
        const flipped = Boolean(layerObj.flipX) || Number(layerObj.scaleX) < 0
            || Boolean(layerObj.flipY) || Number(layerObj.scaleY) < 0;
        if (flipped) {
            alert('裁剪暂不支持翻转后的图层：请先翻回原方向再裁剪');
            return;
        }

        const cropBounds = intersectBounds(cropRect.getBoundingRect(), layerBounds);
        const imageRect = cropBounds ? sceneBoundsToImageRect(layerObj, cropBounds) : null;
        if (!imageRect) {
            alert('裁剪框和图片没有交集，请拖动裁剪框覆盖图片区域');
            return;
        }
        if (imageRect.width < 2 || imageRect.height < 2) {
            alert('裁剪区域太小，请把裁剪框拉大一些');
            return;
        }

        setDrawMode('select');
        onCropLayer?.({
            layerId: layerObj.layerId,
            rect: imageRect,
            x: cropBounds.left,
            y: cropBounds.top,
        });
    }, [onCropLayer, setDrawMode]);

    const applyStretchFromCanvas = React.useCallback(() => {
        const state = stretchStateRef.current;
        if (!state?.layerObj) return;

        const info = computeStretchInfo(state.layerObj);
        if (!info.ok) {
            alert(`无法应用拉伸：${info.errors.join('；')}`);
            return;
        }
        if (!info.changed) return;

        stretchCommitRef.current = true;
        setIsDrawing?.(false);
        setDrawMode('select');
        onStretchLayer?.({
            layerId: state.layerObj.layerId,
            width: info.width,
            height: info.height,
            x: state.layerObj.left,
            y: state.layerObj.top,
        });
    }, [onStretchLayer, setDrawMode, setIsDrawing]);

    // 裁剪模式：在选中图层上创建可拖动 / 缩放的裁剪框，并压暗框外区域
    useEffect(() => {
        if (!fabricCanvas || drawMode !== 'crop') return undefined;

        const layerObj = fabricCanvas.getObjects().find((obj) => obj.layerId === selectedLayerId);
        if (!layerObj) {
            setDrawMode('select');
            return undefined;
        }

        const layerBounds = layerObj.getBoundingRect();
        const dimRects = [0, 1, 2, 3].map(() => createOverlayRect({ fill: CROP_DIM_COLOR, visible: false }));
        const cropRect = createOverlayRect({
            left: layerBounds.left,
            top: layerBounds.top,
            width: layerBounds.width,
            height: layerBounds.height,
            fill: 'rgba(59, 130, 246, 0.06)',
            stroke: '#2563eb',
            strokeWidth: 1.5,
            strokeDashArray: [6, 4],
            strokeUniform: true,
            borderColor: '#2563eb',
            borderScaleFactor: 1.5,
            hasBorders: false,
            cornerColor: '#ffffff',
            cornerStrokeColor: '#2563eb',
            transparentCorners: false,
            cornerSize: 12,
            lockRotation: true,
            lockScalingFlip: true,
            padding: 0,
            selectable: true,
            evented: true,
        });
        cropRect.setControlsVisibility({ mtr: false });

        cropStateRef.current = { layerObj, layerBounds, cropRect, dimRects };

        fabricCanvas.add(...dimRects);
        fabricCanvas.add(cropRect);
        cropRect.setCoords();
        fabricCanvas.setActiveObject(cropRect);

        const clampToLayer = (value, min, max) => Math.min(max, Math.max(min, value));

        // 四条压暗矩形拼出「框外压暗」；裁剪框超出图片时按图片范围裁剪遮罩
        const updateDimRects = (cropBounds) => {
            const layerRight = layerBounds.left + layerBounds.width;
            const layerBottom = layerBounds.top + layerBounds.height;
            const top = clampToLayer(cropBounds.top, layerBounds.top, layerBottom);
            const bottom = clampToLayer(cropBounds.top + cropBounds.height, layerBounds.top, layerBottom);
            const left = clampToLayer(cropBounds.left, layerBounds.left, layerRight);
            const right = clampToLayer(cropBounds.left + cropBounds.width, layerBounds.left, layerRight);

            const positions = [
                { left: layerBounds.left, top: layerBounds.top, width: layerBounds.width, height: top - layerBounds.top },
                { left: layerBounds.left, top: bottom, width: layerBounds.width, height: layerBottom - bottom },
                { left: layerBounds.left, top, width: left - layerBounds.left, height: bottom - top },
                { left: right, top, width: layerRight - right, height: bottom - top },
            ];

            dimRects.forEach((rect, index) => {
                const position = positions[index];
                const visible = position.width > 0.5 && position.height > 0.5;
                rect.set({
                    left: position.left,
                    top: position.top,
                    width: Math.max(0, position.width),
                    height: Math.max(0, position.height),
                    visible,
                });
                rect.setCoords();
            });
        };

        const report = () => {
            const cropBounds = cropRect.getBoundingRect();
            updateDimRects(cropBounds);

            const rotated = normalizeAngleDelta(layerObj.angle) > 0.01;
            const flipped = Boolean(layerObj.flipX) || Number(layerObj.scaleX) < 0
                || Boolean(layerObj.flipY) || Number(layerObj.scaleY) < 0;
            const blockedReason = rotated
                ? '裁剪暂不支持旋转后的图层，请先旋转回 0°'
                : flipped
                    ? '裁剪暂不支持翻转后的图层，请先翻回原方向'
                    : '';
            const intersection = blockedReason ? null : intersectBounds(cropBounds, layerBounds);
            const imageRect = intersection ? sceneBoundsToImageRect(layerObj, intersection) : null;

            setCropInfo({ rect: imageRect, blockedReason });
        };

        const onObjectChanged = (event) => {
            if (event.target === cropRect) report();
        };
        // 点击裁剪框外的空白区域时保持裁剪框选中，手柄不会突然消失
        const onSelectionCleared = () => {
            if (!cropStateRef.current) return;
            if (!fabricCanvas.getActiveObject()) {
                fabricCanvas.setActiveObject(cropRect);
                fabricCanvas.requestRenderAll();
            }
        };

        fabricCanvas.on('object:moving', onObjectChanged);
        fabricCanvas.on('object:scaling', onObjectChanged);
        fabricCanvas.on('object:modified', onObjectChanged);
        fabricCanvas.on('selection:cleared', onSelectionCleared);

        report();
        fabricCanvas.requestRenderAll();

        return () => {
            fabricCanvas.off('object:moving', onObjectChanged);
            fabricCanvas.off('object:scaling', onObjectChanged);
            fabricCanvas.off('object:modified', onObjectChanged);
            fabricCanvas.off('selection:cleared', onSelectionCleared);
            cropStateRef.current = null;
            setCropInfo(null);
            [cropRect, ...dimRects].forEach((obj) => fabricCanvas.remove(obj));
            fabricCanvas.discardActiveObject();
            fabricCanvas.requestRenderAll();
        };
    }, [fabricCanvas, drawMode, selectedLayerId, setDrawMode]);

    // 拉伸模式：只允许拖拽当前图层的控制柄；取消时恢复原变换，应用时把缩放固化成像素尺寸
    useEffect(() => {
        if (!fabricCanvas || drawMode !== 'stretch') return undefined;

        const layerObj = fabricCanvas.getObjects().find((obj) => obj.layerId === selectedLayerId);
        if (!layerObj) {
            setDrawMode('select');
            return undefined;
        }

        const original = {
            left: layerObj.left,
            top: layerObj.top,
            scaleX: layerObj.scaleX,
            scaleY: layerObj.scaleY,
        };
        stretchCommitRef.current = false;
        stretchStateRef.current = { layerObj };

        setAllObjectsSelectable(fabricCanvas, false);
        layerObj.set({ selectable: true, evented: true, lockScalingFlip: true });
        layerObj.setCoords();
        fabricCanvas.setActiveObject(layerObj);
        fabricCanvas.requestRenderAll();

        const report = () => {
            setStretchInfo(computeStretchInfo(layerObj));
        };

        const onObjectChanged = (event) => {
            if (event.target === layerObj) report();
        };

        fabricCanvas.on('object:scaling', onObjectChanged);
        fabricCanvas.on('object:modified', onObjectChanged);
        report();

        return () => {
            fabricCanvas.off('object:scaling', onObjectChanged);
            fabricCanvas.off('object:modified', onObjectChanged);
            setStretchInfo(null);
            stretchStateRef.current = null;
            layerObj.set({ lockScalingFlip: false });

            if (!stretchCommitRef.current) {
                // 取消 / 切换模式：把拖拽产生的缩放还原，避免留下“没应用”的变形
                layerObj.set({
                    left: original.left,
                    top: original.top,
                    scaleX: original.scaleX,
                    scaleY: original.scaleY,
                });
                layerObj.setCoords();
                fabricCanvas.requestRenderAll();
                // 触发已有的 object:modified 监听，把位置/缩放同步回父组件
                fabricCanvas.fire('object:modified', { target: layerObj });
            }
            stretchCommitRef.current = false;
        };
    }, [fabricCanvas, drawMode, selectedLayerId, setDrawMode]);

    // 裁剪 / 拉伸模式的键盘操作：Esc 取消，Enter 应用
    useEffect(() => {
        if (!fabricCanvas) return undefined;
        if (drawMode !== 'crop' && drawMode !== 'stretch') return undefined;

        const onKeyDown = (event) => {
            const target = event.target;
            const tag = (target?.tagName || '').toLowerCase();
            if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                cancelImageTool();
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                if (drawMode === 'crop') applyCropFromCanvas();
                else applyStretchFromCanvas();
            }
        };

        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [fabricCanvas, drawMode, cancelImageTool, applyCropFromCanvas, applyStretchFromCanvas]);

    // 监听对象变化（移动/缩放等）同步区域列表和图层信息
    useEffect(() => {
        if (!fabricCanvas) return;

        const onChanged = () => {
            syncRegions();
            syncLayers();
        };

        // 存储每个图层的上一次位置
        const layerPositions = new Map();
        fabricCanvas.getObjects().forEach(obj => {
            if (obj.layerId) {
                layerPositions.set(obj.layerId, { left: obj.left, top: obj.top });
            }
        });

        // 监听图层移动，同步更新关联的遮罩位置
        const onLayerMoving = (e) => {
            const obj = e.target;
            if (!obj || !obj.layerId) return;

            const lastPos = layerPositions.get(obj.layerId);
            if (!lastPos) return;

            // 计算当前图层的偏移量
            const deltaX = obj.left - lastPos.left;
            const deltaY = obj.top - lastPos.top;

            // 更新所有属于该图层的遮罩对象（矩形、路径等）
            fabricCanvas.getObjects().forEach(maskObj => {
                if (maskObj.maskLayerId === obj.layerId && maskObj !== obj) {
                    maskObj.set({
                        left: maskObj.left + deltaX,
                        top: maskObj.top + deltaY
                    });
                    maskObj.setCoords();
                }
            });

            // 更新存储的位置
            layerPositions.set(obj.layerId, { left: obj.left, top: obj.top });
        };

        const onLayerModified = (e) => {
            const obj = e.target;
            // 更新图层位置记录
            if (obj && obj.layerId) {
                layerPositions.set(obj.layerId, { left: obj.left, top: obj.top });
            }
            onChanged();
        };

        fabricCanvas.on('object:moving', onLayerMoving);
        fabricCanvas.on('object:modified', onLayerModified);
        fabricCanvas.on('object:added', onChanged);
        fabricCanvas.on('object:removed', onChanged);

        return () => {
            fabricCanvas.off('object:moving', onLayerMoving);
            fabricCanvas.off('object:modified', onLayerModified);
            fabricCanvas.off('object:added', onChanged);
            fabricCanvas.off('object:removed', onChanged);
        };
    }, [fabricCanvas, getAllLayersBounds]);

    // Sync canvas selection with layer panel selection (bidirectional)
    useEffect(() => {
        if (!fabricCanvas || !onSelectLayer) return;

        const handleSelectionCreated = (e) => {
            const selected = e.selected?.[0];
            if (selected && selected.layerId) {
                // 如果处于参考图选择模式，将选中的图层添加为参考图
                if (isSelectingReference && onAddReferenceImage) {
                    const layer = layers.find(l => l.id === selected.layerId);
                    if (layer) {
                        onAddReferenceImage({
                            url: layer.url,
                            base64: layer.base64,
                            mimeType: layer.mimeType,
                            name: layer.name,
                        });
                        // 添加后立即取消选中，允许继续选择其他图层
                        fabricCanvas.discardActiveObject();
                        fabricCanvas.requestRenderAll();
                    }
                } else {
                    onSelectLayer(selected.layerId);
                }
            }
        };

        const handleSelectionUpdated = (e) => {
            const selected = e.selected?.[0];
            if (selected && selected.layerId) {
                // 参考图选择模式下添加参考图并取消选中
                if (isSelectingReference && onAddReferenceImage) {
                    const layer = layers.find(l => l.id === selected.layerId);
                    if (layer) {
                        onAddReferenceImage({
                            url: layer.url,
                            base64: layer.base64,
                            mimeType: layer.mimeType,
                            name: layer.name,
                        });
                        // 添加后立即取消选中，允许继续选择其他图层
                        fabricCanvas.discardActiveObject();
                        fabricCanvas.requestRenderAll();
                    }
                } else {
                    onSelectLayer(selected.layerId);
                }
            }
        };

        const handleSelectionCleared = () => {
            onSelectLayer(null);
        };

        fabricCanvas.on('selection:created', handleSelectionCreated);
        fabricCanvas.on('selection:updated', handleSelectionUpdated);
        fabricCanvas.on('selection:cleared', handleSelectionCleared);

        return () => {
            fabricCanvas.off('selection:created', handleSelectionCreated);
            fabricCanvas.off('selection:updated', handleSelectionUpdated);
            fabricCanvas.off('selection:cleared', handleSelectionCleared);
        };
    }, [fabricCanvas, onSelectLayer, isSelectingReference, onAddReferenceImage, layers]);

    // Sync layer panel selection to canvas selection
    useEffect(() => {
        if (!fabricCanvas) return;
        // 裁剪 / 拉伸模式由工具自己管理画布选中对象，避免抢走裁剪框 / 控制柄
        if (drawMode === 'crop' || drawMode === 'stretch') return;

        // Find the object with the selected layer ID
        const objects = fabricCanvas.getObjects();
        const targetObject = objects.find(obj => obj.layerId === selectedLayerId);

        if (targetObject) {
            // Select the object on canvas
            fabricCanvas.setActiveObject(targetObject);
            fabricCanvas.requestRenderAll();
        } else if (selectedLayerId === null) {
            // Clear selection if no layer is selected
            fabricCanvas.discardActiveObject();
            fabricCanvas.requestRenderAll();
        }
    }, [fabricCanvas, selectedLayerId, drawMode]);

    // Generate mask layer from lasso selection
    const generateMaskFromLasso = useCallback(() => {
        if (!fabricCanvas || !lassoSelection) return null;

        const bounds = getAllLayersBounds();
        if (!bounds) return null;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = bounds.width;
        tempCanvas.height = bounds.height;
        const ctx = tempCanvas.getContext('2d');

        // Fill with black background
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);

        // Draw white mask from lasso path
        ctx.save();
        ctx.translate(-bounds.left, -bounds.top);
        ctx.fillStyle = 'white';
        ctx.strokeStyle = 'white';

        const pathData = lassoSelection.path;
        console.log('generateMaskFromLasso - total commands:', pathData.length);
        console.log('generateMaskFromLasso - first 5:', pathData.slice(0, 5));
        console.log('generateMaskFromLasso - last 5:', pathData.slice(-5));

        // Count command types
        const commandTypes = {};
        pathData.forEach(cmd => {
            const type = cmd[0];
            commandTypes[type] = (commandTypes[type] || 0) + 1;
        });
        console.log('generateMaskFromLasso - command types:', commandTypes);

        ctx.beginPath();
        pathData.forEach((cmd) => {
            if (cmd[0] === 'M') {
                ctx.moveTo(cmd[1], cmd[2]);
            } else if (cmd[0] === 'L') {
                ctx.lineTo(cmd[1], cmd[2]);
            } else if (cmd[0] === 'Q') {
                // Quadratic curve
                ctx.quadraticCurveTo(cmd[1], cmd[2], cmd[3], cmd[4]);
            } else if (cmd[0] === 'C') {
                // Cubic curve
                ctx.bezierCurveTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
            } else if (cmd[0] === 'Z') {
                ctx.closePath();
            } else {
                console.warn('Unknown path command:', cmd[0], cmd);
            }
        });
        ctx.fill();
        ctx.restore();

        return {
            dataUrl: tempCanvas.toDataURL('image/png'),
            x: bounds.left,
            y: bounds.top
        };
    }, [fabricCanvas, lassoSelection, getAllLayersBounds]);

    // Cutout lasso selection from current layer (full size)
    const cutoutLassoSelection = useCallback(() => {
        if (!fabricCanvas || !lassoSelection) return null;

        // Get bounds of all layers
        const bounds = getAllLayersBounds();
        if (!bounds) return null;

        // Create a temporary canvas
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = bounds.width;
        tempCanvas.height = bounds.height;
        const ctx = tempCanvas.getContext('2d');

        // Draw all visible layers
        fabricCanvas.getObjects().forEach(obj => {
            if (obj.layerId && obj.visible) {
                const img = obj.getElement();
                ctx.save();
                ctx.translate(obj.left - bounds.left, obj.top - bounds.top);
                ctx.rotate(obj.angle * Math.PI / 180);
                ctx.scale(obj.scaleX, obj.scaleY);
                ctx.drawImage(img, 0, 0);
                ctx.restore();
            }
        });

        // Apply lasso mask
        ctx.globalCompositeOperation = 'destination-in';
        ctx.save();
        ctx.translate(-bounds.left, -bounds.top);

        const pathData = lassoSelection.path;
        ctx.beginPath();
        pathData.forEach((cmd) => {
            if (cmd[0] === 'M') {
                ctx.moveTo(cmd[1], cmd[2]);
            } else if (cmd[0] === 'L') {
                ctx.lineTo(cmd[1], cmd[2]);
            } else if (cmd[0] === 'Q') {
                ctx.quadraticCurveTo(cmd[1], cmd[2], cmd[3], cmd[4]);
            } else if (cmd[0] === 'C') {
                ctx.bezierCurveTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
            } else if (cmd[0] === 'Z') {
                ctx.closePath();
            }
        });
        ctx.fill();
        ctx.restore();

        return tempCanvas.toDataURL('image/png');
    }, [fabricCanvas, lassoSelection, getAllLayersBounds]);

    // Cutout lasso selection (cropped to bounding box only)
    const cutoutLassoSelectionCropped = useCallback(() => {
        if (!fabricCanvas || !lassoSelection) return null;

        // Get bounds of all layers
        const bounds = getAllLayersBounds();
        if (!bounds) return null;

        // Calculate bounding box of lasso path
        const pathData = lassoSelection.path;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        pathData.forEach((cmd) => {
            if (cmd[0] === 'M' || cmd[0] === 'L') {
                minX = Math.min(minX, cmd[1]);
                minY = Math.min(minY, cmd[2]);
                maxX = Math.max(maxX, cmd[1]);
                maxY = Math.max(maxY, cmd[2]);
            } else if (cmd[0] === 'Q') {
                // Quadratic curve: control point and end point
                minX = Math.min(minX, cmd[1], cmd[3]);
                minY = Math.min(minY, cmd[2], cmd[4]);
                maxX = Math.max(maxX, cmd[1], cmd[3]);
                maxY = Math.max(maxY, cmd[2], cmd[4]);
            } else if (cmd[0] === 'C') {
                // Cubic curve: two control points and end point
                minX = Math.min(minX, cmd[1], cmd[3], cmd[5]);
                minY = Math.min(minY, cmd[2], cmd[4], cmd[6]);
                maxX = Math.max(maxX, cmd[1], cmd[3], cmd[5]);
                maxY = Math.max(maxY, cmd[2], cmd[4], cmd[6]);
            }
        });

        const cropWidth = Math.ceil(maxX - minX);
        const cropHeight = Math.ceil(maxY - minY);

        // Create a temporary canvas with full size first
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = bounds.width;
        tempCanvas.height = bounds.height;
        const ctx = tempCanvas.getContext('2d');

        // Draw all visible layers
        fabricCanvas.getObjects().forEach(obj => {
            if (obj.layerId && obj.visible) {
                const img = obj.getElement();
                ctx.save();
                ctx.translate(obj.left - bounds.left, obj.top - bounds.top);
                ctx.rotate(obj.angle * Math.PI / 180);
                ctx.scale(obj.scaleX, obj.scaleY);
                ctx.drawImage(img, 0, 0);
                ctx.restore();
            }
        });

        // Apply lasso mask
        ctx.globalCompositeOperation = 'destination-in';
        ctx.save();
        ctx.translate(-bounds.left, -bounds.top);

        ctx.beginPath();
        pathData.forEach((cmd) => {
            if (cmd[0] === 'M') {
                ctx.moveTo(cmd[1], cmd[2]);
            } else if (cmd[0] === 'L') {
                ctx.lineTo(cmd[1], cmd[2]);
            } else if (cmd[0] === 'Q') {
                ctx.quadraticCurveTo(cmd[1], cmd[2], cmd[3], cmd[4]);
            } else if (cmd[0] === 'C') {
                ctx.bezierCurveTo(cmd[1], cmd[2], cmd[3], cmd[4], cmd[5], cmd[6]);
            } else if (cmd[0] === 'Z') {
                ctx.closePath();
            }
        });
        ctx.fill();
        ctx.restore();

        // Create cropped canvas
        const croppedCanvas = document.createElement('canvas');
        croppedCanvas.width = cropWidth;
        croppedCanvas.height = cropHeight;
        const croppedCtx = croppedCanvas.getContext('2d');

        // Copy only the cropped region
        croppedCtx.drawImage(
            tempCanvas,
            minX - bounds.left, minY - bounds.top, cropWidth, cropHeight,
            0, 0, cropWidth, cropHeight
        );

        return {
            dataUrl: croppedCanvas.toDataURL('image/png'),
            x: minX,
            y: minY
        };
    }, [fabricCanvas, lassoSelection, getAllLayersBounds]);

    const hudText = useMemo(() => {
        const parts = [];

        // 显示相对于图层包围盒的坐标
        if (pointer) {
            const relativeCoords = sceneToRelativeCoords(pointer);
            parts.push(`X: ${Math.round(relativeCoords.x)}  Y: ${Math.round(relativeCoords.y)}`);
        } else {
            parts.push('X: -  Y: -');
        }

        parts.push(`缩放: ${Math.round(zoom * 100)}%`);

        if (rectInfo) {
            const relativeRect = sceneToRelativeCoords({ x: rectInfo.x, y: rectInfo.y });
            parts.push(
                `框选: X ${Math.round(relativeRect.x)}  Y ${Math.round(relativeRect.y)}  W ${Math.round(rectInfo.width)}  H ${Math.round(rectInfo.height)}`
            );
        }

        if (isRestoring) parts.push('回撤中…');
        if (drawMode === 'crop') {
            parts.push('裁剪：拖动 / 缩放裁剪框 · Enter 应用 · Esc 取消');
        } else if (drawMode === 'stretch') {
            parts.push('拉伸：拖拽控制柄改变尺寸 · Enter 应用 · Esc 取消');
        } else if (!isDrawing && drawMode !== 'select') {
            parts.push('绘制未启用（点击左侧按钮或点工具自动启用）');
        }
        parts.push('空格拖拽平移 · 滚轮缩放');
        return parts.join('  ·  ');
    }, [pointer, zoom, rectInfo, isRestoring, isDrawing, drawMode, sceneToRelativeCoords]);

    return (
        <div className="relative w-full h-full flex flex-col">
            <div
                ref={containerRef}
                className="flex-1 w-full h-full rounded-ios-md overflow-hidden shadow-inner-cut"
                style={{
                    background: `
                        linear-gradient(45deg, #e5e5e5 25%, transparent 25%),
                        linear-gradient(-45deg, #e5e5e5 25%, transparent 25%),
                        linear-gradient(45deg, transparent 75%, #e5e5e5 75%),
                        linear-gradient(-45deg, transparent 75%, #e5e5e5 75%)
                    `,
                    backgroundSize: '20px 20px',
                    backgroundPosition: '0 0, 0 10px, 10px -10px, -10px 0px',
                    backgroundColor: '#ffffff'
                }}
            >
                <canvas ref={canvasRef} className="block" />
            </div>

            <div className="absolute top-4 left-4 flex items-center gap-2">
                <div className="px-3 py-1.5 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50 text-xs text-slate-700 select-none">
                    {hudText}
                </div>
                <div className="flex items-center gap-2 p-1 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        onClick={fitToView}
                        title="适应窗口并居中显示全貌"
                    >
                        适应窗口
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        onClick={resetTo1to1}
                        title="恢复 1:1（不放大）"
                    >
                        1:1
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        onClick={() => {
                            if (!rectInfo) return;
                            const text = `${Math.round(rectInfo.x)},${Math.round(rectInfo.y)},${Math.round(rectInfo.width)},${Math.round(rectInfo.height)}`;
                            copyToClipboard(text);
                        }}
                        disabled={!rectInfo}
                        title="复制框选坐标（x,y,w,h）"
                    >
                        复制框选
                    </Button>
                </div>
            </div>

            {/* Only show toolbar when there are layers */}
            {layers.length > 0 && (
                <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3">
                    {(drawMode === 'brush' || drawMode === 'eraser') && (
                        <div className="px-4 py-2 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                            <div className="flex items-center gap-3">
                                <span className="text-xs font-medium text-slate-600">画笔大小</span>
                                <input
                                    type="range"
                                    min="5"
                                max="100"
                                value={brushSize}
                                onChange={(e) => setBrushSize(Number(e.target.value))}
                                className="w-32"
                            />
                            <span className="text-xs font-medium text-slate-900 w-8">{brushSize}</span>
                        </div>
                    </div>
                )}

                {drawMode === 'crop' && (
                    <div className="flex items-center gap-3 px-4 py-2 bg-white/95 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                        <span className="text-xs font-medium text-slate-600">
                            {cropInfo?.blockedReason ? (
                                <span className="text-amber-600">{cropInfo.blockedReason}</span>
                            ) : cropInfo?.rect ? (
                                <>
                                    裁剪尺寸{' '}
                                    <span className="font-semibold tabular-nums text-slate-900">
                                        {cropInfo.rect.width} × {cropInfo.rect.height}
                                    </span>{' '}
                                    px
                                </>
                            ) : (
                                '把裁剪框拖到图片范围内'
                            )}
                        </span>
                        <Button size="sm" variant="secondary" className="rounded-full" onClick={cancelImageTool}>
                            取消
                        </Button>
                        <Button
                            size="sm"
                            className="rounded-full"
                            onClick={applyCropFromCanvas}
                            disabled={!cropInfo?.rect}
                        >
                            应用裁剪
                        </Button>
                    </div>
                )}

                {drawMode === 'stretch' && (
                    <div className="flex items-center gap-3 px-4 py-2 bg-white/95 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                        <span className="text-xs font-medium text-slate-600">
                            {stretchInfo?.errors?.length ? (
                                <span className="text-red-500">{stretchInfo.errors[0]}</span>
                            ) : (
                                <>
                                    输出尺寸{' '}
                                    <span className="font-semibold tabular-nums text-slate-900">
                                        {stretchInfo?.width ?? '—'} × {stretchInfo?.height ?? '—'}
                                    </span>{' '}
                                    px
                                    {stretchInfo?.ratioChanged && (
                                        <span className="text-amber-600">（比例已改变，会变形）</span>
                                    )}
                                    {stretchInfo?.warnings?.length > 0 && (
                                        <span className="text-amber-600">（{stretchInfo.warnings[0]}）</span>
                                    )}
                                </>
                            )}
                        </span>
                        <Button size="sm" variant="secondary" className="rounded-full" onClick={cancelImageTool}>
                            取消
                        </Button>
                        <Button
                            size="sm"
                            className="rounded-full"
                            onClick={applyStretchFromCanvas}
                            disabled={!stretchInfo?.ok || !stretchInfo?.changed}
                        >
                            应用拉伸
                        </Button>
                    </div>
                )}

                <div className="flex items-center gap-2 p-2 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                    <Button
                        variant={drawMode === 'select' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('select');
                            setIsDrawing?.(false);
                        }}
                        className="rounded-full w-10 h-10"
                        title="选择工具"
                    >
                        <MousePointer2 size={18} />
                    </Button>

                    <Button
                        variant={drawMode === 'brush' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('brush');
                            setIsDrawing?.(true);
                        }}
                        className="rounded-full w-10 h-10"
                        title="画笔"
                    >
                        <Pencil size={18} />
                    </Button>

                    <Button
                        variant={drawMode === 'rectangle' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('rectangle');
                            setIsDrawing?.(true);
                        }}
                        className="rounded-full w-10 h-10"
                        title="矩形框选（按住 Shift 画正方形）"
                    >
                        <Square size={18} />
                    </Button>

                    <Button
                        variant={drawMode === 'eraser' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('eraser');
                            setIsDrawing?.(true);
                        }}
                        className="rounded-full w-10 h-10"
                        title="橡皮擦"
                    >
                        <Eraser size={18} />
                    </Button>

                    {/* Lasso Tool with Dropdown */}
                    <div className="relative">
                        <Button
                            variant={drawMode?.startsWith('lasso') ? 'primary' : 'ghost'}
                            size="icon"
                            onClick={() => setShowLassoDropdown(!showLassoDropdown)}
                            className="rounded-full w-10 h-10"
                            title="套索工具"
                        >
                            <Lasso size={18} />
                        </Button>

                        {showLassoDropdown && (
                            <div className="absolute bottom-full mb-2 left-0 bg-white rounded-lg shadow-lg border border-gray-200 p-2 min-w-[160px] z-50">
                                <button
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 rounded"
                                    onClick={() => {
                                        setDrawMode('lasso-free');
                                        setLassoMode('free');
                                        setIsDrawing?.(true);
                                        setShowLassoDropdown(false);
                                    }}
                                >
                                    自由套索
                                </button>
                                <button
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 rounded"
                                    onClick={() => {
                                        setDrawMode('lasso-polygonal');
                                        setLassoMode('polygonal');
                                        setIsDrawing?.(true);
                                        setShowLassoDropdown(false);
                                    }}
                                >
                                    多边形套索
                                </button>
                                <button
                                    className="w-full text-left px-3 py-2 text-sm hover:bg-gray-100 rounded"
                                    onClick={() => {
                                        setDrawMode('lasso-magnetic');
                                        setLassoMode('magnetic');
                                        setIsDrawing?.(true);
                                        setShowLassoDropdown(false);
                                    }}
                                >
                                    磁性套索
                                </button>
                            </div>
                        )}
                    </div>

                    <div className="w-px h-6 bg-gray-300 mx-1" />

                    {/* 裁剪：在画布上拖出裁剪框，确认后裁掉框外内容 */}
                    <Button
                        variant={drawMode === 'crop' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            if (!selectedLayerId) {
                                alert('请先选择一个图层再裁剪');
                                return;
                            }
                            setDrawMode('crop');
                            setIsDrawing?.(false);
                        }}
                        disabled={!selectedLayerId}
                        className="rounded-full w-10 h-10"
                        title="裁剪：拖出裁剪框，Enter 应用 / Esc 取消"
                    >
                        <Crop size={18} />
                    </Button>

                    {/* 拉伸：拖拽控制柄改变尺寸，确认后把缩放固化成新的像素尺寸 */}
                    <Button
                        variant={drawMode === 'stretch' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            if (!selectedLayerId) {
                                alert('请先选择一个图层再拉伸');
                                return;
                            }
                            setDrawMode('stretch');
                            setIsDrawing?.(false);
                        }}
                        disabled={!selectedLayerId}
                        className="rounded-full w-10 h-10"
                        title="拉伸：拖拽手柄改变图片尺寸，Enter 应用 / Esc 取消"
                    >
                        <Scaling size={18} />
                    </Button>

                    {/* Background Removal Tool */}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                            if (selectedLayerId && onRemoveBackground) {
                                onRemoveBackground(selectedLayerId);
                            }
                        }}
                        disabled={!selectedLayerId}
                        className="rounded-full w-10 h-10"
                        title="移除背景"
                    >
                        <Sparkles size={18} />
                    </Button>

                    <div className="w-px h-6 bg-gray-300 mx-1" />

                    <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full w-10 h-10"
                        onClick={undo}
                        disabled={historyStep <= 0 || isRestoring}
                        title="撤销"
                    >
                        <Undo2 size={18} />
                    </Button>

                    <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full w-10 h-10"
                        onClick={redo}
                        disabled={historyStep >= historyLength - 1 || isRestoring}
                        title="重做"
                    >
                        <Redo2 size={18} />
                    </Button>

                    <div className="w-px h-6 bg-gray-300 mx-1" />

                    <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full w-10 h-10 text-red-500 hover:bg-red-50"
                        onClick={clearCanvas}
                        title="删除选中的图层"
                    >
                        <Trash2 size={18} />
                    </Button>
                </div>

                {/* Conditional buttons for lasso selection */}
                {lassoSelection && (
                    <div className="flex items-center gap-2 p-2 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                        <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full"
                            onClick={() => {
                                const maskResult = generateMaskFromLasso();
                                if (maskResult && onAddLayer) {
                                    onAddLayer({
                                        url: maskResult.dataUrl,
                                        name: '遮罩图层',
                                        type: 'mask',
                                        x: maskResult.x,
                                        y: maskResult.y
                                    });
                                }
                            }}
                            title="生成遮罩图层"
                        >
                            生成遮罩
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full"
                            onClick={() => {
                                const cutoutDataUrl = cutoutLassoSelection();
                                if (cutoutDataUrl && onAddLayer) {
                                    onAddLayer({
                                        url: cutoutDataUrl,
                                        name: '抠图图层',
                                        type: 'cutout'
                                    });
                                }
                            }}
                            title="抠出套索区域（保持原图尺寸）"
                        >
                            抠出区域
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full"
                            onClick={() => {
                                const cutoutResult = cutoutLassoSelectionCropped();
                                if (cutoutResult && onAddLayer) {
                                    onAddLayer({
                                        url: cutoutResult.dataUrl,
                                        name: '裁剪抠图',
                                        type: 'cutout-cropped',
                                        x: cutoutResult.x,
                                        y: cutoutResult.y
                                    });
                                }
                            }}
                            title="裁剪抠出（仅保留选区边界）"
                        >
                            裁剪抠出
                        </Button>
                        <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-full text-red-600 hover:text-red-700 hover:bg-red-50"
                            onClick={() => {
                                if (fabricCanvas && lassoSelection) {
                                    // Remove the lasso path from canvas
                                    fabricCanvas.remove(lassoSelection);
                                    setLassoSelection(null);
                                    fabricCanvas.requestRenderAll();
                                    pushHistory();
                                }
                            }}
                            title="取消套索区域"
                        >
                            <X size={16} className="mr-1" />
                            取消套索
                        </Button>
                    </div>
                )}
            </div>
            )}
        </div>
    );
}
