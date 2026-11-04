// 全家福：11 个节点按族排成网格，彼此不连线（纯"产品照"）
app.graph.clear();

const types = [
  "TextSnapshot",
  "TextGateSplit",
  "PromptToggle",
  "CameraMixer",
  "StringMixer",
  "StringMixer5",
  "StringMixer7",
  "PromptSanitizer",
  "PromptFileLoader",
  "SkillPromptOptimizer",
  "SkillPromptLayoutCompiler",
];

const nodes = types.map((t) => {
  const n = LiteGraph.createNode(t);
  if (!n) throw new Error("建不出节点 " + t);
  app.graph.add(n);
  return n;
});

await __wait(4000);

__set(nodes[4], "box_1", "masterpiece, best quality");
__set(nodes[4], "box_2", "1girl, blue hair");
__set(nodes[7], "string", "(((best quality))), masterpiece, 1girl");
await __wait(1500);

// 4 列网格，列宽/行高按实际尺寸算（相机那类高节点不会压到下一行）
const cols = 4;
const gapX = 80;
const gapY = 90;
const colW = [];
const rowH = [];
nodes.forEach((n, i) => {
  const c = i % cols;
  const r = Math.floor(i / cols);
  colW[c] = Math.max(colW[c] || 0, n.size[0]);
  rowH[r] = Math.max(rowH[r] || 0, n.size[1]);
});

let y = 0;
for (let r = 0; r * cols < nodes.length; r++) {
  let x = 0;
  for (let c = 0; c < cols; c++) {
    const n = nodes[r * cols + c];
    if (n) n.pos = [x, y];
    x += (colW[c] || 0) + gapX;
  }
  y += (rowH[r] || 0) + gapY;
}

await __wait(800);
app.canvas.setDirty(true, true);
await __wait(1200);

const totalW = colW.reduce((a, b) => a + b + gapX, 0) - gapX;
const totalH = y - gapY;
const scale = Math.min(1, 1450 / totalW, 1150 / totalH);
return __placeMany(nodes, 30, scale);
