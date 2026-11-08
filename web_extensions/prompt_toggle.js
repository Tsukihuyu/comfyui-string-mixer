// Prompt Toggle —— 编辑框 + 片段开关
//
// Python 侧负责拆分与拼接（/prompt_toggle/split 给的也是同一份结果），
// 这里只做界面：把片段画成一排可点的按钮，点一下切换开关，
// 状态写进被隐藏的 mask 控件（JSON 的 0/1 数组），随工作流一起保存。
//
// 高度：节点有下限，片段区从剩余空间里取，超了就滚动——不随内容长高。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ChipList } from "./chip_panel.js";

const NODE_TYPE = "PromptToggle";
const MIN_NODE_H = 320; // 节点高度下限
const TEXT_H = 84; // 编辑框固定占用
const FALLBACK_TOP = 138; // 面板上沿的首帧估计值（之后用 mask 控件的 last_y）
const MIN_PANEL_H = 110; // 片段区高度下限

function getWidget(node, name) {
  return (node.widgets || []).find((w) => w && w.name === name);
}

function readMask(node) {
  const st = node.__pt;
  if (st && Array.isArray(st.mask) && st.mask.length) return st.mask;
  try {
    const v = JSON.parse(node.properties?.prompt_toggle_mask || "[]");
    return Array.isArray(v) ? v.map((x) => (x ? 1 : 0)) : [];
  } catch {
    return [];
  }
}

// 状态存在 node.properties（随工作流保存），由 graphToPrompt 注入到 mask 输入，
// 因此节点上不需要、也不会出现 mask 那一行控件。
function writeMask(node, arr) {
  const st = node.__pt;
  if (st) st.mask = arr;
  node.properties = node.properties || {};
  node.properties.prompt_toggle_mask = JSON.stringify(arr);
  app.graph?.change?.(); // 标脏，关窗口前会提示保存
}

// 文本改过之后，按“文字 + 出现次序”把旧的开关状态接过去
function reconcile(prevSegs, prevMask, segs) {
  const pool = new Map();
  prevSegs.forEach((s, i) => {
    if (!pool.has(s)) pool.set(s, []);
    pool.get(s).push(prevMask[i] ?? 1);
  });
  return segs.map((s) => {
    const q = pool.get(s);
    return q && q.length ? q.shift() : 1;
  });
}

// 开=绿，关=红；词条本体由 chip_panel.js 统一画（两个炸词节点共用一份）
function ensureChipStyles() {
  if (document.getElementById("pfl-chip-style")) return;
  const css = document.createElement("style");
  css.id = "pfl-chip-style";
  css.textContent = `
    .pfl-undo{
      font-size:11px;line-height:17px;padding:0 7px;border-radius:6px;cursor:pointer;
      display:none;border:1px solid rgba(255,190,90,.6);
      background:rgba(255,180,60,.16);color:#ffd08a;
    }
    .pfl-undo:hover{background:rgba(255,180,60,.3)}
    .pfl-status{font-size:11px;margin-left:auto;opacity:.75;font-variant-numeric:tabular-nums}
    .pfl-status[data-off="1"]{color:#ff9b9b}
  `;
  document.head.appendChild(css);
}

function smallButton(label, onclick) {
  const b = document.createElement("button");
  b.textContent = label;
  b.style.cssText = [
    "font-size:11px",
    "padding:1px 8px",
    "border-radius:6px",
    "cursor:pointer",
    "border:1px solid var(--border,#555)",
    "background:var(--card,#2a2a2a)",
    "color:var(--foreground,#ddd)",
  ].join(";");
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onclick();
  });
  return b;
}

function render(node) {
  const st = node.__pt;
  if (!st) return;
  ensureChipStyles();
  st.chips?.render();
}

// ------------------------------------------------------------------ 写文本框
// 词条面板（开关/删除/拖动/权重）统一在 chip_panel.js 里，这里只负责把新文本写回控件。

