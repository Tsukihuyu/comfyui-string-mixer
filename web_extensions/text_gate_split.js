// TextGateSplit —— 闸门炸词：框空放上游进来，箱内文字按标点炸成可开关的片段
//
// 一个节点两段活，两段都沿用仓库里已有的实现：
//   闸门段（同 TextSnapshot）：框空 -> 输出上游原样，并把上游写进框；
//                              框里有字 -> 只输出框内，上游有差异则报警
//   炸词段（同 PromptToggle）：框内文字按标点炸成片段，关掉的片段不进输出
//
// 输出规则：
//   * 框空          -> 上游原样通过（不炸、不重拼标点）
//   * 片段全开      -> 输出框内原文（同样不重拼）
//   * 有关掉的片段  -> 按 join_mode 重拼（comma=", " / original=保留原标点）
//   * 片段全关      -> 输出空 + 界面红字报警
//   * 开关状态按文字内容接续（reconcile，与 PromptToggle 同一套）
//
// mask（片段开关的 0/1 数组）是纯状态：存 node.properties.tgs_mask，
// 排队前由这里的 graphToPrompt 包装注入 mask 输入，界面上没有那一行控件。
//
// 三只眼睛：框（你的内容）/ 上游预览条（上次执行上游给了什么）/ 状态条（哪一态 + 放入上游）

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { ChipList } from "./chip_panel.js";

const NODE_TYPE = "TextGateSplit";
const BAR_H = 30;        // 状态条固定高度
const UP_H = 52;         // 上游预览条固定高度（不参与分配）
const CHIPS_H = 112;     // 片段区最小高度
// 编辑框：高度跟着内容走 —— 最少露 2 行，最多 10 行（再多就在框内滚动）。
// 10 行是固定高度，与节点宽窄无关；窄了只是每行字数少、要滚得更多。
// 剩下的高度全部给片段区（片段区不设上限）。
const TEXT_MIN_LINES = 2;
const TEXT_MAX_LINES = 10;
const TEXT_LINE_H = 15;  // 量不到真实行高时的兜底（canvas 单位）
const TEXT_PAD_V = 4;    // 编辑框上下内边距（box-sizing: border-box）
const TEXT_SLACK = 16;   // 框架给每个控件的固定开销：视觉高度 = computeSize − 16
                         // （上下各 10px 外边距、又多算 4px；片段区/预览条一直按这个口径写）
const UP_CHARS = 1200;   // 预览最多渲染多少字
const DEFAULT_H = 470;   // 新建节点的高度
const MIN_NODE_H = 416;  // 能缩到的最小高度（编辑框 2 行 + 片段 112 + 固定部分）
// 框架的账（实测，别凭感觉改）：
//   * 每个 DOM 控件的 computedHeight = computeSize + 4，可见高度 = computedHeight − 20
//     （上下各 10px 外边距），所以控件占用的纵向空间 = 可见高度 + 20
//   * 控件区之外还有标题 26 + 底部留白 8
// 版面分配必须跟这套账严格对上：只要多占 1px，_arrangeWidgets 就会每帧把节点加高一次。
const WIDGET_OVERHEAD = 20;  // 单个 DOM 控件除可见高度外的固定占用
const NODE_CHROME = 34;      // 标题 26 + 底部留白 8
const RETRY_MS = 200;    // 队列忙时重试间隔
const RETRY_MAX = 10;
const ARM_MS = 5000;     // "再点一次"的确认态
const WAIT_MS = 300000;  // 等回填的兜底超时

// ------------------------------------------------------------------ 样式

function ensureStyle() {
  if (document.getElementById("tgs-style")) return;
  const css = document.createElement("style");
  css.id = "tgs-style";
  css.textContent = `
.ts-bar, .tgs-bar {
  display: flex; align-items: center; gap: 6px; height: 100%;
  box-sizing: border-box; padding: 0 2px; overflow: hidden;
}
.tgs-btn {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  height: 24px; padding: 0 10px; border-radius: 6px; cursor: pointer;
  font-family: inherit; font-size: 12px; line-height: 1; white-space: nowrap;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
  color: #cfe0f5; background: rgba(120, 140, 170, 0.18);
  border: 1px solid rgba(150, 165, 195, 0.45);
}
.tgs-btn:hover:not([disabled]) { background: rgba(140, 160, 195, 0.32); }
.tgs-btn[disabled] { opacity: 0.5; cursor: default; }
.tgs-btn[data-state="follow"] {
  color: #a9d6ff; background: rgba(64, 140, 220, 0.2);
  border-color: rgba(110, 180, 240, 0.6);
}
.tgs-btn[data-state="dirty"] {
  color: #ffd98a; background: rgba(214, 158, 46, 0.22);
  border-color: rgba(230, 180, 80, 0.72);
}
.tgs-btn[data-state="armed"] {
  color: #ffe9bd; background: rgba(214, 138, 46, 0.4);
  border-color: rgba(240, 178, 78, 0.95);
}
.tgs-btn[data-state="error"] {
  color: #ffb4b4; background: rgba(214, 74, 74, 0.2);
  border-color: rgba(240, 120, 120, 0.72);
}
.tgs-btn[data-state="busy"] {
  color: #c3cbd9; background: rgba(120, 130, 150, 0.18);
  border-color: rgba(160, 170, 190, 0.4);
}
.tgs-btn[data-state="void"] {
  color: #c9b4b4; background: rgba(160, 90, 90, 0.14);
  border-color: rgba(190, 110, 110, 0.5);
}
.tgs-btn[data-lock="1"][data-on="1"] {
  color: #ffd98a; background: rgba(214, 158, 46, 0.24);
  border-color: rgba(230, 180, 80, 0.8);
}
.tgs-status {
  flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: rgba(200, 210, 230, 0.72);
}
.tgs-status[data-tone="info"] { color: #9fc8f2; }
.tgs-status[data-tone="warn"] { color: #ffcf7a; }
.tgs-status[data-tone="error"] { color: #ff9b9b; }

/* 上游只读预览 */
.tgs-up {
  display: flex; flex-direction: column; gap: 2px; height: 100%;
  box-sizing: border-box; padding: 3px 6px 4px;
  border-radius: 6px; border-left: 3px solid rgba(150, 165, 195, 0.4);
  background: rgba(0, 0, 0, 0.2);
}
.tgs-up[data-mode="follow"] { border-left-color: rgba(110, 180, 240, 0.85); }
.tgs-up[data-mode="snapshot"] { border-left-color: rgba(150, 165, 195, 0.35); }
.tgs-up[data-mode="void"] { border-left-color: rgba(190, 110, 110, 0.6); }
.tgs-up[data-blocked="1"] { border-left-color: rgba(230, 180, 80, 0.95); }
.tgs-up-head {
  flex: 0 0 auto; font-size: 10px; line-height: 12px;
  color: rgba(170, 185, 210, 0.75); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.tgs-up-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  font-size: 11px; line-height: 15px; white-space: pre-wrap; word-break: break-word;
  color: rgba(205, 215, 235, 0.9); user-select: text; cursor: text;
}
.tgs-up-body[data-empty="1"] { color: rgba(170, 185, 210, 0.5); font-style: italic; }

/* 片段区 */
.tgs-panel {
  display: flex; flex-direction: column; gap: 6px; height: 100%;
  box-sizing: border-box; padding: 6px; border-radius: 8px;
  background: rgba(0, 0, 0, 0.18);
}
.tgs-chips-bar { display: flex; gap: 6px; flex: 0 0 auto; align-items: center; }
.tgs-mini {
  font-size: 11px; padding: 1px 8px; border-radius: 6px; cursor: pointer;
  border: 1px solid rgba(150, 165, 195, 0.45); background: rgba(0, 0, 0, 0.2);
  color: rgba(215, 225, 240, 0.9);
}
.tgs-mini:hover { background: rgba(140, 160, 195, 0.3); }
.tgs-count {
  font-size: 11px; margin-left: auto; opacity: 0.75;
  font-variant-numeric: tabular-nums; color: rgba(205, 215, 235, 0.85);
}
.tgs-count[data-off="1"] { color: #ff9b9b; }
.tgs-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; padding: 2px;
}
/* 词条本体（.smchip 系列）由 chip_panel.js 统一提供，两个炸词节点共用一份 */
.tgs-btn.tgs-water { color: #d8b4fe; background: rgba(139, 92, 246, 0.16); border-color: rgba(167, 139, 250, 0.6); }
.tgs-btn.tgs-water[data-water="1"] {
  color: #bfe9ff; background: rgba(56, 150, 200, 0.34);
  border-color: rgba(120, 205, 245, 0.95);
  box-shadow: 0 0 8px rgba(90, 180, 235, 0.35);
}
.tgs-mini[data-undo="1"] {
  display: none;
  border-color: rgba(255, 190, 90, 0.6);
  background: rgba(255, 180, 60, 0.16);
  color: #ffd08a;
}
.tgs-hint { font-size: 11px; opacity: 0.55; padding: 4px 2px; color: rgba(205, 215, 235, 0.9); }
`;
  document.head.append(css);
}

