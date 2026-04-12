"""Workflow (WF) — Function Result contract, tool registry, and workflow models.

This module is the foundation of the terminal's workflow system. It defines:

    1. ``FunctionResult`` — the dual-output contract that every workflow tool
       returns. Agents reason over ``data`` + ``summary``; the frontend renders
       ``widget`` (a structured description the UI can visualize) and captures
       screenshots for the final report.

    2. A **tool registry** (``register_tool`` / ``TOOL_REGISTRY``) that adapts
       existing Flask endpoints into agent-callable tools without refactoring
       the route handlers. Each tool has a JSON-schema-style parameter spec so
       it can be handed to Claude as a tool definition.

    3. ``Workflow`` + ``WorkflowStep`` — a lightweight YAML-backed workflow
       definition. Workflows are the "Claude skills" the user writes: a
       description, a focus, an ordered list of steps, and an output spec.

Deliberately dependency-free (no pydantic, no anthropic) so this module is
safe to import even when those packages are missing. The agent loop in
``_agent.py`` is where the optional Anthropic SDK dependency lives.
"""

from __future__ import annotations

import contextvars
import json
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Any, Callable, Dict, List, Optional

try:
    import yaml  # type: ignore
    _HAS_YAML = True
except ImportError:
    _HAS_YAML = False


# ═══════════════════════════════════════════════════════════════════
# 1. FunctionResult — the dual-output contract
# ═══════════════════════════════════════════════════════════════════

@dataclass
class FunctionResult:
    """The single data structure every workflow tool returns.

    Attributes:
        data:     Raw structured data the agent reasons over. Must be
                  JSON-serializable. Agents see the full ``data`` when it's
                  small, otherwise only ``summary`` + a truncated preview.
        summary:  1-3 sentence natural-language description of what was
                  returned. This is what Claude actually reads most of the
                  time — it's the compact LLM-friendly representation.
        widget:   Structured render hint the frontend uses to visualize the
                  result (e.g. ``{"type": "table", "columns": [...], ...}``).
                  The frontend re-renders widgets from this spec and
                  screenshots them via html2canvas — the backend never
                  produces HTML or images itself.
        metadata: Execution metadata — tool name, elapsed ms, params used,
                  source. Useful for debugging and the final report.
        error:    Populated on failure. If set, ``data`` is usually empty.
    """

    data: Any = None
    summary: str = ""
    widget: Optional[Dict[str, Any]] = None
    metadata: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None

    def to_json(self) -> Dict[str, Any]:
        return asdict(self)

    @property
    def ok(self) -> bool:
        return self.error is None

    def agent_view(self, max_chars: int = 4000) -> Dict[str, Any]:
        """Compact representation to send back to Claude as a tool result.

        We always include ``summary`` and ``metadata``. ``data`` is included
        in full only if it's small; otherwise we include a truncated
        preview so the agent has something concrete to reference without
        blowing the context window.
        """
        if self.error:
            return {"error": self.error, "summary": self.summary, "metadata": self.metadata}

        try:
            full = json.dumps(self.data, default=str)
        except (TypeError, ValueError):
            full = str(self.data)

        if len(full) <= max_chars:
            return {
                "summary": self.summary,
                "data": self.data,
                "metadata": self.metadata,
            }

        # Truncate large payloads; preserve structure if it's a list/dict
        preview: Any
        if isinstance(self.data, list):
            preview = self.data[:10]
        elif isinstance(self.data, dict):
            preview = {k: v for i, (k, v) in enumerate(self.data.items()) if i < 10}
        else:
            preview = full[:max_chars] + "…"

        return {
            "summary": self.summary,
            "data_preview": preview,
            "data_truncated": True,
            "data_size_chars": len(full),
            "metadata": self.metadata,
        }


# ═══════════════════════════════════════════════════════════════════
# 2. Tool registry
# ═══════════════════════════════════════════════════════════════════

# Keys allowed inside a property definition when we emit JSON Schema
# to an LLM. Our internal ``params_schema`` uses two custom keys
# (``required`` as a per-property bool, ``default``) that are NOT part
# of the subset Gemini / OpenAI / Anthropic actually accept.
#
# Gemini is the strictest: it rejects the whole property if it contains
# an unknown key, then the parent-level ``required`` array references a
# property that no longer exists and the request 400s with
# "property is not defined". OpenAI and Anthropic are more lenient but
# still occasionally complain, so we sanitize in one place for everyone.
_ALLOWED_PROP_KEYS = {
    "type", "description", "enum", "items", "properties",
    "format", "nullable", "minimum", "maximum",
    "minItems", "maxItems", "minLength", "maxLength",
    "pattern", "anyOf", "oneOf", "allOf",
}


