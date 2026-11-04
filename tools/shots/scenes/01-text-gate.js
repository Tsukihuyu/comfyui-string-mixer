// ⛩ 文本闸门 / Text Gate —— 左边接一个文本混合，框里自己写了字
// 想说明：框里有字就"关闸"，上游内容被拦下（状态条给字数），清空即放行。
app.graph.clear();

const src = LiteGraph.createNode("StringMixer");
app.graph.add(src);
src.pos = [0, 60];

const gate = LiteGraph.createNode("TextSnapshot");
app.graph.add(gate);
gate.pos = [470, 0];

await __wait(1600);

__set(src, "box_1", "masterpiece, best quality");
__set(src, "box_2", "1girl, blue hair, kimono");
__set(src, "box_3", "cinematic lighting, film grain");
await __wait(300);

__set(gate, "text", "masterpiece, best quality, 1girl, blue hair, kimono, cherry blossoms");
await __wait(800);

const slot = (gate.inputs || []).findIndex((i) => i && i.name === "source");
if (slot >= 0) src.connect(0, gate, slot);
await __wait(900);

// 真跑一次这条链（只提交闸门及其上游），让"上游预览 / 拦下字数"是真实回填的
try {
  await app.queuePrompt(0, 1, { queueNodeIds: [gate.id] });
  for (let i = 0; i < 40; i++) {
    const st = document.querySelector(".ts-status");
    if (st && /拦下|字/.test(st.textContent)) break;
    await __wait(500);
  }
} catch (e) {
  // 队列不可用也不影响截图，只是状态条显示未回填
}

app.canvas.setDirty(true, true);
await __wait(800);
return __placeMany([src, gate]);