// ------------------------------------------------------------------ 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textWidget(node) {
  return (node.widgets || []).find((w) => w && w.name === "text");
}

// 多行文字控件是 DOM widget，element 就是那个 <textarea>
function textEl(node) {
  const w = textWidget(node);
  return w?.element || w?.inputEl || null;
}

function hasSource(node) {
  const inp = (node.inputs || []).find((i) => i && i.name === "source");
  return !!inp && inp.link != null;
}

function sourceText(node) {
  const w = textWidget(node);
  return w ? String(w.value ?? "") : "";
}

function stamp() {
  const d = new Date();
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, "0"))
    .join(":");
}

// follow = 框空且有上游（闸门开）；void = 框空且没上游；snapshot = 框里有字（闸门关）
function modeOf(node) {
  if (sourceText(node).trim()) return "snapshot";
  return hasSource(node) ? "follow" : "void";
}

// ------------------------------------------------------------------ 片段开关状态

function readMask(node) {
  const st = node.__tgs;
  if (st && Array.isArray(st.mask) && st.mask.length) return st.mask;
  try {
    const v = JSON.parse(node.properties?.tgs_mask || "[]");
    return Array.isArray(v) ? v.map((x) => (x ? 1 : 0)) : [];
  } catch {
    return [];
  }
}

function writeMask(node, arr) {
  const st = node.__tgs;
  if (st) st.mask = arr;
  node.properties = node.properties || {};
  node.properties.tgs_mask = JSON.stringify(arr);
  app.graph?.change?.(); // 标脏，关窗口前会提示保存
}

// ------------------------------------------------------------------ 闸门状态：你动没动过手
//
// 闸门关的理由只有一个——你动过手。三条判据全部不成立才算“没动过”：
//   * 没有手动锁（properties.tgs_lock）
//   * 框内文字 == 上次流入的原文（properties.tgs_base）
//   * 片段开关 == 上次流入时的开关（properties.tgs_mbase，缺省=全开）
// 没动过时，全局 queue 会把新上游直接放进闸（注入 adopt=1 给后端），而不是拦截。
// 老工作流没有 tgs_base：说明框里的字是你自己写的，一律当“已锁定”，绝不覆盖。

function propStr(node, key) {
  const v = node.properties?.[key];
  return typeof v === "string" ? v : "";
}

function setProp(node, key, value) {
  node.properties = node.properties || {};
  if (value) node.properties[key] = value;
  else delete node.properties[key];
}

function readMBase(node) {
  try {
    const v = JSON.parse(propStr(node, "tgs_mbase") || "[]");
    return Array.isArray(v) ? v.map((x) => (x ? 1 : 0)) : [];
  } catch {
    return [];
  }
}

// 把当前内容认作基线：以后拿它比“动没动过”
function acceptAsBaseline(node) {
  setProp(node, "tgs_base", sourceText(node));
  const st = node.__tgs;
  if (st?.mask?.length) setProp(node, "tgs_mbase", JSON.stringify(st.mask));
  else setProp(node, "tgs_mbase", "");
  setProp(node, "tgs_lock", "");
  app.graph?.change?.();
}

// adopt / reservoir 是纯注入用的输入（界面上不该多出这些插槽，插了也没意义）
function hideInjectedSockets(node) {
  let hit = false;
  for (const name of ["adopt", "reservoir"]) {
    const idx = (node.inputs || []).findIndex((i) => i && i.name === name);
    if (idx >= 0) {
      node.inputs.splice(idx, 1);
      hit = true;
    }
  }
  if (hit) node.setDirtyCanvas?.(true, true);
}

