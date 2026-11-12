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
.sm-list { position: relative; }
.smchip {
  display: inline-flex; align-items: stretch;
  font-size: 12px; line-height: 17px; padding: 1px 6px 1px 3px; border-radius: 11px;
  cursor: pointer; max-width: 100%; white-space: normal; word-break: break-word;
  text-align: left; border: 1px solid transparent; font-weight: 500;
  transition: filter .12s ease, opacity .12s ease, border-color .12s ease;
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

/* 双击就地编辑：词片本体换成一个输入框，宽度跟着内容走（颜色仍继承开/关的红绿） */
.smchip.editing { cursor: text; }
.smchip .smchip-edit {
  align-self: center; min-width: 48px; max-width: 100%;
  font: inherit; font-size: 12px; line-height: 15px;
  color: inherit; background: rgba(0,0,0,.35);
  border: 1px solid currentColor; border-radius: 7px;
  padding: 0 4px; margin: 0; outline: none; box-sizing: border-box;
}
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
    this.editing = null;   // {i, box, input, seg} 正在编辑的那一段
    this.clickTimer = null; // 待生效的单击开关（双击判定窗口内先压着）
    this.lastClick = null;  // {i, t, seg} 上一次单击
    this.undoState = null;
    this.undoTimer = null;
    ensureChipStyles();
    if (opts.list) opts.list.classList.add("sm-list");
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
    const { list, countEl } = this.opts;
    if (!list) return;
    const st = this.st;
    const segs = st.segs || [];
    const weights = st.weights || [];

    if (countEl) {
      const on = segs.reduce((n, _, i) => n + (this.isOn(i) ? 1 : 0), 0);
      countEl.textContent = segs.length ? `开 ${on} / ${segs.length}` : "";
      if (countEl.dataset) countEl.dataset.off = segs.length && on === 0 ? "1" : "";
    }

    if (!segs.length) {
      const hint = document.createElement("div");
      hint.className = "sm-hint";
      hint.textContent = this.opts.hint || "框里有字后，这里会按标点炸成可点的片段";
      list.replaceChildren(hint);
      return;
    }

    list.replaceChildren(...segs.map((seg, i) => this.chipEl(seg, i, weights[i])));
  }

  chipEl(seg, i, weight) {
    const on = this.isOn(i);
    const w = Number.isFinite(Number(weight)) ? Number(weight) : 1;
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.i = String(i);
    b.className = `smchip ${on ? "on" : "off"}${w !== 1 ? " wtd" : ""}`;
    b.title = [
      on ? "单击关掉这一段（不进输出）" : "单击打开这一段",
      "双击 = 就地改这个词",
      "按住拖动 = 换位置",
      "左侧 ＋/－ = 权重 ±0.05",
      "右侧 × = 从文本框里删掉（可撤销）",
    ].join("；");

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

  // ---------------------------------------------------------------- 双击就地编辑

  beginEdit(i) {
    const list = this.opts.list;
    const seg = (this.st.segs || [])[i];
    if (this.editing || seg == null || !list) return;
    const chip = list.querySelector(`.smchip[data-i="${i}"]`);
    if (!chip) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "smchip-edit";
    input.value = seg;              // 原文整段交给你改（(cat:1.2) 连括号一起）
    input.spellcheck = false;
    input.autocomplete = "off";

    // 输入框宽度跟着内容走：用 canvas 量（输入框自己的 scrollWidth 要等布局）
    const fitWidth = () => {
      const cs = getComputedStyle(input);
      const ctx = (this._measure ||= document.createElement("canvas").getContext("2d"));
      if (!ctx) return;
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const w = ctx.measureText(input.value || " ").width;
      input.style.width = `${Math.min(240, Math.max(48, Math.ceil(w) + 18))}px`;
    };

    // chip 的手势处理器会 preventDefault，光标和选区会被一起吃掉 -> 这里拦住
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("mousedown", (e) => e.stopPropagation());
    input.addEventListener("keydown", (e) => {
      if (e.isComposing || e.keyCode === 229) return; // 输入法组字中，别当提交
      if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        this.finishEdit(true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        this.finishEdit(false);
      }
    });
    input.addEventListener("input", () => fitWidth());
    input.addEventListener("blur", () => {
      if (this.editing) this.finishEdit(true); // 点到别处也算提交
    });

    // <button> 里不能塞 <input>（交互元素套交互元素，浏览器会闹脾气），
    // 所以编辑期间把一个同色的 <div> 换上去，退出编辑后整体重画。
    const box = document.createElement("div");
    box.className = `${chip.className.replace(/\bediting\b/g, "").trim()} editing`;
    box.dataset.i = String(i);
    box.append(input);
    chip.replaceWith(box);

    this.editing = { i, box, input, seg };

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

    input.focus();
    input.select();
    fitWidth();
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

    if (!commit) {
      this.render();
      return;
    }
    const clean = val.trim();
    if (clean === ed.seg) {
      this.render();
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

  // ---------------------------------------------------------------- 操作

  toggle(i) {
    const st = this.st;
    const mask = (st.mask || []).slice();
    if (i < 0 || i >= (st.segs || []).length) return;
    mask[i] = mask[i] ? 0 : 1;
    st.mask = mask;
    this.opts.writeMask(mask);
    this.render();
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