def _clean_property(prop: Any) -> Dict[str, Any]:
    """Return a property definition stripped down to keys the LLM
    schema validators accept. Our internal ``required`` / ``default``
    markers are dropped — they're only used by the registry to build
    the parent-level ``required`` array."""
    if not isinstance(prop, dict):
        return {"type": "string"}
    cleaned: Dict[str, Any] = {}
    for k, v in prop.items():
        if k in _ALLOWED_PROP_KEYS:
            cleaned[k] = v
    # Default type for sloppy declarations so we never emit an empty
    # property (which Gemini also rejects).
    if "type" not in cleaned and "enum" not in cleaned and "anyOf" not in cleaned:
        cleaned["type"] = "string"
    return cleaned


def _schema_object(params_schema: Dict[str, Any]) -> Dict[str, Any]:
    """Build a JSON-Schema object from our internal params_schema.

    - ``properties`` gets every entry cleaned via ``_clean_property``
    - ``required`` is the parent-level array listing property names
      whose internal schema had ``required: True``
    - emits an empty ``properties`` dict (not None) for tools with no
      parameters, because Gemini rejects missing ``properties`` on
      ``type: object`` schemas.
    """
    properties: Dict[str, Any] = {}
    required: list = []
    for key, prop in (params_schema or {}).items():
        properties[key] = _clean_property(prop)
        if isinstance(prop, dict) and prop.get("required", False):
            required.append(key)
    obj: Dict[str, Any] = {
        "type": "object",
        "properties": properties,
    }
    if required:
        obj["required"] = required
    return obj


@dataclass
class ToolSpec:
    """Describes a workflow tool — its schema and its executor."""

    name: str
    description: str
    params_schema: Dict[str, Any]           # internal schema (may contain custom keys)
    executor: Callable[..., FunctionResult]
    category: str = "general"
    stock_specific: bool = False

    def anthropic_tool(self) -> Dict[str, Any]:
        """Format as an Anthropic ``tools`` list entry."""
        return {
            "name": self.name,
            "description": self.description,
            "input_schema": _schema_object(self.params_schema),
        }

    def openai_tool(self) -> Dict[str, Any]:
        """Format as an OpenAI ``tools`` list entry.

        litellm routes this same shape to OpenAI, Gemini (via
        google-genai), OpenRouter, Perplexity, etc. The parameters
        object is sanitized to the subset all of them accept.
        """
        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": _schema_object(self.params_schema),
            },
        }


TOOL_REGISTRY: Dict[str, ToolSpec] = {}


# ═══════════════════════════════════════════════════════════════════
# Run context — per-workflow user state available to any tool
#
# Some tools (W / watchlist, future "current-user" helpers) need access
# to data that doesn't belong in the LLM-visible params_schema:
#
#   • the user's watchlist symbols
#   • their display name / locale / base currency
#   • any asset-class-specific preferences
#
# We pass that state via a contextvar set at the start of each
# workflow run. The tool reads it through ``get_run_context()``. This
# keeps the tool's ``params_schema`` clean (the LLM never sees the
# user data as a callable parameter) while still letting the tool
# access it at execution time.
#
# For parallel step batches we copy the context explicitly via
# ``contextvars.copy_context()`` — see _agent.py::_run_batch.
# ═══════════════════════════════════════════════════════════════════

_RUN_CONTEXT: contextvars.ContextVar[Dict[str, Any]] = contextvars.ContextVar(
    "wf_run_context", default={}
)


def set_run_context(ctx: Dict[str, Any]) -> None:
    """Install a per-run context dict (user_id, watchlist, ...)."""
    _RUN_CONTEXT.set(ctx or {})


def get_run_context() -> Dict[str, Any]:
    """Return the current run context (or an empty dict)."""
    return _RUN_CONTEXT.get() or {}