function writeText(node, text) {
  const w = getWidget(node, "text");
  if (!w) return;
  w.value = text;
  w.callback?.(text); // 走原有回调 -> 重新拆分、按文字接续 mask
  node.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
}

// 打字时不必每个字符都拆一次，攒 180ms 再算
function scheduleRefresh(node) {
  const st = node.__pt;
  if (!st) return;
  clearTimeout(st.timer);
  st.timer = setTimeout(() => refreshSegments(node), 180);
}

async function refreshSegments(node) {
  const st = node.__pt;
  if (!st) return;

  const text = getWidget(node, "text")?.value ?? "";
  const seq = ++st.seq;
  try {
    const res = await api.fetchApi(`/prompt_toggle/split?text=${encodeURIComponent(text)}`);
    const data = await res.json();
    if (seq !== st.seq) return; // 又改了，这次结果作废
    const segs = data.segments || [];
    // 刚载入工作流时 st.segs 还是空的，没法按文字对号入座 → 直接按位置沿用存档
    const mask =
      st.segs.length === 0 && st.mask.length === segs.length
        ? st.mask.slice()
        : reconcile(st.segs, st.mask, segs);
    st.segs = segs;
    st.weights = data.weights || [];
    st.mask = mask.length === segs.length ? mask : segs.map(() => 1);
    writeMask(node, st.mask);
    render(node);
  } catch (e) {
    console.warn("[PromptToggle] 拆分失败：", e);
  }
}

// 片段区高度 = 节点剩余空间；ComfyUI 的 DOM 控件外框只在创建时算一次高度，
// 所以拖动节点后要自己把外框对齐，否则面板会一直停在初始高度。
function syncPanelHeight(node) {
  const st = node.__pt;
  if (!st || !st.panel) return;
  const wrap = st.panel.parentElement;
  if (!wrap || wrap === document.body) return;

  // ComfyUI 有时会把外框高度重算回 computeSize 的值（比如点击纯文本触发重排），
  // 用 ResizeObserver 盯住外框，被改就纠回来
  if (st.observed !== wrap) {
    st.observed = wrap;
    if (typeof ResizeObserver !== "undefined") {
      st.ro = new ResizeObserver(() => syncPanelHeight(node));
      st.ro.observe(wrap);
    }
  }

  const w = getWidget(node, "chips");
  const top = w?.last_y ?? FALLBACK_TOP; // 面板自己的上沿
  const h = Math.max(MIN_PANEL_H, (node.size?.[1] ?? MIN_NODE_H) - top - 10);
  const want = `${h}px`;
  if (wrap.style.height !== want) wrap.style.height = want;
  if (st.panel.style.height !== "100%") st.panel.style.height = "100%";
}

// DOM 面板是独立图层，永远浮在 canvas 之上；别的节点盖得住节点的画布部分，
// 盖不住面板。所以只要有「排在后面（更靠前）」的节点与本节点重叠，就把面板藏起来，
// 让重叠表现和普通节点一致。
function syncOcclusion(node) {
  const st = node.__pt;
  const wrap = st?.panel?.parentElement;
  if (!wrap || wrap === document.body) return;

  const nodes = app.graph?._nodes || [];
  const myIdx = nodes.indexOf(node);
  let covered = false;
  if (myIdx >= 0) {
    const x1 = node.pos[0];
    const y1 = node.pos[1];
    const x2 = x1 + node.size[0];
    const y2 = y1 + node.size[1];
    for (let i = myIdx + 1; i < nodes.length; i++) {
      const o = nodes[i];
      if (!o || o.mode === 4 || !o.size) continue; // 4 = bypass/隐藏
      if (o.pos[0] < x2 && o.pos[0] + o.size[0] > x1 &&
          o.pos[1] < y2 && o.pos[1] + o.size[1] > y1) {
        covered = true;
        break;
      }
    }
  }
  const want = covered ? "hidden" : "visible";
  if (wrap.style.visibility !== want) wrap.style.visibility = want;
}

// mask 不再是控件，排队前由这里把状态注入 prompt
let promptInjectionInstalled = false;

