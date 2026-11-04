// Camera Mixer —— 可视化相机控制（方位 / 俯仰 / 距离 / 焦距 / 光圈）
//
// 分工：Python 是唯一的算法真源（__init__.py 的 camera_build）。这个文件只做两件事：
//   1. 画两张小图：左边俯视盘（拖它 = 方位 + 景别），右边侧视剖面（拖它 = 俯仰）；
//   2. 把控件值搬给 /camera_mixer/preview，把返回的文字贴到面板上。
// 所以图上高亮的档、面板上的读数、预览文字，全都来自同一个 camera_build()，
// 界面显示和真正排队时输出的那一行不可能对不上。
//
// 三个轴怎么拖：
//   紫点绕中心转 -> 方位（0°=正面，±90°=左右，180°=背面）
//   紫点离中心远近 -> 景别（6 档，拖的时候吸附）
//   青点沿弧上下 -> 俯仰（顶部=鸟瞰，底部=虫瞰）
//   在图上滚轮 -> 换镜头

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "CameraMixer";
const SCENE_H = 290;
const PANEL_H = 236;
const MIN_W = 400;
const THROTTLE = 100;

const C = {
  az: "#c792ea",
  dist: "#ffb800",
  el: "#00ffd0",
  ink: "#d8d8e2",
  dim: "#75758c",
  line: "#2e2e42",
  body: "#4c4c64",
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const round2 = (v) => Math.round(v * 100) / 100;

function wget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name);
}

function state(node) {
  if (!node.__cm) {
    node.__cm = { cfg: null, info: null, text: "", seq: 0, timer: 0, drag: null, geom: null, built: false };
  }
  return node.__cm;
}

// 机位与权重设置不再是控件：存在 properties 里，排队时注入 inputs。
// 图上拖拽 + 面板是唯一入口，面板顶部那行读数就是它们的数值。
const POS_KEYS = ["pos_azimuth", "pos_elevation", "pos_distance"];
const WEIGHT_KEYS = ["weight_mode", "weight_cap"];
const FOCAL_KEY = "focal_mm";
const HIDDEN_INPUTS = [...POS_KEYS, ...WEIGHT_KEYS, FOCAL_KEY];

const VALS_DEFAULTS = {
  pos_azimuth: 0,
  pos_elevation: 0,
  pos_distance: 0,
  focal_mm: 50,
  weight_mode: "保守 (≤1.4)",
  weight_cap: 1.4,
};