function gateState(node) {
  const text = sourceText(node);
  const manualLock = propStr(node, "tgs_lock") === "1";
  // 框空 = 闸门本身就是开的，跟“动没动过”无关
  if (!text.trim()) return { open: true, reason: "", manualLock };

  const base = propStr(node, "tgs_base");
  const reasons = [];
  if (manualLock) reasons.push("手动锁");
  if (!base) reasons.push("手写内容");
  else if (text !== base) reasons.push("字改过");

  const mask = node.__tgs?.mask || [];
  const mbase = readMBase(node);
  const baseMask = mbase.length === mask.length ? mbase : mask.map(() => 1);
  if (mask.some((m, i) => (m ? 1 : 0) !== baseMask[i])) reasons.push("关了词");

  return { open: reasons.length === 0, reason: reasons.join(" · "), manualLock };
}

// 文本变了以后，按「文字 + 出现次序」把旧的开关状态接过去（与 PromptToggle 同一套）
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

function maskOn(mask, i) {
  return mask[i] !== 0;
}

// ------------------------------------------------------------------ 上游预览

function updatePreview(node) {
  const st = node.__tgs;
  if (!st || !st.upBody) return;

  const mode = modeOf(node);
  const linked = hasSource(node);
  let head;
  let body;
  let empty = "0";

  if (!linked) {
    head = "上游 · 未接线";
    body = "左边 source 没连，本节点只能手写。";
    empty = "1";
    st.upEl.dataset.blocked = "";
  } else if (st.upSrc == null) {
    head = "上游 · 还没执行过";
    body = "排一次队（或点 ✎ 放入上游），这里就会显示上游给了什么。";
    empty = "1";
    st.upEl.dataset.blocked = "";
  } else {
    const len = st.upSrc.length;
    const blocked = mode === "snapshot" && !!st.blocked;
    head = `上游 · 上次执行 ${st.upAt || ""} · ${len} 字`
      + (mode === "follow" ? " · 闸门开着" : blocked ? " · 被闸门拦下" : "");
    body = len > UP_CHARS ? st.upSrc.slice(0, UP_CHARS) + `\n…（共 ${len} 字，其余未渲染）` : st.upSrc;
    if (!st.upSrc.trim()) {
      body = "（上游这次是空的）";
      empty = "1";
    }
    st.upEl.dataset.blocked = blocked ? "1" : "";
  }

  const sig = [mode, head, body, linked ? 1 : 0, st.blocked ? 1 : 0].join("|");
  if (st.upSig === sig) return;
  st.upSig = sig;

  st.upEl.dataset.mode = mode;
  st.upHead.textContent = head;
  st.upBody.textContent = body;
  st.upBody.dataset.empty = empty;
  st.upBody.scrollTop = 0;
}

// ------------------------------------------------------------------ 片段渲染

function renderChips(node) {
  // 词条本体（开关 / × 删除 / 拖动排序 / 权重加减）统一在 chip_panel.js 里
  node.__tgs?.chips?.render();
}

function undoDelete(node) {
  node.__tgs?.chips?.undoLast();
}

// ------------------------------------------------------------------ 蓄水模式
//
// properties.tgs_reservoir = "1" 时进入蓄水：永不拦、不看动没动手，上游每次给的
// "账本里没有的段"由后端算好回报（rsv_chunk / rsv_keys），前端把增量接在框末尾。
// 账本 properties.tgs_seen 是归一键数组；✕ 清空框会连账本一起清。

const RSV_KEY = "tgs_reservoir";
const SEEN_KEY = "tgs_seen";

function rsvOn(node) {
  return node.properties?.[RSV_KEY] === "1";
}