function installPromptInjection() {
  if (promptInjectionInstalled) return;
  promptInjectionInstalled = true;
  const orig = app.graphToPrompt.bind(app);
  app.graphToPrompt = async function (...args) {
    const res = await orig(...args);
    const out = res?.output || {};
    for (const node of app.graph?._nodes || []) {
      if (node.type !== NODE_TYPE || !node.__pt) continue;
      const entry = out[String(node.id)];
      if (entry?.inputs) entry.inputs.mask = JSON.stringify(node.__pt.mask || []);
    }
    return res;
  };
}

// upstream 有没有接线（连上就提示：输出会带上上游原文）
function syncUpstreamBadge(node) {
  const st = node.__pt;
  if (!st?.badge) return;
  const inp = (node.inputs || []).find((i) => i.name === "upstream");
  const on = !!inp && inp.link != null;
  const want = on ? "" : "none";
  if (st.badge.style.display !== want) st.badge.style.display = want;
}

// 兜底巡检：ComfyUI 重排 DOM 控件层时会把外框改回 computeSize 的高度，
// 而绘制/ResizeObserver 在页面不可见时都可能不触发，所以挂一个极廉价的定时器，
// 只做「值不一致才写」，不做重活。
let panelWatchTimer = null;

function ensurePanelWatch() {
  if (panelWatchTimer) return;
  panelWatchTimer = setInterval(() => {
    for (const node of app.graph?._nodes || []) {
      if (node.type !== NODE_TYPE || !node.__pt) continue;
      syncPanelHeight(node);
      syncUpstreamBadge(node);
      syncOcclusion(node);
    }
  }, 250);
}

