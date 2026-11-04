// 🧼 提示词净化 / Prompt Cleaner —— 一堆括号、重复词、多余空格
// 想说明：三个开关各管一件事，改完直接出干净的一句，不用手抠。
app.graph.clear();
const n = LiteGraph.createNode("PromptSanitizer");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1500);

__set(
  n,
  "string",
  "(((best quality))), masterpiece,   masterpiece , ((1girl)), 1girl, blue hair, [blurry], (smile:1.2)",
);
__set(n, "clean_weights", true);
__set(n, "dedupe", true);
__set(n, "format", true);
await __wait(1200);

app.canvas.setDirty(true, true);
await __wait(400);
return __place(n);
