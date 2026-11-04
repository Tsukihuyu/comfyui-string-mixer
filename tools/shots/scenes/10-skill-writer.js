// ✍️ 技能写词 / Skill Writer —— 一句话需求 + 规则书 → 成稿
// 想说明：把"怎么说"交给规则书（SKILL.md），节点只负责调模型、出干净的一句话。
app.graph.clear();
const n = LiteGraph.createNode("SkillPromptOptimizer");
app.graph.add(n);
n.pos = [0, 0];
await __wait(1800);

__set(n, "prompt", "一个穿和服的少女站在樱花树下，午后侧逆光，想要安静的氛围");
__set(n, "output_format", "caption");
__set(n, "language", "English");

// 规则书与 endpoint 的下拉项来自 skillprompt/skills/ 和 skillprompt/skillprompt.ini
const skill = __widget(n, "skill");
const sOpt = ((skill && skill.options && skill.options.values) || []).map(String);
const sPick = sOpt.find((v) => v.includes("demo")) || sOpt[0];
if (skill && sPick) __set(n, "skill", sPick);

const model = __widget(n, "llm_model");
const mOpt = ((model && model.options && model.options.values) || []).map(String);
const mPick = mOpt.find((v) => /demo/i.test(v)) || mOpt[0];
if (model && mPick) __set(n, "llm_model", mPick);

await __wait(1400);
app.canvas.setDirty(true, true);
await __wait(500);
return __place(n);