function readVals(node) {
  const raw = node.properties?.camera_vals;
  const o = raw && typeof raw === "object" ? raw : {};
  const out = { ...VALS_DEFAULTS };
  for (const k of HIDDEN_INPUTS) {
    const v = o[k];
    if (typeof v === "string" && v) out[k] = v;
    else if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function writeVals(node, patch, markDirty) {
  node.properties = node.properties || {};
  node.properties.camera_vals = { ...readVals(node), ...patch };
  if (markDirty) app.graph?.change?.(); // 拖拽中不每帧标脏，松手时再标
}

// ---------------------------------------------------------------- 控件值 / 配置
function values(node) {
  const g = (name, def) => {
    const w = wget(node, name);
    return w ? w.value : def;
  };
  const v = readVals(node);
  return {
    pos_azimuth: v.pos_azimuth,
    pos_elevation: v.pos_elevation,
    pos_distance: v.pos_distance,
    focal_mm: v.focal_mm,
    f_stop: String(g("f_stop", "f/8")),
    lens_on: !!g("lens_on", true),
    dutch_enabled: !!g("dutch_enabled", false),
    roll: Number(g("roll", 0)),
    weight_mode: v.weight_mode,
    weight_cap: v.weight_cap,
  };
}

// 配置存在 properties 里（跟 Prompt Toggle 的 mask 同一套做法），排队时注入 _cfg
function readCfgJson(node) {
  const raw = node.properties?.camera_cfg;
  return typeof raw === "string" ? raw : "";
}

function writeCfgJson(node, json) {
  node.properties = node.properties || {};
  node.properties.camera_cfg = json;
  app.graph?.change?.(); // 标脏，关窗口会提示保存
}

function persistCfg(node) {
  const st = state(node);
  if (!st.cfg) return;
  writeCfgJson(node, JSON.stringify(st.cfg));
  refreshNow(node);
}

function dig(obj, path) {
  return path.reduce((o, k) => (o == null ? o : o[k]), obj);
}

function previewUrl(node) {
  const v = values(node);
  const q = Object.keys(v)
    .map((k) => `${k}=${encodeURIComponent(v[k])}`)
    .join("&");
  return `/camera_mixer/preview?${q}&_cfg=${encodeURIComponent(readCfgJson(node))}`;
}

// ---------------------------------------------------------------- 向后端要预览
async function refreshNow(node) {
  const st = state(node);
  const seq = ++st.seq;
  try {
    const res = await api.fetchApi(previewUrl(node));
    const data = await res.json();
    if (seq !== st.seq) return; // 又改了，这次结果作废
    st.info = data.info || null;
    st.text = data.text || "";
    st.weightModes = data.weight_modes || st.weightModes;
    st.lenses = data.lenses || st.lenses;
    st.fStops = data.f_stops || st.fStops;
    if (data.cfg) st.cfg = data.cfg;
    if (!st.built && st.cfg) buildSections(node);
    updatePanelText(node);
    draw(node);
  } catch (e) {
    console.warn("[CameraMixer] 预览失败：", e);
  }
}

// 拖拽时不必每像素都问一次后端
function schedule(node) {
  const st = state(node);
  clearTimeout(st.timer);
  st.timer = setTimeout(() => refreshNow(node), THROTTLE);
}

function updatePanelText(node) {
  const st = state(node);
  if (st.readoutEl) st.readoutEl.textContent = st.info?.readout || "";
  if (st.previewEl) {
    st.previewEl.textContent = st.text || "（当前设置不输出任何词）";
    st.previewEl.style.opacity = st.text ? "0.95" : "0.45";
  }
}

// ---------------------------------------------------------------- 布局
function bandCenters(gears) {
  const edges = [1, ...gears, -1];
  const out = [];
  for (let i = 0; i + 1 < edges.length; i++) out.push((edges[i] + edges[i + 1]) / 2);
  return out;
}

// ============================================================
// 画图（v2：两幅都画成「人 + 相机 + 视线」，不再用抽象锥形）
// ============================================================
function layout(cssW, cssH, info) {
  const pad = 12;
  const gap = 14;
  const top = 6;
  const titleH = 16;
  const bodyTop = top + titleH;
  const bodyBottom = cssH - pad;
  // 关键：两幅图共用同一条水平中线（cy）和同一套尺度，
  // 否则一幅高、一幅低、一大一小，看着就是“歪”的。
  const cy = (bodyTop + bodyBottom) / 2;
  const half = (bodyBottom - bodyTop) / 2;

  const leftW = Math.max(150, Math.round((cssW - pad * 2 - gap) * 0.56));
  const left = { x: pad, y: top, w: leftW, h: cssH - top - pad, titleH };
  const right = {
    x: pad + leftW + gap,
    y: top,
    w: Math.max(90, cssW - pad * 2 - gap - leftW),
    h: cssH - top - pad,
    titleH,
  };

  const R = Math.max(34, Math.min(left.w / 2 - 18, half - 8));
  // 俯仰弧只比方位圈大一点点：这样"上/下"两个字的纵向位置正好跟"背面/正面"对齐
  const R2 = R + 3;
  // 主体统一画成圆点：两幅同尺寸
  const rs = Math.max(7, R * 0.17);

  const subjX = right.x + Math.max(28, right.w * 0.26);

  return {
    left, right, cy, half,
    dcx: left.x + left.w / 2, dcy: cy, R, rMin: R * 0.42, rMax: R, rs,
    subjX, R2,
    gears: info?.distance_gears || [0.7, 0.2, 0, -0.35, -0.7],
    pole: info?.pole ?? 0.85,
    eyeBand: info?.eye_band ?? 0.25,
  };
}

const radial = (lay, dist) => lay.rMin + ((1 - dist) / 2) * (lay.rMax - lay.rMin);

// ---------------------------------------------------------------- 画图
function draw(node) {
  const st = state(node);
  const cv = st.canvas;
  if (!cv) return;

  const cssW = Math.max(220, Math.round(cv.clientWidth || (node.size?.[0] ?? 380) - 24));
  // 高度：用 DOM 控件实际分到的高度（外层 .dom-widget）。ComfyUI 给的高度比
  // computeSize 申请的小几十像素，硬按常量画就会被裁掉一截。
  const holder = st.sceneWrap?.parentElement;
  const cssH = Math.max(
    170,
    Math.round((holder && holder.clientHeight) || st.sceneWrap?.clientHeight || SCENE_H)
  );

  // 画布被 graph zoom 用 CSS 放大/缩小时，位图分辨率要跟着走，否则放大就糊。
  const rect = cv.getBoundingClientRect();
  const viewScale = cv.clientWidth ? Math.max(0.5, rect.width / cv.clientWidth) : 1;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const bw = Math.round(cssW * viewScale * dpr);
  const bh = Math.round(cssH * viewScale * dpr);
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
  }
  if (cv.style.height !== `${cssH}px`) cv.style.height = `${cssH}px`;
  st.viewScale = viewScale;

  const g = cv.getContext("2d");
  g.setTransform(viewScale * dpr, 0, 0, viewScale * dpr, 0, 0);
  g.clearRect(0, 0, cssW, cssH);

  const v = values(node);
  const info = st.info || {};
  const lay = layout(cssW, cssH, info);
  st.geom = lay;

  drawDisc(g, lay, v, info);
  drawProfile(g, lay, v, info);
}

// 小相机图标：+x 方向是镜头朝向
function drawCamera(g, x, y, aim, color) {
  g.save();
  g.translate(x, y);
  g.rotate(aim);
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineWidth = 1.4;
  g.beginPath();
  if (g.roundRect) g.roundRect(-14, -7, 14, 14, 3);
  else g.rect(-14, -7, 14, 14);
  g.fill();
  g.beginPath();
  g.arc(-2, 0, 4.2, 0, Math.PI * 2);
  g.fillStyle = "rgba(0,0,0,.6)";
  g.fill();
  g.stroke();
  g.restore();
}

// 视线：两条虚线 + 很淡的扇形，长度 = 到主体的距离
function drawViewCone(g, x, y, aim, len, half, color) {
  g.save();
  g.globalAlpha = 0.38;
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.setLineDash([3, 3]);
  for (const s of [-1, 1]) {
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + Math.cos(aim + s * half) * len, y + Math.sin(aim + s * half) * len);
    g.stroke();
  }
  g.setLineDash([]);
  g.globalAlpha = 0.07;
  g.fillStyle = color;
  g.beginPath();
  g.moveTo(x, y);
  g.arc(x, y, len, aim - half, aim + half);
  g.closePath();
  g.fill();
  g.restore();
}

const DIST_KEYS = ["ecu", "cu", "medium", "cowboy", "full", "wide"];

