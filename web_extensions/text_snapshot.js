// TextSnapshot —— 文本闸门：空着就放上游进来（并留在框里），有字就拦下上游
//
// 闸门的读法（状态由"框里有没有字"表达，不需要额外开关）：
//   * 框空 + 接了上游  -> 闸门开着：下次执行时上游整段流进来，写进框，之后可直接改
//   * 框空 + 没接上游  -> 空：没上游也没内容（红色直说，不静默）
//   * 框里有字        -> 闸门关着：只输出框里的字；上游若和框里不一样，执行后明确报警
//   * 清空框 / 点 ✕   -> 重新开闸（上游下次执行时再流进来）
//   * 「✎ 放入上游」   -> 手动开一次闸：把上游拉进来（框里已有的要确认才覆盖）
//
// 为什么 queue 可以写框：只有在"框是空的"时候写。空的框没有任何内容可丢，
// 而这次执行用的恰恰就是上游——把流过来的东西留在框里 = 所见即所出。
// 有字时 queue 绝不写框（写了就是覆盖你的东西）。
//
// 取词只走局部执行：app.queuePrompt(0, 1, { queueNodeIds: [本节点 id] })
//   -> ComfyUI 只跑本节点和它的上游（后端 execution.py: validate_prompt 按
//      partial_execution_list 收执行目标），其他分支一概不碰
//   -> 上游没变时走执行缓存；缓存命中也会补发 'executed' 事件
//      （comfy_execution/asset_enrichment.py: emit_cached_output），所以点按钮是瞬发
//
// 三只眼睛看同一件事：
//   1. 框：你的内容（空 = 闸门开）
//   2. 上游预览条：上次执行时上游给了什么（只读、可选中、可滚动；被拦下时左边变琥珀）
//   3. 状态条：哪一态 + 按钮
//
// 注意：改完 JS 要浏览器硬刷新（Ctrl+Shift+R），Python 侧改了要重启 ComfyUI。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "TextSnapshot";
const BAR_H = 30;        // 状态条固定高度
const UP_H = 52;         // 上游预览条固定高度（标题行 + 两行正文）
const UP_CHARS = 1200;   // 预览最多渲染多少字（再多显示会拖慢 DOM；标题里给总字数）
const MIN_NODE_H = 270;  // 节点高度下限（编辑框 + 预览条 + 状态条）
const TEXT_MIN = 108;    // 编辑框最小高度
const TEXT_MAX = 900;    // 编辑框最大高度
// 节点里不归编辑框的部分（canvas 单位，实测）：标题 + 预览条 + 状态条 + 间隙
const FIXED_TOP = 26 + (UP_H + 16) + (BAR_H + 16) + 2 * 4 + 10;
const RETRY_MS = 200;    // 队列正在处理别的提交时的重试间隔
const RETRY_MAX = 10;    // 重试次数上限（约 2 秒）
const IDLE_POLL_MS = 800;            // 挂起时多久探一次队列
const IDLE_MAX_MS = 30 * 60 * 1000;  // 挂起兜底：半小时还没空就放弃
const ARM_MS = 5000;     // "再点一次"的确认态保持时间
const WAIT_MS = 300000;  // 等后端回填的兜底超时（上游可能是 LLM，给 5 分钟）

// ------------------------------------------------------------------ 样式

