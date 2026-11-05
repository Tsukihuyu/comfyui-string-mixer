// Prompt File Loader —— 给文件下拉列表加一个「刷新文件列表」按钮
//
// 为什么需要：ComfyUI 的 combo（下拉）选项只在节点创建时向后端要一次，
// 你改了 directory 控件或往目录里新丢了 txt，列表不会自己更新。
// 这里点按钮 -> 请求后端路由 /prompt_file_loader/list -> 就地替换选项。
//
// 注意：改完 JS 要重启 ComfyUI + 浏览器硬刷新（Ctrl+Shift+R）。

import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const NODE_TYPE = "PromptFileLoader";
const NO_FILE = "（不读取文件）";

async function refreshFileList(node) {
  const dirWidget = (node.widgets || []).find((w) => w && w.name === "directory");
  const fileWidget = (node.widgets || []).find((w) => w && w.name === "file");
  if (!dirWidget || !fileWidget) return; // 端口模式下控件可能被隐藏，交给后端默认值

  try {
    const res = await api.fetchApi(
      `/prompt_file_loader/list?directory=${encodeURIComponent(dirWidget.value ?? "")}`
    );
    const data = await res.json();
    const files = [NO_FILE, ...(data.files || [])];

    fileWidget.options = fileWidget.options || {};
    fileWidget.options.values = files;
    // 之前选的文件不在了（改名/删除/换了目录）就退回「不读取文件」，避免静默读错
    if (!files.includes(fileWidget.value)) fileWidget.value = NO_FILE;
    node.setDirtyCanvas(true, true);
  } catch (e) {
    console.warn("[PromptFileLoader] 刷新文件列表失败：", e);
  }
}

// ---------------------------------------------------------------- 悬停缩略图
// 两种触发：① 鼠标停在 file 控件那一行（显示当前选中文件的同名图）
//           ② 点开下拉后停在其中某一项（显示那一项的同名图）
// 图由后端 /prompt_file_loader/preview 出 320px 缩略图；没有同名图 -> 404 -> 不显示。

let tipEl = null;
let cursor = { x: 0, y: 0 };

function ensureTip() {
  if (tipEl) return tipEl;
  tipEl = document.createElement("div");
  tipEl.id = "pfl-preview-tip";
  Object.assign(tipEl.style, {
    position: "fixed",
    zIndex: "999999",
    display: "none",
    pointerEvents: "none",
    padding: "4px",
    borderRadius: "8px",
    background: "rgba(18,18,18,.92)",
    border: "1px solid rgba(255,255,255,.18)",
    boxShadow: "0 8px 28px rgba(0,0,0,.5)",
  });
  const img = document.createElement("img");
  Object.assign(img.style, {
    display: "block",
    maxWidth: "320px",
    maxHeight: "320px",
    borderRadius: "5px",
  });
  tipEl.appendChild(img);
  document.body.appendChild(tipEl);
  return tipEl;
}

function hideTip() {
  if (tipEl) tipEl.style.display = "none";
}

function moveTip(x, y) {
  if (!tipEl || tipEl.style.display === "none") return;
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  let left = x + 18;
  let top = y + 18;
  if (left + w > window.innerWidth - 8) left = x - w - 18;
  if (top + h > window.innerHeight - 8) top = y - h - 18;
  tipEl.style.left = `${Math.max(4, left)}px`;
  tipEl.style.top = `${Math.max(4, top)}px`;
}

// 关键：整条链路只用一个 <img>，onload/onerror 是单槽赋值而不是累积监听。
// 每个回调都先确认「这个地址还是当前地址」，否则就是迟到的旧请求，直接作废——
// 否则扫过无图项时，那一次 404 会把之前所有图的 error 回调一起触发，把它们误判成坏图。
function showTip(node, filename, x, y) {
  cursor = { x, y };
  if (!filename || filename === NO_FILE) return hideTip();

  const dir = (node.widgets || []).find((w) => w.name === "directory");
  const url =
    `/prompt_file_loader/preview?directory=${encodeURIComponent(dir?.value ?? "")}` +
    `&file=${encodeURIComponent(filename)}`;

  const el = ensureTip();
  const img = el.firstChild;

  if (img.dataset.url !== url) {
    img.dataset.url = url;
    img.dataset.ready = "";
    img.onload = () => {
      if (img.dataset.url !== url) return; // 已经换过图，这次结果作废
      img.dataset.ready = "1";
      el.style.display = "block";
      moveTip(cursor.x, cursor.y);
    };
    img.onerror = () => {
      if (img.dataset.url !== url) return; // 迟到的旧错误，不影响当前这张
      img.dataset.ready = "";
      hideTip();
    };
    img.src = url;
  }

  // 已经加载过的（浏览器缓存命中）立刻显示，不走 onload
  if (img.dataset.ready === "1") {
    el.style.display = "block";
    moveTip(x, y);
  }
}

// 被「排在后面（画面上更靠前）」的节点压住时，不应该还能悬停出图
function isCoveredByLater(node) {
  const nodes = app.graph?._nodes || [];
  const idx = nodes.indexOf(node);
  if (idx < 0) return false;
  const x1 = node.pos[0];
  const y1 = node.pos[1];
  const x2 = x1 + node.size[0];
  const y2 = y1 + node.size[1];
  for (let i = idx + 1; i < nodes.length; i++) {
    const o = nodes[i];
    if (!o || o.mode === 4 || !o.size) continue;
    if (o.pos[0] < x2 && o.pos[0] + o.size[0] > x1 &&
        o.pos[1] < y2 && o.pos[1] + o.size[1] > y1) {
      return true;
    }
  }
  return false;
}

