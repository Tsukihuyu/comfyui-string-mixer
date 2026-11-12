// 双击就地改词 —— 真界面验证（无头 Edge + CDP，连 127.0.0.1:8188 的 CPU 实例）
//
// 用法：node tools/shots/verify_edit.mjs
// 只读地驱动页面：建节点、注文字、派发合成指针事件，把每一步的实测值打印成 JSON。
// 截图落在 .verify/（.gitignore 里已忽略）。

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = process.env.SHOT_OUT || path.join(ROOT, ".verify");
const APP = process.env.COMFY_URL || "http://127.0.0.1:8188";
const EDGE = process.env.EDGE_PATH || "C:/Program Files (x86)/Microsoft/EdgeCore/156.0.4314.58/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9412);

fs.mkdirSync(OUT, { recursive: true });

const profile = path.join(HERE, ".profile-verify");
const edge = spawn(
  EDGE,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--window-size=1700,1300",
    APP,
  ],
  { stdio: "ignore" },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function target() {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const page = pages.find((t) => t.url.includes(APP));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("浏览器没起来");
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let seq = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result);
};
const cdp = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++seq;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails));
  }
  return r.result.value;
}

await cdp("Runtime.enable");
await cdp("Page.enable");
await cdp("Emulation.setDeviceMetricsOverride", {
  width: 1700, height: 1300, deviceScaleFactor: 2, mobile: false,
});
// 无头 Edge 默认上报 prefers-reduced-motion: reduce，前端会把过渡时长压到 1e-06s，
// 颜色渐变根本不会发生——那是无障碍的正确行为，不是 bug。验证渐变必须显式关掉它。
await cdp("Emulation.setEmulatedMedia", {
  features: [{ name: "prefers-reduced-motion", value: "no-preference" }],
});

let ready = false;
for (let i = 0; i < 90; i++) {
  ready = await evaluate("!!(window.app && window.app.graph && window.LiteGraph)").catch(() => false);
  if (ready) break;
  await sleep(1000);
}
if (!ready) throw new Error(`页面没准备好：${page.url}`);
console.log(`attached: ${page.url}`);

// 页面里的公共帮手：合成单击/双击、读 mask、算节点包围盒
const PREAMBLE = `
const __wait = (ms) => new Promise((r) => setTimeout(r, ms));
const __widget = (node, name) => (node.widgets || []).find((w) => w.name === name);
function __setText(node, value) {
  const w = __widget(node, "text");
  w.value = value;
  w.callback?.(value);
  node.setDirtyCanvas?.(true, true);
  app.canvas.setDirty(true, true);
}
function __mask(node) {
  try { return JSON.parse(node.properties?.prompt_toggle_mask || "[]"); } catch { return []; }
}
function __chips() { return [...document.querySelectorAll(".smchip")]; }
function __labels() { return __chips().map((e) => e.querySelector(".lbl")?.textContent ?? ""); }
function __tap(i) {
  const el = document.querySelector('.smchip[data-i="' + i + '"]');
  if (!el) throw new Error("没有第 " + i + " 个词片");
  const r = el.getBoundingClientRect();
  const x = Math.round(r.left + r.width / 2);
  const y = Math.round(r.top + r.height / 2);
  const opt = { bubbles: true, button: 0, clientX: x, clientY: y, pointerId: 1, isPrimary: true };
  el.dispatchEvent(new PointerEvent("pointerdown", opt));
  window.dispatchEvent(new PointerEvent("pointerup", opt));
}
async function __dbl(i) { __tap(i); await __wait(90); __tap(i); await __wait(140); }
function __place(node, pad = 22) {
  const c = app.canvas;
  c.ds.scale = 1;
  c.ds.offset = [-node.pos[0] + 120, -node.pos[1] + 160];
  c.draw(true);
  return new Promise((res) => setTimeout(() => {
    const titleH = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
    const o = c.ds.offset;
    res({
      x: Math.max(0, Math.round(node.pos[0] + o[0] - pad)),
      y: Math.max(0, Math.round(node.pos[1] + o[1] - titleH - pad)),
      w: Math.round(node.size[0] + pad * 2),
      h: Math.round(node.size[1] + titleH + pad * 2),
    });
  }, 900));
}
`;

