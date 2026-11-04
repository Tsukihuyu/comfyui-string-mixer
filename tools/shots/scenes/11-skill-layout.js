// 🧭 技能排版 / Skill Layout —— 结构化布局 JSON → 一行可用的布局提示词
// 想说明：位置用数字定，不用再靠"left/right"这种模糊词；编出来的东西可以直接喂给下游。
app.graph.clear();
const n = LiteGraph.createNode("SkillPromptLayoutCompiler");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1600);

await __setText(
  n,
  "text",
  [
    "{",
    '  "summary": "少女站在樱花树下，右侧三分之一处，远景留白",',
    '  "items": [',
    '    {"desc": "1girl, blue hair, kimono", "bbox": [420, 260, 900, 980]},',
    '    {"desc": "cherry blossoms", "bbox": [0, 0, 1024, 320]}',
    "  ]",
    "}",
  ].join("\n"),
);
await __wait(900);

app.canvas.setDirty(true, true);
await __wait(500);
return __place(n);