function setupNode(node) {
  if (node.__pt) return;
  const st = (node.__pt = { segs: [], weights: [], mask: [], seq: 0 });
  installPromptInjection();
  ensurePanelWatch();

  // 摘掉 mask 控件：它是纯状态，不该占一行界面。
  // 老工作流里那行的值（若存在）先搬进 properties，避免升级后丢勾选。
  const idx = (node.widgets || []).findIndex((w) => w && w.name === "mask");
  if (idx >= 0) {
    const legacy = node.widgets[idx];
    if (legacy?.value && !node.properties?.prompt_toggle_mask) {
      node.properties = node.properties || {};
      node.properties.prompt_toggle_mask = String(legacy.value);
    }
    node.widgets.splice(idx, 1);
  }
  st.mask = readMask(node);

  // 编辑框固定高度，把剩余空间让给片段区
  const textW = getWidget(node, "text");
  if (textW) {
    textW.computeSize = (width) => [width ?? 240, TEXT_H];
    const cb = textW.callback;
    textW.callback = function (...args) {
      const r = cb?.apply(this, args);
      scheduleRefresh(node);
      return r;
    };
  }

  const panel = document.createElement("div");
  panel.style.cssText =
    "display:flex;flex-direction:column;gap:6px;height:100%;box-sizing:border-box;" +
    "padding:6px;border-radius:8px;background:rgba(0,0,0,.18);";
  panel.title = "点片段切换开关：绿色=开启，红色=关闭";
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());

  const bar = document.createElement("div");
  bar.style.cssText = "display:flex;gap:6px;flex:0 0 auto;align-items:center;";
  bar.append(
    smallButton("全开", () => {
      st.mask = st.segs.map(() => 1);
      writeMask(node, st.mask);
      render(node);
    }),
    smallButton("全关", () => {
      st.mask = st.segs.map(() => 0);
      writeMask(node, st.mask);
      render(node);
    }),
    smallButton("反选", () => {
      st.mask = st.mask.map((m) => (m ? 0 : 1));
      writeMask(node, st.mask);
      render(node);
    }),
    (() => {
      const badge = document.createElement("span");
      badge.textContent = "＋上游在前";
      badge.style.cssText =
        "font-size:10px;padding:0 6px;border-radius:6px;line-height:16px;display:none;" +
        "background:rgba(88,132,255,.18);border:1px solid rgba(120,160,255,.45);color:#a8c0ff;";
      st.badge = badge;
      return badge;
    })(),
    (() => {
      // 删除后的撤销入口：平时隐藏，点 × 之后出现 10 秒
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pfl-undo";
      b.textContent = "撤销";
      b.title = "把上一步操作（删除 / 拖动排序 / 权重）退回原来的文本（10 秒内有效）";
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        st.chips?.undoLast();
      });
      st.undoBtn = b;
      return b;
    })(),
    (() => {
      const status = document.createElement("span");
      status.className = "pfl-status";
      st.status = status;
      return status;
    })()
  );

  const list = document.createElement("div");
  list.style.cssText =
    "flex:1 1 auto;min-height:0;overflow-y:auto;overflow-x:hidden;display:flex;" +
    "flex-wrap:wrap;gap:6px;align-content:flex-start;padding:2px;";
  panel.append(bar, list);

  const domWidget = node.addDOMWidget("chips", "chips", panel, { serialize: false });
  // 这个前端按 widget.serialize 判断是否写进 widgets_values（不是 options.serialize），
  // 只给 options 的话存档里会多出一格空字符串。
  domWidget.serialize = false;
  // 注意：这里必须返回固定高度。若按 node.size 计算，最小尺寸会跟着当前高度一起涨
  // （computeSize = 各控件高度之和），节点就会「能拉大、拉不回去」。
  // 真实高度由 syncPanelHeight 每帧对齐。
  domWidget.computeSize = (width) => [width ?? 260, MIN_PANEL_H];

  st.panel = panel;
  st.list = list;

  // 词条面板：开关 / × 删除 / 拖动排序 / 权重加减，逻辑都在 chip_panel.js
  st.chips = new ChipList(node, {
    state: st,
    list,
    countEl: st.status,
    undoBtn: st.undoBtn,
    hint: "在上面的编辑框里输入提示词，这里会按标点拆成可点的片段",
    getText: () => String(getWidget(node, "text")?.value ?? ""),
    writeText: (text) => writeText(node, text),
    writeMask: (arr) => writeMask(node, arr),
    after: () => render(node),
  });

  if (node.size && node.size[1] < MIN_NODE_H) node.size[1] = MIN_NODE_H;

  const onResize = node.onResize;
  node.onResize = function (size) {
    const r = onResize?.apply(this, arguments);
    if (this.size[1] < MIN_NODE_H) this.size[1] = MIN_NODE_H;
    syncPanelHeight(this);
    this.setDirtyCanvas?.(true, true);
    return r;
  };

  render(node);
  refreshSegments(node);
  syncPanelHeight(node);

  // 首次布局时 ComfyUI 会用自己的值盖掉外框高度，绘制期间再对齐一次（有变化才写）
  const onDrawForeground = node.onDrawForeground;
  node.onDrawForeground = function (ctx) {
    const r = onDrawForeground?.apply(this, arguments);
    syncPanelHeight(this);
    syncUpstreamBadge(this);
    syncOcclusion(this);
    return r;
  };

  // 恢复工作流：控件值在 onConfigure 里才落位，这里重新读一次 mask 再渲染
  const onConfigure = node.onConfigure;
  node.onConfigure = function (info) {
    const r = onConfigure?.apply(this, arguments);
    const stored = readMask(this);
    if (stored.length && this.__pt) this.__pt.mask = stored;
    refreshSegments(this);
    return r;
  };

  // 连线/断线时立刻更新徽标（不必等下一帧绘制）
  const onConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected, linkInfo) {
    const r = onConnectionsChange?.apply(this, arguments);
    syncUpstreamBadge(this);
    return r;
  };

  // 首帧结束、以及稍后再各纠一次，避免刚创建时停在 ComfyUI 算的旧高度
  requestAnimationFrame(() => syncPanelHeight(node));
  setTimeout(() => syncPanelHeight(node), 300);
}

app.registerExtension({
  name: "StringMixer.PromptToggle",
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
    refreshSegments(node);
  },
});
