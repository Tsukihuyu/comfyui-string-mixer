// 📄 提示词文件 / Prompt File —— 从目录里挑一个 txt
// 想说明：提示词可以是一个文件（可版本管理、可分享），节点里选文件即可。
app.graph.clear();
const n = LiteGraph.createNode("PromptFileLoader");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1800);

__set(n, "directory", "prompts");
await __wait(2200);

const fw = __widget(n, "file");
const opts = (fw && fw.options && fw.options.values) || [];
const pick = opts.map(String).find((v) => v.includes("portrait"));
if (fw && pick) {
  fw.value = pick;
  fw.callback?.(pick);
}
await __wait(1600);

app.canvas.setDirty(true, true);
await __wait(500);
return __place(n);