const results = [];
async function shot(name, clip) {
  await sleep(300);
  const s = await cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 },
  });
  const out = path.join(OUT, name);
  fs.writeFileSync(out, Buffer.from(s.data, "base64"));
  return out;
}

async function run(label, body) {
  const value = await evaluate(`(async () => {\n${PREAMBLE}\n${body}\n})()`);
  results.push({ step: label, ...value });
  console.log(`✔ ${label}\n   ${JSON.stringify(value)}`);
  return value;
}

// ---------------------------------------------------------------- 1. 建节点 + 铺词
const setup = await run(
  "建节点并铺 5 段词",
  `
app.graph.clear();
const n = LiteGraph.createNode("PromptToggle");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1500);
__setText(n, "masterpiece, 1girl, kimono, cherry blossoms, smile");
await __wait(1400);
window.__n = n;
app.canvas.ds.scale = 1;
app.canvas.ds.offset = [-n.pos[0] + 120, -n.pos[1] + 160];
app.canvas.draw(true);
await __wait(900);
return { chips: __labels(), mask: __mask(n), nodeH: n.size[1] };
`,
);
if (!setup.chips?.length) throw new Error("词片没渲染出来，后面的验证没意义");

// ---------------------------------------------------------------- 2. 单击延迟 220ms
await run(
  "单击：立刻读不变、220ms 后翻转",
  `
const n = window.__n;
const before = __mask(n);
__tap(1);
const immediate = __mask(n);
await __wait(400);
const after = __mask(n);
return { before, immediate, after, flipped: immediate[1] === before[1] && after[1] !== before[1] };
`,
);

// ---------------------------------------------------------------- 2b. 就地换色（绿↔红渐变）
const fade = await run(
  "开关不重建元素：同一个 DOM 节点，颜色在过渡中（0/80ms/之后 三点取值）",
  `
const n = window.__n;
const pick = () => document.querySelector('.smchip[data-i="3"]');
const el = pick();
window.__fadeEl = el;
const cs = getComputedStyle(el);
const t0 = cs.backgroundColor;
const transition = cs.transitionProperty + " / " + cs.transitionDuration;
const titleBefore = el.title.split("；")[0];
__tap(3);              // 单击 -> 220ms 后真的切换
await __wait(300);     // 切换刚发生：此刻正处在 280ms 的过渡里
const mid = getComputedStyle(el).backgroundColor;
const titleAfter = el.title.split("；")[0];
return {
  sameElement: !!el.isConnected && el === pick(),
  cls: el.className,
  transition, t0, mid,
  interpolated: mid !== t0,
  titleBefore, titleAfter,
  count: document.querySelector(".pfl-status")?.textContent,
  clip: await __place(n, 0),
};
`,
);
const shotFade = await shot("04-fade-mid.png", fade.clip);

const fadeEnd = await run(
  "过渡落定 + 批量「全关」也是就地换色（元素不重建）",
  `
const n = window.__n;
const el = window.__fadeEl;
const pick = (i) => document.querySelector('.smchip[data-i="' + i + '"]');
await __wait(500);
const end = getComputedStyle(el).backgroundColor;
const sameAfterFade = !!el.isConnected && el === pick(3);
const beforeBulk = [...document.querySelectorAll(".smchip")];
// 点「全关」按钮
const bulkBtn = (label) => [...document.querySelectorAll("button")].find((b) => b.textContent === label);
bulkBtn("全关")?.click();
await __wait(120);
const midBulk = getComputedStyle(pick(0)).backgroundColor;
await __wait(500);
const afterBulk = getComputedStyle(pick(0)).backgroundColor;
const countOff = document.querySelector(".pfl-status")?.textContent;
const bulkMask = __mask(n);
// 复位成全开，后面的步骤照原样跑
bulkBtn("全开")?.click();
await __wait(500);
return {
  end,
  sameAfterFade,
  sameElementsAfterBulk: beforeBulk.every((b, i) => b === pick(i)),
  classes: beforeBulk.map((b) => b.className),
  midBulk, afterBulk, bulkFaded: midBulk !== afterBulk,
  countOff, bulkMask,
  maskReset: __mask(n),
  clip: await __place(n, 0),
};
`,
);
const shotBulk = await shot("05-all-off.png", fadeEnd.clip);

