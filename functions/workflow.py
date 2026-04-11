"""WF — Workflow blueprint.

Exposes the workflow system over HTTP:

    GET  /api/wf/list                 — available workflows (metadata)
    GET  /api/wf/tools                — registered tools + schemas
    POST /api/wf/run                  — start a run, returns run_id
    GET  /api/wf/stream/<run_id>      — Server-Sent Events stream
    POST /api/wf/nl                   — natural-language → workflow (if Claude)

The run state lives in an in-memory registry keyed by ``run_id``. A
background thread pushes events onto a per-run ``queue.Queue`` and the
SSE endpoint drains it. For a single-process Flask deployment this is
plenty; if the terminal ever scales out, replace the in-memory store
with Redis without touching the rest of the system.
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
import uuid
from typing import Any, Dict, Optional

from flask import Blueprint, Response, jsonify, request

from functions._workflow import (
    WORKFLOWS,
    Workflow,
    list_tools,
    load_workflows_from_dir,
)
from functions._agent import nl_to_workflow, run_workflow
# Import tool adapters so @register_tool decorators execute
from functions import _wf_tools  # noqa: F401


wf_bp = Blueprint("wf", __name__)


# ═══════════════════════════════════════════════════════════════════
# Workflow loading
# ═══════════════════════════════════════════════════════════════════

WORKFLOWS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "workflows",
)

# Load on import — hot reload via /api/wf/reload
load_workflows_from_dir(WORKFLOWS_DIR)


# ═══════════════════════════════════════════════════════════════════
# Run registry — in-memory, keyed by run_id
# ═══════════════════════════════════════════════════════════════════

class Run:
    """A live workflow run — the queue holds pending events until the
    SSE consumer drains them."""

    def __init__(self, run_id: str, workflow: Workflow, inputs: Dict[str, Any]):
        self.id = run_id
        self.workflow = workflow
        self.inputs = inputs
        self.events: "queue.Queue[Dict[str, Any]]" = queue.Queue(maxsize=1000)
        self.created_at = time.time()
        self.done = False

    def emit(self, event_type: str, payload: Dict[str, Any]) -> None:
        try:
            self.events.put_nowait({"type": event_type, "payload": payload})
        except queue.Full:
            pass
        if event_type == "done":
            self.done = True


_runs: Dict[str, Run] = {}
_runs_lock = threading.Lock()


def _new_run(workflow: Workflow, inputs: Dict[str, Any]) -> Run:
    run_id = uuid.uuid4().hex[:12]
    run = Run(run_id, workflow, inputs)
    with _runs_lock:
        # Prune old finished runs (keep last 50)
        if len(_runs) > 50:
            oldest = sorted(_runs.values(), key=lambda r: r.created_at)[:10]
            for r in oldest:
                if r.done:
                    _runs.pop(r.id, None)
        _runs[run_id] = run
    return run


# ═══════════════════════════════════════════════════════════════════
# Routes
# ═══════════════════════════════════════════════════════════════════

@wf_bp.route("/api/wf/list")
def list_workflows():
    """Return all loaded workflows with their summary metadata."""
    return jsonify({
        "workflows": [wf.to_summary_json() for wf in WORKFLOWS.values()],
        "count": len(WORKFLOWS),
    })


@wf_bp.route("/api/wf/tools")
def get_tools():
    """Return registered tools with JSON schemas."""
    return jsonify({"tools": list_tools()})


@wf_bp.route("/api/wf/reload", methods=["POST"])
def reload_workflows():
    """Re-read the workflows/ directory. Useful during development."""
    load_workflows_from_dir(WORKFLOWS_DIR)
    return jsonify({"reloaded": True, "count": len(WORKFLOWS)})


@wf_bp.route("/api/wf/<wf_id>")
def get_workflow(wf_id: str):
    """Return the full spec of a single workflow — used by the UI
    builder to pre-fill the edit form."""
    wf = WORKFLOWS.get(wf_id)
    if wf is None:
        return jsonify({"error": f"Unknown workflow: {wf_id}"}), 404
    return jsonify(_full_spec(wf) | {"id": wf.id})


@wf_bp.route("/api/wf/save", methods=["POST"])
def save_workflow():
    """Create or update a workflow from the UI builder.

    Body: ``{"id": "optional_existing_id", "name": "...", "description":
    "...", "focus": "...", "inputs": {...}, "steps": [...]}``.

    The id is slugified from the name when creating. Saved as YAML in
    ``workflows/`` so it survives restarts and is human-editable on
    disk. After writing, we hot-reload the directory so the new entry
    is immediately available without a server restart.

    Per-user scoping is intentionally deferred — workflows are global
    in this iteration. When we move to multi-tenant this file-based
    store becomes the seed for a ``workflows`` table scoped by user_id.
    """
    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        return jsonify({"error": "name is required"}), 400

    # Validate referenced tools exist — fail loudly, don't let the user
    # save a workflow that's going to 500 on run.
    from functions._workflow import TOOL_REGISTRY
    steps = body.get("steps") or []
    if not isinstance(steps, list) or not steps:
        return jsonify({"error": "at least one step is required"}), 400
    for i, s in enumerate(steps):
        if not isinstance(s, dict) or not s.get("tool"):
            return jsonify({"error": f"step {i}: missing tool"}), 400
        if s["tool"] not in TOOL_REGISTRY:
            return jsonify({
                "error": f"step {i}: unknown tool '{s['tool']}' "
                         f"(available: {sorted(TOOL_REGISTRY.keys())})"
            }), 400

    # Resolve id — explicit id = update, else slug from name
    wf_id = (body.get("id") or "").strip() or _slugify(name)
    if not wf_id:
        return jsonify({"error": "could not derive id from name"}), 400

    spec = {
        "name": name,
        "description": body.get("description", ""),
        "focus": body.get("focus", ""),
        "inputs": body.get("inputs") or {},
        "steps": [_normalize_step(s, i) for i, s in enumerate(steps)],
        "tags": body.get("tags") or [],
        "output": body.get("output", "report"),
    }

    os.makedirs(WORKFLOWS_DIR, exist_ok=True)
    path = os.path.join(WORKFLOWS_DIR, f"{wf_id}.yaml")
    try:
        import yaml  # PyYAML
        with open(path, "w", encoding="utf-8") as f:
            yaml.safe_dump(spec, f, sort_keys=False, allow_unicode=True)
    except ImportError:
        # Fallback: JSON is always valid YAML
        with open(path, "w", encoding="utf-8") as f:
            json.dump(spec, f, indent=2, ensure_ascii=False)

    # Hot reload so the new entry is immediately visible
    load_workflows_from_dir(WORKFLOWS_DIR)
    saved = WORKFLOWS.get(wf_id)
    if saved is None:
        return jsonify({"error": "save succeeded but reload could not find the workflow"}), 500
    return jsonify({
        "id": wf_id,
        "workflow": saved.to_summary_json(),
        "saved": True,
    })


@wf_bp.route("/api/wf/<wf_id>", methods=["DELETE"])
def delete_workflow(wf_id: str):
    """Delete a saved workflow. Removes the YAML file from disk and
    reloads the registry."""
    # Whitelist the id against the registry to prevent path-traversal
    if wf_id not in WORKFLOWS:
        return jsonify({"error": f"Unknown workflow: {wf_id}"}), 404

    # Look for the file with the same basename — tolerate both .yaml
    # and .yml so we don't leave orphan files around
    removed = False
    for ext in (".yaml", ".yml", ".json"):
        path = os.path.join(WORKFLOWS_DIR, f"{wf_id}{ext}")
        if os.path.isfile(path):
            try:
                os.remove(path)
                removed = True
            except OSError as e:
                return jsonify({"error": f"delete failed: {e}"}), 500

    load_workflows_from_dir(WORKFLOWS_DIR)
    return jsonify({"deleted": removed, "id": wf_id, "count": len(WORKFLOWS)})


# ── Helpers ────────────────────────────────────────────────────────

def _slugify(name: str) -> str:
    """Convert a human name into a filesystem-safe workflow id."""
    import re
    s = name.lower().strip()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = s.strip("_")
    return s[:60] or "workflow"


def _normalize_step(s: Dict[str, Any], idx: int) -> Dict[str, Any]:
    """Canonicalize a step dict from the UI — fills missing ids,
    coerces params to a dict, and drops unknown keys."""
    out: Dict[str, Any] = {
        "id": (s.get("id") or "").strip() or f"step{idx + 1}",
        "tool": s.get("tool"),
        "label": s.get("label", ""),
    }
    params = s.get("params")
    if isinstance(params, dict):
        out["params"] = params
    elif isinstance(params, str) and params.strip():
        # Allow params to arrive as a JSON string from the builder UI
        try:
            out["params"] = json.loads(params)
        except json.JSONDecodeError:
            out["params"] = {}
    else:
        out["params"] = {}
    if s.get("depends_on"):
        out["depends_on"] = s["depends_on"]
    if s.get("parallel_group"):
        out["parallel_group"] = s["parallel_group"]
    return out


@wf_bp.route("/api/wf/agent_status")
def agent_status():
    """Report whether agentic mode is available.

    Agentic mode = ``litellm`` installed + at least one provider key
    configured. We don't check user keys here — that's the UI's job,
    because keys are per-user and this endpoint is stateless. We only
    report whether the **server side** is capable of running agentic
    mode at all.
    """
    try:
        import litellm  # noqa: F401
        litellm_ok = True
    except ImportError:
        litellm_ok = False

    return jsonify({
        "agentic": litellm_ok,
        "litellm": litellm_ok,
        "providers": ["anthropic", "openai", "gemini", "perplexity", "openrouter"],
        "default_model": os.environ.get("WF_AGENT_MODEL", "claude-3-5-sonnet-20241022"),
    })


@wf_bp.route("/api/wf/openrouter/models")
def openrouter_models():
    """Fetch the full OpenRouter model catalogue.

    OpenRouter's ``/api/v1/models`` endpoint is public (no auth needed)
    and returns every model currently routed, with pricing, context
    length, and provider metadata. We cache the response for 10 minutes
    so the settings modal doesn't hammer their API every time it opens.
    """
    def fetch():
        import urllib.request
        req = urllib.request.Request(
            "https://openrouter.ai/api/v1/models",
            headers={"User-Agent": "terminal-wf/1.0"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            raw = json.loads(resp.read().decode("utf-8"))
        models = raw.get("data", []) if isinstance(raw, dict) else []
        # Normalize to the subset the UI actually needs — keeps response
        # small and stable even if OpenRouter tweaks their schema.
        normalized = []
        for m in models:
            if not isinstance(m, dict):
                continue
            mid = m.get("id")
            if not mid:
                continue
            pricing = m.get("pricing") or {}
            ctx = m.get("context_length") or m.get("top_provider", {}).get("context_length")
            supports_tools = "tools" in (m.get("supported_parameters") or [])
            normalized.append({
                "id": mid,
                "name": m.get("name") or mid,
                "context_length": ctx,
                "pricing_prompt": pricing.get("prompt"),
                "pricing_completion": pricing.get("completion"),
                "supports_tools": supports_tools,
                "description": (m.get("description") or "")[:200],
            })
        normalized.sort(key=lambda x: x["id"])
        return {"models": normalized, "count": len(normalized)}

    try:
        from functions._utils import cached
        data = cached("openrouter_models", fetch, ttl=600)
        return jsonify(data)
    except Exception as e:  # noqa: BLE001
        return jsonify({"error": str(e), "models": []}), 500


@wf_bp.route("/api/wf/run", methods=["POST"])
def start_run():
    """Start a workflow run.

    Body: ``{"workflow_id": str, "inputs": {...}, "mode": "auto|scripted|agentic"}``
    For ad-hoc runs the body may pass a full workflow spec under ``workflow``.
    """
    body = request.get_json(silent=True) or {}
    wf_id: Optional[str] = body.get("workflow_id")
    ad_hoc_spec = body.get("workflow")
    inputs: Dict[str, Any] = body.get("inputs") or {}
    mode = body.get("mode", "auto")
    llm_keys: Dict[str, str] = body.get("llm_keys") or {}

    if ad_hoc_spec and isinstance(ad_hoc_spec, dict):
        try:
            workflow = Workflow.from_dict(ad_hoc_spec, wf_id or "_adhoc")
        except Exception as e:  # noqa: BLE001
            return jsonify({"error": f"Invalid workflow spec: {e}"}), 400
    elif wf_id:
        workflow = WORKFLOWS.get(wf_id)
        if workflow is None:
            return jsonify({"error": f"Unknown workflow: {wf_id}"}), 404
    else:
        return jsonify({"error": "workflow_id or workflow required"}), 400

    run = _new_run(workflow, inputs)

    def worker():
        try:
            run_workflow(workflow, inputs, run.emit, mode=mode, llm_keys=llm_keys)
        except Exception as e:  # noqa: BLE001
            run.emit("error", {"message": str(e)})
            run.emit("done", {})

    threading.Thread(target=worker, daemon=True).start()
    return jsonify({
        "run_id": run.id,
        "workflow_id": workflow.id,
        "name": workflow.name,
        "step_count": len(workflow.steps),
    })


@wf_bp.route("/api/wf/stream/<run_id>")
def stream_run(run_id: str):
    """Server-Sent Events stream for a run.

    Events are serialized as ``event: <type>\\ndata: <json>\\n\\n`` so the
    client can use ``EventSource`` and register handlers per type.
    """
    with _runs_lock:
        run = _runs.get(run_id)
    if run is None:
        return jsonify({"error": "unknown run_id"}), 404

    def generate():
        # Send an initial comment so the browser treats the stream as open
        yield ": stream open\n\n"
        while True:
            try:
                evt = run.events.get(timeout=30)
            except queue.Empty:
                # Heartbeat
                yield ": keepalive\n\n"
                if run.done:
                    break
                continue

            try:
                payload = json.dumps(evt.get("payload") or {}, default=str)
            except Exception:
                payload = "{}"
            yield f"event: {evt['type']}\ndata: {payload}\n\n"

            if evt["type"] == "done":
                break

    headers = {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "Connection": "keep-alive",
    }
    return Response(generate(), headers=headers)


@wf_bp.route("/api/wf/nl", methods=["POST"])
def nl_compile():
    """Natural language → workflow spec (no run yet). Returns the spec for
    the user to review / edit before executing."""
    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    llm_keys = body.get("llm_keys") or {}
    if not text:
        return jsonify({"error": "text required"}), 400
    wf = nl_to_workflow(text, llm_keys=llm_keys)
    if wf is None:
        return jsonify({
            "error": (
                "Natural-language compilation requires Claude. "
                "Set ANTHROPIC_API_KEY and install `anthropic`."
            ),
        }), 503
    return jsonify({"workflow": wf.to_summary_json(), "spec": _full_spec(wf)})


def _full_spec(wf: Workflow) -> Dict[str, Any]:
    """The complete workflow spec — used as payload for an ad-hoc run."""
    return {
        "name": wf.name,
        "description": wf.description,
        "focus": wf.focus,
        "inputs": wf.inputs,
        "steps": [
            {
                "id": s.id,
                "tool": s.tool,
                "params": s.params,
                "depends_on": s.depends_on,
                "parallel_group": s.parallel_group,
                "label": s.label,
            }
            for s in wf.steps
        ],
        "tags": wf.tags,
    }
