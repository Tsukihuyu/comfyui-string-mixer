// 系列共用：DOM 控件（多行文本框、Prompt Toggle 的面板）永远浮在 canvas 之上。
// 别的节点盖得住节点的画布部分（标题、开关、下拉框），却盖不住这些 DOM 元素，
// 于是出现「一部分被遮挡、一部分又浮在上面」。
//
// 这里统一处理：只要某个节点被「排在它后面（即画面上更靠前）」的节点矩形压住，
// 就把它所有 DOM 控件的包装元素临时设为 visibility:hidden；对方移开自动恢复。

import { app } from "../../scripts/app.js";

const TYPES = new Set([
  "StringMixer",
  "StringMixer5",
  "StringMixer7",
  "PromptSanitizer",
  "PromptToggle",
  "CameraMixer",
  "TextSnapshot",
  "TextGateSplit",
]);

const TICK_MS = 250; // 与 prompt_toggle 的巡检同频，够用且开销可忽略

function isCovered(node, nodes, index) {
  const x1 = node.pos[0];
  const y1 = node.pos[1];
  const x2 = x1 + node.size[0];
  const y2 = y1 + node.size[1];
  for (let i = index + 1; i < nodes.length; i++) {
    const o = nodes[i];
    if (!o || o.mode === 4 || !o.size) continue; // 4 = bypass
    if (o.pos[0] < x2 && o.pos[0] + o.size[0] > x1 &&
        o.pos[1] < y2 && o.pos[1] + o.size[1] > y1) {
      return true;
    }
  }
  return false;
}

// 一个控件可能没有独立包装（老前端），那就直接拿元素本身
function wrappersOf(node) {
  const out = [];
  for (const w of node.widgets || []) {
    const el = w?.element;
    if (!el) continue;
    const wrap = el.closest?.(".dom-widget") || el;
    if (wrap && !out.includes(wrap)) out.push(wrap);
  }
  return out;
}

function tick() {
  const nodes = app.graph?._nodes || [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if (!node || !TYPES.has(node.type) || !node.size) continue;
    const want = isCovered(node, nodes, i) ? "hidden" : "visible";
    for (const wrap of wrappersOf(node)) {
      if (wrap.style.visibility !== want) wrap.style.visibility = want;
    }
  }
}

app.registerExtension({
  name: "StringMixer.OverlapGuard",
  setup() {
    setInterval(tick, TICK_MS);
  },
});