// ---------------------------------------------------------------- 3. 双击进入编辑
const enter = await run(
  "双击第 2 个词 -> 原地出现输入框（内容全选，开关不动）",
  `
const n = window.__n;
const ch = n.__pt.chips;
ch.__log = [];
const oh = ch.handleTap.bind(ch);
ch.handleTap = (...a) => { ch.__log.push(["tap", a[0], Math.round(performance.now())]); return oh(...a); };
const ob = ch.beginEdit.bind(ch);
ch.beginEdit = (...a) => { ch.__log.push(["beginEdit", a[0], Math.round(performance.now())]); return ob(...a); };
const maskBefore = __mask(n);
await __dbl(2);
const input = document.querySelector(".smchip-edit");
return {
  opened: !!input,
  chipCount: __chips().length,
  isInput: input?.tagName,
  value: input?.value,
  focused: document.activeElement === input,
  selectedAll: input ? input.selectionStart === 0 && input.selectionEnd === input.value.length : false,
  maskBefore, maskAfter: __mask(n),
  log: ch.__log,
  lastClick: ch.lastClick && { i: ch.lastClick.i, t: Math.round(ch.lastClick.t) },
  editing: ch.editing ? ch.editing.i : null,
  dragging: !!ch.drag,
  editingDom: (() => {
    const b = document.querySelector(".smchip.editing");
    if (!b) return null;
    const rb = b.getBoundingClientRect();
    const ri = b.querySelector(".smchip-edit").getBoundingClientRect();
    const ro = document.querySelector('.smchip[data-i="0"]').getBoundingClientRect();
    return {
      children: [...b.children].map((c) => c.className || c.tagName),
      hasWcol: !!b.querySelector(".wcol"),
      hasDel: !!b.querySelector(".smchip-del"),
      boxW: Math.round(rb.width), boxH: Math.round(rb.height),
      inputW: Math.round(ri.width), inputH: Math.round(ri.height),
      otherH: Math.round(ro.height),
    };
  })(),
  clip: await __place(n),
};
`,
);
const shotEdit = await shot("01-editing.png", enter.clip);

// ---------------------------------------------------------------- 4. Enter 提交 -> 写回编辑框
const commit = await run(
  "改词 + Enter -> 编辑框与词片同步更新",
  `
const n = window.__n;
const input = document.querySelector(".smchip-edit");
if (!input) return { skipped: "第 3 步没进编辑态，这一步没得测", clip: await __place(n) };
input.value = "golden kimono";
input.dispatchEvent(new Event("input", { bubbles: true }));
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await __wait(1200);
return {
  stillEditing: !!document.querySelector(".smchip-edit"),
  text: __widget(n, "text").value,
  chips: __labels(),
  mask: __mask(n),
  undoShown: document.querySelector(".pfl-undo")?.style.display,
  clip: await __place(n),
};
`,
);
const shotDone = await shot("02-committed.png", commit.clip);

// ---------------------------------------------------------------- 5. Esc 丢弃
await run(
  "改词 + Esc -> 文本不变",
  `
const n = window.__n;
const before = __widget(n, "text").value;
await __dbl(0);
const input = document.querySelector(".smchip-edit");
input.value = "SHOULD-NOT-APPEAR";
input.dispatchEvent(new Event("input", { bubbles: true }));
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await __wait(700);
return { unchanged: __widget(n, "text").value === before, text: __widget(n, "text").value };
`,
);