// 图坐标 -> 落在哪个节点的 file 控件上
function comboNodeAt(clientX, clientY) {
  const cv = app.canvas;
  if (!cv || !app.graph) return null;
  const rect = cv.canvas.getBoundingClientRect();
  const ds = cv.ds;
  const gx = (clientX - rect.left) / ds.scale - ds.offset[0];
  const gy = (clientY - rect.top) / ds.scale - ds.offset[1];

  for (const node of app.graph._nodes || []) {
    if (node.type !== NODE_TYPE) continue;
    const w = (node.widgets || []).find((x) => x.name === "file");
    if (!w || w.last_y === undefined) continue;
    const lx = gx - node.pos[0];
    const ly = gy - node.pos[1];
    if (lx >= 0 && lx <= node.size[0] && ly >= w.last_y && ly <= w.last_y + (w.height || 20)) {
      return isCoveredByLater(node) ? null : node;
    }
  }
  return null;
}

let lastComboNode = null; // 菜单里的项属于哪个节点（鼠标点开前记下的）

function installHover() {
  if (window.__pflHoverInstalled) return;
  window.__pflHoverInstalled = true;

  // 画布悬停：文档级捕获监听，画布被前端重建也不会失效
  document.addEventListener(
    "mousemove",
    (e) => {
      const t = e.target;
      if (t?.closest?.(".litecontextmenu")) return; // 菜单里的项另有处理
      if (!t?.classList?.contains("lgraphcanvas")) return hideTip();

      const node = comboNodeAt(e.clientX, e.clientY);
      lastComboNode = node;
      if (!node) return hideTip();
      const file = (node.widgets || []).find((w) => w.name === "file");
      showTip(node, file?.value, e.clientX, e.clientY);
    },
    true
  );
  document.addEventListener("mouseleave", hideTip, true);

  // 下拉列表是 DOM（litegraph 的 litemenu），在容器上做事件委托（条目不逐个挂，避免被重绘换掉）
  const hooked = new WeakSet();
  const watchMenu = () => {
    for (const menu of document.querySelectorAll(".litecontextmenu.litemenubar-panel")) {
      if (hooked.has(menu)) continue;
      const entries = [...menu.querySelectorAll(".litemenu-entry")];
      if (!entries.length) continue;
      // 只认本节点的文件列表：首项是「不读取文件」
      if ((entries[0].textContent || "").trim() !== NO_FILE) continue;
      hooked.add(menu);

      menu.addEventListener("mousemove", (ev) => {
        const entry = ev.target?.closest?.(".litemenu-entry");
        if (!entry || !menu.contains(entry)) return hideTip();
        const node =
          lastComboNode || (app.graph?._nodes || []).find((n) => n.type === NODE_TYPE);
        if (!node) return;
        showTip(node, (entry.textContent || "").trim(), ev.clientX, ev.clientY);
      });
      menu.addEventListener("mouseleave", hideTip);

      // 菜单一关就藏图
      const watcher = new MutationObserver(() => {
        if (!document.body.contains(menu)) {
          hideTip();
          watcher.disconnect();
        }
      });
      watcher.observe(document.body, { childList: true, subtree: true });
    }
  };
  new MutationObserver(watchMenu).observe(document.body, {
    childList: true,
    subtree: true,
  });
  watchMenu();
}

app.registerExtension({
  name: "StringMixer.PromptFileLoader",
  setup() {
    installHover();
  },
  beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData?.name !== NODE_TYPE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated?.apply(this, arguments);

      const btn = this.addWidget("button", "🔄 刷新文件列表", null, () =>
        refreshFileList(this)
      );
      // 按钮不是后端输入，别让它被序列化进工作流 / prompt
      btn.serialize = false;
      if (btn.options) btn.options.serialize = false;

      // 载入已存工作流时，按保存的 directory 重扫一次，列表才和控件对得上
      requestAnimationFrame(() => refreshFileList(this));

      // 前后缀：只有「自定义」才需要那两个框，其余模式藏起来（免得以为模板还能改）
      const affixW = (this.widgets || []).find((w) => w && w.name === "affix");
      const preW = (this.widgets || []).find((w) => w && w.name === "prefix");
      const sufW = (this.widgets || []).find((w) => w && w.name === "suffix");
      const setShown = (w, shown) => {
        if (!w) return;
        if (shown) {
          if (w.__pflHidden) {
            delete w.computeSize;   // 回到 LiteGraph 默认高度
            w.__pflHidden = false;
          }
        } else if (!w.__pflHidden) {
          w.computeSize = () => [0, -4];   // 负高度 = 不画，但序列化顺序不变
          w.__pflHidden = true;
        }
      };
      const syncAffix = () => {
        const custom = affixW?.value === "自定义";
        setShown(preW, custom);
        setShown(sufW, custom);
        const want = this.computeSize();
        this.setSize([this.size[0], want[1]]);
        this.setDirtyCanvas?.(true, true);
        app.canvas?.setDirty(true, true);
      };
      this.__pflSyncAffix = syncAffix;
      if (affixW) {
        const ob = affixW.callback;
        affixW.callback = function (...args) {
          const r = ob?.apply(this, args);
          syncAffix();
          return r;
        };
      }
      requestAnimationFrame(syncAffix);
      return r;
    };
  },

  // 载入已存工作流：控件值在 onNodeCreated 之后才恢复，这里再按真实目录刷一次
  loadedGraphNode(node) {
    if (node.type !== NODE_TYPE) return;
    refreshFileList(node);
    requestAnimationFrame(() => node.__pflSyncAffix?.());
  },
});
