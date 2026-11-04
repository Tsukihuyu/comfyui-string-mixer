// ⛩ 闸门炸词 / Text Gate Toggle —— 10 个片段，关掉 3 个
// 想说明：上游接进来的词按标点炸成一排，关掉的留在原地（变红），不是删掉。
app.graph.clear();
const n = LiteGraph.createNode("TextGateSplit");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1600);

await __setText(
  n,
  "text",
  "masterpiece, best quality, 1girl, blue hair, kimono, cherry blossoms, smile, looking at viewer, shallow depth of field, cinematic light",
);
await __wait(1200);

const chips = __clickAll(".tgs-chip");
// 关掉第 4 个（blue hair 之外挑三个有辨识度的）
[3, 7, 8].forEach((i) => chips[i]?.click());
await __wait(1200);

n.setDirtyCanvas?.(true, true);
app.canvas.setDirty(true, true);
await __wait(600);
return __place(n);
