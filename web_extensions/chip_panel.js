// 共用的「词条面板」：炸出来的每个词 = 一个 chip
//
// Prompt Toggle 与 闸门炸词 共用这一份，免得两套行为漂移：
//   单击      = 开 / 关（绿 / 红）—— 为双击让路，延迟 220ms 才真的切换
//   双击      = 就地改这一段（词片原地变输入框；Enter / 点别处提交，Esc 取消）
//   按住拖动  = 换位置（松手落位；蓝线标出落点）
//   左侧 ＋/－ = 权重 ±0.05（上＋下－；写进文本框，1.00 时自动去括号）
//   右侧 ×    = 从文本框里彻底删掉这一段（可撤销）
//
// 所有改文本的操作都交给后端算（/prompt_toggle/split 的 drop / move / weight / edit），
// 前端只负责画和写回，标点规则只有一处实现。

import { api } from "../../scripts/api.js";

const DRAG_SLOP = 4;      // 移动超过这么多像素才算拖动，否则算单击
const DOUBLE_MS = 220;    // 双击判定窗口；单击的开关也压这么久，用户点了两下就不闪
const UNDO_MS = 10000;    // 撤销窗口
const WEIGHT_STEP = 0.05; // 与后端 nodes/toggle.py 的 WEIGHT_STEP 对齐

const STYLE_ID = "sm-chip-style";

const CSS = `
.sm-list { position: relative; cursor: text; }
/* 空白处双击插入的悬停竖线：绝对定位、不吃指针事件，只在缝上亮起来 */
.sm-gap-bar {
  position: absolute; width: 2px; border-radius: 1px; opacity: 0;
  background: rgba(140, 180, 255, 0.8); pointer-events: none;
  transition: opacity .12s ease; z-index: 1;
}
.sm-gap-bar.on { opacity: 1; }
.smchip {
  display: inline-flex; align-items: stretch;
  font-size: 12px; line-height: 17px; padding: 1px 6px 1px 3px; border-radius: 11px;
  cursor: pointer; max-width: 100%; white-space: normal; word-break: break-word;
  text-align: left; border: 1px solid transparent; font-weight: 500;
  /* 绿↔红要「淡」过去：颜色属性全部参与过渡，开关一下能看出插件干了活。
     前提是开关时元素不重建——见 paintChips()。 */
  transition: background-color .28s ease, border-color .28s ease, color .28s ease,
              filter .12s ease, opacity .12s ease;
  font-family: inherit; user-select: none;
}
.smchip:hover { filter: brightness(1.3); }
.smchip.on  { background: rgba(46,160,67,.22);  border-color: rgba(74,222,128,.75); color: #86efac; }
.smchip.off { background: rgba(248,81,73,.15);  border-color: rgba(248,81,73,.55);  color: #fca5a5; }
.smchip.wtd { background: rgba(214,158,46,.16); border-color: rgba(230,180,80,.8);  color: #f2d19a; }
/* 关掉 + 带权重：整条按「关掉」的红色走，只有权重数字留在徽章上 */
.smchip.off.wtd { background: rgba(248,81,73,.15); border-color: rgba(248,81,73,.55); color: #fca5a5; }
.smchip.dragging { opacity: .38; }
.smchip.pressing { filter: brightness(1.45); }
.smchip .lbl { align-self: center; }

/* 左侧竖排 ＋/－：上＋下－，和右边的 × 一样用一道淡竖线隔开 */
.smchip .wcol {
  display: flex; flex-direction: column; justify-content: center; gap: 0;
  padding-right: 4px; margin-right: 5px; position: relative; flex: 0 0 auto;
}
.smchip .wcol::after {
  content: ""; position: absolute; right: 0; top: 1px; bottom: 1px; width: 1px;
  background: currentColor; opacity: .45;
}
.smchip .wbtn {
  font-size: 9px; line-height: 9px; font-weight: 700; opacity: .8;
  width: 12px; text-align: center; border-radius: 3px;
  display: flex; align-items: center; justify-content: center; height: 10px;
}
.smchip .wbtn:hover { opacity: 1; background: rgba(255,255,255,.18); }

.smchip .wbadge {
  align-self: center; font-size: 10px; font-weight: 700; margin-left: 5px; padding: 0 4px;
  border-radius: 5px; background: rgba(214,158,46,.32); color: #ffd08a;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.smchip.off .wbadge { background: rgba(248,81,73,.25); color: #fca5a5; }

/* 右侧删除键 */
.smchip .smchip-del {
  position: relative; flex: 0 0 auto; padding: 0 2px 0 8px; margin-left: 2px;
  font-size: 12px; line-height: 13px; cursor: pointer; opacity: .8; font-weight: 700;
  align-self: stretch; display: flex; align-items: center;
}
.smchip .smchip-del::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0; width: 1px;
  background: currentColor; opacity: .55;
}
.smchip .smchip-del:hover { opacity: 1; color: #ff9b9b; }

/* 拖动预览：被拖的词片半透明，并实时插到目标位置，把两边的词挤开（不用落点线） */
.sm-hint { font-size: 11px; opacity: .55; padding: 4px 2px; }

/* 双击就地编辑 / 插入用的框：textarea，随内容换行长高（单行短词就是一行高，外观不变） */
.smchip .smchip-edit {
  align-self: center; min-width: 48px; max-width: 100%;
  font: inherit; font-size: 12px; line-height: 17px; /* 与 .smchip 一致：进编辑时高度不跳 */
  color: inherit; background: rgba(0,0,0,.35);
  border: 1px solid currentColor; border-radius: 7px;
  padding: 0 4px; margin: 0; outline: none; box-sizing: border-box;
  display: block; resize: none; overflow: hidden;
  white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere;
}
.smchip.editing { cursor: text; }
`;