function readSeen(node) {
  try {
    const v = JSON.parse(node.properties?.[SEEN_KEY] || "[]");
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

function writeSeen(node, keys) {
  node.properties = node.properties || {};
  if (keys.length) node.properties[SEEN_KEY] = JSON.stringify(keys);
  else delete node.properties[SEEN_KEY];
  app.graph?.change?.();
}

function toggleReservoir(node) {
  const st = node.__tgs;
  if (!st || st.busy) return;
  const on = !rsvOn(node);
  node.properties = node.properties || {};
  if (on) node.properties[RSV_KEY] = "1";
  else delete node.properties[RSV_KEY];
  st.sig = ""; // 状态条要立刻重画
  app.graph?.change?.();
  flash(node, on
    ? "💧 已切到蓄水模式 · 上游的新词会接在框末尾（重复的不蓄）"
    : "🚧 已切回拦截模式 · 框空放行、有字拦下", on ? "info" : "", 3500);
  render(node);
}

// ------------------------------------------------------------------ 分段请求（与 PromptToggle 同一个后端逻辑）

function scheduleSplit(node) {
  const st = node.__tgs;
  if (!st) return;
  clearTimeout(st.splitTimer);
  st.splitTimer = setTimeout(() => refreshSegments(node), 180);
}

async function refreshSegments(node) {
  const st = node.__tgs;
  if (!st) return;
  const text = sourceText(node);
  const seq = ++st.seq;
  try {
    const res = await api.fetchApi(`/prompt_toggle/split?text=${encodeURIComponent(text)}`);
    const data = await res.json();
    if (seq !== st.seq) return; // 又改了，这次结果作废
    const segs = data.segments || [];
    // 刚载入工作流时 st.segs 还是空的，没法按文字对号入座 -> 直接按位置沿用存档
    const mask =
      st.segs.length === 0 && st.mask.length === segs.length
        ? st.mask.slice()
        : reconcile(st.segs, st.mask, segs);
    st.segs = segs;
    st.weights = data.weights || [];
    st.mask = mask.length === segs.length ? mask : segs.map(() => 1);
    writeMask(node, st.mask);
    renderChips(node);
    render(node);
  } catch (e) {
    console.warn("[TextGateSplit] 拆分失败：", e);
  }
}

// ------------------------------------------------------------------ 状态条

function render(node) {
  const st = node.__tgs;
  if (!st || !st.btn) return;
  // 框架偶尔会在控件变动后把注入用的插槽加回来：顺手再摘一次（幂等、很便宜）
  if ((node.inputs || []).some((i) => i && (i.name === "adopt" || i.name === "reservoir"))) {
    hideInjectedSockets(node);
  }

  const mode = modeOf(node);
  const gate = gateState(node);
  st.gate = gate;
  // “锁着”才叫动过手；没动过手时闸门是开的，即便框里有字
  st.dirty = mode === "snapshot" && !gate.open;
  const segs = st.segs || [];
  const onCount = segs.reduce((n, _, i) => n + (maskOn(st.mask, i) ? 1 : 0), 0);
  st.allOff = segs.length > 0 && onCount === 0;

  let state = "snapshot";
  let label = "✎ 换成最新上游";
  if (st.busy) {
    state = "busy";
    label = "✎ 放入中…";
  } else if (st.error) {
    state = "error";
    label = "⚠ 失败，点此重试";
  } else if (mode === "void") {
    state = "void";
    label = "✎ 未接上游";
  } else if (gate.open) {
    state = "follow";
    label = "✎ 放入上游";
  } else if (st.armed === "pull") {
    state = "armed";
    label = "⚠ 再点一次覆盖";
  } else {
    state = "dirty";
    label = "✎ 覆盖改动";
  }

  const reservoir = rsvOn(node);
  if (reservoir) {
    // 蓄水时闸门那套（开/关/拦下/动过手/手动锁）全部让位，只报账本
    state = st.busy ? "busy" : "water";
    label = st.busy ? "✎ 蓄水中…" : "✎ 放入上游";
  }

  let note;
  let tone = "";
  if (st.busy) {
    note = "放入中…（只跑本节点和上游）";
  } else if (st.error) {
    note = st.error;
    tone = "error";
  } else if (mode === "void") {
    note = "空：没上游也没内容";
    tone = "error";
  } else if (mode === "follow") {
    note = "闸门开着 · 下次执行上游会整段流进来";
    tone = "info";
  } else if (gate.open) {
    note = "闸门开（未编辑）· 下次执行会换上新上游";
    tone = "info";
  } else if (st.allOff) {
    note = "⚠ 片段全关，本次输出为空";
    tone = "error";
  } else if (st.blocked) {
    note = `闸门关（${gate.reason}）· 上游被拦下（点 ✎ 放入）`;
    tone = "warn";
  } else {
    note = `闸门关（${gate.reason}）· 点 ✕ 重新开闸${segs.length ? ` · 开 ${onCount}/${segs.length} 段` : ""}`;
    tone = "warn";
  }
  if (!st.busy && !st.error && st.flash) {
    note = st.flash.text;
    tone = st.flash.tone || "";
  }
  if (reservoir && !st.flash && !st.busy && !st.error) {
    note = `蓄水模式 · 账本 ${readSeen(node).length} 段`
      + (st.rsvLast ? ` · 上次 +${st.rsvLast} 段` : "");
    tone = "info";
  }

  const showClear = mode === "snapshot";
  const clearArmed = st.armed === "clear";

  const sig = [state, label, note, tone, showClear ? 1 : 0, clearArmed ? 1 : 0,
    st.busy ? 1 : 0, gate.manualLock ? 1 : 0,
    reservoir ? 1 : 0, reservoir ? readSeen(node).length : 0].join("|");
  if (st.sig === sig) {
    updatePreview(node);
    return;
  }
  st.sig = sig;

  st.btn.dataset.state = state;
  st.btn.disabled = !!st.busy || mode === "void";
  st.btn.textContent = label;
  st.btn.title =
    (st.error ? st.error + "\n\n" : "") +
    (reservoir
      ? "蓄水中：点它 = 正常执行一次，只把上游里的新词接到框末尾（重复的不蓄）。"
      : "把上游放进框里：只执行本节点和它的上游（其他分支不动），上游没变时走缓存，基本瞬发。\n"
        + "框空着、或者你没动过手时，不用点它——下次执行会自己换。");

  if (st.clearBtn) {
    st.clearBtn.style.display = showClear ? "" : "none";
    st.clearBtn.dataset.armed = clearArmed ? "1" : "";
    st.clearBtn.title = clearArmed
      ? "再点一次：清空框，重新开闸（下次执行上游会流进来）"
      : "清空框，重新开闸";
    st.clearBtn.disabled = !!st.busy;
  }

  if (st.waterBtn) {
    st.waterBtn.textContent = reservoir ? "💧 蓄水模式" : "🚧 拦截模式";
    st.waterBtn.dataset.water = reservoir ? "1" : "0";
    st.waterBtn.disabled = !!st.busy;
    st.waterBtn.title = reservoir
      ? `蓄水模式：上游每次给的新词接在框末尾，重复的不蓄。账本已记 ${readSeen(node).length} 段；点一下切回拦截模式。`
      : "拦截模式（原来的闸门：框空放行、有字拦下）。点一下切到蓄水模式：上游给多少蓄多少，只增不减。";
  }

  if (st.lockBtn) {
    const lockedNow = gate.manualLock;
    st.lockBtn.textContent = lockedNow ? "🔒" : "🔓";
    st.lockBtn.dataset.on = lockedNow ? "1" : "";
    st.lockBtn.disabled = !!st.busy || reservoir || !sourceText(node).trim();
    st.lockBtn.title = reservoir
      ? "蓄水模式不看闸门，锁不上（点 💧 蓄水模式 切回拦截模式）"
      : !sourceText(node).trim()
      ? "框是空的，闸门本来就开着，不用锁"
      : lockedNow
        ? "已锁定：下次执行不会换掉这里的内容。点击 = 解锁，并把当前内容认作新基线"
        : gate.open
          ? "点一下锁住：下次执行不会自动换掉这里的内容"
          : `已因「${gate.reason}」拦着。点一下再加一道手动锁`;
  }

  st.status.textContent = note;
  st.status.dataset.tone = tone;
  updatePreview(node);
}

// ------------------------------------------------------------------ 提示

function flash(node, text, tone = "", ms = 3500) {
  const st = node.__tgs;
  if (!st) return;
  st.flash = { text, tone };
  clearTimeout(st.flashTimer);
  st.flashTimer = setTimeout(() => {
    const s2 = node.__tgs;
    if (!s2) return;
    s2.flash = null;
    render(node);
  }, ms);
  render(node);
}

function cancelFlash(node) {
  const st = node.__tgs;
  if (!st) return;
  clearTimeout(st.flashTimer);
  st.flash = null;
}

function arm(node, kind) {
  const st = node.__tgs;
  if (!st) return;
  cancelFlash(node);
  st.armed = kind;
  clearTimeout(st.armTimer);
  st.armTimer = setTimeout(() => {
    const s2 = node.__tgs;
    if (!s2) return;
    s2.armed = null;
    render(node);
  }, ARM_MS);
  render(node);
}

// ------------------------------------------------------------------ 写入 / 开闸

// 词条面板改文本（删词/排序/权重）走这里：只写控件 + 走回调，不碰基线——
// 用户动过手就该被闸门认出来，下次执行不会拿上游把这堆改动盖掉。
function writeBoxText(node, text) {
  const w = textWidget(node);
  if (!w) return;
  w.value = text;
  w.callback?.(text);
  node.setDirtyCanvas?.(true, true);
  app.canvas?.setDirty?.(true, true);
  app.graph?.change?.();
}

function applyInflow(node, raw, count, why) {
  const st = node.__tgs;
  const w = textWidget(node);
  if (!st || !w) return;
  w.value = raw;
  // 记住这次流进来的是哪一句：以后拿它比“你动没动过手”
  setProp(node, "tgs_base", raw);
  setProp(node, "tgs_mbase", "");
  setProp(node, "tgs_lock", "");
  st.baseline = raw;
  st.dirty = false;
  st.blocked = false;
  st.armed = null;
  st.at = stamp();
  clearTimeout(st.armTimer);
  node.setDirtyCanvas?.(true, true);
  app.graph?.change?.();
  refreshSegments(node); // 新词进来 -> 按文字接续旧的片段开关
  render(node);
  if (!raw.trim()) return;
  const msg = why === "adopt"
    ? `上游换了新词（${raw.length} 字）· 上次你没动过手，已自动换进来`
    : why === "auto"
      ? `上游 ${raw.length} 字已流入框内，可直接改`
      : `已放入上游 ${raw.length} 字`;
  flash(node, msg, "info", 4000);
}

function clearBox(node) {
  const st = node.__tgs;
  const w = textWidget(node);
  if (!st || !w) return;
  w.value = "";
  setProp(node, "tgs_base", "");
  setProp(node, "tgs_mbase", "");
  setProp(node, "tgs_lock", "");
  st.baseline = "";
  st.dirty = false;
  st.blocked = false;
  st.armed = null;
  st.at = "";
  st.flash = null;
  st.rsvLast = 0;
  writeSeen(node, []); // 蓄水账本一起清，否则清空后上游的老词永远蓄不进来
  node.setDirtyCanvas?.(true, true);
  app.graph?.change?.();
  refreshSegments(node);
  render(node);
  flash(node, rsvOn(node) ? "已清空 · 上游的词会重新蓄进来" : "已开闸 · 下次执行上游会流进来", "info", 3000);
}

// 锁按钮：只负责手动锁本身。🔓 -> 锁上；🔒 -> 解开（并把当前内容认作新基线）
// 因为“关了词/改过字”而关着的，点它只是再上一层手动锁，不会顺手把基线改掉。
function onLockClick(node) {
  const st = node.__tgs;
  if (!st || st.busy || !sourceText(node).trim()) return;
  cancelFlash(node);
  const gate = gateState(node);
  if (gate.manualLock) {
    acceptAsBaseline(node);
    flash(node, "已解锁（当前内容作为新基线）", "info", 3000);
  } else {
    setProp(node, "tgs_lock", "1");
    app.graph?.change?.();
    flash(node, "已锁定 · 下次执行不会换掉这里的内容", "warn", 3500);
  }
  st.sig = "";
  render(node);
}

// 上游这次空着、而你框里有字：保留旧词，但要说清楚
function warnEmptyUpstream(node) {
  flash(node, "上游这次是空的 · 旧词保留（下次再有词会自动换）", "warn", 5000);
}

function onClearClick(node) {
  const st = node.__tgs;
  if (!st || st.busy || modeOf(node) !== "snapshot") return;
  cancelFlash(node);
  if (st.dirty && st.armed !== "clear") {
    arm(node, "clear");
    return;
  }
  clearBox(node);
}

// ------------------------------------------------------------------ 放入上游（局部执行）

// 队列是不是还在忙（跑着或排着）
async function queueBusy() {
  try {
    const res = await fetch("/api/queue", { cache: "no-store" });
    const q = await res.json();
    return !!((q.queue_running || []).length + (q.queue_pending || []).length);
  } catch {
    return !!app.processingQueue;
  }
}

async function pull(node) {
  const st = node.__tgs;
  if (!st || st.busy || node.id == null || node.id < 0) return;

  st.busy = true;
  st.armed = null;
  st.error = "";
  st.flash = null;
  st.pending = true;
  render(node);

  let queued = false;
  let lastError = "";
  let busySeen = false;
  for (let i = 0; i < RETRY_MAX; i++) {
    try {
      const ok = await app.queuePrompt(0, 1, { queueNodeIds: [String(node.id)] });
      if (ok !== false) {
        queued = true;
        break;
      }
      if (!app.processingQueue && !(await queueBusy())) {
        lastError = "ComfyUI 拒绝了这次执行（看控制台 / 错误面板）";
        break;
      }
      busySeen = true;
    } catch (e) {
      lastError = String(e?.message || e);
      break;
    }
    await sleep(RETRY_MS);
  }

  if (!queued) {
    st.pending = false;
    st.busy = false;
    // 不做排队/挂起：闸门开闸是“执行上游”，得跟队列抢，干脆当场说清楚
    st.error = busySeen
      ? "前序任务还没跑完 · 稍后再试"
      : (lastError || "ComfyUI 拒绝了这次执行");
    render(node);
    return;
  }

  clearTimeout(st.waitTimer);
  st.waitTimer = setTimeout(() => {
    const s2 = node.__tgs;
    if (!s2 || !s2.pending) return;
    s2.pending = false;
    s2.busy = false;
    s2.error = "等后端回填超时（看 ComfyUI 控制台）";
    render(node);
  }, WAIT_MS);
}

function onMainClick(node) {
  const st = node.__tgs;
  if (!st || st.busy) return;
  cancelFlash(node);

  const mode = modeOf(node);
  if (mode === "void") {
    st.error = "左边 source 没接线，先接上";
    render(node);
    return;
  }
  if (mode === "snapshot" && st.dirty && st.armed !== "pull") {
    arm(node, "pull");
    return;
  }
  pull(node);
}

// ------------------------------------------------------------------ mask 注入

let injectionInstalled = false;

function installPromptInjection() {
  if (injectionInstalled) return;
  injectionInstalled = true;
  const orig = app.graphToPrompt.bind(app);
  app.graphToPrompt = async function (...args) {
    const res = await orig(...args);
    const out = res?.output || {};
    for (const node of app.graph?._nodes || []) {
      if (node?.type !== NODE_TYPE || !node.__tgs) continue;
      const entry = out[String(node.id)];
      if (entry?.inputs) {
        entry.inputs.mask = JSON.stringify(node.__tgs.mask || []);
        // adopt=1：这次没动过手，后端直接把新上游放进闸（而不是拦下）
        entry.inputs.adopt = gateState(node).open ? "1" : "0";
        // 蓄水：开关 + 已吸收账本
        entry.inputs.reservoir = JSON.stringify({
          on: rsvOn(node) ? 1 : 0,
          seen: readSeen(node),
        });
      }
    }
    return res;
  };
}

// ------------------------------------------------------------------ 节点装配

function setupNode(node) {
  if (node.__tgs) return;
  ensureStyle();
  installPromptInjection();

  const st = (node.__tgs = {
    btn: null, clearBtn: null, lockBtn: null, status: null,
    upEl: null, upHead: null, upBody: null,
    panel: null, list: null, count: null,
    segs: [], weights: [], mask: [], seq: 0, waterBtn: null, rsvLast: 0,
    baseline: sourceText(node),
    dirty: false, armed: null, busy: false, pending: false,
    error: "", at: "", count: 0, blocked: false, allOff: false,
    upSrc: null, upAt: "", upSig: "",
    flash: null, sig: "", splitTimer: null,
  });

  // mask 是纯状态，不该占一行界面：先把老值搬进 properties，再把控件摘掉
  const maskIdx = (node.widgets || []).findIndex((w) => w && w.name === "mask");
  if (maskIdx >= 0) {
    const legacy = node.widgets[maskIdx];
    if (legacy?.value && !node.properties?.tgs_mask) {
      node.properties = node.properties || {};
      node.properties.tgs_mask = String(legacy.value);
    }
    node.widgets.splice(maskIdx, 1);
  }
  st.mask = readMask(node);
  hideInjectedSockets(node);

  // 编辑框高度按内容算（layout 里分配），这里给个初值
  const textW = textWidget(node);
  if (textW) {
    textW.computeSize = (width) =>
      [width ?? 300, (st.textH ?? TEXT_MIN_LINES * TEXT_LINE_H + TEXT_PAD_V) + TEXT_SLACK];
    const cb = textW.callback;
    textW.callback = function (...args) {
      const r = cb?.apply(this, args);
      cancelFlash(node);
      scheduleSplit(node);
      render(node);
      queueLayout(node);
      return r;
    };
  }

  // ---- 上游预览条
  const upEl = document.createElement("div");
  upEl.className = "tgs-up";
  upEl.dataset.mode = "follow";
  upEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  upEl.addEventListener("mousedown", (e) => e.stopPropagation());
  const upHead = document.createElement("div");
  upHead.className = "tgs-up-head";
  const upBody = document.createElement("div");
  upBody.className = "tgs-up-body";
  upEl.append(upHead, upBody);
  st.upEl = upEl; st.upHead = upHead; st.upBody = upBody;
  const upWidget = node.addDOMWidget("tgs_up", "tgs_up", upEl, { serialize: false });
  upWidget.serialize = false;
  upWidget.computeSize = (width) => [width ?? 300, UP_H + 16];

  // ---- 片段区
  const panel = document.createElement("div");
  panel.className = "tgs-panel";
  panel.addEventListener("pointerdown", (e) => e.stopPropagation());
  const bar = document.createElement("div");
  bar.className = "tgs-chips-bar";
  const mk = (label, fn) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tgs-mini";
    b.textContent = label;
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    return b;
  };
  const countEl = document.createElement("span");
  countEl.className = "tgs-count";
  // 删除后的撤销入口：平时 display:none，点 × 之后出现 10 秒
  const undoBtn = mk("撤销", () => undoDelete(node));
  undoBtn.dataset.undo = "1";
  undoBtn.title = "把上一步操作（删除 / 拖动排序 / 权重 / 编辑）退回原来的文本（10 秒内有效）";
  bar.append(
    mk("全开", () => st.chips?.applyMask(st.segs.map(() => 1))),
    mk("全关", () => st.chips?.applyMask(st.segs.map(() => 0))),
    mk("反选", () => st.chips?.applyMask(st.mask.map((m) => (m ? 0 : 1)))),
    undoBtn,
    countEl
  );
  const list = document.createElement("div");
  list.className = "tgs-list";
  panel.append(bar, list);
  st.panel = panel; st.list = list; st.countEl = countEl; st.undoBtn = undoBtn;
  const chipsWidget = node.addDOMWidget("tgs_chips", "tgs_chips", panel, { serialize: false });
  chipsWidget.serialize = false;
  chipsWidget.computeSize = (width) => [width ?? 300, CHIPS_H + 16];
  st.chipsWidget = chipsWidget;

  // 词条面板：开关 / × 删除 / 拖动排序 / 权重加减，逻辑都在 chip_panel.js
  st.chips = new ChipList(node, {
    state: st,
    list,
    countEl,
    undoBtn,
    hint: "框里有字后，这里会按标点炸成可点的片段（点一下关掉/打开，双击改词，按住拖动换位置）",
    getText: () => sourceText(node),
    writeText: (text) => writeBoxText(node, text),
    writeMask: (arr) => writeMask(node, arr),
    after: () => { cancelFlash(node); render(node); },
  });

  // ---- 状态条
  const sbar = document.createElement("div");
  sbar.className = "tgs-bar";
  sbar.addEventListener("pointerdown", (e) => e.stopPropagation());
  sbar.addEventListener("mousedown", (e) => e.stopPropagation());

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tgs-btn";
  btn.textContent = "✎ 放入上游";
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onMainClick(node);
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "tgs-btn";
  clearBtn.textContent = "✕";
  clearBtn.style.padding = "0 7px";
  clearBtn.style.display = "none";
  clearBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClearClick(node);
  });

  // 手动锁：有时我只想留住这段词，一个字都不想改，也不想下次被换掉
  const lockBtn = document.createElement("button");
  lockBtn.type = "button";
  lockBtn.className = "tgs-btn";
  lockBtn.dataset.lock = "1";
  lockBtn.textContent = "🔓";
  lockBtn.style.padding = "0 6px";
  lockBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  lockBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onLockClick(node);
  });

  // 蓄水开关：自动 ⇄ 蓄水（状态在 properties，不新增控件行）
  const waterBtn = document.createElement("button");
  waterBtn.type = "button";
  waterBtn.className = "tgs-btn tgs-water";
  waterBtn.textContent = "🚧 拦截模式";
  waterBtn.style.padding = "0 8px";
  waterBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  waterBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleReservoir(node);
  });

  const status = document.createElement("span");
  status.className = "tgs-status";
  sbar.append(btn, clearBtn, waterBtn, lockBtn, status);
  st.btn = btn; st.clearBtn = clearBtn; st.waterBtn = waterBtn; st.lockBtn = lockBtn; st.status = status;

  const barWidget = node.addDOMWidget("tgs_bar", "tgs_bar", sbar, { serialize: false });
  barWidget.serialize = false;
  barWidget.computeSize = (width) => [width ?? 300, BAR_H + 16];

  if (node.size && node.size[1] < MIN_NODE_H) {
    node.size = [Math.max(node.size[0] || 300, 360), DEFAULT_H];
  }

  // 关键：node.computeSize() 是「最小高度」。若它等于当前控件高度之和（≈当前高度），
  // 节点就只能变高、缩不回去（每缩一点，最小高度又跟着降到新高度）。
  // 钉成常数，控件高度由 layout() 按实际节点高度分配。
  const baseComputeSize = node.computeSize.bind(node);
  node.computeSize = function (out) {
    const s = baseComputeSize(out);
    return [s[0], MIN_NODE_H];
  };

  const onConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected, linkInfo) {
    const r = onConnectionsChange?.apply(this, arguments);
    render(this);
    return r;
  };

  // 拉高/压矮节点：把多出来的高度优先给片段区，其次给编辑框（预览条与状态条不动）
  const onResize = node.onResize;
  node.onResize = function () {
    const r = onResize?.apply(this, arguments);
    layout(this);
    return r;
  };

  const onConfigure = node.onConfigure;
  node.onConfigure = function () {
    const r = onConfigure?.apply(this, arguments);
    const s = this.__tgs;
    if (s) {
      s.mask = readMask(this);
      s.segs = []; // 让 refreshSegments 走「按存档位置沿用」那条路
      s.baseline = propStr(this, "tgs_base");
      hideInjectedSockets(this);
      s.dirty = false;
      s.blocked = false;
      s.armed = null;
      s.error = "";
      s.at = "";
      s.count = 0;
      s.flash = null;
      s.upSrc = null;
      s.upAt = "";
      s.upSig = "";
      s.sig = "";
      refreshSegments(this);
      render(this);
    }
    return r;
  };

  ensurePoll();
  layout(node);
  refreshSegments(node);
  render(node);
}