function ensureStyle() {
  if (document.getElementById("ts-style")) return;
  const css = document.createElement("style");
  css.id = "ts-style";
  css.textContent = `
.ts-bar {
  display: flex; align-items: center; gap: 6px; height: 100%;
  box-sizing: border-box; padding: 0 2px; overflow: hidden;
}
.ts-btn, .ts-clear {
  flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center;
  height: 24px; border-radius: 6px; cursor: pointer;
  font-family: inherit; font-size: 12px; line-height: 1; white-space: nowrap;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.ts-btn { padding: 0 10px; }
.ts-clear { padding: 0 7px; }
.ts-btn {
  color: #cfe0f5; background: rgba(120, 140, 170, 0.18);
  border: 1px solid rgba(150, 165, 195, 0.45);
}
.ts-btn:hover:not([disabled]) { background: rgba(140, 160, 195, 0.32); }
.ts-btn[disabled] { opacity: 0.5; cursor: default; }
/* 闸门开（框空）：蓝 */
.ts-btn[data-state="follow"] {
  color: #a9d6ff; background: rgba(64, 140, 220, 0.2);
  border-color: rgba(110, 180, 240, 0.6);
}
/* 有手改：琥珀 */
.ts-btn[data-state="dirty"] {
  color: #ffd98a; background: rgba(214, 158, 46, 0.22);
  border-color: rgba(230, 180, 80, 0.72);
}
/* 确认：更亮的琥珀 */
.ts-btn[data-state="armed"] {
  color: #ffe9bd; background: rgba(214, 138, 46, 0.4);
  border-color: rgba(240, 178, 78, 0.95);
}
/* 出错：红 */
.ts-btn[data-state="error"] {
  color: #ffb4b4; background: rgba(214, 74, 74, 0.2);
  border-color: rgba(240, 120, 120, 0.72);
}
/* 进行中：灰 */
.ts-btn[data-state="busy"] {
  color: #c3cbd9; background: rgba(120, 130, 150, 0.18);
  border-color: rgba(160, 170, 190, 0.4);
}
/* 空：没上游也没内容 */
.ts-btn[data-state="void"] {
  color: #c9b4b4; background: rgba(160, 90, 90, 0.14);
  border-color: rgba(190, 110, 110, 0.5);
}
.ts-clear {
  color: rgba(200, 210, 230, 0.7); background: transparent;
  border: 1px solid rgba(150, 165, 195, 0.35);
}
.ts-clear:hover { color: #ffb4b4; border-color: rgba(240, 120, 120, 0.7); }
.ts-clear[data-armed="1"] {
  color: #ffd98a; border-color: rgba(230, 180, 80, 0.8);
  background: rgba(214, 158, 46, 0.18);
}
.ts-status {
  flex: 1 1 auto; min-width: 0; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap;
  font-size: 11px; color: rgba(200, 210, 230, 0.72);
}
.ts-status[data-tone="info"] { color: #9fc8f2; }
.ts-status[data-tone="warn"] { color: #ffcf7a; }
.ts-status[data-tone="error"] { color: #ff9b9b; }

/* 上游只读预览：只看、可选中、可滚动；永远不写进编辑框 */
.ts-up {
  display: flex; flex-direction: column; gap: 2px; height: 100%;
  box-sizing: border-box; padding: 3px 6px 4px;
  border-radius: 6px; border-left: 3px solid rgba(150, 165, 195, 0.4);
  background: rgba(0, 0, 0, 0.2);
}
.ts-up[data-mode="follow"] { border-left-color: rgba(110, 180, 240, 0.85); }
.ts-up[data-mode="snapshot"] { border-left-color: rgba(150, 165, 195, 0.35); }
.ts-up[data-mode="void"] { border-left-color: rgba(190, 110, 110, 0.6); }
/* 上游有内容但被闸门拦下：琥珀 */
.ts-up[data-blocked="1"] { border-left-color: rgba(230, 180, 80, 0.95); }
.ts-up-head {
  flex: 0 0 auto; font-size: 10px; line-height: 12px;
  color: rgba(170, 185, 210, 0.75); white-space: nowrap;
  overflow: hidden; text-overflow: ellipsis;
}
.ts-up-body {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden;
  font-size: 11px; line-height: 15px; white-space: pre-wrap; word-break: break-word;
  color: rgba(205, 215, 235, 0.9); user-select: text; cursor: text;
}
.ts-up-body[data-empty="1"] { color: rgba(170, 185, 210, 0.5); font-style: italic; }
`;
  document.head.append(css);
}

