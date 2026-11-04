// 🎥 相机镜头 / Camera Rig —— 右侧、略俯、中景
// 想说明：点选方位/高度/景别，预览行就是排队时真输出的那句；不用记英文模板。
app.graph.clear();
const n = LiteGraph.createNode("CameraMixer");

// 面板是异步搭起来的，而且读的是 properties.camera_vals：
// 在 add() 之前把值放进去，面板第一次渲染就会照着这些值来。
n.properties = n.properties || {};
n.properties.camera_vals = {
  pos_azimuth: 0.45,
  pos_elevation: 0.35,
  pos_distance: -0.25,
};

app.graph.add(n);
n.pos = [0, 0];

await __wait(3000);
app.canvas.setDirty(true, true);
await __wait(700);
return __place(n);