function drawDisc(g, lay, v, info) {
  const { dcx, dcy, R, left } = lay;

  g.fillStyle = "rgba(255,184,0,.8)";
  g.font = "11px system-ui,Segoe UI,sans-serif";
  g.textAlign = "left";
  g.textBaseline = "top";
  g.fillText("俯视 · 方位 + 距离", left.x, left.y);

  // 六档距离圈，当前那档高亮
  bandCenters(lay.gears).forEach((c, i) => {
    const on = DIST_KEYS[i] === info.distance_key;
    g.beginPath();
    g.arc(dcx, dcy, radial(lay, c), 0, Math.PI * 2);
    g.strokeStyle = on ? "rgba(255,184,0,.5)" : "rgba(255,184,0,.12)";
    g.lineWidth = on ? 1.6 : 1;
    g.stroke();
  });

  // 先算相机位置（视线要画在人下面，不能把人盖住）
  const theta = ((90 - v.pos_azimuth * 180) * Math.PI) / 180;
  const r = radial(lay, v.pos_distance);
  const px = dcx + r * Math.cos(theta);
  const py = dcy + r * Math.sin(theta);
  lay.cam = { x: px, y: py };

  const aim = Math.atan2(dcy - py, dcx - px);
  const dist = Math.hypot(dcx - px, dcy - py);
  const half = Math.atan(18 / Math.max(1, info.focal_mm || 50));
  drawViewCone(g, px, py, aim, dist * 0.82, half, C.az);

  // 主体：一个圆点（两幅一致，不做火柴人）
  g.beginPath();
  g.arc(dcx, dcy, lay.rs, 0, Math.PI * 2);
  g.fillStyle = "rgba(215,215,230,.95)";
  g.fill();

  // 四方位（圈外）
  g.fillStyle = "rgba(205,205,220,.55)";
  g.font = "10px system-ui,Segoe UI,sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("正面", dcx, dcy + R + 13);
  g.fillText("背面", dcx, dcy - R - 13);
  g.fillText("左", dcx - R - 13, dcy);
  g.fillText("右", dcx + R + 13, dcy);

  drawCamera(g, px, py, aim, C.az);
}

function drawProfile(g, lay, v, info) {
  const { right, subjX, cy, R2, rs } = lay;

  g.fillStyle = "rgba(0,255,208,.75)";
  g.font = "11px system-ui,Segoe UI,sans-serif";
  g.textAlign = "left";
  g.textBaseline = "top";
  g.fillText("侧视 · 俯仰", right.x, right.y);

  // 主体：和左边同一个圆点，画在共用中线上；不画地面、不画人
  g.beginPath();
  g.arc(subjX, cy, rs, 0, Math.PI * 2);
  g.fillStyle = "rgba(215,215,230,.95)";
  g.fill();

  // 俯仰弧：圆心 = 主体，半径只比左图方位圈大 3px
  g.beginPath();
  g.arc(subjX, cy, R2, -Math.PI / 2, Math.PI / 2);
  g.strokeStyle = "rgba(0,255,208,.30)";
  g.lineWidth = 1.5;
  g.stroke();

  const band = lay.eyeBand ?? 0.25;
  for (const m of [1, lay.pole, band, 0, -band, -lay.pole, -1]) {
    const a = (-m * Math.PI) / 2;
    const inner = Math.abs(m) >= lay.pole - 1e-6 || m === 0 ? 7 : 4;
    g.beginPath();
    g.moveTo(subjX + R2 * Math.cos(a), cy + R2 * Math.sin(a));
    g.lineTo(subjX + (R2 - inner) * Math.cos(a), cy + (R2 - inner) * Math.sin(a));
    g.strokeStyle = Math.abs(m) >= lay.pole - 1e-6 ? "rgba(0,255,208,.5)" : "rgba(0,255,208,.18)";
    g.stroke();
  }

  // 相机
  const a = (-v.pos_elevation * Math.PI) / 2;
  const px = subjX + R2 * Math.cos(a);
  const py = cy + R2 * Math.sin(a);
  lay.el = { x: px, y: py };

  const aim = Math.atan2(cy - py, subjX - px);
  const half = Math.atan(12 / Math.max(1, info.focal_mm || 50));
  drawViewCone(g, px, py, aim, Math.hypot(subjX - px, cy - py), half, C.el);
  drawCamera(g, px, py, aim, C.el);

  // 上/下：纵向跟左图的「背面/正面」同一条线（cy ∓ (R+13)，R2 = R+3）
  // 横放在弧线端点左侧，避免和相机点打架
  g.fillStyle = "rgba(205,205,220,.55)";
  g.font = "10px system-ui,Segoe UI,sans-serif";
  g.textAlign = "right";
  g.textBaseline = "middle";
  g.fillText("上", subjX - rs - 8, cy - R2 - 10);
  g.fillText("下", subjX - rs - 8, cy + R2 + 10);
}

// ---------------------------------------------------------------- 拖拽
function localXY(cv, ev) {
  const rect = cv.getBoundingClientRect();
  const sx = rect.width ? cv.clientWidth / rect.width : 1;
  const sy = rect.height ? cv.clientHeight / rect.height : 1;
  return { x: (ev.clientX - rect.left) * sx, y: (ev.clientY - rect.top) * sy };
}

function hit(lay, x, y) {
  if (!lay) return null;
  const near = (p) => p && Math.hypot(p.x - x, p.y - y) < 16;
  if (near(lay.cam)) return "orbit";
  if (near(lay.el)) return "elevation";
  return null;
}