// 版面分配：编辑框按内容占 2~10 行，剩下的高度全给片段区
//
// 量行数的办法：拿一个隐藏的 div，套上编辑框同样的字体和宽度，把文字灌进去读高度。
// 直接读 textarea 的 scrollHeight 不行——框比内容高的时候它只返回框高。
let measureEl = null;
function measureBox() {
  if (measureEl?.isConnected) return measureEl;
  measureEl = document.createElement("div");
  measureEl.id = "tgs-measure";
  measureEl.style.cssText =
    "position:absolute;left:-9999px;top:0;visibility:hidden;"
    + "box-sizing:content-box;margin:0;padding:0;border:0;"
    + "white-space:pre-wrap;overflow-wrap:break-word;word-break:break-word;";
  document.body.append(measureEl);
  return measureEl;
}

function textMetrics(node) {
  const el = textEl(node);
  if (!el || !el.isConnected) return null;
  const cs = getComputedStyle(el);
  const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
  const width = el.clientWidth
    - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
  const m = {
    lineH: parseFloat(cs.lineHeight),
    padV,
    width: Math.max(60, width || 200),
    font: cs.font || `${cs.fontSize} ${cs.fontFamily}`,
    spacing: cs.letterSpacing,
  };
  // line-height 常是 "normal"（parseFloat 得到 NaN），量一次行高差就准了
  if (!m.lineH || !isFinite(m.lineH)) m.lineH = measureLineH(m);
  return m;
}