def register_tool(
    name: str,
    description: str,
    params_schema: Optional[Dict[str, Any]] = None,
    category: str = "general",
    stock_specific: bool = False,
    aliases: Optional[List[str]] = None,
):
    """Decorator that registers a function as an agent-callable tool.

    The decorated function must accept keyword arguments matching
    ``params_schema`` and return a ``FunctionResult``.

    ``aliases`` lets a single executor surface under multiple names —
    e.g. ``DES`` as the primary Bloomberg-style short code with
    ``INFO`` as a backward-compat alias. Both show in the registry
    and both resolve to the same ``ToolSpec``.
    """
    def decorator(func: Callable[..., FunctionResult]) -> Callable[..., FunctionResult]:
        spec = ToolSpec(
            name=name,
            description=description,
            params_schema=params_schema or {},
            executor=func,
            category=category,
            stock_specific=stock_specific,
        )
        TOOL_REGISTRY[name] = spec
        for alias in (aliases or []):
            # Alias spec points to the same executor + schema but keeps
            # its own name so ``openai_tool()`` / list_tools() render the
            # alias correctly when the LLM wants to call it by that name.
            alias_spec = ToolSpec(
                name=alias,
                description=f"{description} (alias for {name})",
                params_schema=params_schema or {},
                executor=func,
                category=category,
                stock_specific=stock_specific,
            )
            TOOL_REGISTRY[alias] = alias_spec
        return func
    return decorator


def run_tool(name: str, **params) -> FunctionResult:
    """Execute a registered tool, timing it and wrapping errors."""
    spec = TOOL_REGISTRY.get(name)
    if spec is None:
        return FunctionResult(
            error=f"Unknown tool: {name}",
            summary=f"Tool {name!r} is not registered",
        )
    t0 = time.time()
    try:
        result = spec.executor(**params)
    except Exception as e:  # noqa: BLE001
        import traceback
        traceback.print_exc()
        return FunctionResult(
            error=str(e),
            summary=f"{name} failed: {e}",
            metadata={"tool": name, "params": params, "elapsed_ms": int((time.time() - t0) * 1000)},
        )

    if not isinstance(result, FunctionResult):
        # Defensive: wrap stray return values
        result = FunctionResult(data=result, summary=f"{name} returned data")

    # Always tag metadata with tool + timing
    result.metadata.setdefault("tool", name)
    result.metadata.setdefault("params", params)
    result.metadata["elapsed_ms"] = int((time.time() - t0) * 1000)
    return result


def list_tools() -> List[Dict[str, Any]]:
    """JSON-safe list of all registered tools — for ``/api/wf/tools``."""
    return [
        {
            "name": spec.name,
            "description": spec.description,
            "params": spec.params_schema,
            "category": spec.category,
            "stock_specific": spec.stock_specific,
        }
        for spec in TOOL_REGISTRY.values()
    ]


# ═══════════════════════════════════════════════════════════════════
# 3. Workflow models
# ═══════════════════════════════════════════════════════════════════

@dataclass
class WorkflowStep:
    """A single step inside a workflow.

    ``tool`` is the name of a registered tool. ``params`` may contain
    literal values or ``{{inputs.foo}}`` / ``{{steps.<id>.data.bar}}``
    template references — resolved at run-time by the agent runtime.
    ``parallel_group`` steps with the same group value run concurrently.
    """

    id: str
    tool: str
    params: Dict[str, Any] = field(default_factory=dict)
    depends_on: List[str] = field(default_factory=list)
    parallel_group: Optional[str] = None
    label: str = ""  # Optional human-readable label


@dataclass
class Workflow:
    id: str
    name: str
    description: str                           # What the WF does
    focus: str = ""                            # What to emphasize in analysis
    inputs: Dict[str, Any] = field(default_factory=dict)   # input schema
    steps: List[WorkflowStep] = field(default_factory=list)
    output: str = "report"                     # "report" | "data"
    tags: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, d: Dict[str, Any], wf_id: str) -> "Workflow":
        raw_steps = d.get("steps", [])
        steps = [
            WorkflowStep(
                id=s.get("id", f"step_{i}"),
                tool=s["tool"],
                params=s.get("params", {}) or {},
                depends_on=s.get("depends_on", []) or [],
                parallel_group=s.get("parallel_group"),
                label=s.get("label", ""),
            )
            for i, s in enumerate(raw_steps)
        ]
        return cls(
            id=wf_id,
            name=d.get("name", wf_id),
            description=d.get("description", ""),
            focus=d.get("focus", ""),
            inputs=d.get("inputs", {}) or {},
            steps=steps,
            output=d.get("output", "report"),
            tags=d.get("tags", []) or [],
        )

    def to_summary_json(self) -> Dict[str, Any]:
        """Compact representation for the /api/wf/list endpoint."""
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "focus": self.focus,
            "inputs": self.inputs,
            "tags": self.tags,
            "step_count": len(self.steps),
            "steps": [
                {"id": s.id, "tool": s.tool, "label": s.label or s.tool}
                for s in self.steps
            ],
        }