// ---------------------------------------------------------------- 6. 清空 = 删除
await run(
  "改词 + 清空 + Enter -> 这一段被删掉（段数 -1）",
  `
const n = window.__n;
const nBefore = __chips().length;
await __dbl(4);
const input = document.querySelector(".smchip-edit");
input.value = "   ";
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await __wait(1200);
const chips = __labels();
return { before: nBefore, after: chips.length, chips, text: __widget(n, "text").value, mask: __mask(n) };
`,
);

// ---------------------------------------------------------------- 7. 带权重的段按原文编辑
await run(
  "带权重的段 -> 输入框里是原文 (cat:1.2)",
  `
const n = window.__n;
__setText(n, "(cat:1.2), dog, bird");
await __wait(1400);
const chipsBefore = __labels();
await __dbl(0);
const input = document.querySelector(".smchip-edit");
const value = input?.value ?? null;
if (input) {
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await __wait(400);
}
return { chipsBefore, opened: !!input, value, chips: __labels() };
`,
);

// ---------------------------------------------------------------- 8. 词里写逗号 -> 拆成多段
await run(
  "改词里带逗号 -> 炸成两段，两段都继承原开关",
  `
const n = window.__n;
__setText(n, "cat, dog, bird");
await __wait(1400);
const maskBefore = __mask(n);
__tap(1);
await __wait(350);
const maskOff = __mask(n);
await __dbl(1);
const input = document.querySelector(".smchip-edit");
input.value = "wolf, fox";
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await __wait(1300);
return {
  maskBefore, maskOff,
  chips: __labels(), mask: __mask(n), text: __widget(n, "text").value,
  bothInherited: __mask(n)[1] === maskOff[1] && __mask(n)[2] === maskOff[1],
};
`,
);

// ---------------------------------------------------------------- 9. 闸门炸词也吃到同一份
const gate = await run(
  "闸门炸词（共用 chip_panel）双击同样能编辑",
  `
app.graph.clear();
const g = LiteGraph.createNode("TextGateSplit");
app.graph.add(g);
g.pos = [0, 0];
await __wait(1500);
__setText(g, "upstream, ignored");
await __wait(1400);
app.canvas.ds.scale = 1;
app.canvas.ds.offset = [-g.pos[0] + 120, -g.pos[1] + 160];
app.canvas.draw(true);
await __wait(900);
await __dbl(0);
const input = document.querySelector(".smchip-edit");
const opened = !!input;
const value = input?.value;
const clip = await __place(g);
return { opened, value, chips: __labels(), clip };
`,
);
const shotGate = await shot("03-gate-editing.png", gate.clip);

// ---------------------------------------------------------------- 12-15. 空白处双击插入
const insertSetup = await run(
  "12-插入场景：窄节点 + 6 段词（强制折行）",
  `
app.graph.clear();
const n = LiteGraph.createNode("PromptToggle");
app.graph.add(n);
n.pos = [0, 0];
n.size[0] = 300;          // 窄一点，逼出多行
n.size[1] = 420;
await __wait(1500);
__setText(n, "alpha, beta, gamma, delta, epsilon, zeta");
await __wait(1400);
window.__ins = n;
app.canvas.ds.scale = 1;
app.canvas.ds.offset = [-n.pos[0] + 120, -n.pos[1] + 160];
app.canvas.draw(true);
await __wait(900);
const rows = new Map();
[...n.__pt.list.querySelectorAll(".smchip")].forEach((el, i) => {
  const r = el.getBoundingClientRect();
  const key = Math.round(r.top);
  if (!rows.has(key)) rows.set(key, []);
  rows.get(key).push(i);
});
return {
  chips: __labels(), width: n.size[0],
  rows: [...rows.values()],
  listBox: (() => { const r = n.__pt.list.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })(),
  clip: await __place(n, 0),
};
`,
);