function setVal(node, name, value) {
  // 直接写值，不触发 callback —— 避免「拖一次回调一次」的循环
  if (POS_KEYS.includes(name)) {
    writeVals(node, { [name]: value }, false);
    return;
  }
  const w = wget(node, name);
  if (!w) return;
  w.value = value;
}

function setLensStep(node, dir) {
  const st = state(node);
  const list = st.lenses || ["14mm", "24mm", "35mm", "50mm", "85mm", "135mm", "200mm"];
  const now = readVals(node).focal_mm;
  const at = Math.max(0, list.findIndex((x) => parseFloat(x) >= now - 0.5));
  const next = Math.max(0, Math.min(list.length - 1, at + dir)); // 到头就停，不循环
  const mm = parseFloat(list[next]);
  if (!Number.isFinite(mm) || mm === now) return false;
  writeVals(node, { focal_mm: mm }, true);
  if (st.focalSel) st.focalSel.value = String(mm);
  return true;
}

function installCanvas(node) {
  const st = state(node);
  const cv = st.canvas;

  cv.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return; // 只认左键：中键/右键留给 ComfyUI 自己用
    const p = localXY(cv, ev);
    const mode = hit(state(node).geom, p.x, p.y);
    if (!mode) return;
    ev.preventDefault();
    ev.stopPropagation();
    state(node).drag = mode;
    try { cv.setPointerCapture?.(ev.pointerId); } catch { /* 合成事件没有真实指针，忽略 */ }
  });

  cv.addEventListener("pointermove", (ev) => {
    const st2 = state(node);
    if (!st2.drag) return;
    ev.preventDefault();
    const lay = st2.geom;
    if (!lay) return;
    const p = localXY(cv, ev);

    if (st2.drag === "orbit") {
      const dx = p.x - lay.dcx;
      const dy = p.y - lay.dcy;
      // 画布角 theta = 90 - 方位*180（90°=正面在下方），atan2 的 ±180 断点要掰到 [-90,270)
      let th = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (th < -90) th += 360;
      const az = Math.max(-1, Math.min(1, (90 - th) / 180));
      setVal(node, "pos_azimuth", round2(az));
      const rr = Math.hypot(dx, dy);
      const raw = 1 - 2 * clamp01((rr - lay.rMin) / (lay.rMax - lay.rMin));
      const centers = bandCenters(lay.gears);
      const snapped = centers.reduce((best, c) => (Math.abs(c - raw) < Math.abs(best - raw) ? c : best), centers[0]);
      setVal(node, "pos_distance", snapped);
    } else {
      const dx = p.x - lay.subjX;
      const dy = p.y - lay.cy;
      const el = Math.max(-1, Math.min(1, -((Math.atan2(dy, dx) * 180) / Math.PI) / 90));
      setVal(node, "pos_elevation", round2(el));
    }

    draw(node);
    schedule(node);
  });

  const endDrag = (ev) => {
    const st2 = state(node);
    if (!st2.drag) return;
    st2.drag = null;
    try { cv.releasePointerCapture?.(ev.pointerId); } catch { /* 同上 */ }
    app.graph?.change?.(); // 松手时一次性标脏
    refreshNow(node);
  };
  cv.addEventListener("pointerup", endDrag);
  cv.addEventListener("pointercancel", endDrag);

  cv.addEventListener(
    "wheel",
    (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      if (!setLensStep(node, ev.deltaY > 0 ? 1 : -1)) return; // 到头不动，也不再请求
      draw(node);
      refreshNow(node);
    },
    { passive: false }
  );
}

// ---------------------------------------------------------------- 面板
function injectStyles() {
  if (document.getElementById("cm-style")) return;
  const css = document.createElement("style");
  css.id = "cm-style";
  css.textContent = `
    .cm-panel{display:flex;flex-direction:column;gap:5px;height:100%;box-sizing:border-box;
      padding:5px 7px;border-radius:8px;background:rgba(0,0,0,.20);font-size:11px;
      color:var(--fg,#ddd);overflow:hidden}
    .cm-readout{flex:0 0 auto;font-size:11px;opacity:.85;font-variant-numeric:tabular-nums}
    /* 固定高度 + 滚动：文字多少都不改面板高度，节点就不会跟着上下跳 */
    .cm-preview{flex:0 0 auto;height:56px;box-sizing:border-box;
      font-family:ui-monospace,Consolas,monospace;font-size:11px;
      line-height:1.45;padding:4px 6px;border-radius:6px;background:rgba(255,255,255,.05);
      overflow-y:auto;overflow-x:hidden;word-break:break-all;cursor:text;user-select:text}
    .cm-body{flex:0 0 auto;display:flex;flex-direction:column;gap:3px;overflow:hidden}
    .cm-sec{background:rgba(255,255,255,.035);border-radius:6px;overflow:hidden;flex:0 0 auto}
    .cm-head{width:100%;display:flex;align-items:center;gap:4px;text-align:left;
      background:none;border:0;color:inherit;font:inherit;font-size:11px;line-height:16px;
      padding:3px 6px;cursor:pointer;opacity:.9}
    .cm-head:hover{background:rgba(255,255,255,.07)}
    .cm-head::before{content:"▸";font-size:9px;opacity:.65;width:9px}
    .cm-sec.open > .cm-head::before{content:"▾"}
    .cm-grid{display:none;flex-direction:column;gap:3px;padding:1px 6px 6px}
    .cm-sec.open > .cm-grid{display:flex}
    .cm-grid .cm-sec{background:rgba(255,255,255,.03);margin-left:2px}
    .cm-row{display:flex;align-items:center;gap:5px}
    .cm-row>span{flex:0 0 44px;opacity:.68;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .cm-sw{flex:0 0 auto;width:28px;height:16px;border-radius:4px;cursor:pointer;font-size:10px;
      line-height:14px;padding:0;border:1px solid rgba(248,81,73,.55);
      background:rgba(248,81,73,.15);color:#fca5a5}
    .cm-sw.on{border-color:rgba(74,222,128,.75);background:rgba(46,160,67,.22);color:#86efac}
    .cm-inp{flex:1 1 auto;min-width:0;font-size:11px;padding:1px 5px;border-radius:4px;
      border:1px solid var(--border,#444);background:rgba(0,0,0,.30);color:inherit}
    .cm-num{flex:0 0 auto;min-width:48px;font-size:11px;padding:1px 4px;border-radius:4px;
      border:1px solid var(--border,#444);background:rgba(0,0,0,.30);color:inherit}
    .cm-cap{width:46px}
    .cm-sel{flex:1 1 auto;min-width:0;font-size:11px;padding:1px 4px;border-radius:4px;
      border:1px solid var(--border,#444);background:rgba(0,0,0,.30);color:inherit}
    .cm-note{font-size:10px;line-height:1.5;opacity:.62;padding:1px 0 3px}
  `;
  document.head.appendChild(css);
}

