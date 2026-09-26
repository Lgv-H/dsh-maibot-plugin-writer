"""插件 plugin.py 的 AST 探针：把语法与结构事实以 JSON 打到 stdout。

由 dsh-maibot-plugin-writer 调用：
    python ast_probe.py <plugin.py 绝对路径>

只读文件、只输出 JSON；语法错误也走正常输出（syntaxError 非空），
让调用方在一次往返里拿到全部结论。
"""

import ast
import json
import sys


def _chain(node: ast.AST) -> str:
    """还原属性调用链，例如 ctx.send.text。"""
    parts = []
    current = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
    return ".".join(reversed(parts))


def _open_mode(node: ast.Call) -> str:
    """提取 open() 的 mode 参数（字面量才返回，动态值返回 '<dynamic>'）。"""
    if len(node.args) > 1:
        second = node.args[1]
        if isinstance(second, ast.Constant):
            return str(second.value)
        return "<dynamic>"
    for keyword in node.keywords:
        if keyword.arg == "mode":
            if isinstance(keyword.value, ast.Constant):
                return str(keyword.value.value)
            return "<dynamic>"
    return ""


def _assignments(node: ast.ClassDef) -> dict:
    """收集类体里的简单赋值（用于识别 __ui_label__ 与 config_model）。"""
    found = {}
    for statement in node.body:
        if not isinstance(statement, ast.Assign):
            continue
        for target in statement.targets:
            if isinstance(target, ast.Name):
                found[target.id] = statement.value
    return found


def main() -> int:
    result = {
        "syntaxError": "",
        "lines": 0,
        "imports": [],
        "fromImports": [],
        "calls": [],
        "classes": [],
        "hasCreatePlugin": False,
        "initDefs": 0,
        "functionCount": 0,
        "importCount": 0,
        "nodeCount": 0,
        "hasFutureAnnotations": False,
        "configModel": "",
    }

    if len(sys.argv) < 2:
        result["syntaxError"] = "缺少 plugin.py 路径参数"
        print(json.dumps(result, ensure_ascii=False))
        return 0

    path = sys.argv[1]
    try:
        with open(path, encoding="utf-8") as handle:
            source = handle.read()
    except OSError as exc:
        result["syntaxError"] = f"读取失败: {exc}"
        print(json.dumps(result, ensure_ascii=False))
        return 0

    result["lines"] = source.count("\n") + 1

    try:
        tree = ast.parse(source)
    except SyntaxError as exc:
        result["syntaxError"] = f"{exc.msg} (line {exc.lineno})"
        print(json.dumps(result, ensure_ascii=False))
        return 0

    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            result["imports"].extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            result["fromImports"].append(module)
            if module == "__future__" and any(alias.name == "annotations" for alias in node.names):
                result["hasFutureAnnotations"] = True
        elif isinstance(node, ast.Call):
            func = node.func
            result["calls"].append(
                {
                    "name": func.attr if isinstance(func, ast.Attribute) else getattr(func, "id", ""),
                    "chain": _chain(func),
                    "line": node.lineno,
                    "mode": _open_mode(node) if getattr(func, "id", "") == "open" else "",
                }
            )
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            result["functionCount"] += 1
            if node.name == "create_plugin":
                result["hasCreatePlugin"] = True
            if node.name == "__init__":
                result["initDefs"] += 1
        elif isinstance(node, ast.ClassDef):
            assignments = _assignments(node)
            has_ui_label = "__ui_label__" in assignments
            config_model = ""
            if "config_model" in assignments:
                config_model = _chain(assignments["config_model"])
            result["classes"].append(
                {
                    "name": node.name,
                    "bases": [
                        getattr(base, "id", "") or getattr(base, "attr", "")
                        for base in node.bases
                    ],
                    "hasUiLabel": has_ui_label,
                    "configModel": config_model,
                }
            )
            if config_model:
                result["configModel"] = config_model

    result["importCount"] = len(result["imports"]) + len(result["fromImports"])
    result["nodeCount"] = sum(1 for _ in ast.walk(tree))
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