const hover = await run(
  "12b-悬停竖线：指针落在两个词片之间的缝上就亮起来，落在词片上就灭",
  `
const n = window.__ins;
const list = n.__pt.list;
const chips = [...list.querySelectorAll(".smchip")];
const r0 = chips[0].getBoundingClientRect();
const r1 = chips[1].getBoundingClientRect();
const sameRow = Math.abs(r0.top - r1.top) < 2;
const gapX = Math.round(sameRow ? (r0.right + r1.left) / 2 : r0.right + 8);
const gapY = Math.round(r0.top + r0.height / 2);
list.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: gapX, clientY: gapY }));
await __wait(120);
const bar = list.querySelector(".sm-gap-bar");
const onGap = { on: !!bar?.classList.contains("on"), left: bar ? Math.round(parseFloat(bar.style.left || -1)) : null, height: bar ? Math.round(parseFloat(bar.style.height || -1)) : null };
// 移到词片上：应熄灭（真实浏览器里 pointermove 的目标是词片；这里也直接派到词片上）
const c = chips[2].getBoundingClientRect();
chips[2].dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: Math.round(c.left + 10), clientY: Math.round(c.top + 8) }));
await __wait(120);
const onChip = !!bar?.classList.contains("on");
// 再回到缝上，留给截图
list.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: gapX, clientY: gapY }));
await __wait(150);
return { sameRow, gapX, gapY, onGap, onChip, barOnAgain: !!bar?.classList.contains("on"), clip: await __place(n, 0) };
`,
);
const shotHover = await shot("06-insert-hover.png", hover.clip);

const openBox = await run(
  "12c-双击缝：该处出现空输入框（带 placeholder），插入下标 = 后一个词片的序号",
  `
const n = window.__ins;
const list = n.__pt.list;
const chips = [...list.querySelectorAll(".smchip")];
const r0 = chips[0].getBoundingClientRect();
const r1 = chips[1].getBoundingClientRect();
const x = Math.round((r0.right + r1.left) / 2);
const y = Math.round(r0.top + r0.height / 2);
list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 }));
await __wait(200);
const box = list.querySelector(".smchip.editing");
const input = box?.querySelector(".smchip-edit");
return {
  opened: !!input,
  insertAt: box?.dataset.insert,
  placeholder: input?.placeholder,
  empty: input?.value === "",
  focused: document.activeElement === input,
  boxClass: box?.className,
  barHidden: !list.querySelector(".sm-gap-bar")?.classList.contains("on"),
  clip: await __place(n, 0),
};
`,
);
const shotBox = await shot("07-insert-box.png", openBox.clip);

const inserted = await run(
  "13-提交插入：新词落在中间，其余标点一个不动，新段默认开启",
  `
const n = window.__ins;
const input = n.__pt.list.querySelector(".smchip-edit");
input.value = "NEW";
input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await __wait(1300);
return {
  text: __widget(n, "text").value,
  chips: __labels(),
  mask: __mask(n),
  newChipOn: document.querySelector('.smchip[data-i="1"]')?.className,
  undoShown: document.querySelector(".pfl-undo")?.style.display,
  clip: await __place(n, 0),
};
`,
);
const shotInserted = await shot("08-inserted.png", inserted.clip);

const rowTail = await run(
  "14-行尾空白 = 插到该行最后（文本中间）；最后一行之后 = 追加末尾",
  `
const n = window.__ins;
const list = n.__pt.list;
const chips = [...list.querySelectorAll(".smchip")];
const lb = list.getBoundingClientRect();
// 找第一行最后一个词片
const rowTop = Math.round(chips[0].getBoundingClientRect().top);
const rowIdx = chips.map((el, i) => i).filter(i => Math.round(chips[i].getBoundingClientRect().top) === rowTop);
const lastOfRow = rowIdx[rowIdx.length - 1];
const rl = chips[lastOfRow].getBoundingClientRect();
const tailX = Math.round(Math.min(lb.right - 6, rl.right + 18));
const tailY = Math.round(rl.top + rl.height / 2);
list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: tailX, clientY: tailY, button: 0 }));
await __wait(200);
const box = list.querySelector(".smchip.editing");
const atTail = box?.dataset.insert ?? null;
const input = box?.querySelector(".smchip-edit");
if (input) { input.value = "TAIL"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
await __wait(1300);
const afterTail = __widget(n, "text").value;

// 最后一行下方的空白 = 追加
const chips2 = [...list.querySelectorAll(".smchip")];
const last = chips2[chips2.length - 1].getBoundingClientRect();
list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: Math.round(lb.left + 20), clientY: Math.round(Math.min(lb.bottom - 4, last.bottom + 28)), button: 0 }));
await __wait(200);
const box2 = list.querySelector(".smchip.editing");
const atEnd = box2?.dataset.insert ?? null;
const input2 = box2?.querySelector(".smchip-edit");
if (input2) { input2.value = "END"; input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
await __wait(1300);
return {
  lastOfRow, atTail, afterTail,
  chipsForEnd: chips2.length, atEnd,
  finalText: __widget(n, "text").value,
  endsWithEnd: __widget(n, "text").value.trim().endsWith(", END"),
  mask: __mask(n),
};
`,
);