function row(label) {
  const el = document.createElement("div");
  el.className = "cm-row";
  const s = document.createElement("span");
  s.textContent = label;
  s.title = label;
  el.appendChild(s);
  return el;
}

function switchEl(onState) {
  const b = document.createElement("button");
  b.className = `cm-sw${onState ? " on" : ""}`;
  b.textContent = onState ? "开" : "关";
  b.type = "button";
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    b.__toggle?.();
  });
  return b;
}

// 一行标签：开关 + 文案输入 + 该词自己的权重上限（留空跟随全局）
function tagRow(node, path, label) {
  const st = state(node);
  const item = dig(st.cfg, path) || {};
  const el = row(label);

  const sw = switchEl(item.enabled !== false);
  sw.__toggle = () => {
    const cur = dig(st.cfg, path);
    cur.enabled = cur.enabled === false;
    sw.classList.toggle("on", cur.enabled !== false);
    sw.textContent = cur.enabled !== false ? "开" : "关";
    persistCfg(node);
  };

  const inp = document.createElement("input");
  inp.className = "cm-inp";
  inp.type = "text";
  inp.value = item.tag ?? "";
  inp.placeholder = "（空 = 不出词）";
  inp.addEventListener("change", () => {
    dig(st.cfg, path).tag = inp.value;
    persistCfg(node);
  });
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());

  const cap = document.createElement("input");
  cap.className = "cm-num cm-cap";
  cap.type = "number";
  cap.min = 1;
  cap.max = 10;
  cap.step = 0.05;
  cap.value = item.cap == null || item.cap === "" ? "" : String(item.cap);
  cap.placeholder = "全局";
  cap.title = "该词的权重上限：留空跟随全局；填了也只能比全局更低（全局是天花板）";
  cap.addEventListener("change", () => {
    const holder = dig(st.cfg, path);
    const raw = cap.value.trim();
    if (!raw) {
      delete holder.cap;
      cap.value = "";
    } else {
      const v = Math.max(1, Math.min(10, Number(raw) || 1));
      holder.cap = Math.round(v * 100) / 100;
      cap.value = String(holder.cap);
    }
    persistCfg(node);
  });
  cap.addEventListener("pointerdown", (e) => e.stopPropagation());

  el.append(sw, inp, cap);
  return el;
}

function plainSwitch(node, path, label, onChange) {
  const st = state(node);
  const el = row(label);
  const on = dig(st.cfg, path) !== false;
  const sw = switchEl(on);
  sw.__toggle = () => {
    const next = dig(st.cfg, path) === false;
    const holder = path.slice(0, -1).reduce((o, k) => o[k], st.cfg);
    holder[path[path.length - 1]] = next;
    sw.classList.toggle("on", next);
    sw.textContent = next ? "开" : "关";
    onChange?.(next);
    persistCfg(node);
  };
  el.append(sw);
  return el;
}

function numberRow(node, path, label, min, max, step) {
  const st = state(node);
  const el = row(label);
  const inp = document.createElement("input");
  inp.className = "cm-num";
  inp.type = "number";
  inp.min = min;
  inp.max = max;
  inp.step = step;
  inp.value = String(dig(st.cfg, path));
  inp.addEventListener("change", () => {
    const v = Math.max(min, Math.min(max, Number(inp.value) || min));
    inp.value = String(v);
    const holder = path.slice(0, -1).reduce((o, k) => o[k], st.cfg);
    holder[path[path.length - 1]] = v;
    persistCfg(node);
  });
  inp.addEventListener("pointerdown", (e) => e.stopPropagation());
  el.append(inp);
  return el;
}

// 折叠区：自己控按钮 + class，不依赖 <details> 的原生行为
// （DOM 控件里原生 details 的展开/收起被上层事件吃掉过，点着没反应）
function section(node, title) {
  const wrap = document.createElement("div");
  wrap.className = "cm-sec";

  const head = document.createElement("button");
  head.type = "button";
  head.className = "cm-head";
  head.textContent = title;

  const grid = document.createElement("div");
  grid.className = "cm-grid";

  head.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    wrap.classList.toggle("open");
    syncPanelHeight(node, { shrink: true });
  });

  wrap.append(head, grid);
  return { wrap, grid };
}

