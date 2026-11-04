"""SkillPrompt —— LLM 按 markdown 规则书写词 + 确定性布局编译。

并入 comfyui-string-mixer 后作为一个子包存在：
  * 这里是「LLM 类」节点（要联网、有 endpoint 配置），和 mixer 家族（纯文本处理）分开摆；
  * 根目录 __init__.py 只负责把这里的 NODE_CLASS_MAPPINGS 并进整个插件的注册表；
  * 数据与配置都在仓库根目录：skills/（规则书）、skillprompt.ini（endpoint，不进版本库）。

模块分工：
  optimizer.py        SkillPromptOptimizer —— 调 OpenAI 兼容 endpoint，按 skill 写提示词
  layout_compiler.py  SkillPromptLayoutCompiler —— 把结构化 JSON 编译成布局提示词（纯本地）
  promptkit.py        编译/清洗/画布校验等纯函数
  skills.py           扫描 skills/ 下含 SKILL.md 的文件夹
  config.py           读 skillprompt.ini，生成 llm_model 下拉
  http_client.py      POST 请求 / 流式读取 / 触发词处理
  unload.py           尽量让上游模型释放显存（llama.cpp / LM Studio / Ollama）
"""

from .layout_compiler import SkillPromptLayoutCompiler
from .optimizer import SkillPromptOptimizer

NODE_CLASS_MAPPINGS = {
    "SkillPromptOptimizer": SkillPromptOptimizer,
    "SkillPromptLayoutCompiler": SkillPromptLayoutCompiler,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "SkillPromptOptimizer": "✍️ 技能写词 / Skill Writer",
    "SkillPromptLayoutCompiler": "🧭 技能排版 / Skill Layout",
}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]
