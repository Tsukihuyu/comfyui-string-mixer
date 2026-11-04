// 💥 提示词炸词 / Prompt Toggle —— 10 段，关掉 4 段
// 想说明：标点切开、逐段开关，关掉的留在原地（红色），不是删掉重写。
app.graph.clear();
const n = LiteGraph.createNode("PromptToggle");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1600);

await __setText(
  n,
  "text",
  "masterpiece, best quality, 1girl, blue hair, kimono, cherry blossoms, smile, looking at viewer, shallow depth of field, cinematic light",
);
await __wait(1000);

const chips = __clickAll(".pfl-chip");
[1, 5, 7, 8].forEach((i) => chips[i]?.click());
await __wait(900);

app.canvas.setDirty(true, true);
await __wait(500);
return __place(n);