const lineHCache = new Map();
function measureLineH(m) {
  const key = `${m.font}|${m.spacing}`;
  if (lineHCache.has(key)) return lineHCache.get(key);
  const box = measureBox();
  box.style.font = m.font;
  box.style.letterSpacing = m.spacing;
  box.style.width = "400px";
  box.textContent = "M";
  const one = box.scrollHeight;
  box.textContent = "M\nM";
  const lineH = Math.max(1, box.scrollHeight - one);
  lineHCache.set(key, lineH);
  return lineH;
}

function textLines(node) {
  const w = textWidget(node);
  const m = textMetrics(node);
  if (!w || !m) return TEXT_MAX_LINES;
  const value = String(w.value ?? "");
  const cache = node.__tgs?.lineCache;
  if (cache && cache.value === value && cache.width === m.width) return cache.lines;
  const box = measureBox();
  box.style.font = m.font;
  box.style.letterSpacing = m.spacing;
  box.style.width = `${m.width}px`;
  box.textContent = value || " ";
  const lines = Math.max(1, Math.round(box.scrollHeight / m.lineH));
  if (node.__tgs) node.__tgs.lineCache = { value, width: m.width, lines };
  return lines;
}

// 打字时行数会变：稍等再量，别每敲一个字就重排一遍
function queueLayout(node) {
  const st = node.__tgs;
  if (!st) return;
  clearTimeout(st.layoutTimer);
  st.layoutTimer = setTimeout(() => layout(node), 120);
}

