import React, { useRef, useState } from 'react';
import { Download, Image as ImageIcon, ImageOff, Upload } from 'lucide-react';
import { CanvasEditor } from './components/CanvasEditor';
import { ControlPanel } from './components/ControlPanel';
import { LayerPanel } from './components/LayerPanel';
import { Layout } from './components/Layout';
import { Button } from './components/ui/Button';
import {
  editImage,
  editImageViaChatCompletions,
  generateImage,
  generateImageViaChatCompletions,
  uploadFile,
} from './lib/api';
import { removeImageBackground } from './lib/backgroundRemoval';
import { extractByMask } from './lib/maskExtraction';
import { isChatImageModel, migrateLegacySizeConfig, normalizeSizeConfig, resolveOutputSize } from './lib/imageSize';
import {
  cropImageToDataUrl,
  resizeImageToDataUrl,
  splitDataUrl,
  validateCropRect,
  validateTargetSize,
} from './lib/imageTools';

function App() {
  // 图层管理
  const [layers, setLayers] = useState([]);
  const [selectedLayerId, setSelectedLayerId] = useState(null);
  const nextLayerIdRef = useRef(1);

  // 使用 ref 保存最新的 selectedLayerId，避免闭包问题
  const selectedLayerIdRef = useRef(selectedLayerId);
  React.useEffect(() => {
    selectedLayerIdRef.current = selectedLayerId;
  }, [selectedLayerId]);

  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);

  const [apiKey, setApiKey] = useState(() => localStorage.getItem('apiKey') || '');
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem('baseUrl') || 'https://foxi-ai.top');
  const [modelName, setModelName] = useState(() => localStorage.getItem('modelName') || 'gemini-2.5-flash-image');

  const [mode, setMode] = useState('generate'); // 'generate' | 'edit'
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawMode, setDrawMode] = useState('brush'); // 'brush' | 'rectangle' | 'eraser' | 'select'
  const [brushSize, setBrushSize] = useState(30);

  // 输出尺寸：只有一个配置（按比例 / 自定义像素 / 沿用原图），由 SizeControl 统一编辑
  const [sizeConfig, setSizeConfig] = useState(() => {
    try {
      const saved = localStorage.getItem('sizeConfig');
      if (saved) return normalizeSizeConfig(JSON.parse(saved));
    } catch {
      // 旧数据损坏时回退到迁移逻辑
    }
    return migrateLegacySizeConfig({
      imageSize: localStorage.getItem('imageSize'),
      aspectRatio: localStorage.getItem('aspectRatio'),
    });
  });
  const [generateCount, setGenerateCount] = useState(() => {
    const saved = localStorage.getItem('generateCount');
    return saved ? parseInt(saved) : 1;
  });

  // 抠图相关
  const [isRemoving, setIsRemoving] = useState(false);
  const [removalProgress, setRemovalProgress] = useState(null);

  // 遮罩抠图相关
  const [maskExtractionMode, setMaskExtractionMode] = useState(false);
  const [mainLayerForMask, setMainLayerForMask] = useState(null);
  const [maskLayerForExtraction, setMaskLayerForExtraction] = useState(null);

  // 参考图相关
  const [referenceImages, setReferenceImages] = useState([]); // 参考图数组，最多15张
  const [isSelectingReference, setIsSelectingReference] = useState(false); // 是否处于参考图选择模式
  const nextReferenceIdRef = useRef(1);

  // 编辑模式：是否保留原图
  const [keepOriginal, setKeepOriginal] = useState(() => {
    const saved = localStorage.getItem('keepOriginal');
    return saved === null ? true : saved === 'true'; // 默认勾选
  });

  const canvasRef = useRef(null);
  const [regions, setRegions] = useState([]);
  const [regionInstructions, setRegionInstructions] = useState({});

  // 编辑模式下“沿用原图尺寸”需要知道当前选中图层的像素尺寸
  const activeLayer = layers.find((layer) => layer.id === selectedLayerId) || null;
  const sourceSize = activeLayer ? { width: activeLayer.width, height: activeLayer.height } : null;

  // 添加新图层
  const addLayer = React.useCallback(async (layerData) => {
    // Parse base64 from data URL if needed
    const mime = String(layerData.url).split(';')[0].split(':')[1] || 'image/png';
    const base64 = String(layerData.url).split(',')[1];

    // Get image dimensions
    const img = new Image();
    img.src = layerData.url;
    await new Promise((resolve) => { img.onload = resolve; });

    const newLayer = {
      id: nextLayerIdRef.current++,
      name: layerData.name || `图层 ${nextLayerIdRef.current - 1}`,
      visible: true,
      locked: false,
      url: layerData.url,
      base64,
      mimeType: mime,
      width: img.width,
      height: img.height,
      x: 0,
      y: 0,
      ...layerData,
    };
    setLayers(prev => [...prev, newLayer]);
    setSelectedLayerId(newLayer.id);
    return newLayer;
  }, []);

  // 删除图层
  const deleteLayer = React.useCallback((layerId) => {
    setLayers(prev => prev.filter(l => l.id !== layerId));
    if (selectedLayerIdRef.current === layerId) {
      setSelectedLayerId(null);
    }
  }, []);

  // 切换图层可见性
  const toggleLayerVisibility = (layerId) => {
    setLayers(prev => prev.map(l =>
      l.id === layerId ? { ...l, visible: !l.visible } : l
    ));
  };

  // 切换图层锁定
  const toggleLayerLock = (layerId) => {
    setLayers(prev => prev.map(l =>
      l.id === layerId ? { ...l, locked: !l.locked } : l
    ));
  };

  // 上移图层
  const moveLayerUp = (layerId) => {
    setLayers(prev => {
      const index = prev.findIndex(l => l.id === layerId);
      if (index <= 0) return prev;
      const newLayers = [...prev];
      [newLayers[index - 1], newLayers[index]] = [newLayers[index], newLayers[index - 1]];
      return newLayers;
    });
  };

  // 下移图层
  const moveLayerDown = (layerId) => {
    setLayers(prev => {
      const index = prev.findIndex(l => l.id === layerId);
      if (index < 0 || index >= prev.length - 1) return prev;
      const newLayers = [...prev];
      [newLayers[index], newLayers[index + 1]] = [newLayers[index + 1], newLayers[index]];
      return newLayers;
    });
  };

  // 参考图管理函数
  // 添加参考图（文生图模式：上传文件；编辑模式：从图层选择）
  const addReferenceImage = React.useCallback(async (imageData) => {
    let limitReached = false;

    setReferenceImages(prev => {
      if (prev.length >= 15) {
        limitReached = true;
        return prev;
      }

      const newReference = {
        id: nextReferenceIdRef.current++,
        url: imageData.url,
        base64: imageData.base64,
        mimeType: imageData.mimeType,
        name: imageData.name || `参考图 ${nextReferenceIdRef.current - 1}`,
      };

      return [...prev, newReference];
    });

    // 在状态更新后显示提示
    if (limitReached) {
      setTimeout(() => alert('最多只能添加 15 张参考图'), 0);
    }
  }, []);

  // 删除参考图
  const deleteReferenceImage = React.useCallback((refId) => {
    setReferenceImages(prev => prev.filter(r => r.id !== refId));
  }, []);

  // 清空所有参考图
  const clearReferenceImages = React.useCallback(() => {
    setReferenceImages([]);
  }, []);

  // 复制图层
  const duplicateLayer = React.useCallback((layerId) => {
    setLayers(prev => {
      const sourceLayer = prev.find(l => l.id === layerId);
      if (!sourceLayer) {
        // 如果图层不存在，清除 sessionStorage 中的 ID
        sessionStorage.removeItem('copiedLayerId');
        console.warn('未找到要复制的图层');
        return prev;
      }

      const newLayer = {
        ...sourceLayer,
        id: nextLayerIdRef.current++,
        name: `${sourceLayer.name} (副本)`,
        // 偏移位置使其可见
        x: (sourceLayer.x || 0) + 20,
        y: (sourceLayer.y || 0) + 20,
      };

      // 延迟设置选中状态，等待 Fabric 对象创建完成
      setTimeout(() => {
        setSelectedLayerId(newLayer.id);
      }, 100);

      return [...prev, newLayer];
    });
  }, []);

  // 文件上传处理
  const handleFileUpload = React.useCallback(async (e) => {
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;

    try {
      input.value = '';

      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
      });

      const mime = String(dataUrl).split(';')[0].split(':')[1] || 'image/png';
      const base64 = String(dataUrl).split(',')[1];

      // 获取图片尺寸
      const img = new Image();
      img.src = dataUrl;
      await new Promise((resolve) => { img.onload = resolve; });

      // 添加为新图层
      addLayer({
        url: dataUrl,
        base64,
        mimeType: mime,
        width: img.width,
        height: img.height,
        x: 0,
        y: 0,
      });

      setMode('edit');
      setDrawMode('select');
    } catch (err) {
      console.error('上传失败', err);
      alert('上传失败: ' + err.message);
    }
  }, [addLayer, setMode, setDrawMode]);

  // 遮罩抠图功能
  const handleMaskExtraction = async () => {
    if (!mainLayerForMask || !maskLayerForExtraction) {
      alert('请先选择主图层和遮罩图层');
      return;
    }

    const mainLayer = layers.find(l => l.id === mainLayerForMask);
    const maskLayer = layers.find(l => l.id === maskLayerForExtraction);

    if (!mainLayer || !maskLayer) {
      alert('图层不存在');
      return;
    }

    try {
      setIsRemoving(true);
      const resultDataUrl = await extractByMask(mainLayer.url, maskLayer.url);

      await addLayer({
        url: resultDataUrl,
        name: `${mainLayer.name} (遮罩抠图)`,
      });

      // 重置状态
      setMaskExtractionMode(false);
      setMainLayerForMask(null);
      setMaskLayerForExtraction(null);

      alert('遮罩抠图完成！');
    } catch (error) {
      console.error('Mask extraction failed:', error);
      alert(`遮罩抠图失败: ${error.message}`);
    } finally {
      setIsRemoving(false);
    }
  };

  // 抠图功能
  const handleRemoveBackground = async (layerId) => {
    const layer = layers.find(l => l.id === layerId);
    if (!layer || !layer.url) return;

    try {
      setIsRemoving(true);
      setRemovalProgress({ key: 'fetch:model', current: 0, total: 100 });

      const resultDataUrl = await removeImageBackground(layer.url, (progress) => {
        setRemovalProgress(progress);
      });

      // 解析结果
      const mime = String(resultDataUrl).split(';')[0].split(':')[1] || 'image/png';
      const base64 = String(resultDataUrl).split(',')[1];

      // 创建新图层
      addLayer({
        url: resultDataUrl,
        base64,
        mimeType: mime,
        width: layer.width,
        height: layer.height,
        x: layer.x + 20,
        y: layer.y + 20,
        name: `${layer.name} (抠图)`,
      });

      alert('抠图完成！新图层已添加到画布');
    } catch (err) {
      console.error('抠图失败:', err);
      alert(`抠图失败: ${err.message}`);
    } finally {
      setIsRemoving(false);
      setRemovalProgress(null);
    }
  };

  // 下载图层
  const downloadLayer = (layerId) => {
    const layer = layers.find(l => l.id === layerId);
    if (!layer || !layer.url) return;

    // 创建一个临时 canvas 来确保透明背景
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d', { alpha: true });

      // 不设置背景色，保持透明
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0);

      // 导出为 PNG（保留透明通道）
      canvas.toBlob((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = layer.mimeType === 'image/jpeg' ? 'jpg' : layer.mimeType === 'image/webp' ? 'webp' : 'png';
        a.download = `${layer.name}_${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }, 'image/png');
    };
    img.src = layer.url;
  };

  // 替换某个图层的像素（供画布上的裁剪 / 拉伸工具使用）
  const replaceLayerImage = React.useCallback((layerId, updates) => {
    const { mimeType, base64 } = splitDataUrl(updates.url);
    setLayers((prev) => prev.map((layer) => (
      layer.id === layerId
        ? { ...layer, ...updates, mimeType, base64 }
        : layer
    )));
  }, []);

  // 画布裁剪工具回调：把选中图层裁剪到指定像素区域，并让裁剪结果保持在画布原来的位置
  const handleCropLayer = React.useCallback(async ({ layerId, rect, x, y }) => {
    const layer = layers.find((item) => item.id === layerId);
    if (!layer) {
      alert('图层不存在，可能已被删除');
      return;
    }

    const check = validateCropRect(rect, { width: layer.width, height: layer.height });
    if (!check.ok) {
      alert(`裁剪区域不合法：${check.errors.join('；')}`);
      return;
    }

    try {
      const result = await cropImageToDataUrl(layer.url, check.rect);
      replaceLayerImage(layer.id, {
        url: result.dataUrl,
        width: result.width,
        height: result.height,
        x: Number.isFinite(x) ? x : layer.x,
        y: Number.isFinite(y) ? y : layer.y,
      });
    } catch (err) {
      console.error('裁剪失败:', err);
      alert(`裁剪失败：${err.message}`);
    }
  }, [layers, replaceLayerImage]);

  // 画布拉伸工具回调：把拖拽缩放后的显示尺寸固化成新的图片像素尺寸
  const handleStretchLayer = React.useCallback(async ({ layerId, width, height, x, y }) => {
    const layer = layers.find((item) => item.id === layerId);
    if (!layer) {
      alert('图层不存在，可能已被删除');
      return;
    }

    const check = validateTargetSize(
      { width, height },
      { sourceSize: { width: layer.width, height: layer.height } }
    );
    if (!check.ok) {
      alert(`目标尺寸不合法：${check.errors.join('；')}`);
      return;
    }

    try {
      const result = await resizeImageToDataUrl(layer.url, check.size);
      replaceLayerImage(layer.id, {
        url: result.dataUrl,
        width: result.width,
        height: result.height,
        x: Number.isFinite(x) ? x : layer.x,
        y: Number.isFinite(y) ? y : layer.y,
        // 像素尺寸已经是拉伸后的结果，显示缩放归位到 1
        scaleX: 1,
        scaleY: 1,
      });
    } catch (err) {
      console.error('拉伸失败:', err);
      alert(`拉伸失败：${err.message}`);
    }
  }, [layers, replaceLayerImage]);

  // 处理拖拽上传
  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const files = Array.from(e.dataTransfer.files);
    const imageFiles = files.filter(file => file.type.startsWith('image/'));

    for (const file of imageFiles) {
      await handleFileUpload({ target: { files: [file] } });
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    e.stopPropagation();
  };

  // 处理粘贴上传
  React.useEffect(() => {
    localStorage.setItem('apiKey', apiKey);
  }, [apiKey]);

  React.useEffect(() => {
    localStorage.setItem('baseUrl', baseUrl);
  }, [baseUrl]);

  React.useEffect(() => {
    localStorage.setItem('modelName', modelName);
  }, [modelName]);

  React.useEffect(() => {
    localStorage.setItem('sizeConfig', JSON.stringify(sizeConfig));
  }, [sizeConfig]);

  React.useEffect(() => {
    localStorage.setItem('generateCount', generateCount);
  }, [generateCount]);

  React.useEffect(() => {
    localStorage.setItem('keepOriginal', keepOriginal);
  }, [keepOriginal]);

  // 快捷键处理
  React.useEffect(() => {
    const handleKeyDown = (e) => {
      // Ctrl+C / Cmd+C: 复制图层
      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && !e.shiftKey) {
        // 检查是否在输入框中
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const currentSelectedId = selectedLayerIdRef.current;
        if (currentSelectedId) {
          e.preventDefault();
          // 将选中的图层 ID 存储到 sessionStorage
          sessionStorage.setItem('copiedLayerId', currentSelectedId);
          console.log('已复制图层 ID:', currentSelectedId);

          // 清空剪贴板（写入空白内容）
          try {
            navigator.clipboard.writeText('').catch(() => {
              console.log('无法清空剪贴板');
            });
          } catch (err) {
            console.log('浏览器不支持剪贴板操作');
          }
        }
      }

      // Delete: 删除图层
      if (e.key === 'Delete') {
        // 检查是否在输入框中
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

        const currentSelectedId = selectedLayerIdRef.current;
        if (currentSelectedId) {
          e.preventDefault();
          deleteLayer(currentSelectedId);
        }
      }
    };

    const handlePasteEvent = async (e) => {
      // 检查是否在输入框中
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

      // 优先检查剪贴板中是否有图片
      const items = e.clipboardData?.items;
      if (items) {
        for (const item of items) {
          if (item.type.startsWith('image/')) {
            // 剪贴板有图片，粘贴图片
            e.preventDefault();
            const file = item.getAsFile();
            if (file) {
              await handleFileUpload({ target: { files: [file] } });
              // 粘贴图片后清除复制的图层 ID
              sessionStorage.removeItem('copiedLayerId');
            }
            return;
          }
        }
      }

      // 剪贴板没有图片，检查是否有复制的图层 ID
      const copiedLayerId = sessionStorage.getItem('copiedLayerId');
      if (copiedLayerId) {
        e.preventDefault();
        duplicateLayer(parseInt(copiedLayerId));
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('paste', handlePasteEvent);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('paste', handlePasteEvent);
    };
  }, [deleteLayer, duplicateLayer, handleFileUpload]);

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      alert('请输入提示词');
      return;
    }

    try {
      setIsGenerating(true);
      let resultDataUrl;

      // 编辑模式：对选中的图层进行编辑
      if (mode === 'edit') {
        // 获取选中的图层
        const selectedLayer = layers.find(l => l.id === selectedLayerId);
        if (!selectedLayer) {
          alert('请先选择要编辑的图层');
          return;
        }

        // 输出尺寸：沿用原图 / 按比例 / 自定义像素，统一由 SizeControl 决定
        const editOutputSize = resolveOutputSize({
          config: sizeConfig,
          model: modelName,
          mode: 'edit',
          sourceSize: { width: selectedLayer.width, height: selectedLayer.height },
        });
        if (editOutputSize.errors.length > 0) {
          alert(`输出尺寸不合法：${editOutputSize.errors.join('；')}`);
          return;
        }

        // 获取图层的 dataUrl
        const imageDataUrl = `data:${selectedLayer.mimeType};base64,${selectedLayer.base64}`;

        // 检查是否有绘制的遮罩
        const canvas = canvasRef.current;
        const objects = canvas?.getObjects().filter(obj => !obj.layerId && !obj.isCanvasOverlay) || [];
        const hasMask = objects.length > 0;

        let maskDataUrl = null;
        if (hasMask) {
          // 有遮罩：构建遮罩 base64
          try {
            const maskBase64 = buildMaskBase64();
            maskDataUrl = `data:image/png;base64,${maskBase64}`;
          } catch (err) {
            console.error('构建遮罩失败:', err);
            alert(`构建遮罩失败: ${err.message}`);
            return;
          }
        }

        // 调用编辑 API（支持有遮罩或无遮罩）
        if (isChatImageModel(modelName)) {
          const result = await editImageViaChatCompletions({
            imageDataUrl,
            maskDataUrl, // 可以为 null
            prompt,
            apiKey,
            baseUrl,
            model: modelName,
            referenceImages, // 添加参考图
            aspectRatio: editOutputSize.aspectRatio,
            imageSize: editOutputSize.imageSize,
          });
          resultDataUrl = `data:${result.mimeType};base64,${result.base64}`;
        } else {
          if (!hasMask) {
            alert('当前模型在编辑模式下需要先绘制遮罩：请涂抹或框选要修改的区域（无遮罩的整图编辑暂未接入）');
            return;
          }
          const result = await editImage({
            imageBase64: selectedLayer.base64,
            maskBase64: buildMaskBase64(),
            prompt,
            apiKey,
            baseUrl,
            model: modelName,
            imageMimeType: selectedLayer.mimeType,
            size: editOutputSize.pixelSize,
          });
          const firstImage = result?.data?.[0];
          if (!firstImage?.b64_json) throw new Error('编辑失败：未返回图片数据');
          resultDataUrl = `data:image/png;base64,${firstImage.b64_json}`;
        }
      } else {
        // 生成模式：批量生成新图片
        const count = generateCount;
        const generatedImages = [];

        // 输出尺寸：按比例 / 自定义像素（生成模式没有“沿用原图”选项）
        const outputSize = resolveOutputSize({
          config: sizeConfig,
          model: modelName,
          mode: 'generate',
        });
        if (outputSize.errors.length > 0) {
          alert(`输出尺寸不合法：${outputSize.errors.join('；')}`);
          return;
        }

        for (let i = 0; i < count; i++) {
          if (isChatImageModel(modelName)) {
            const result = await generateImageViaChatCompletions({
              prompt,
              apiKey,
              baseUrl,
              model: modelName,
              aspectRatio: outputSize.aspectRatio,
              imageSize: outputSize.imageSize,
              referenceImages, // 添加参考图
            });
            generatedImages.push(`data:${result.mimeType};base64,${result.base64}`);
          } else {
            const result = await generateImage({
              prompt,
              apiKey,
              baseUrl,
              model: modelName,
              size: outputSize.pixelSize,
            });
            const firstImage = result?.data?.[0];
            if (!firstImage?.b64_json) throw new Error('生成失败：未返回图片数据');
            generatedImages.push(`data:image/png;base64,${firstImage.b64_json}`);
          }
        }

        // 使用第一张图片作为 resultDataUrl（用于后续处理）
        resultDataUrl = generatedImages[0];

        // 如果是批量生成，保存所有生成的图片
        if (mode === 'generate' && generatedImages.length > 1) {
          // 批量添加所有生成的图片为新图层
          for (let i = 0; i < generatedImages.length; i++) {
            const dataUrl = generatedImages[i];
            const mime = String(dataUrl).split(';')[0].split(':')[1] || 'image/png';
            const base64 = String(dataUrl).split(',')[1];

            const img = new Image();
            img.src = dataUrl;
            await new Promise((resolve) => { img.onload = resolve; });

            await addLayer({
              url: dataUrl,
              base64,
              mimeType: mime,
              width: img.width,
              height: img.height,
              x: (layers.length + i) * 20,
              y: (layers.length + i) * 20,
              name: `生成图片 ${layers.length + i + 1}`,
            });

            // 添加延迟以确保 Fabric.js 有时间创建图层对象
            // 这样可以避免批量生成时图层无法交互的问题
            await new Promise(resolve => setTimeout(resolve, 100));
          }

          setMode('edit');
          setDrawMode('select'); // 自动切换到选择工具，方便用户立即拖动图层
          return; // 批量生成完成，直接返回
        }
      }

      const mime = String(resultDataUrl).split(';')[0].split(':')[1] || 'image/png';
      const base64 = String(resultDataUrl).split(',')[1];

      // 获取图片尺寸
      const img = new Image();
      img.src = resultDataUrl;
      await new Promise((resolve) => { img.onload = resolve; });

      if (mode === 'edit') {
        // 编辑模式：根据 keepOriginal 决定是替换还是新建图层
        if (keepOriginal) {
          // 保留原图：创建新图层
          const selectedLayer = layers.find(l => l.id === selectedLayerId);
          await addLayer({
            url: resultDataUrl,
            base64,
            mimeType: mime,
            width: img.width,
            height: img.height,
            x: selectedLayer ? selectedLayer.x + 20 : 0,
            y: selectedLayer ? selectedLayer.y + 20 : 0,
            name: selectedLayer ? `${selectedLayer.name} (编辑)` : '编辑结果',
          });
        } else {
          // 不保留原图：替换选中的图层
          setLayers(prev => prev.map(layer =>
            layer.id === selectedLayerId
              ? { ...layer, url: resultDataUrl, base64, mimeType: mime, width: img.width, height: img.height }
              : layer
          ));
        }

        // 清除画布上的遮罩绘制
        const canvas = canvasRef.current;
        if (canvas) {
          const objects = canvas.getObjects().filter(obj => !obj.layerId && !obj.isCanvasOverlay);
          objects.forEach(obj => canvas.remove(obj));
          canvas.requestRenderAll();
        }
      } else {
        // 生成模式：添加为新图层
        addLayer({
          url: resultDataUrl,
          base64,
          mimeType: mime,
          width: img.width,
          height: img.height,
          x: layers.length * 20,
          y: layers.length * 20,
          name: `生成图片 ${layers.length + 1}`,
        });

        setMode('edit');
        setDrawMode('select'); // 自动切换到选择工具，方便用户立即拖动图层
      }
    } catch (err) {
      console.error(mode === 'edit' ? '编辑失败:' : '生成失败:', err);
      alert(`${mode === 'edit' ? '编辑' : '生成'}失败: ${err.message}`);
    } finally {
      setIsGenerating(false);
    }
  };

  const buildMaskBase64 = (previewMode = false) => {
    const canvas = canvasRef.current;
    if (!canvas) throw new Error('画布未就绪');

    // 获取选中图层的原始尺寸
    const selectedLayer = layers.find(l => l.id === selectedLayerId);
    if (!selectedLayer) throw new Error('请先选择要编辑的图层');

    const imgWidth = selectedLayer.width;
    const imgHeight = selectedLayer.height;

    // 获取所有绘制对象（不包括图层与图像工具的叠加层）
    const objects = canvas.getObjects().filter(obj => !obj.layerId && !obj.isCanvasOverlay);
    if (objects.length === 0) throw new Error('请先绘制遮罩区域');

    // 获取选中图层的 Fabric 对象，用于计算相对坐标
    const layerObj = canvas.getObjects().find(obj => obj.layerId === selectedLayerId);
    if (!layerObj) throw new Error('未找到选中的图层对象');

    const layerLeft = layerObj.left;
    const layerTop = layerObj.top;

    // 创建一个新的离屏 canvas，尺寸与原图一致
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = imgWidth;
    maskCanvas.height = imgHeight;
    const ctx = maskCanvas.getContext('2d');

    // 填充黑色背景
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, imgWidth, imgHeight);

    const expandRatio = 0.01; // 1% 扩张

    // 绘制白色遮罩区域
    ctx.fillStyle = 'white';
    objects.forEach((obj) => {
      if (obj.type === 'rect') {
        const bounds = obj.getBoundingRect();

        // 转换为相对于图层的坐标
        const relativeX = bounds.left - layerLeft;
        const relativeY = bounds.top - layerTop;

        // 计算 1% 扩张
        const expansion = Math.max(bounds.width, bounds.height) * expandRatio;

        const x = Math.max(0, relativeX - expansion);
        const y = Math.max(0, relativeY - expansion);
        const w = Math.min(imgWidth - x, bounds.width + expansion * 2);
        const h = Math.min(imgHeight - y, bounds.height + expansion * 2);

        ctx.fillRect(x, y, w, h);
      } else if (obj.type === 'path') {
        // 对于路径，需要转换坐标并绘制
        const path = obj.path;
        if (!path) return;

        ctx.beginPath();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = obj.strokeWidth || 30;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        path.forEach((cmd, i) => {
          const type = cmd[0];
          if (type === 'M') {
            const x = cmd[1] - layerLeft;
            const y = cmd[2] - layerTop;
            ctx.moveTo(x, y);
          } else if (type === 'L') {
            const x = cmd[1] - layerLeft;
            const y = cmd[2] - layerTop;
            ctx.lineTo(x, y);
          } else if (type === 'Q') {
            const cpX = cmd[1] - layerLeft;
            const cpY = cmd[2] - layerTop;
            const endX = cmd[3] - layerLeft;
            const endY = cmd[4] - layerTop;
            ctx.quadraticCurveTo(cpX, cpY, endX, endY);
          }
        });
        ctx.stroke();
      }
    });

    const dataUrl = maskCanvas.toDataURL('image/png');
    const base64 = dataUrl.split(',')[1];

    // 如果是预览模式，将遮罩添加为新图层
    if (previewMode) {
      addLayer({
        url: dataUrl,
        base64,
        mimeType: 'image/png',
        width: imgWidth,
        height: imgHeight,
        x: 0,
        y: 0,
        name: '遮罩预览',
      });
    }

    return base64;
  };

  const handlePreviewMask = () => {
    try {
      buildMaskBase64(true); // 传入 true 启用预览模式
    } catch (err) {
      console.error('预览遮罩失败:', err);
      throw err;
    }
  };

  return (
    <Layout
      toolbar={
        <div className="flex flex-col gap-3 items-center">
          {/* Upload Button - macOS style with spring interaction */}
          <div className="relative group">
            <button
              className="w-12 h-12 rounded-[10px] flex items-center justify-center
                         bg-white/90 dark:bg-white/10
                         shadow-[0_0_0_0.5px_rgba(0,0,0,0.1),0_2px_8px_rgba(0,0,0,0.08)]
                         hover:shadow-[0_0_0_0.5px_rgba(0,0,0,0.15),0_4px_12px_rgba(0,0,0,0.12)]
                         active:scale-[0.96]
                         transition-all duration-200 ease-out
                         border border-black/[0.05] dark:border-white/10"
            >
              <Upload size={20} className="text-gray-700 dark:text-gray-300" strokeWidth={1.5} />
            </button>
            <input
              type="file"
              className="absolute inset-0 opacity-0 cursor-pointer"
              onChange={handleFileUpload}
              accept="image/*"
            />
          </div>
        </div>
      }
      layerPanel={
        <LayerPanel
          layers={layers}
          selectedLayerId={selectedLayerId}
          onSelectLayer={setSelectedLayerId}
          onDeleteLayer={deleteLayer}
          onToggleVisibility={toggleLayerVisibility}
          onToggleLock={toggleLayerLock}
          onMoveLayerUp={moveLayerUp}
          onMoveLayerDown={moveLayerDown}
          onDuplicateLayer={duplicateLayer}
          onRemoveBackground={handleRemoveBackground}
          onDownloadLayer={downloadLayer}
          isRemoving={isRemoving}
          removalProgress={removalProgress}
          maskExtractionMode={maskExtractionMode}
          setMaskExtractionMode={setMaskExtractionMode}
          mainLayerForMask={mainLayerForMask}
          setMainLayerForMask={setMainLayerForMask}
          maskLayerForExtraction={maskLayerForExtraction}
          setMaskLayerForExtraction={setMaskLayerForExtraction}
          onMaskExtraction={handleMaskExtraction}
          isSelectingReference={isSelectingReference}
          onAddReferenceImage={addReferenceImage}
        />
      }
      properties={
        <ControlPanel
          prompt={prompt}
          setPrompt={setPrompt}
          onGenerate={handleGenerate}
          isGenerating={isGenerating}
          apiKey={apiKey}
          setApiKey={setApiKey}
          baseUrl={baseUrl}
          setBaseUrl={setBaseUrl}
          modelName={modelName}
          setModelName={setModelName}
          mode={mode}
          setMode={setMode}
          sizeConfig={sizeConfig}
          setSizeConfig={setSizeConfig}
          sourceSize={sourceSize}
          generateCount={generateCount}
          setGenerateCount={setGenerateCount}
          regions={regions}
          regionInstructions={regionInstructions}
          setRegionInstruction={(id, text) =>
            setRegionInstructions((prev) => ({ ...prev, [id]: text }))
          }
          focusRegion={(id) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getObjects().find((o) => o.type === 'rect' && o.regionId === id);
            if (!rect) return;
            setDrawMode('select');
            setIsDrawing(false);
            canvas.setActiveObject(rect);
            canvas.requestRenderAll();
          }}
          onPreviewMask={handlePreviewMask}
          referenceImages={referenceImages}
          onAddReferenceImage={addReferenceImage}
          onDeleteReferenceImage={deleteReferenceImage}
          isSelectingReference={isSelectingReference}
          setIsSelectingReference={setIsSelectingReference}
          setDrawMode={setDrawMode}
          layers={layers}
          keepOriginal={keepOriginal}
          setKeepOriginal={setKeepOriginal}
        />
      }
    >
      <div
        className="flex-1 w-full h-full p-4"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        <CanvasEditor
          layers={layers}
          onLayersChange={(layerData) => {
            setLayers(prev => prev.map(layer => {
              const updated = layerData.find(d => d.id === layer.id);
              return updated ? { ...layer, ...updated } : layer;
            }));
          }}
          isDrawing={isDrawing}
          setIsDrawing={setIsDrawing}
          drawMode={drawMode}
          setDrawMode={setDrawMode}
          brushSize={brushSize}
          setBrushSize={setBrushSize}
          onRegionsChange={(next) => {
            setRegions(next);
            setRegionInstructions((prev) => {
              const keep = new Set(next.map((r) => r.id));
              const nextMap = {};
              Object.keys(prev).forEach((k) => {
                const id = Number(k);
                if (keep.has(id)) nextMap[id] = prev[id];
              });
              return nextMap;
            });
          }}
          onCanvasReady={(canvas) => {
            canvasRef.current = canvas;
          }}
          onRemoveBackground={handleRemoveBackground}
          selectedLayerId={selectedLayerId}
          onSelectLayer={setSelectedLayerId}
          onDeleteLayer={deleteLayer}
          onAddLayer={addLayer}
          isSelectingReference={isSelectingReference}
          onAddReferenceImage={addReferenceImage}
          onCropLayer={handleCropLayer}
          onStretchLayer={handleStretchLayer}
        />
      </div>
    </Layout>
  );
}

export default App;