const cancelAndEmpty = await run(
  "15-Esc 不插入 / 空串不插入 / 空文本双击空白 = 新建第一段",
  `
const n = window.__ins;
const list = n.__pt.list;
const lb = list.getBoundingClientRect();
const before = __widget(n, "text").value;
// Esc
list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: Math.round(lb.left + 30), clientY: Math.round(lb.bottom - 6), button: 0 }));
await __wait(150);
let input = list.querySelector(".smchip-edit");
if (input) { input.value = "NOPE"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); }
await __wait(700);
const afterEsc = __widget(n, "text").value;
// 空串提交
list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: Math.round(lb.left + 30), clientY: Math.round(lb.bottom - 6), button: 0 }));
await __wait(150);
input = list.querySelector(".smchip-edit");
if (input) input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await __wait(900);
const afterEmpty = __widget(n, "text").value;

// 清空文本 -> 只剩提示文字，再双击那片空白
__setText(n, "");
await __wait(1400);
const hintThere = !!list.querySelector(".sm-hint");
const lb2 = list.getBoundingClientRect();
list.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: Math.round(lb2.left + 30), clientY: Math.round(lb2.top + 12), button: 0 }));
await __wait(200);
const box = list.querySelector(".smchip.editing");
const at = box?.dataset.insert ?? null;
const input2 = box?.querySelector(".smchip-edit");
if (input2) { input2.value = "first"; input2.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); }
await __wait(1300);
return {
  before, afterEsc, escKept: afterEsc === before,
  afterEmpty, emptyKept: afterEmpty === before,
  hintThere, insertAtOnEmpty: at,
  textFromEmpty: __widget(n, "text").value,
  maskFromEmpty: __mask(n),
  chips: __labels(),
};
`,
);
const clipFromEmpty = await run("16-截图用：空文本插入后的样子", `
const n = window.__ins;
return { clip: await __place(n, 0) };
`);
const shotFromEmpty = await shot("09-insert-empty.png", clipFromEmpty.clip);

const longEdit = await run(
  "17-长词编辑：框跟词片同宽、随内容长高（不再是一条窄缝）",
  `
const n = window.__ins;
const list = n.__pt.list;
__setText(n, "short, extremelylongsegmentwithoutanycommasatallthatwilldefinitelyneedtowrapseveraltimesbecauseitisreallylong, tail");
await __wait(1500);
const chips = [...list.querySelectorAll(".smchip")];
const idx = chips.findIndex((el) => (el.querySelector(".lbl")?.textContent || "").startsWith("extremely"));
const chip = chips[idx];
const cr = chip.getBoundingClientRect();
await __dbl(idx);
const ta = list.querySelector(".smchip-edit");
if (!ta) return { opened: false };
const editBox = list.querySelector(".smchip.editing");
const rb = editBox.getBoundingClientRect();
const r1 = ta.getBoundingClientRect();
return {
  opened: true, idx, tag: ta.tagName,
  chipW: Math.round(cr.width), chipH: Math.round(cr.height),
  boxW: Math.round(rb.width), boxH: Math.round(rb.height),
  taW: Math.round(r1.width), taH: Math.round(r1.height),
  sameWidth: Math.abs(rb.width - cr.width) <= 3,
  // 进编辑后 ＋/－/×/锁 都让位了，文字可用宽度变大，可能少折一行 —— 差一行以内就算对
  asTallAsChip: Math.abs(rb.height - cr.height) <= 20,
  innerScroll: ta.scrollHeight > ta.clientHeight + 2,
  overflowX: ta.scrollWidth > ta.clientWidth + 1,
  listW: list.clientWidth, listH: list.clientHeight,
  clip: await __place(n, 0),
};
`,
);
const shotLong = await shot("10-long-edit.png", longEdit.clip);