// ------------------------------------------------------------------ 小工具

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textWidget(node) {
  return (node.widgets || []).find((w) => w && w.name === "text");
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

// ------------------------------------------------------------------ 上游预览条

function updatePreview(node) {
  const st = node.__ts;
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

// ------------------------------------------------------------------ 状态条

function render(node) {
  const st = node.__ts;
  if (!st || !st.btn) return;

  const mode = modeOf(node);
  // 脏判定：当前文本 != 上次从上游拿到的原文（只在闸门关着时才有意义）
  st.dirty = mode === "snapshot" && st.baseline != null && sourceText(node) !== st.baseline;

  let state = "snapshot";
  let label = "✎ 换成最新上游";
  if (st.waiting) {
    state = "armed";
    label = "⏳ 等队列空 · 点此取消";
  } else if (st.busy) {
    state = "busy";
    label = "✎ 放入中…";
  } else if (st.error) {
    state = "error";
    label = "⚠ 失败，点此重试";
  } else if (mode === "void") {
    state = "void";
    label = "✎ 未接上游";
  } else if (mode === "follow") {
    state = "follow";
    label = "✎ 放入上游";
  } else if (st.armed === "pull") {
    state = "armed";
    label = "⚠ 再点一次覆盖";
  } else if (st.dirty) {
    state = "dirty";
    label = "✎ 覆盖改动";
  }

  let note;
  let tone = "";
  if (st.waiting) {
    note = "队列正忙 · 这一轮跑完会自动放入";
    tone = "warn";
  } else if (st.busy) {
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
  } else if (st.dirty) {
    note = (st.at ? "闸门关（已手改）" : "闸门关（手写）") + " · 点 ✕ 重新开闸";
    tone = "warn";
  } else if (st.blocked) {
    note = "闸门关 · 上游被拦下（点 ✎ 放入）";
    tone = "warn";
  } else if (st.at) {
    note = `闸门关 · ${st.at} 放入 · ${st.count} 段`;
  } else {
    note = "闸门关（手写） · 点 ✕ 重新开闸";
  }
  if (!st.busy && !st.error && st.flash) {
    note = st.flash.text;
    tone = st.flash.tone || "";
  }

  // 清空按钮：只有闸门关着时才有意义（开着时框本来就是空的）
  const showClear = mode === "snapshot";
  const clearArmed = st.armed === "clear";

  const sig = [
    state, label, note, tone, showClear ? 1 : 0, clearArmed ? 1 : 0, st.busy ? 1 : 0,
    st.waiting ? 1 : 0,
  ].join("|");
  if (st.sig === sig) {
    updatePreview(node);
    return;
  }
  st.sig = sig;

  st.btn.dataset.state = state;
  // 挂起的时候按钮要能点（点一下取消等待）
  st.btn.disabled = (!!st.busy && !st.waiting) || mode === "void";
  st.btn.textContent = label;
  st.btn.title =
    (st.error ? st.error + "\n\n" : "") +
    "把上游放进框里：只执行本节点和它的上游（其他分支不动），上游没变时走缓存，基本瞬发。\n" +
    "框空着时不用点它——下次执行上游会自己流进来。";

  if (st.clearBtn) {
    st.clearBtn.style.display = showClear ? "" : "none";
    st.clearBtn.textContent = clearArmed ? "⚠ 清空?" : "✕";
    st.clearBtn.dataset.armed = clearArmed ? "1" : "";
    st.clearBtn.title = clearArmed
      ? "再点一次：清空框，重新开闸（下次执行上游会流进来）"
      : "清空框，重新开闸";
    st.clearBtn.disabled = !!st.busy;
  }

  st.status.textContent = note;
  st.status.dataset.tone = tone;
  updatePreview(node);
}

// 一次性提示（比如"上游已流入"）
function flash(node, text, tone = "", ms = 3500) {
  const st = node.__ts;
  if (!st) return;
  st.flash = { text, tone };
  clearTimeout(st.flashTimer);
  st.flashTimer = setTimeout(() => {
    const s2 = node.__ts;
    if (!s2) return;
    s2.flash = null;
    render(node);
  }, ms);
  render(node);
}

function cancelFlash(node) {
  const st = node.__ts;
  if (!st) return;
  clearTimeout(st.flashTimer);
  st.flash = null;
}

function arm(node, kind) {
  const st = node.__ts;
  if (!st) return;
  cancelFlash(node);
  st.armed = kind;
  clearTimeout(st.armTimer);
  st.armTimer = setTimeout(() => {
    const s2 = node.__ts;
    if (!s2) return;
    s2.armed = null;
    render(node);
  }, ARM_MS);
  render(node);
}

// 把一段上游原文写进框：这是唯一会写控件的地方，调用前必须确认"写进去不丢东西"
function applyInflow(node, raw, count, why) {
  const st = node.__ts;
  const w = textWidget(node);
  if (!st || !w) return;
  w.value = raw;
  st.baseline = raw;
  st.dirty = false;
  st.blocked = false;
  st.armed = null;
  st.count = count;
  st.at = stamp();
  clearTimeout(st.armTimer);
  node.setDirtyCanvas?.(true, true);
  app.graph?.change?.(); // 标脏：内容变了，关窗口前会提示保存
  render(node);
  if (!raw.trim()) return;
  flash(node, why === "auto"
    ? `上游 ${raw.length} 字已流入框内，可直接改`
    : `已放入上游 ${raw.length} 字`, "info", 3500);
}

// ------------------------------------------------------------------ 手动放入（按钮）

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

// 队列忙的时候点“放入上游”：别硬失败，挂起等它空下来再补一次
function startQueueWait(node) {
  const st = node.__ts;
  if (!st) return;
  st.waiting = true;
  st.busy = true;      // 按钮这时是“点此取消”
  st.pending = false;
  st.error = "";
  st.idleSince = Date.now();
  clearInterval(st.idleTimer);
  st.idleTimer = setInterval(async () => {
    const s2 = node.__ts;
    if (!s2 || !s2.waiting || !app.graph?._nodes?.includes(node)) {
      clearInterval(s2?.idleTimer);
      return;
    }
    if (Date.now() - s2.idleSince > IDLE_MAX_MS) {
      stopQueueWait(node, "等队列空太久了，先放弃了");
      return;
    }
    if (await queueBusy()) return;
    clearInterval(s2.idleTimer);
    s2.idleTimer = null;
    s2.waiting = false;
    s2.busy = false;   // 让 pull 能进得去
    pull(node);        // 队列空了，补这次放入
  }, IDLE_POLL_MS);
  render(node);
}

function stopQueueWait(node, why = "") {
  const st = node.__ts;
  if (!st) return;
  clearInterval(st.idleTimer);
  st.idleTimer = null;
  st.waiting = false;
  st.busy = false;
  st.pending = false;
  if (why) st.error = why;
  render(node);
}

async function pull(node) {
  const st = node.__ts;
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
      // 第三个参数 = 局部执行的目标节点；只跑本节点和它的上游
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
    if (busySeen && !lastError) {
      // 队列正忙：挂起等它空，空了自动补（不用人再点一次）
      startQueueWait(node);
      flash(node, "队列正忙 · 空下来会自动放入", "warn", 4000);
      return;
    }
    st.pending = false;
    st.busy = false;
    st.error = lastError || "队列正忙，稍后再点";
    render(node);
    return;
  }

  clearTimeout(st.waitTimer);
  st.waitTimer = setTimeout(() => {
    const s2 = node.__ts;
    if (!s2 || !s2.pending) return;
    s2.pending = false;
    s2.busy = false;
    s2.error = "等后端回填超时（看 ComfyUI 控制台）";
    render(node);
  }, WAIT_MS);
}

function onMainClick(node) {
  const st = node.__ts;
  if (!st) return;
  if (st.waiting) {                 // 挂起中再点 = 取消等待
    stopQueueWait(node);
    flash(node, "已取消等待队列", "info", 2500);
    return;
  }
  if (st.busy) return;
  cancelFlash(node);

  const mode = modeOf(node);
  if (mode === "void") {
    st.error = "左边 source 没接线，先接上";
    render(node);
    return;
  }
  // 有手改才需要"再点一次"；原样覆盖只是重新取最新，不拦
  if (mode === "snapshot" && st.dirty && st.armed !== "pull") {
    arm(node, "pull");
    return;
  }
  pull(node);
}

function clearBox(node) {
  const st = node.__ts;
  const w = textWidget(node);
  if (!st || !w) return;
  w.value = "";
  st.baseline = "";
  st.dirty = false;
  st.blocked = false;
  st.armed = null;
  st.at = "";
  st.count = 0;
  st.flash = null;
  node.setDirtyCanvas?.(true, true);
  app.graph?.change?.();
  render(node);
  flash(node, "已开闸 · 下次执行上游会流进来", "info", 3000);
}

function onClearClick(node) {
  const st = node.__ts;
  if (!st || st.busy || modeOf(node) !== "snapshot") return;
  cancelFlash(node);
  // 原样内容清掉不心疼（随时能再放）；手改过的要确认一次
  if (st.dirty && st.armed !== "clear") {
    arm(node, "clear");
    return;
  }
  clearBox(node);
}

// ------------------------------------------------------------------ 节点装配

function setupNode(node) {
  if (node.__ts) return;
  ensureStyle();

  const st = (node.__ts = {
    btn: null,
    clearBtn: null,
    status: null,
    upEl: null,
    upHead: null,
    upBody: null,
    baseline: sourceText(node), // 打开时视为"当前内容就是基线"，不会一上来就报脏
    dirty: false,
    armed: null, // null | "pull" | "clear"
    busy: false,
    pending: false,
    waiting: false,      // 队列忙 -> 挂起等它空
    idleTimer: null,
    idleSince: 0,
    error: "",
    at: "",
    count: 0,
    blocked: false,  // 上次执行时上游有内容但被闸门拦下
    upSrc: null,     // 上次执行时上游给的原文（只用于预览）
    upAt: "",
    upCount: 0,
    upSig: "",
    flash: null,
    sig: "",
  });

  // ---- 上游预览条（只读，不参与任何输入；放在编辑框和按钮之间）
  const upEl = document.createElement("div");
  upEl.className = "ts-up";
  upEl.dataset.mode = "follow";
  upEl.addEventListener("pointerdown", (e) => e.stopPropagation());
  upEl.addEventListener("mousedown", (e) => e.stopPropagation());

  const upHead = document.createElement("div");
  upHead.className = "ts-up-head";
  const upBody = document.createElement("div");
  upBody.className = "ts-up-body";
  upEl.append(upHead, upBody);

  st.upEl = upEl;
  st.upHead = upHead;
  st.upBody = upBody;

  const upWidget = node.addDOMWidget("ts_up", "ts_up", upEl, { serialize: false });
  upWidget.serialize = false;
  // 框架会把 DOM 控件的外部高度算掉约 16px（内边距/间距），所以要多给 16 —— 同 PromptToggle。
  upWidget.computeSize = (width) => [width ?? 280, UP_H + 16];

  // ---- 按钮 / 状态条
  const bar = document.createElement("div");
  bar.className = "ts-bar";
  bar.addEventListener("pointerdown", (e) => e.stopPropagation());
  bar.addEventListener("mousedown", (e) => e.stopPropagation());

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "ts-btn";
  btn.textContent = "✎ 放入上游";
  btn.addEventListener("pointerdown", (e) => e.stopPropagation());
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onMainClick(node);
  });

  const clearBtn = document.createElement("button");
  clearBtn.type = "button";
  clearBtn.className = "ts-clear";
  clearBtn.textContent = "✕";
  clearBtn.style.display = "none";
  clearBtn.addEventListener("pointerdown", (e) => e.stopPropagation());
  clearBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    onClearClick(node);
  });

  const status = document.createElement("span");
  status.className = "ts-status";

  bar.append(btn, clearBtn, status);
  st.btn = btn;
  st.clearBtn = clearBtn;
  st.status = status;

  const domWidget = node.addDOMWidget("ts_bar", "ts_bar", bar, { serialize: false });
  // 这个前端版本按 widget.serialize 判断是否写进 widgets_values（不是 options.serialize），
  // 两个都置上，才不会在存档里多出一个空值把后面的控件位置挤歪。
  domWidget.serialize = false;
  domWidget.computeSize = (width) => [width ?? 280, BAR_H + 16];

  // 用户敲字 -> 立刻更新（空->开闸，有字->关闸）
  const w = textWidget(node);
  if (w) {
    const cb = w.callback;
    w.callback = function (...args) {
      const r = cb?.apply(this, args);
      cancelFlash(node);
      render(node);
      return r;
    };
  }

  if (node.size && node.size[1] < MIN_NODE_H) {
    node.size = [Math.max(node.size[0] || 280, 340), MIN_NODE_H];
  }

  // 关键：node.computeSize() 是最小高度；让它跟着当前高度涨，节点就只能变高不能变矮。
  // 钉成常数，编辑框高度由 layoutBox() 按实际节点高度分配。
  const baseComputeSize = node.computeSize.bind(node);
  node.computeSize = function (out) {
    const s = baseComputeSize(out);
    return [s[0], MIN_NODE_H];
  };

  // 接线 / 断线立刻反映（开闸 <-> 空）
  const onConnectionsChange = node.onConnectionsChange;
  node.onConnectionsChange = function (type, index, connected, linkInfo) {
    const r = onConnectionsChange?.apply(this, arguments);
    render(this);
    return r;
  };

  // 拉高/压矮节点：多出来的高度全给编辑框（预览条与状态条不动）
  const onResize = node.onResize;
  node.onResize = function () {
    const r = onResize?.apply(this, arguments);
    layoutBox(this);
    return r;
  };

  // 载入工作流：控件值在 onConfigure 里才落位，落位后把当前内容当作基线——
  // 不假装"已同步"，也不要一开图就喊脏。
  const onConfigure = node.onConfigure;
  node.onConfigure = function () {
    const r = onConfigure?.apply(this, arguments);
    const s = this.__ts;
    if (s) {
      s.baseline = sourceText(this);
      s.dirty = false;
      s.blocked = false;
      s.armed = null;
      s.error = "";
      s.at = "";
      s.count = 0;
      s.flash = null;
      s.upSrc = null; // 预览条要等这次会话执行过一次才有内容
      s.upAt = "";
      s.upSig = "";
      s.sig = "";
      render(this);
    }
    return r;
  };

  // 撤销、脚本改值、工作流重载这类不经过 callback 的变化，靠一次廉价巡检兜住
  ensurePoll();
  layoutBox(node);
  render(node);
}