export function ensureChipStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const el = document.createElement("style");
  el.id = STYLE_ID;
  el.textContent = CSS;
  document.head.append(el);
}

function fmtWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return "1";
  return String(Number(n.toFixed(2)));
}

// 指针落在哪个位置：在「拖动开始时冻结的矩形」里找，返回摘掉被拖那一个之后应插入的下标。
// 为什么用冻结坐标：预览会实时重排词片，拿实时布局算落点就会跟手指互相推让、来回跳；
// 冻结之后映射是单调的，动起来才稳。
function slotFromRects(rects, from, x, y) {
  let idx = 0;
  for (let k = 0; k < rects.length; k++) {
    if (k === from) continue;
    const r = rects[k];
    if (y < r.top) break;                                   // 指针在这一行上面 -> 插在它前面
    if (y <= r.bottom && x < r.left + r.width / 2) break;    // 同一行且在它的左半边
    idx++;
  }
  return idx;
}

export class ChipList {
  /**
   * @param {object} node   ComfyUI 节点
   * @param {object} opts
   *   state     宿主的状态对象（含 segs / mask / weights）
   *   list      词条容器（DOM）
   *   countEl   右上角「开 x / y」（可选）
   *   undoBtn   “撤销”按钮（可选）
   *   hint      没有片段时的提示文字
   *   getText() 读文本框内容
   *   writeText(text)  写文本框（宿主自己走回调）
   *   writeMask(arr)   把开关状态存进 properties
   *   after()          操作完让宿主重画一次
   */
  constructor(node, opts) {
    this.node = node;
    this.opts = opts;
    this.drag = null;
    this.editing = null;   // {mode:"edit"|"insert", i|k, box, input, seg} 正在编辑/插入的那一段
    this.clickTimer = null; // 待生效的单击开关（双击判定窗口内先压着）
    this.lastClick = null;  // {i, t, seg} 上一次单击
    this.undoState = null;
    this.undoTimer = null;
    this.gapBar = null;     // 空白处双击插入的悬停竖线
    this.gapAt = -1;
    ensureChipStyles();
    if (opts.list) {
      opts.list.classList.add("sm-list");
      this.bindListGestures(opts.list);
    }
  }

