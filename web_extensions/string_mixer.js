// [已停用] 这里原本用 convertWidgetToInput 把 input_string 从文本框转成纯输入端口。
//
// 现代 ComfyUI 前端里 widget 与 socket 是共存的：每个控件旁边自带连接点，
// 控件既能直接填文字，也能连别的节点。所以「去文本框、只留端口」既做不到、
// 也没必要 —— 旧版 convertWidgetToInput 现在是个只会打印警告的空壳：
//
//   prototype.convertWidgetToInput = function () {
//     console.warn("Please remove call to convertWidgetToInput. "
//                + "Widget to socket conversion is no longer necessary, as they co-exist now.");
//     return false;
//   }
//
// 留着本文件只为说明去向，不再注册任何扩展。真要在旧前端上跑，恢复方案见 git 历史。