const longGrow = await run(
  "18-长词编辑长高：继续加长内容框跟着变高，宽度封在词片区宽（不在框里横向滚）",
  `
const n = window.__ins;
const list = n.__pt.list;
const ta = list.querySelector(".smchip-edit");
const r1 = ta.getBoundingClientRect();
ta.value = ta.value + " " + "MORE".repeat(40);
ta.dispatchEvent(new Event("input", { bubbles: true }));
await __wait(250);
const r2 = ta.getBoundingClientRect();
const after = { boxW: Math.round(r2.width), boxH: Math.round(r2.height), scrollH: ta.scrollHeight, clientH: ta.clientHeight, overflowX: ta.scrollWidth > ta.clientWidth + 1 };
// 再来一次巨型粘贴：高度必须停在词片区可视高度，改成框内滚动
ta.value = "X".repeat(4000);
ta.dispatchEvent(new Event("input", { bubbles: true }));
await __wait(250);
const capped = {
  boxH: Math.round(ta.getBoundingClientRect().height),
  listH: list.clientHeight,
  overflowY: ta.style.overflowY,
  scrollsInside: ta.scrollHeight > ta.clientHeight + 2,
};
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await __wait(400);
return {
  before: { w: Math.round(r1.width), h: Math.round(r1.height) },
  after,
  heightGrew: r2.height > r1.height,
  widthCapped: Math.round(r2.width) <= list.clientWidth,
  noHorizScroll: !after.overflowX,
  capped,
  heightCapped: capped.boxH <= capped.listH,
  closedAfterEsc: !list.querySelector(".smchip-edit"),
  textUnchanged: __widget(n, "text").value.startsWith("short, extremely"),
};
`,
);

// ---------------------------------------------------------------- 19-22. 逐词锁
const lockSetup = await run(
  "19-逐词锁：上锁 → 图标变实心、键写进 properties",
  `
app.graph.clear();
const n = LiteGraph.createNode("PromptToggle");
app.graph.add(n);
n.pos = [0, 0];
n.size[0] = 320;
n.size[1] = 400;
await __wait(1600);
__setText(n, "blue hair, cat, dog");
await __wait(1500);
window.__lock = n;
app.canvas.ds.scale = 1;
app.canvas.ds.offset = [-n.pos[0] + 120, -n.pos[1] + 160];
app.canvas.draw(true);
await __wait(900);

const lockAt = (i) => n.__pt.list.querySelector('.smchip[data-i="' + i + '"] .smlock');
// 已锁/未锁都是同一个图案，靠颜色区分：已锁青蓝 #7dd3fc，未锁灰绿 #9fb8a6
const before = { cls: lockAt(0)?.className, blue: lockAt(0)?.innerHTML.includes("7dd3fc"), grey: lockAt(0)?.innerHTML.includes("9fb8a6") };
lockAt(0).click();
await __wait(250);
return {
  before,
  after: { cls: lockAt(0)?.className, blue: lockAt(0)?.innerHTML.includes("7dd3fc"), grey: lockAt(0)?.innerHTML.includes("9fb8a6") },
  pinsProp: n.properties.prompt_toggle_pins,
  keys: n.__pt.keys,
  chips: __labels(),
  clip: await __place(n, 0),
};
`,
);
const shotLocked = await shot("11-lock-on.png", lockSetup.clip);