// 除编辑框、片段区之外，其余控件（join_mode / 上游预览条 / 状态条）已经占掉的纵向空间
//
// 用 computeSize 而不是 computedHeight：后者要等第一次绘制才填上，
// 节点刚创建时读不到就会算错账 —— 那一次错账足以让节点被迫长高一次。
function widgetSlotH(w, width) {
  if (typeof w.computeSize === "function") {
    const s = w.computeSize(width);
    if (Array.isArray(s) && isFinite(s[1])) return s[1] + 4; // 框架的 computedHeight = computeSize + 4
  }
  return w.computedHeight ?? 24;
}

function otherWidgetHeight(node, width) {
  const st = node.__tgs;
  let h = 0;
  for (const w of node.widgets) {
    if (!w || w === st.chipsWidget || w.name === "text") continue;
    h += widgetSlotH(w, width);
  }
  return h;
}

function layout(node) {
  const st = node.__tgs;
  const w = textWidget(node);
  if (!st || !w || !st.chipsWidget || st.laying) return;

  const H = node.size?.[1] || MIN_NODE_H;

  const m = textMetrics(node);
  const lineH = m?.lineH || TEXT_LINE_H;
  const padV = m?.padV ?? TEXT_PAD_V;
  const lines = textLines(node);

  const minText = TEXT_MIN_LINES * lineH + padV;
  const maxText = TEXT_MAX_LINES * lineH + padV;
  const want = Math.min(maxText, Math.max(minText, lines * lineH + padV));

  // 版面必须严丝合缝：多占 1px，_arrangeWidgets 下一帧就会把节点加高（于是每帧都长一点）
  const fixed = NODE_CHROME + otherWidgetHeight(node, node.size?.[0] ?? 400) + WIDGET_OVERHEAD * 2;
  // 片段区先保住最小高度，编辑框再退让；其余空间全归片段区，不设上限
  const text = Math.max(minText, Math.min(want, H - fixed - CHIPS_H));
  const chips = Math.max(CHIPS_H, H - fixed - text);

  if (chips === st.chipsH && text === st.textH && lines === st.lines) return;
  st.chipsH = chips;
  st.textH = text;
  st.lines = lines;

  st.laying = true;
  w.computeSize = (width) => [width ?? 300, text + TEXT_SLACK];
  st.chipsWidget.computeSize = (width) => [width ?? 300, chips + 16];
  const wrap = st.panel?.parentElement;
  if (wrap && wrap !== document.body) wrap.style.height = `${chips}px`;

  node.setDirtyCanvas?.(true, true);
  setTimeout(() => {
    const s2 = node.__tgs;
    if (s2) s2.laying = false;
  }, 60);
}