// 400ms 一次，只做字符串比较 + 必要时写 DOM（render 内部有签名去重）
// 版面：节点多高，编辑框就多高（减去固定部分），不留空白
function layoutBox(node) {
  const st = node.__ts;
  const w = textWidget(node);
  if (!st || !w || st.laying) return;
  const H = node.size?.[1] || MIN_NODE_H;
  const text = Math.max(TEXT_MIN, Math.min(TEXT_MAX, H - FIXED_TOP));
  if (text === st.textH) return;
  st.textH = text;
  st.laying = true;
  w.computeSize = (width) => [width ?? 280, text];
  node.setDirtyCanvas?.(true, true);
  setTimeout(() => {
    const s2 = node.__ts;
    if (s2) s2.laying = false;
  }, 60);
}

let pollTimer = null;
function ensurePoll() {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    for (const node of app.graph?._nodes || []) {
      if (node?.type !== NODE_TYPE || !node.__ts) continue;
      layoutBox(node);
      render(node);
    }
  }, 400);
}

// 上游执行报错时不会有 'executed' 回来，把挂着的节点从"放入中"解放出来
api.addEventListener("execution_error", () => {
  for (const node of app.graph?._nodes || []) {
    const st = node?.__ts;
    if (!st || !st.pending) continue;
    st.pending = false;
    st.busy = false;
    clearTimeout(st.waitTimer);
    st.error = "上游执行报错（看 ComfyUI 控制台）";
    render(node);
  }
});