const lockDeny = await run(
  "20-× 删锁定词被拒（图标闪一下，文本不变）；解锁后删得掉",
  `
const n = window.__lock;
const list = n.__pt.list;
const text0 = __widget(n, "text").value;
// × 在锁定词上
list.querySelector('.smchip[data-i="0"] .smchip-del').click();
await __wait(120);
const denyClass = list.querySelector('.smchip[data-i="0"] .smlock')?.classList.contains("deny");
await __wait(400);
const afterDel = __widget(n, "text").value;
// 双击 -> 清空 -> Enter 也应该被拒
await __dbl(0);
const ta = list.querySelector(".smchip-edit");
ta.value = "   ";
ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await __wait(900);
const afterEmpty = __widget(n, "text").value;
const stillPinned = list.querySelector('.smchip[data-i="0"] .smlock')?.classList.contains("on");
// 解锁后再删：应当成功
list.querySelector('.smchip[data-i="0"] .smlock').click();
await __wait(200);
list.querySelector('.smchip[data-i="0"] .smchip-del').click();
await __wait(1200);
return {
  text0,
  denyClass,
  delBlocked: afterDel === text0,
  emptyEditBlocked: afterEmpty === text0,
  stillPinned,
  pinsAfterUnlock: n.properties.prompt_toggle_pins ?? null,
  textAfterDelete: __widget(n, "text").value,
  chips: __labels(),
};
`,
);

const gateLock = await run(
  "21-闸门炸词：✕ 清空只留锁词、账本保留锁定键、闸门仍算开着",
  `
app.graph.clear();
const g = LiteGraph.createNode("TextGateSplit");
app.graph.add(g);
g.pos = [0, 0];
g.size[0] = 340;
g.size[1] = 460;
await __wait(1700);
__setText(g, "blue hair, cat, dog");
await __wait(1500);
window.__glock = g;
app.canvas.ds.scale = 1;
app.canvas.ds.offset = [-g.pos[0] + 120, -g.pos[1] + 160];
app.canvas.draw(true);
await __wait(900);

const list = g.__tgs.list;
const lockBtns = [...list.querySelectorAll(".smlock")];
lockBtns[0].click();          // 锁 blue hair
await __wait(300);
const pinsBefore = g.properties.tgs_pins;
// ✕ 在状态条上（不是词条面板），需要点两次（第一次是"确认"档）
const clearBtn = g.__tgs.clearBtn;
clearBtn?.click();
await __wait(150);
clearBtn?.click();
await __wait(1600);
return {
  pinsBefore,
  textAfterClear: __widget(g, "text").value,
  chips: __labels(),
  seen: JSON.parse(g.properties.tgs_seen || "[]"),
  gateOpen: g.__tgs.gate?.open,
  gateReason: g.__tgs.gate?.reason,
  lockedOnly: g.__tgs.chips?.lockedOnly?.(),
  pinsAfterClear: g.properties.tgs_pins,
  clip: await __place(g, 0),
};
`,
);
const shotGateLock = await shot("12-gate-locked-clear.png", gateLock.clip);

const injection = await run(
  "22-排队注入：graphToPrompt 里 pins 带上了锁定词",
  `
const g = window.__glock;
const res = await app.graphToPrompt();
const entry = (res.output || {})[String(g.id)];
return {
  pins: entry?.inputs?.pins,
  parsed: JSON.parse(entry?.inputs?.pins || "[]"),
  mask: entry?.inputs?.mask,
  text: entry?.inputs?.text,
};
`,
);

// ---------------------------------------------------------------- 汇总
const out = path.join(OUT, "verify-edit.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log("\n=== 实测结果 ===");
console.log(JSON.stringify(results, null, 2));
console.log(`\n截图：${shotEdit}\n      ${shotDone}\n      ${shotGate}\n      ${shotHover}\n      ${shotBox}\n      ${shotInserted}\n      ${shotFromEmpty}\n      ${shotLong}
      ${shotLocked}
      ${shotGateLock}`);
ws.close();
edge.kill();
