// 🧵 文本混合 3 / Text Mix 3 —— 三个框，第 2 个关掉
// 想说明：每框一个开关，关掉的整段不参与合并；外部输入在最前面。
app.graph.clear();
const n = LiteGraph.createNode("StringMixer");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1500);

__set(n, "box_1", "masterpiece, best quality, ultra detailed");
__set(n, "box_2", "1girl, blue hair, kimono");
__set(n, "enable_2", false);
__set(n, "box_3", "cinematic lighting, film grain, 35mm");
__set(n, "separator", ", ");
await __wait(1000);

app.canvas.setDirty(true, true);
await __wait(400);
return __place(n);