function buildSections(node) {
  const st = state(node);
  if (st.built || !st.body || !st.cfg) return;
  st.built = true;
  st.body.replaceChildren();

  // 标签文案：五个轴共同套在一个父折叠里（折中折）
  const tagsSec = section(node, "标签文案：方位 / 高度 / 景别 / 透视 / 景深");

  // 方位
  const az = section(node, "方位（4 向）");
  [["front", "正面"], ["right", "右侧"], ["back", "背面"], ["left", "左侧"]].forEach(([k, label]) => {
    az.grid.appendChild(tagRow(node, ["tags", "azimuth", "directions", k], label));
  });
  tagsSec.grid.appendChild(az.wrap);

  // 高度
  const el = section(node, "高度（5 档）");
  [["bird", "鸟瞰"], ["high", "俯视"], ["eye", "平视"], ["low", "仰视"], ["worm", "虫瞰"]].forEach(([k, label]) => {
    el.grid.appendChild(tagRow(node, ["tags", "elevation", "tiers", k], label));
  });
  tagsSec.grid.appendChild(el.wrap);

  // 景别
  const di = section(node, "景别（6 档）");
  [["ecu", "特写"], ["cu", "近景"], ["medium", "中景"], ["cowboy", "牛仔"], ["full", "全身"], ["wide", "远景"]]
    .forEach(([k, label]) => {
      di.grid.appendChild(tagRow(node, ["tags", "distance", "tiers", k], label));
    });
  tagsSec.grid.appendChild(di.wrap);

  // 透视：焦距选什么 + 各档文案（开关在节点控件 lens_on 上）
  const fov = section(node, "透视（按焦距）");
  const rowFocal = row("焦距");
  const focalSel = document.createElement("select");
  focalSel.className = "cm-sel";
  const lensList = st.lenses || ["14mm", "24mm", "35mm", "50mm", "85mm", "135mm", "200mm"];
  for (const l of lensList) {
    const mm = parseFloat(l);
    if (!Number.isFinite(mm)) continue;
    const o = document.createElement("option");
    o.value = String(mm);
    o.textContent = l;
    focalSel.appendChild(o);
  }
  focalSel.value = String(readVals(node).focal_mm);
  if (!focalSel.value || focalSel.selectedIndex < 0) focalSel.selectedIndex = 0;
  focalSel.title = "焦距：只决定出哪个透视词，以及图上扇形的张角；要不要出词看节点上的开关";
  focalSel.addEventListener("pointerdown", (e) => e.stopPropagation());
  focalSel.addEventListener("change", () => {
    writeVals(node, { focal_mm: parseFloat(focalSel.value) || 50 }, true);
    refreshNow(node);
  });
  st.focalSel = focalSel;
  rowFocal.appendChild(focalSel);
  fov.grid.appendChild(rowFocal);
  fov.grid.appendChild(plainSwitch(node, ["out_focal"], "输出焦距值"));

  [["fisheye", "≤20mm"], ["wide", "≤35mm"], ["normal", "≤70mm"], ["tele", ">70mm"]].forEach(([k, label]) => {
    fov.grid.appendChild(tagRow(node, ["tags", "fov", "bands", k], label));
  });
  tagsSec.grid.appendChild(fov.wrap);

  // 景深：光圈档位在节点主体上那个下拉里选，这里只留「要不要输出原始光圈值」和各档文案
  const dof = section(node, "景深（按光圈）");
  dof.grid.appendChild(plainSwitch(node, ["out_fstop"], "输出光圈值"));

  [["shallow", "≤f/2"], ["mild", "≤f/4"], ["neutral", "≤f/8"], ["deep", ">f/8"]].forEach(([k, label]) => {
    dof.grid.appendChild(tagRow(node, ["tags", "dof", "bands", k], label));
  });
  tagsSec.grid.appendChild(dof.wrap);

  // 轴开关与行为
  const beh = section(node, "轴开关 / 行为");
  beh.grid.append(
    plainSwitch(node, ["tags", "azimuth", "enabled"], "方位轴"),
    plainSwitch(node, ["tags", "elevation", "enabled"], "高度轴"),
    plainSwitch(node, ["tags", "distance", "enabled"], "景别轴"),
    plainSwitch(node, ["tags", "fov", "enabled"], "透视轴"),
    plainSwitch(node, ["tags", "dof", "enabled"], "景深轴"),
    plainSwitch(node, ["tags", "tilt", "enabled"], "倾斜轴"),
    plainSwitch(node, ["azimuth_in_pole"], "极区留方位"),
    numberRow(node, ["pole"], "极区阈值", 0.3, 1.0, 0.05),
    numberRow(node, ["weight_strength"], "总强度", 0.0, 1.0, 0.05)
  );
  const note = document.createElement("div");
  note.className = "cm-note";
  note.textContent = "极区阈值：|俯仰| 超过这个数时方位词自动静默（鸟瞰谈「正面」没意义）。"
    + "「极区留方位」打开则强行保留。总强度：全体系数，1.0 = 用满上限。";
  beh.grid.appendChild(note);

  const weight = buildWeightSection(node);
  st.body.append(weight.wrap, tagsSec.wrap, beh.wrap);
  st.sections = [weight, tagsSec, az, el, di, fov, dof, beh];
  st.topSections = [weight, tagsSec, beh]; // 量高度只量顶层，子项已经算在父项里
  syncPanelHeight(node, { shrink: true });
}

// 权重区：模式 / 全局上限 / 每词上限的说明。
// 全局上限是天花板，每个词右侧的小格子只能在它之下再压。
const WM_NOTES = {
  "保守 (≤1.4)":
    "权重在 Anima 上不是「编码器能吃多少」的硬限制，而是一个逐 token 的乘法因子："
    + "太大不会崩，只会让那个词独占注意力。1.4 是社区经验值里的保守上限，默认用它。",
  "自定义上限":
    "自己定天花板，1.0–10。参考仓库用的就是 10 这一档（配合它那套 10 倍权重）；"
    + "调高后相机词会更强势，但容易把画面压成那几个词。",
  "关闭权重 (裸词)":
    "只输出裸词，不加括号。权重对 Anima 走的是 T5 分支的乘法，关掉后相机词最温和，"
    + "提示词一长容易被内容词盖掉。",
};

