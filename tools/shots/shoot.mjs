// README 截图器：连真实的 ComfyUI 页面，按场景脚本摆好节点，再按包围盒裁切截图。
//
// 用法（先启动 ComfyUI，默认 127.0.0.1:8199）：
//   node tools/shots/shoot.mjs                 # 拍全部场景
//   node tools/shots/shoot.mjs 02-gate-toggle  # 只拍指定场景（按文件名前缀）
//
// 为什么这么干：README 的图必须是真 UI。手拼/PS 的图一旦 UI 改动就撒谎，
// 而脚本化之后，改完前端跑一遍就能全部重拍。
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../..");
const OUT = process.env.SHOT_OUT || path.join(ROOT, "docs", "images");
const APP = process.env.COMFY_URL || "http://127.0.0.1:8199";
const EDGE =
  process.env.EDGE_PATH ||
  "C:/Program Files (x86)/Microsoft/EdgeCore/156.0.4314.58/msedge.exe";
const PORT = Number(process.env.CDP_PORT || 9411);
const only = process.argv[2] || "";

fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- 启动浏览器
const profile = path.join(HERE, ".profile");
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
      // 一定要挑中 ComfyUI 那个标签页：无头 Edge 启动时可能先有别的页（新标签页等）
      const pages = list.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
      const page = pages.find((t) => t.url.includes("127.0.0.1:8199") || t.url.includes(APP));
      if (page) return page;
    } catch {}
    await sleep(500);
  }
  throw new Error("浏览器没起来");
}

const page = await target();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

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

const withTimeout = (p, ms, label) =>
  Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} 超时 ${ms}ms`)), ms)),
  ]);

async function evaluate(expression) {
  const r = await cdp("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
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

// 等前端把 app / LiteGraph 准备好
let ready = false;
for (let i = 0; i < 90; i++) {
  ready = await evaluate(
    "!!(window.app && window.app.graph && window.LiteGraph)",
  ).catch(() => false);
  if (ready) break;
  await sleep(1000);
}
if (!ready) throw new Error(`页面没准备好：${page.url}`);
console.log(`attached: ${page.url}`);

// 场景公共帮手：等待、把节点摆到画布左上、算包围盒
const PREAMBLE = `
const __wait = (ms) => new Promise((r) => setTimeout(r, ms));
function __place(node, pad = 22) {
  const c = app.canvas;
  c.ds.scale = 1;
  c.ds.offset = [-node.pos[0] + 150, -node.pos[1] + 170];
  c.setDirty(true, true);
  const s = c.ds.scale, o = c.ds.offset;
  const titleH = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
  const x = (node.pos[0] + o[0]) * s;
  const y = (node.pos[1] + o[1]) * s - titleH * s;
  const w = node.size[0] * s;
  const h = (node.size[1] + titleH) * s;
  return {
    x: Math.max(0, Math.round(x - pad)),
    y: Math.max(0, Math.round(y - pad)),
    w: Math.round(w + pad * 2),
    h: Math.round(h + pad * 2),
  };
}
function __widget(node, name) {
  return (node.widgets || []).find((w) => w.name === name);
}
function __set(node, name, value) {
  const w = __widget(node, name);
  if (!w) throw new Error("没有控件 " + name);
  w.value = value;
  w.callback?.(value);
  node.setDirtyCanvas?.(true, true);
  app.canvas.setDirty(true, true);
}
async function __setText(node, name, value) {
  __set(node, name, value);
  await __wait(1200);
}
function __clickAll(sel) {
  return [...document.querySelectorAll(sel)];
}
// 多个节点一起入镜：按并集算裁切框（坐标系只设一次，免得前后不一致）
function __placeMany(nodes, pad = 22, scale = 1) {
  const c = app.canvas;
  c.ds.scale = scale;
  const minX = Math.min(...nodes.map((n) => n.pos[0]));
  const minY = Math.min(...nodes.map((n) => n.pos[1]));
  c.ds.offset = [-minX + 150 / scale, -minY + 170 / scale];
  c.setDirty(true, true);
  const s = c.ds.scale, o = c.ds.offset;
  const titleH = (window.LiteGraph && LiteGraph.NODE_TITLE_HEIGHT) || 30;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const n of nodes) {
    const x = (n.pos[0] + o[0]) * s;
    const y = (n.pos[1] + o[1]) * s - titleH * s;
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x + n.size[0] * s);
    y2 = Math.max(y2, y + (n.size[1] + titleH) * s);
  }
  return {
    x: Math.max(0, Math.round(x1 - pad)),
    y: Math.max(0, Math.round(y1 - pad)),
    w: Math.round(x2 - x1 + pad * 2),
    h: Math.round(y2 - y1 + pad * 2),
  };
}
`;

const scenes = fs
  .readdirSync(path.join(HERE, "scenes"))
  .filter((f) => f.endsWith(".js"))
  .filter((f) => !only || f.startsWith(only))
  .sort();

const report = [];
for (const file of scenes) {
  const name = file.replace(/\.js$/, "");
  const body = fs.readFileSync(path.join(HERE, "scenes", file), "utf8");
  let clip;
  try {
    clip = await withTimeout(
      evaluate(`(async () => {\n${PREAMBLE}\n${body}\n})()`),
      90000,
      name,
    );
  } catch (e) {
    report.push(`✘ ${name}: ${e.message.split("\n")[0]}`);
    continue;
  }
  if (!clip || typeof clip.w !== "number") {
    report.push(`✘ ${name}: 场景没返回包围盒`);
    continue;
  }
  await sleep(300);
  const shot = await cdp("Page.captureScreenshot", {
    format: "png",
    captureBeyondViewport: true,
    clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: 1 },
  });
  const out = path.join(OUT, `${name}.png`);
  fs.writeFileSync(out, Buffer.from(shot.data, "base64"));
  const kb = Math.round(fs.statSync(out).size / 1024);
  report.push(`✔ ${name}.png  ${clip.w}×${clip.h}  ${kb}KB`);
}

console.log(report.join("\n"));
ws.close();
edge.kill();