  // 词片区容器自己的手势：悬停提示 + 双击空白插入。
  // 容器从不重建（只换子节点），所以这里的 dblclick 是浏览器原生判定，不用压 220ms。
  bindListGestures(list) {
    list.addEventListener("pointermove", (e) => this.onHover(e));
    list.addEventListener("pointerleave", () => this.hideGapBar());
    list.addEventListener("dblclick", (e) => {
      if (this.drag || this.editing) return;
      if (e.target?.closest?.(".smchip")) return; // 双击词片 = 改词，别抢
      e.preventDefault();
      e.stopPropagation();
      const rects = this.chipRects();
      if (!rects.length) {
        this.beginInsert(0); // 空文本：新建第一段
        return;
      }
      this.beginInsert(slotFromRects(rects, -1, e.clientX, e.clientY));
    });
  }

  chipEls() {
    return Array.from(this.opts.list?.querySelectorAll(".smchip") || []);
  }

  chipRects() {
    return this.chipEls().map((el) => el.getBoundingClientRect());
  }

  get st() {
    return this.opts.state;
  }

  isOn(i) {
    const mask = this.st.mask || [];
    return mask[i] !== 0;
  }

  // ---------------------------------------------------------------- 渲染

  render() {
    if (this.drag?.moved) return; // 拖动中别重画，会打断手势
    if (this.editing) return;     // 编辑中别重画：一重画输入框和光标就没了
    const { list } = this.opts;
    if (!list) return;
    const st = this.st;
    const segs = st.segs || [];
    const weights = st.weights || [];

    this.updateCount();

    if (!segs.length) {
      const hint = document.createElement("div");
      hint.className = "sm-hint";
      hint.textContent = this.opts.hint || "框里有字后，这里会按标点炸成可点的片段";
      list.replaceChildren(hint);
      this.restoreGapBar();
      return;
    }

    list.replaceChildren(...segs.map((seg, i) => this.chipEl(seg, i, weights[i])));
    this.restoreGapBar(); // replaceChildren 会把悬停竖线一起清掉，这里挂回来
  }

  updateCount() {
    const { countEl } = this.opts;
    if (!countEl) return;
    const segs = this.st.segs || [];
    const on = segs.reduce((n, _, i) => n + (this.isOn(i) ? 1 : 0), 0);
    countEl.textContent = segs.length ? `开 ${on} / ${segs.length}` : "";
    if (countEl.dataset) countEl.dataset.off = segs.length && on === 0 ? "1" : "";
  }

  // 词片 class 的唯一来源：整排重建（render）和就地换色（paintChips）都调这里，
  // 两条路径就不可能给出两种颜色。
  chipClass(i) {
    const w = Number(this.st.weights?.[i]);
    const ww = Number.isFinite(w) ? w : 1;
    return `smchip ${this.isOn(i) ? "on" : "off"}${ww !== 1 ? " wtd" : ""}`;
  }

  // 悬停提示同理：就地换色不重建元素，title 也得跟着改，否则开关后提示还写着旧动作
  chipTitle(i) {
    return [
      this.isOn(i) ? "单击关掉这一段（不进输出）" : "单击打开这一段",
      "双击 = 就地改这个词",
      "按住拖动 = 换位置",
      "左侧 ＋/－ = 权重 ±0.05",
      "右侧 × = 从文本框里删掉（可撤销）",
    ].join("；");
  }

  // 就地换色：只改现有词片的 class、不重建元素，CSS 过渡才有起点（绿↔红淡过去的基础）。
  // 段数对不上（文本被改过）就跑不动了，只能退回整排重建。
  paintChips() {
    const list = this.opts.list;
    const segs = this.st.segs || [];
    if (!list || this.editing) return this.render();
    const els = Array.from(list.querySelectorAll(".smchip"));
    if (els.length !== segs.length) return this.render();
    els.forEach((el, i) => {
      const cls = this.chipClass(i);
      if (el.className !== cls) el.className = cls;
      const tip = this.chipTitle(i);
      if (el.title !== tip) el.title = tip;
    });
    this.updateCount();
  }

  // 批量改开关（全开 / 全关 / 反选）：同样就地换色，一排一起淡过去
  applyMask(arr) {
    if (!Array.isArray(arr)) return;
    this.cancelPendingClick();
    this.lastClick = null;
    this.st.mask = arr;
    this.opts.writeMask(arr);
    this.paintChips();
    this.opts.after?.();
  }