# ═══════════════════════════════════════════════════════════════════
# 4. Workflow loading
# ═══════════════════════════════════════════════════════════════════

WORKFLOWS: Dict[str, Workflow] = {}


def load_workflows_from_dir(directory: str) -> Dict[str, Workflow]:
    """Load every ``*.yaml`` / ``*.json`` workflow file in ``directory``.

    Files that fail to parse are skipped with a warning — a broken workflow
    never takes the whole system down.
    """
    WORKFLOWS.clear()
    if not os.path.isdir(directory):
        return WORKFLOWS

    for fname in sorted(os.listdir(directory)):
        path = os.path.join(directory, fname)
        if not os.path.isfile(path):
            continue

        wf_id, ext = os.path.splitext(fname)
        try:
            if ext in (".yaml", ".yml"):
                if not _HAS_YAML:
                    print(f"[WF] Skipping {fname}: PyYAML not installed")
                    continue
                with open(path, "r", encoding="utf-8") as f:
                    raw = yaml.safe_load(f) or {}  # type: ignore[name-defined]
            elif ext == ".json":
                with open(path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
            else:
                continue

            wf = Workflow.from_dict(raw, wf_id)
            WORKFLOWS[wf_id] = wf
        except Exception as e:  # noqa: BLE001
            print(f"[WF] Failed to load {fname}: {e}")

    return WORKFLOWS


# ═══════════════════════════════════════════════════════════════════
# 5. Template resolution (for step params)
# ═══════════════════════════════════════════════════════════════════

_TEMPLATE_RE = None


def _get_template_re():
    global _TEMPLATE_RE
    if _TEMPLATE_RE is None:
        import re
        _TEMPLATE_RE = re.compile(r"\{\{\s*([^}]+?)\s*\}\}")
    return _TEMPLATE_RE


def resolve_params(
    params: Dict[str, Any],
    inputs: Dict[str, Any],
    steps_results: Dict[str, FunctionResult],
) -> Dict[str, Any]:
    """Substitute ``{{inputs.x}}`` / ``{{steps.<id>.data.path}}`` references.

    Kept small on purpose — this is not a full Jinja clone. It supports
    dotted path access (``steps.earnings.data.rows.0.symbol``) and falls
    through to the literal ``{{...}}`` string on lookup failure so workflow
    authors notice the typo immediately.
    """
    re_t = _get_template_re()

    def lookup(path: str) -> Any:
        parts = path.split(".")
        root = parts[0]
        rest = parts[1:]
        if root == "inputs":
            node: Any = inputs
        elif root == "steps":
            if not rest:
                return None
            step_id = rest[0]
            rest = rest[1:]
            step_result = steps_results.get(step_id)
            if step_result is None:
                return f"{{{{{path}}}}}"
            # Expose .data, .summary, .metadata
            if not rest:
                return step_result.to_json()
            top = rest[0]
            rest = rest[1:]
            node = getattr(step_result, top, None)
        else:
            return f"{{{{{path}}}}}"

        for part in rest:
            if node is None:
                return f"{{{{{path}}}}}"
            if isinstance(node, dict):
                node = node.get(part)
            elif isinstance(node, list):
                try:
                    node = node[int(part)]
                except (ValueError, IndexError):
                    return f"{{{{{path}}}}}"
            else:
                node = getattr(node, part, None)
        return node

    def resolve_value(v: Any) -> Any:
        if isinstance(v, str):
            matches = list(re_t.finditer(v))
            if not matches:
                return v
            # If the whole string is a single {{...}}, return the resolved
            # value with its native type (int, list, dict, …)
            if len(matches) == 1 and matches[0].group(0) == v.strip():
                return lookup(matches[0].group(1).strip())
            # Otherwise, string-interpolate
            def repl(m):
                val = lookup(m.group(1).strip())
                return str(val) if val is not None else ""
            return re_t.sub(repl, v)
        if isinstance(v, list):
            return [resolve_value(x) for x in v]
        if isinstance(v, dict):
            return {k: resolve_value(x) for k, x in v.items()}
        return v

    return {k: resolve_value(v) for k, v in params.items()}
