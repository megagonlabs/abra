"""calculator — evaluate an arithmetic expression, safely.

A safe `eval` is NOT `eval()`: we parse the expression with `ast` and walk a
whitelist of nodes (numbers, the arithmetic operators, parentheses, a handful of
`math` functions and the pi/e/tau constants). Anything else — names, attribute
access, calls to unlisted functions — raises, so there is no code-execution path.
Pure + offline; no bridge use.
"""

from __future__ import annotations

import ast
import math
import operator

from adapters.common.tools import Tool, tool

_BINOPS = {
    ast.Add: operator.add,
    ast.Sub: operator.sub,
    ast.Mult: operator.mul,
    ast.Div: operator.truediv,
    ast.FloorDiv: operator.floordiv,
    ast.Mod: operator.mod,
    ast.Pow: operator.pow,
}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}
_FUNCS = {
    name: getattr(math, name)
    for name in ("sqrt", "sin", "cos", "tan", "log", "log2", "log10", "exp", "floor", "ceil", "fabs", "factorial")
}
_CONSTS = {"pi": math.pi, "e": math.e, "tau": math.tau}


def _ev(node):
    if isinstance(node, ast.Expression):
        return _ev(node.body)
    if isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("only numeric literals are allowed")
        return node.value
    if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
        return _BINOPS[type(node.op)](_ev(node.left), _ev(node.right))
    if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
        return _UNARY[type(node.op)](_ev(node.operand))
    if isinstance(node, ast.Name) and node.id in _CONSTS:
        return _CONSTS[node.id]
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id in _FUNCS
        and not node.keywords
    ):
        return _FUNCS[node.func.id](*[_ev(a) for a in node.args])
    raise ValueError("unsupported expression")


def evaluate(expression: str) -> float:
    """Evaluate `expression` over the arithmetic whitelist. Raises ValueError on
    anything outside it (the only failure surface)."""
    return _ev(ast.parse(expression, mode="eval"))


@tool
def calculator(bridge):
    async def run(args: dict) -> str:
        expr = str(args.get("expression", "")).strip()
        if not expr:
            raise ValueError("no expression provided")
        return str(evaluate(expr))

    return Tool(
        "calculator",
        "Evaluate an arithmetic expression. Supports + - * / // % ** and parentheses, "
        "common math functions (sqrt, sin, cos, tan, log, log2, log10, exp, floor, ceil, "
        "fabs, factorial) and the constants pi, e, tau. Returns the numeric result.",
        {
            "type": "object",
            "properties": {"expression": {"type": "string", "description": "e.g. '2 * (3 + 4) ** 2'"}},
            "required": ["expression"],
        },
        run,
    )