app.registerExtension({
  name: "StringMixer.TextSnapshot",
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);
      setupNode(this);
      return r;
    };

    // 后端回报：一份 ui 同时喂给两条路
    //   * 点了按钮的那次（pending）-> 必定写框（人已经确认过了）
    //   * 普通排队且本次输出取自上游（ts_used=1）-> 闸门开着，把流进来的东西留在框里
    //   * 普通排队但用的是框内文字 -> 只更新预览条；若上游和框里不一样，报警
    const onExecuted = nodeType.prototype.onExecuted;
    nodeType.prototype.onExecuted = function (message) {
      const r = onExecuted?.apply(this, arguments);
      const st = this.__ts;
      if (!st || !message || message.ts_source === undefined) return r;

      const raw = String(message.ts_source[0] ?? "");
      const count = Number((message.ts_count && message.ts_count[0]) ?? 0) || 0;
      const used = !!(message.ts_used && message.ts_used[0]);
      const blocked = !!(message.ts_blocked && message.ts_blocked[0]);

      // 预览条永远跟着走：它只回答"上游这次给了什么"
      st.upSrc = raw;
      st.upCount = count;
      st.upAt = stamp();

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
          // 上游是空的：不写框（写进去也不会有字），保持开着
          render(this);
          flash(this, "上游这次是空的，闸门还开着", "warn", 3500);
          return r;
        }
        applyInflow(this, raw, count, "manual");
        return r;
      }

      cancelFlash(this); // 新一次执行来了，上一条"流入/开闸"提示到此为止

      if (used) {
        // 闸门开着、本次输出取自上游：把流进来的东西留在框里（空的框没有内容可丢）
        if (!sourceText(this).trim()) {
          st.upSig = "";
          applyInflow(this, raw, count, "auto");
        } else {
          // 执行过程中你已经写了东西：以你为准，不覆盖
          flash(this, "你已经写了内容，上游这次没放进来", "warn", 4000);
        }
      } else {
        st.blocked = blocked;
        if (blocked) {
          flash(this, `⚠ 上游 ${raw.length} 字被闸门拦下（框里有你的内容）· 点 ✎ 放入`, "warn", 5000);
        } else {
          render(this);
        }
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