function buildWeightSection(node) {
  const st = state(node);
  const sec = section(node, "权重");
  const vals = readVals(node);

  const rowMode = row("模式");
  const sel = document.createElement("select");
  sel.className = "cm-sel";
  for (const m of st.weightModes || [vals.weight_mode]) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = m;
    sel.appendChild(o);
  }
  sel.value = vals.weight_mode;
  sel.addEventListener("pointerdown", (e) => e.stopPropagation());
  sel.addEventListener("change", () => {
    writeVals(node, { weight_mode: sel.value }, true);
    refreshState();
    refreshNow(node);
  });
  rowMode.appendChild(sel);

  const rowCap = row("上限");
  const capInp = document.createElement("input");
  capInp.className = "cm-num cm-cap";
  capInp.type = "number";
  capInp.min = 1;
  capInp.max = 10;
  capInp.step = 0.05;
  capInp.value = String(vals.weight_cap);
  capInp.title = "全局权重天花板；只在「自定义上限」模式生效（1.0–10）";
  capInp.addEventListener("pointerdown", (e) => e.stopPropagation());
  capInp.addEventListener("change", () => {
    const v = Math.max(1, Math.min(10, Number(capInp.value) || 1));
    capInp.value = String(v);
    writeVals(node, { weight_cap: v }, true);
    refreshNow(node);
  });
  rowCap.appendChild(capInp);

  const note = document.createElement("div");
  note.className = "cm-note";

  function refreshState() {
    const v = readVals(node);
    const custom = v.weight_mode === "自定义上限";
    capInp.disabled = !custom;
    capInp.style.opacity = custom ? "1" : ".45";
    note.textContent = (WM_NOTES[v.weight_mode] || "")
      + " 下面每个标签右侧的小格子是「该词上限」：留空 = 跟随全局，填了也只能比全局更低。";
  }
  refreshState();

  sec.grid.append(rowMode, rowCap, note);
  return sec;
}

// 面板高度 = 内容实际高度：收起来就变矮，展开就长高（节点跟着缩/放）
function measurePanel(node) {
  const st = state(node);
  let h = (st.readoutEl?.offsetHeight || 0) + 5 + (st.previewEl?.offsetHeight || 0);
  for (const s of st.topSections || []) h += 3 + s.wrap.offsetHeight;
  return Math.round(h + 10); // 面板自身上下 padding
}

let heightBusy = false;

// 面板高度 = 内容实际高度，直接写死到外层容器上。
// 高度不封顶：内容多高就多高（封顶会被裁，手工拖大也救不回来）
// （容器高度是固定的，拖大只多出空白）。现在：
//   · 内容多高就多高，不封顶；
//   · 装不下时自动把节点撑大；只有主动折叠/展开才缩小；
//   · 200ms 巡检会把被框架改回去的高度再纠回来（同 Prompt Toggle 的做法）。
function syncPanelHeight(node, opts = {}) {
  const st = state(node);
  if (heightBusy || !st.panel || !st.domWidget) return;
  heightBusy = true;
  try {
    const need = measurePanel(node);
    st.panelH = need;
    // computeSize 只是给节点算最小高度用；多给 16px 抵消框架内边距
    st.domWidget.computeSize = (width) => [width ?? MIN_W, need + 16];

    const wrap = st.panel.parentElement;
    if (wrap && wrap !== document.body && wrap.style.height !== `${need}px`) {
      wrap.style.height = `${need}px`;
    }

    const want = Math.round((st.domWidget.last_y || 0) + need + 20);
    const cur = Math.round(node.size?.[1] || 0);
    const next = opts.shrink ? want : Math.max(cur, want);
    if (cur && next !== cur) node.setSize([node.size[0], next]);
  } finally {
    heightBusy = false;
  }
}

function installPanel(node) {
  const st = state(node);
  const p = document.createElement("div");
  p.className = "cm-panel";
  p.addEventListener("pointerdown", (e) => e.stopPropagation());

  const readout = document.createElement("div");
  readout.className = "cm-readout";
  readout.textContent = "…";

  const preview = document.createElement("div");
  preview.className = "cm-preview";
  preview.textContent = "（正在算…）";
  preview.title = "这里就是排队时会输出的那一行";

  const body = document.createElement("div");
  body.className = "cm-body";

  p.append(readout, preview, body);
  st.panel = p;
  st.readoutEl = readout;
  st.previewEl = preview;
  st.body = body;

  const dw = node.addDOMWidget("camera_panel", "camera_panel", p, { serialize: false });
  // 这个前端按 widget.serialize 判断是否写进 widgets_values（不是 options.serialize），
  // 只给 options 的话存档里会多出一格空字符串，把后面的控件位置挤歪。
  dw.serialize = false;
  st.domWidget = dw;
  // 高度随折叠内容变：先给个常量，buildSections 之后由 syncPanelHeight 接管
  dw.computeSize = (width) => [width ?? MIN_W, PANEL_H];
  requestAnimationFrame(() => syncPanelHeight(node));
  setTimeout(() => syncPanelHeight(node), 300);
  return p;
}

