// ⛩ 闸门炸词 / Text Gate Toggle —— 没动过手的状态（闸门开，跟着上游走）
// 想说明：上游接进来、你什么都没动，状态条会告诉你“下次执行会换上新上游”。
async function __idle() {
  for (let i = 0; i < 200; i++) {
    const q = await (await fetch("/api/queue")).json();
    if (!(q.queue_running || []).length && !(q.queue_pending || []).length) return;
    await __wait(200);
  }
}
app.graph.clear();
const up = LiteGraph.createNode("TextSnapshot");
app.graph.add(up);
up.pos = [0, 0];
const n = LiteGraph.createNode("TextGateSplit");
app.graph.add(n);
n.pos = [420, 0];

const upW = up.widgets.find((w) => w.name === "text");
upW.value = "masterpiece, best quality, 1girl, blue hair kimono, cherry blossoms, smile, looking at viewer";
upW.callback?.(upW.value);
up.connect(0, n, n.inputs.findIndex((i) => i.name === "source"));
await __wait(1500);

await app.queuePrompt(0, 1);
await __wait(600);
await __idle();
await __wait(5000); // 等“已流入框内”的提示过期，露稳态文案

n.setSize([430, 620]);
await __wait(900);
app.canvas.setDirty(true, true);
await __wait(500);
return __place(n);