  chipEl(seg, i, weight) {
    const on = this.isOn(i);
    const w = Number.isFinite(Number(weight)) ? Number(weight) : 1;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.i = String(i);
    b.className = this.chipClass(i);
    b.title = this.chipTitle(i);

    const col = document.createElement("span");
    col.className = "wcol";
    col.append(
      this.wbtnEl("＋", i, +WEIGHT_STEP, w, "权重 +" + fmtWeight(WEIGHT_STEP)),
      this.wbtnEl("－", i, -WEIGHT_STEP, w, "权重 −" + fmtWeight(WEIGHT_STEP)),
    );

    const lbl = document.createElement("span");
    lbl.className = "lbl";
    lbl.textContent = seg;

    const kids = [col, lbl];
    if (w !== 1) {
      const badge = document.createElement("span");
      badge.className = "wbadge";
      badge.textContent = fmtWeight(w);
      badge.title = "当前权重（写进文本框的 (词:权重) 或 LoRA 自己的强度）";
      kids.push(badge);
    }

    const del = document.createElement("span");
    del.className = "smchip-del";
    del.textContent = "×";
    del.title = "从文本框里彻底删掉这一段（可撤销）";
    del.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    del.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.del(i);
    });
    kids.push(del);

    b.append(...kids);
    b.addEventListener("pointerdown", (e) => this.onPointerDown(e, i));
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      // 键盘回车/空格也会发 click（detail = 0）；鼠标点击走 pointerup，别在这里重复触发
      if (e.detail === 0) this.toggle(i);
    });
    return b;
  }

  wbtnEl(glyph, i, delta, weight, tip) {
    const el = document.createElement("span");
    el.className = "wbtn";
    el.textContent = glyph;
    el.title = weight === 1
      ? `${tip}（当前 1.00，加减后才写进括号）`
      : `${tip}（当前 ${fmtWeight(weight)}）`;
    el.addEventListener("pointerdown", (e) => { e.preventDefault(); e.stopPropagation(); });
    el.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.bump(i, delta);
    });
    return el;
  }

  // ---------------------------------------------------------------- 拖动 / 单击

  onPointerDown(e, i) {
    if (e.button !== 0) return;
    if (e.target?.closest?.(".wbtn, .smchip-del")) return; // 加减号/删除键自己处理
    if (this.editing) {
      if (this.editing.i !== i) this.finishEdit(true); // 点在别的词上 = 点别处，先提交
      return;                                          // 这一下不再当成拖动/单击
    }
    e.preventDefault();
    e.stopPropagation();
    const chip = e.currentTarget;
    this.hideGapBar(); // 开始按下词片：插入竖线让位
    const list = this.opts.list;
    // 冻结此刻每个词片在屏幕上的矩形：预览重排会让布局变化，落点必须拿冻结坐标算
    const chips = Array.from(list.querySelectorAll(".smchip"));
    const drag = {
      i, x0: e.clientX, y0: e.clientY, chip, moved: false, slot: i,
      rects: chips.map((el) => el.getBoundingClientRect()),
    };
    this.drag = drag;
    chip.classList.add("pressing");

    const onMove = (ev) => this.onPointerMove(ev);
    const onUp = (ev) => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      this.onPointerUp(ev);
    };
    // 手势被系统收走（切窗口、触屏取消）：当没动过处理，别留下半透明的脏状态
    const onCancel = () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onCancel, true);
      const d = this.drag;
      this.drag = null;
      d?.chip?.classList.remove("pressing", "dragging");
      this.render(); // 预览期间只动过 DOM，重画一次就回到状态里的顺序
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onCancel, true);
  }

  onPointerMove(ev) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(ev.clientX - d.x0, ev.clientY - d.y0) < DRAG_SLOP) return;
      d.moved = true;
      d.chip.classList.add("dragging");
      d.chip.classList.remove("pressing");
    }
    const slot = slotFromRects(d.rects, d.i, ev.clientX, ev.clientY);
    if (slot === d.slot) return;
    d.slot = slot;
    this.previewOrder(d);
  }

  // 预览：把被拖的词片直接插到目标位置，两边的词自己让开（松手前只动 DOM，不动状态）
  previewOrder(d) {
    const list = this.opts.list;
    const others = Array.from(list.querySelectorAll(".smchip")).filter((el) => el !== d.chip);
    const ref = others[d.slot] || null;
    if (ref) list.insertBefore(d.chip, ref);
    else list.append(d.chip);
  }

  onPointerUp(ev) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    d.chip?.classList.remove("pressing", "dragging");
    if (!d.moved) {
      this.handleTap(d.i);    // 单击 = 开关，但先让双击有机会抢走
      return;
    }
    if (d.slot === d.i) {
      this.render();          // 拖了一圈又回原位：把预览时的 DOM 顺序还原
      return;
    }
    this.move(d.i, d.slot);
  }

  // ---------------------------------------------------------------- 单击 / 双击

  // 单击不能立刻切换：两次点击要能合成一次双击。压 DOUBLE_MS 再 toggle，
  // 期间来了第二下就取消切换、改为就地编辑——界面上一格都不会闪。
  handleTap(i) {
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const seg = (this.st.segs || [])[i];
    if (seg == null) return;
    const last = this.lastClick;
    if (last && last.i === i && now - last.t <= DOUBLE_MS) {
      this.lastClick = null;
      this.cancelPendingClick();
      this.beginEdit(i);
      return;
    }
    this.flushPendingClick(); // 上一下点的是别的词：让它立刻生效，别被吞掉
    this.lastClick = { i, t: now, seg };
    this.cancelPendingClick();
    this.clickTimer = setTimeout(() => {
      this.clickTimer = null;
      this.lastClick = null;
      // 这 220ms 里文本可能被改过：那一段还是原来那个词才切换，否则放弃
      if ((this.st.segs || [])[i] !== seg) return;
      this.toggle(i);
    }, DOUBLE_MS);
  }

  cancelPendingClick() {
    if (this.clickTimer) clearTimeout(this.clickTimer);
    this.clickTimer = null;
  }

  flushPendingClick() {
    const l = this.lastClick;
    this.cancelPendingClick();
    this.lastClick = null;
    if (!l) return;
    if ((this.st.segs || [])[l.i] === l.seg) this.toggle(l.i);
  }

  // ---------------------------------------------------------------- 双击就地编辑 / 双击空白插入

  // 造一个就地输入框（改词和新插入共用同一份行为：Enter 提交 / Esc 取消 / 失焦提交 / 中文输入法保护）
  // 用 textarea 而不是 input：input 是单行控件，长词折成两行以上时编辑只能看到一条窄缝。
  makeInput(initial, placeholder, minWidth = 160) {
    const el = document.createElement("textarea");
    el.className = "smchip-edit";
    el.value = initial;
    if (placeholder) el.placeholder = placeholder;
    el.spellcheck = false;
    el.autocomplete = "off";
    el.rows = 1;
    el.wrap = "soft";
    el.style.visibility = "hidden"; // 先进 DOM 量尺寸，量完整再露出来（否则会闪一帧矮框）

    const list = this.opts.list;
    // 宽度跟着内容走（按最长一行量），夹在 [minWidth, 词片区可用宽]；高度跟着折行数长
    const fit = () => {
      const cs = getComputedStyle(el);
      const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + 2; // +2 边框
      const ctx = (this._measure ||= document.createElement("canvas").getContext("2d"));
      const maxW = Math.max(120, (list?.clientWidth || 300) - 8);
      let w = minWidth;
      if (ctx) {
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        const longest = String(el.value || placeholder || "新词")
          .split("\n")
          .reduce((m, line) => Math.max(m, ctx.measureText(line).width), 0);
        w = Math.max(minWidth, Math.ceil(longest) + padX);
      }
      el.style.width = `${Math.min(maxW, w)}px`;

      // 高度：先归零再读 scrollHeight；不超过词片区可视高度，超了框内滚动
      const maxH = Math.max(40, (list?.clientHeight || 200) - 4);
      el.style.height = "auto";
      const need = el.scrollHeight + 2; // scrollHeight 不含边框
      el.style.height = `${Math.min(maxH, need)}px`;
      el.style.overflowY = need > maxH ? "auto" : "hidden";
    };

    // chip 的手势处理器会 preventDefault，光标和选区会被一起吃掉 -> 这里拦住
    el.addEventListener("pointerdown", (e) => e.stopPropagation());
    el.addEventListener("mousedown", (e) => e.stopPropagation());
    el.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 输入法组字中，别当提交
      if (e.key === "Enter") {
        // 换行不在这里做：提示词里的换行本身也是分隔符，要拆词直接输逗号
        e.preventDefault();
        e.stopPropagation();
        this.finishEdit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.finishEdit(false);
      }
    });
    el.addEventListener("input", () => fit());
    el.addEventListener("blur", () => {
      if (this.editing) this.finishEdit(true); // 点到别处也算提交
    });
    return { input: el, fit };
  }

  // 编辑框挂进词片区，成为这一轮编辑的当前框
  mountEditor(ed, box, fit, selectAll) {
    this.editing = ed;
    this.hideGapBar(); // 竖线让位给输入框

    // 编辑期间点面板任何其它地方 = 提交（blur 在 preventDefault 的手势里不一定来）
    this._outside = (e) => {
      if (!this.editing) return;
      if (!this.opts.list?.isConnected) {
        this.detachOutside();
        return;
      }
      if (this.editing.box.contains(e.target)) return;
      this.finishEdit(true);
    };
    document.addEventListener("pointerdown", this._outside, true);

    ed.input.focus();
    if (selectAll) ed.input.select();
    fit();                              // 先在隐藏状态量好宽高，避免闪一帧矮框
    ed.input.style.visibility = "";
    // 词片区可滚动：框可能落在可视区外，滚一把否则看着像没反应
    requestAnimationFrame(() => box.scrollIntoView?.({ block: "nearest" }));
  }

  beginEdit(i) {
    const list = this.opts.list;
    const seg = (this.st.segs || [])[i];
    if (this.editing || seg == null || !list) return;
    const chip = list.querySelector(`.smchip[data-i="${i}"]`);
    if (!chip) return;

    // 起始宽度 = 原词片的文字宽度：同样的字、同样的宽，进编辑时字形不会跳
    const cs = getComputedStyle(chip);
    const innerW = Math.max(
      64,
      chip.clientWidth - parseFloat(cs.paddingLeft || 0) - parseFloat(cs.paddingRight || 0),
    );
    const { input, fit } = this.makeInput(seg, "", innerW);
    // <button> 里不能塞 <textarea>（交互元素套交互元素，浏览器会闹脾气），
    // 所以编辑期间把一个同色的 <div> 换上去，退出编辑后整体重画。
    const box = document.createElement("div");
    box.className = `${chip.className.replace(/\bediting\b/g, "").trim()} editing`;
    box.dataset.i = String(i);
    box.append(input);
    chip.replaceWith(box);
    this.mountEditor({ mode: "edit", i, box, input, seg }, box, fit, true);
  }

  // 双击词片之间的空白：在这个位置开一个空框，写进去的词插进文本同一位置。
  // k = 插到第几段之前（k 等于段数就是追加到末尾）。
  beginInsert(k) {
    const list = this.opts.list;
    if (this.editing || !list) return;
    const segs = this.st.segs || [];
    const at = Math.max(0, Math.min(segs.length, k | 0));

    const { input, fit } = this.makeInput("", "输入新词…");
    const box = document.createElement("div");
    box.className = "smchip on editing"; // 新词默认开启：先长成绿的，写进去就是绿的
    box.dataset.insert = String(at);
    box.append(input);

    list.querySelector(".sm-hint")?.remove(); // 空文本时那块提示让位给输入框
    const chips = this.chipEls();
    const next = chips[at] || null;
    if (next) list.insertBefore(box, next);
    else list.appendChild(box);

    this.mountEditor({ mode: "insert", k: at, box, input, seg: "" }, box, fit, false);
  }

  detachOutside() {
    if (this._outside) document.removeEventListener("pointerdown", this._outside, true);
    this._outside = null;
  }

  finishEdit(commit) {
    const ed = this.editing;
    if (!ed) return;
    this.editing = null;   // 先清干净：blur 再来一次就什么也不做
    this.detachOutside();
    const val = ed.input.value;
    ed.input.remove();
    ed.box.classList.remove("editing");
    ed.box.remove();       // 原地留个空位，随后的 render 会把整排词重画

    const clean = val.trim();
    if (!commit || clean === ed.seg) {
      this.render();
      return;
    }
    if (ed.mode === "insert") {
      this.insert(ed.k, clean); // 插入框里空着提交 = 什么都不插（上面的 clean === seg 已经挡了）
      return;
    }
    if (!clean) {
      this.render();
      this.del(ed.i);      // 清空 = 删掉这一段（带撤销）
      return;
    }
    this.edit(ed.i, clean);
  }

  // 改一段：只替换那一段的原文区间，别处标点不动；新文本写回编辑框
  async edit(i, body) {
    const data = await this.mutate(`edit=${i},${encodeURIComponent(body)}`);
    if (!data) {
      this.render();
      return;
    }
    this.pushUndo();
    const st = this.st;
    const oldMask = st.mask || [];
    const oldN = (st.segs || []).length;
    const newN = (data.segments || []).length;
    // 这一段改完可能变成好几段（词里写了逗号）：按原段的开关复制 k 份插回原位
    const k = Math.max(1, newN - (oldN - 1));
    const mask = [];
    for (let j = 0; j < oldN; j++) {
      const v = oldMask[j] ? 1 : 0;
      if (j === i) for (let c = 0; c < k; c++) mask.push(v);
      else mask.push(v);
    }
    this.applyNew(data, mask);
  }

  // 插一段：新词落在第 k 段之前，只多一个分隔符；mask 在同一位插一个 1（默认开）
  async insert(k, body) {
    const data = await this.mutate(`insert=${k},${encodeURIComponent(body)}`);
    if (!data) {
      this.render();
      return;
    }
    this.pushUndo();
    const oldMask = this.st.mask || [];
    const n = (this.st.segs || []).length;
    // 新词里带逗号会炸成好几段：按实际增加的段数补 1
    const add = Math.max(1, (data.segments || []).length - n);
    const at = Math.max(0, Math.min(n, k));
    const mask = [
      ...oldMask.slice(0, at),
      ...Array(add).fill(1),
      ...oldMask.slice(at),
    ];
    this.applyNew(data, mask);
  }

  // ---------------------------------------------------------------- 空白处插入：悬停竖线

  ensureGapBar() {
    const list = this.opts.list;
    if (!list) return null;
    if (!this.gapBar || !this.gapBar.isConnected) {
      const bar = document.createElement("div");
      bar.className = "sm-gap-bar";
      list.appendChild(bar);
      this.gapBar = bar;
    }
    return this.gapBar;
  }

  restoreGapBar() {
    this.ensureGapBar();
    this.gapAt = -1;
    if (this.gapBar) this.gapBar.classList.remove("on");
  }

  hideGapBar() {
    this.gapAt = -1;
    if (this.gapBar) this.gapBar.classList.remove("on");
  }

  onHover(e) {
    if (this.drag || this.editing) return this.hideGapBar();
    if (e.target?.closest?.(".smchip")) return this.hideGapBar(); // 在词片上不提示
    const els = this.chipEls();
    if (!els.length) return this.hideGapBar(); // 空文本：没有缝可提示
    const rects = els.map((el) => el.getBoundingClientRect());
    this.showGapBar(els, slotFromRects(rects, -1, e.clientX, e.clientY));
  }

  // 竖线画在「前一个词片之后」的那条缝上（插入点落在行边界时也这样，看着最顺）。
  // 位置用 offsetLeft/offsetTop 算：它们相对 .sm-list，滚动 container 里也不会错。
  showGapBar(els, k) {
    const list = this.opts.list;
    const bar = this.ensureGapBar();
    if (!bar || !list) return;
    const prev = k > 0 ? els[k - 1] : null;
    const next = els[k] || null;
    if (!prev && !next) return this.hideGapBar();
    const gap = parseFloat(getComputedStyle(list).columnGap) || 8;
    const half = gap / 2;
    let left, top, height;
    if (prev) {
      left = prev.offsetLeft + prev.offsetWidth + half - 1;
      top = prev.offsetTop;
      height = prev.offsetHeight;
    } else {
      left = Math.max(0, next.offsetLeft - half - 1);
      top = next.offsetTop;
      height = next.offsetHeight;
    }
    bar.style.left = `${Math.round(left)}px`;
    bar.style.top = `${Math.round(top)}px`;
    bar.style.height = `${Math.round(height)}px`;
    bar.classList.add("on");
    this.gapAt = k;
  }

  // ---------------------------------------------------------------- 操作

  toggle(i) {
    const st = this.st;
    const mask = (st.mask || []).slice();
    if (i < 0 || i >= (st.segs || []).length) return;
    mask[i] = mask[i] ? 0 : 1;
    st.mask = mask;
    this.opts.writeMask(mask);
    this.paintChips();   // 就地换色：绿↔红淡过去，不重建元素
    this.opts.after?.();
  }

  async del(i) {
    const data = await this.mutate(`drop=${i}`);
    if (!data) return;
    this.pushUndo();
    const mask = (this.st.mask || []).filter((_, k) => k !== i);
    this.applyNew(data, mask);
  }

  async bump(i, delta) {
    const data = await this.mutate(`weight=${i},${delta}`);
    if (!data) return;
    this.pushUndo();
    this.applyNew(data, (this.st.mask || []).slice());
  }

  async move(from, to) {
    const st = this.st;
    const n = (st.segs || []).length;
    if (!(from >= 0 && from < n) || !(to >= 0 && to < n) || from === to) {
      this.render();
      return;
    }
    const order = Array.from({ length: n }, (_, k) => k);
    order.splice(to, 0, order.splice(from, 1)[0]);
    const data = await this.mutate(`move=${from},${to}`);
    if (!data) {
      this.render(); // 后端没给新文本：把拖动的预览顺序放下，别让界面和状态不一致
      return;
    }
    this.pushUndo();
    const oldMask = st.mask || [];
    const mask = order.map((k) => (oldMask[k] ? 1 : 0)); // 开关跟着词走
    this.applyNew(data, mask);
  }

  async undoLast() {
    const u = this.undoState;
    if (!u) return;
    this.undoState = null;
    clearTimeout(this.undoTimer);
    if (this.opts.undoBtn) this.opts.undoBtn.style.display = "none";
    const st = this.st;
    st.segs = u.segs.slice();
    st.mask = u.mask.slice();
    st.weights = (u.weights || []).slice();
    this.opts.writeMask(st.mask);
    this.render();
    this.opts.writeText(u.text);
    this.opts.after?.();
  }

  // ---------------------------------------------------------------- 内部

  async mutate(query) {
    if (this.busy) return null;
    this.busy = true;
    // 任何改文本的操作都把「待生效的单击开关」作废：那段词马上就要变样了
    this.cancelPendingClick();
    this.lastClick = null;
    const text = this.opts.getText();
    try {
      const res = await api.fetchApi(
        `/prompt_toggle/split?text=${encodeURIComponent(text)}&${query}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      if (typeof data.text !== "string" || data.text === text) return null;
      return data;
    } catch (e) {
      console.warn("[String-Mixer] 词条操作失败：", e);
      return null;
    } finally {
      this.busy = false;
    }
  }

  // 新文本 + 新片段：先换状态再写文本框，宿主的 reconcile 看到的正好是同一组片段
  applyNew(data, mask) {
    const st = this.st;
    const segs = data.segments || [];
    st.segs = segs;
    st.weights = data.weights || [];
    st.mask = Array.isArray(mask) && mask.length === segs.length
      ? mask
      : segs.map(() => 1);
    this.opts.writeMask(st.mask);
    this.render();
    this.opts.writeText(data.text);
    this.opts.after?.();
  }

  pushUndo() {
    const st = this.st;
    this.undoState = {
      text: this.opts.getText(),
      segs: (st.segs || []).slice(),
      mask: (st.mask || []).slice(),
      weights: (st.weights || []).slice(),
    };
    const btn = this.opts.undoBtn;
    if (!btn) return;
    btn.style.display = "inline-block"; // 不能置空：CSS 里默认 display:none
    clearTimeout(this.undoTimer);
    this.undoTimer = setTimeout(() => {
      btn.style.display = "none";
      this.undoState = null;
    }, UNDO_MS);
  }
}
