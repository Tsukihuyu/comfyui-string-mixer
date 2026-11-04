// 🧵 文本混合 5 / Text Mix 5 —— 五个槽位，关掉第 4 个
// 想说明：同一套规则，槽位更多，适合把"质量词 / 主体 / 服装 / 场景 / 光线"分开管。
app.graph.clear();
const n = LiteGraph.createNode("StringMixer5");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1500);

__set(n, "box_1", "masterpiece, best quality");
__set(n, "box_2", "1girl, solo");
__set(n, "box_3", "blue hair, long hair, kimono");
__set(n, "box_4", "cherry blossoms, petals falling");
__set(n, "enable_4", false);
__set(n, "box_5", "soft rim light, golden hour");
await __wait(1000);

app.canvas.setDirty(true, true);
await __wait(400);
return __place(n);
