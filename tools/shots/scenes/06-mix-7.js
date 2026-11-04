// 🧵 文本混合 7 / Text Mix 7 —— 七个槽位，关掉两个
// 想说明：长提示词拆成"一人一格"来管，改哪段只动那一格。
app.graph.clear();
const n = LiteGraph.createNode("StringMixer7");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1500);

__set(n, "box_1", "masterpiece, best quality, ultra detailed");
__set(n, "box_2", "1girl, solo, upper body");
__set(n, "box_3", "blue hair, long wavy hair, hair ribbon");
__set(n, "box_4", "kimono, floral pattern, gold embroidery");
__set(n, "enable_4", false);
__set(n, "box_5", "cherry blossoms, petals falling, spring");
__set(n, "box_6", "soft rim light, golden hour");
__set(n, "enable_6", false);
__set(n, "box_7", "35mm film, shallow depth of field");
await __wait(1000);

app.canvas.setDirty(true, true);
await __wait(400);
return __place(n);