function installScene(node) {
  const st = state(node);
  const wrap = document.createElement("div");
  wrap.style.cssText =
    "width:100%;box-sizing:border-box;border-radius:8px;overflow:hidden;"
    + "background:rgba(0,0,0,.28);";

  // 注意：这里千万不能写 height:100% —— 容器高度是按内容算的，
  // 子元素再写 100% 就成循环引用，整块塌成 0×0（面板也会被一起压扁）。
  // 高度一律用像素，并在 draw() 里按 DOM 控件实际分到的高度反算。
  const cv = document.createElement("canvas");
  cv.style.cssText = "display:block;width:100%;cursor:crosshair;touch-action:none;";
  wrap.appendChild(cv);

  const dw = node.addDOMWidget("camera_scene", "camera_scene", wrap, { serialize: false });
  dw.serialize = false; // 同上：不进 widgets_values
  dw.computeSize = (width) => [width ?? MIN_W, SCENE_H];

  st.sceneWrap = wrap;
  st.canvas = cv;

  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => draw(node));
    ro.observe(wrap);
    st.ro = ro;
  }
  installCanvas(node);
}

// 画布缩放变了要重画（transform 不触发 ResizeObserver）
let zoomTimer = null;

function ensureZoomWatch() {
  if (zoomTimer) return;
  zoomTimer = setInterval(() => {
    for (const node of app.graph?._nodes || []) {
      const st = node?.__cm;
      if (node?.type !== NODE_TYPE || !st?.canvas) continue;
      const cv = st.canvas;
      const rect = cv.getBoundingClientRect();
      const scale = cv.clientWidth ? rect.width / cv.clientWidth : 1;
      if (Math.abs(scale - (st.viewScale || 0)) > 0.01) draw(node);
      // 首次布局晚到、或被框架把高度改回去：巡检纠正（这条只长不缩，不跟用户手动拉高打架）
      if (st.panel && st.sections) {
        const need = measurePanel(node);
        const wrap = st.panel.parentElement;
        const wrapH = wrap && wrap !== document.body ? Math.round(wrap.clientHeight) : need;
        if (Math.abs(need - (st.panelH || 0)) > 4 || Math.abs(wrapH - need) > 4) syncPanelHeight(node);
      }
    }
  }, 200);
}

// ---------------------------------------------------------------- 接线
function installInjection() {
  if (window.__cmInjection) return;
  window.__cmInjection = true;
  const orig = app.graphToPrompt.bind(app);
  app.graphToPrompt = async function (...args) {
    const res = await orig(...args);
    const out = res?.output || {};
    for (const node of app.graph?._nodes || []) {
      if (node.type !== NODE_TYPE) continue;
      const entry = out[String(node.id)];
      if (!entry?.inputs) continue;
      // 界面上没有这几个控件，值在这里补齐
      entry.inputs._cfg = readCfgJson(node);
      const v = readVals(node);
      for (const k of HIDDEN_INPUTS) entry.inputs[k] = v[k];
      refreshNow(node); // 排队顺手把面板预览对齐一次，避免显示滞后于真值
    }
    return res;
  };
}

function setupNode(node) {
  if (node.__cm) return;
  const st = state(node);
  installInjection();
  ensureZoomWatch();
  injectStyles();

  // _cfg 和三个机位值都是可选输入，界面上不占格子：
  // 机位由图上拖拽写入 properties，配置由面板写入 properties，排队时一起注入 inputs。
  const drop = new Set(["_cfg", ...HIDDEN_INPUTS]);
  node.widgets = (node.widgets || []).filter((w) => !(w && drop.has(w.name)));
  node.inputs = (node.inputs || []).filter((i) => !(i && drop.has(i.name)));

  // 滑块动了也要重画重算
  for (const w of node.widgets || []) {
    if (!w || w.name === "camera_scene" || w.name === "camera_panel") continue;
    const cb = w.callback;
    w.callback = function (...args) {
      const r = cb?.apply(this, args);
      draw(node);
      schedule(node);
      return r;
    };
  }

  if (node.size && node.size[0] < MIN_W) node.size[0] = MIN_W;

  // 最小宽度：litegraph 拖拽收窄时只认 node.computeSize() 的宽度，
  // 而各控件的 computeSize 都是"传多少返回多少"，于是节点能被拖到 100 多像素，
  // 相机示意图就被挤没了。这里把最小宽度钉成 MIN_W。
  const baseComputeSize = node.computeSize.bind(node);
  node.computeSize = function (out) {
    const s = baseComputeSize(out);
    return [Math.max(s[0], MIN_W), s[1]];
  };

  const onResize = node.onResize;
  node.onResize = function () {
    const r = onResize?.apply(this, arguments);
    if (this.size[0] < MIN_W) this.size[0] = MIN_W; // 兜底：别让宽度掉到 MIN_W 以下
    return r;
  };

  installScene(node);
  installPanel(node);

  const onConfigure = node.onConfigure;
  node.onConfigure = function (info) {
    const r = onConfigure?.apply(this, arguments);
    requestAnimationFrame(() => {
      // 载入了别的工作流：面板按新的配置重建
      const st2 = state(this);
      st2.built = false;
      st2.body?.replaceChildren();
      refreshNow(this);
    });
    return r;
  };

  const onRemoved = node.onRemoved;
  node.onRemoved = function () {
    state(this).ro?.disconnect?.();
    clearTimeout(state(this).timer);
    return onRemoved?.apply(this, arguments);
  };

  refreshNow(node);
  requestAnimationFrame(() => draw(node));
}

app.registerExtension({
  name: "StringMixer.CameraMixer",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;
    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };
  },
  loadedGraphNode(node) {
    if (node.type !== NODE_TYPE) return;
    setupNode(node);
    refreshNow(node);
  },
});