let pollTimer = null;
function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const node of app.graph?._nodes || []) {
      if (node?.type !== NODE_TYPE || !node.__tgs) continue;
      layout(node);
      render(node);
    }
  }, 400);
}

api.addEventListener("execution_error", () => {
  for (const node of app.graph?._nodes || []) {
    const st = node?.__tgs;
    if (!st || !st.pending) continue;
    st.pending = false;
    st.busy = false;
    clearTimeout(st.waitTimer);
    st.error = "上游执行报错（看 ComfyUI 控制台）";
    render(node);
  }
});

app.registerExtension({
  name: "StringMixer.TextGateSplit",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };

    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      const st = this.__tgs;
      if (!st || !message || message.ts_source === undefined) return r;

      const raw = String(message.ts_source[0] ?? "");
      const count = Number((message.ts_count && message.ts_count[0]) ?? 0) || 0;
      const used = !!(message.ts_used && message.ts_used[0]);
      const blocked = !!(message.ts_blocked && message.ts_blocked[0]);
      const allOff = !!(message.tgs_all_off && message.tgs_all_off[0]);
      const adopted = !!(message.tgs_adopted && message.tgs_adopted[0]);

      st.upSrc = raw;
      st.upAt = stamp();

      // ---- 蓄水：后端只回报"这次新增了什么"，这里把增量接在框内文本末尾
      //      故意不覆盖整框：一次排队跑多轮时，后端手里的 text 是排队那一刻的快照
      if (message.rsv_on && message.rsv_on[0]) {
        const wasPending = st.pending;
        st.pending = false;
        st.busy = false;
        st.armed = null;
        clearTimeout(st.waitTimer);

        const chunk = String(message.rsv_chunk?.[0] ?? "");
        const add = String(message.rsv_fresh?.[0] ?? "");
        const n = Number((message.rsv_n && message.rsv_n[0]) ?? 0) || 0;
        let keys = [];
        try {
          keys = JSON.parse(message.rsv_keys?.[0] ?? "[]");
        } catch {
          keys = [];
        }

        if (!(message.ts_linked && message.ts_linked[0])) {
          st.error = "上游没接线";
          render(this);
          return r;
        }
        if (chunk) {
          const cur = sourceText(this);
          const next = cur.trim() ? cur.replace(/[ 	]+$/, "") + chunk : (add || chunk.trim());
          const w = textWidget(this);
          if (w) {
            w.value = next;
            w.callback?.(next);
          }
          setProp(this, "tgs_base", next);   // 蓄水过的内容就是新基线
          setProp(this, "tgs_mbase", "");
          st.baseline = next;
          st.dirty = false;
          st.blocked = false;
          st.at = stamp();
          if (keys.length) writeSeen(this, readSeen(this).concat(keys));
          st.rsvLast = n;
          this.setDirtyCanvas?.(true, true);
          app.graph?.change?.();
          flash(this, `💧 蓄水 +${n} 段`, "info", 3000);
        } else {
          st.rsvLast = 0;
          flash(this, wasPending && !raw.trim()
            ? "上游这次是空的"
            : "💧 蓄水模式 · 这次没有新词", wasPending && !raw.trim() ? "warn" : "", 2500);
        }
        render(this);
        return r;
      }

      if (st.pending) {
        st.pending = false;
        st.busy = false;
        st.armed = null;
        st.error = "";
        clearTimeout(st.waitTimer);
        if (!(message.ts_linked && message.ts_linked[0])) {
          st.error = "上游没接线";
          render(this);
          return r;
        }
        if (!raw.trim()) {
          render(this);
          flash(this, "上游这次是空的，闸门还开着", "warn", 3500);
          return r;
        }
        applyInflow(this, raw, count, "manual");
        return r;
      }

      cancelFlash(this);

      // 上次没动过手 -> 后端这次直接把新上游放进了闸，框跟着换成新词
      if (adopted) {
        st.blocked = false;
        st.upSig = "";
        applyInflow(this, raw, count, "adopt");
        return r;
      }

      if (used) {
        if (!sourceText(this).trim() && raw.trim()) {
          st.upSig = "";
          applyInflow(this, raw, count, "auto");
        } else {
          render(this);
        }
      } else if (allOff) {
        st.blocked = blocked;
        flash(this, "⚠ 片段全关，本次输出为空", "error", 5000);
      } else if (blocked) {
        st.blocked = true;
        flash(this, `⚠ 上游 ${raw.length} 字被闸门拦下（${gateState(this).reason || "你动过手"}）· 点 ✎ 放入`, "warn", 5000);
      } else if (!raw.trim() && sourceText(this).trim()) {
        // 上游这次给了空：旧词留着，但要说清楚（不然会以为它悄悄没跟上）
        st.blocked = false;
        warnEmptyUpstream(this);
      } else {
        st.blocked = false;
        render(this);
      }
      return r;
    };
  },

  loadedGraphNode(node) {
    if (node?.type !== NODE_TYPE) return;
    setupNode(node);
    render(node);
  },
});
