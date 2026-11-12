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

// ---------------------------------------------------------------- 汇总
const out = path.join(OUT, "verify-edit.json");
fs.writeFileSync(out, JSON.stringify(results, null, 2));
console.log("\n=== 实测结果 ===");
console.log(JSON.stringify(results, null, 2));
console.log(`\n截图：${shotEdit}\n      ${shotDone}\n      ${shotGate}`);
ws.close();
edge.kill();
