"""Single-file reference implementation of the Make connection workflow.

This script mirrors the behaviour of the richer Node service but keeps everything
in one place so developers can port the logic to other stacks with minimal effort.
"""
from __future__ import annotations

import json
import os
import sys
import webbrowser
from pathlib import Path
from typing import Dict, Iterable, List, Optional

import requests

ROOT_DIR = Path(__file__).resolve().parents[2]
ENV_PATH = ROOT_DIR / ".env"
DEFAULT_BLUEPRINT_DIR = ROOT_DIR / "blueprints"
# We drop updated blueprints next to the sample so each language stays self-contained.
UPDATED_DIR = Path(__file__).resolve().parent


def load_env(path: Path) -> Dict[str, str]:
    """Load .env style key=value pairs without introducing a new dependency."""
    values: Dict[str, str] = {}
    if not path.exists():
        return values
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"')
    return values


def ensure_settings(env: Dict[str, str]) -> None:
    """Fail fast if the caller forgot to populate the Make API essentials."""
    missing = [key for key in ("INSTANCE_URL", "AUTH_TOKEN", "TEAM_ID") if not env.get(key)]
    if missing:
        raise RuntimeError(f"Missing required env vars: {', '.join(missing)}")


def make_headers(env: Dict[str, str]) -> Dict[str, str]:
    """Build the baseline Make API headers once so wrappers can stay tiny."""
    return {
        "Content-Type": "application/json",
        "Authorization": f"Token {env['AUTH_TOKEN']}",
    }


def fetch_json(env: Dict[str, str], path: str, *, method: str = "GET", body: Optional[dict] = None) -> dict:
    """Small helper for JSON Make API calls (GET by default, POST when body provided)."""
    url = f"{env['INSTANCE_URL'].rstrip('/')}{path}"
    response = requests.request(method, url, headers=make_headers(env), data=json.dumps(body) if body else None)
    response.raise_for_status()
    return response.json()


def fetch_raw(env: Dict[str, str], path: str, *, method: str = "GET", allow_redirects: bool = True) -> requests.Response:
    """Variant of fetch_json that exposes the raw response (used for consent redirects)."""
    url = f"{env['INSTANCE_URL'].rstrip('/')}{path}"
    response = requests.request(method, url, headers=make_headers(env), allow_redirects=allow_redirects)
    response.raise_for_status()
    return response


def load_blueprint(name_or_path: str) -> dict:
    """Open a blueprint either by absolute path or by name inside the default folder."""
    candidate_path = Path(name_or_path)
    if not candidate_path.exists():
        candidate_path = DEFAULT_BLUEPRINT_DIR / name_or_path
    if not candidate_path.exists():
        raise FileNotFoundError(f"Blueprint not found: {name_or_path}")
    return json.loads(candidate_path.read_text())


def analyse_blueprint(blueprint: dict) -> tuple[str, List[str]]:
    """Walk through the flow and return the non-Facebook app plus its module names."""
    modules: List[tuple[str, str]] = []

    def walk(node):
        if not node:
            return
        if isinstance(node, list):
            for item in node:
                walk(item)
            return
        if isinstance(node, dict):
            module = node.get("module")
            if isinstance(module, str):
                app, _, action = module.partition(":")
                if app and action:
                    modules.append((app, action))
            for value in node.values():
                walk(value)

    walk(blueprint.get("flow"))
    filtered = [item for item in modules if item[0] != "facebook-conversion-leads"]
    if not filtered:
        raise RuntimeError("No eligible modules found in blueprint")

    app_name = filtered[0][0]
    module_names = [action for app, action in filtered if app == app_name]
    return app_name, module_names


def collect_scopes(app_definition: dict, module_names: Iterable[str]) -> List[str]:
    """Cross-reference module names against the app definition to gather scopes."""
    lookup: Dict[str, List[str]] = {}
    for bucket in ("actions", "searches", "triggers"):
        for item in app_definition.get("app", {}).get(bucket, []) or []:
            name = item.get("name")
            if name:
                scopes = item.get("scopes") or item.get("scope") or []
                lookup[name.lower()] = scopes

    combined: set[str] = set()
    for name in module_names:
        combined.update(lookup.get(name.lower(), []))
    return sorted(combined)


def collect_form_fields(schema: dict, bucket: Optional[List[dict]] = None) -> List[dict]:
    """Flatten the form schema and keep only user-editable fields we must populate."""
    bucket = bucket or []
    if not schema:
        return bucket
    if isinstance(schema, list):
        for item in schema:
            collect_form_fields(item, bucket)
        return bucket
    if isinstance(schema, dict):
        identifier = schema.get("key") or schema.get("name")
        field_type = schema.get("type") or schema.get("templateOptions", {}).get("type")
        if identifier and (field_type or "").lower() not in {"button", "content", "htmlelement"}:
            cloned = {
                "key": identifier,
                "type": field_type,
                "data": schema.get("data"),
                "templateOptions": schema.get("templateOptions"),
                "required": bool(
                    schema.get("required")
                    or schema.get("validate", {}).get("required")
                    or schema.get("templateOptions", {}).get("required")
                ),
            }
            template_options = schema.get("templateOptions") or {}
            default_value = schema.get("defaultValue")
            if default_value is None:
                default_value = template_options.get("defaultValue")
            if default_value is None:
                default_value = template_options.get("default")
            if default_value is None:
                default_value = schema.get("default")
            if default_value is not None:
                cloned["defaultValue"] = default_value
            bucket.append(cloned)

        for child_key, child_value in schema.items():
            if child_key == "components":
                continue
            if child_key == "options" and isinstance(child_value, dict):
                store = child_value.get("store")
                if isinstance(store, list) and store:
                    selected = next(
                        (
                            option
                            for option in store
                            if isinstance(option, dict) and (option.get("default") is True or option.get("selected") is True)
                        ),
                        None,
                    )
                    if selected is None:
                        selected = store[0]
                    if isinstance(selected, dict):
                        collect_form_fields(selected, bucket)
                continue
            if child_key == "nested" and isinstance(child_value, list):
                for item in child_value:
                    collect_form_fields(item, bucket)
                continue
            collect_form_fields(child_value, bucket)
    return bucket


def build_payload(form_schema: dict, app_name: str, scopes: List[str], account_name_override: Optional[str]) -> dict:
    """Merge defaults from the form schema with our derived scopes and account name."""
    payload: Dict[str, object] = {}
    fields = collect_form_fields(form_schema)
    for field in fields:
        key = field.get("key")
        if not key:
            continue
        if "defaultValue" in field:
            payload[key] = field.get("defaultValue")
        else:
            payload[key] = field_fallback(field)

    if isinstance(payload.get("accountName"), str) and "{{" in payload["accountName"] and "}}" in payload["accountName"]:
        payload["accountName"] = ""

    payload["accountType"] = payload.get("accountType") or app_name
    payload["accountName"] = account_name_override or payload.get("accountName") or f"{app_name} connection"
    payload["customScopes"] = scopes

    if "property" in payload and not payload["property"]:
        raise RuntimeError("The connection form expects a property value")
    return payload


def field_fallback(field: dict) -> object:
    field_type = str(field.get("type") or "").lower()
    template_type = str(field.get("templateOptions", {}).get("type") or "").lower()
    if field_type == "boolean" or template_type == "boolean":
        return False
    candidate = option_fallback(field)
    if candidate is not None:
        return candidate
    return ""


def option_fallback(field: dict) -> Optional[object]:
    data = field.get("data")
    template = field.get("templateOptions")
    sources = [source for source in (data, template) if isinstance(source, dict)]
    if not sources:
        return None

    for source in sources:
        if "defaultValue" in source:
            return source.get("defaultValue")

    for source in sources:
        for key in ("options", "values", "items", "enum"):
            options = source.get(key)
            if isinstance(options, dict) and isinstance(options.get("store"), list):
                options = options.get("store")
            if not isinstance(options, list) or not options:
                continue
            preferred = next((opt for opt in options if isinstance(opt, dict) and opt.get("default") is True), None)
            if preferred is None:
                preferred = next((opt for opt in options if isinstance(opt, dict) and opt.get("selected") is True), None)
            candidates = options if preferred is None else [preferred]
            for option in candidates:
                if isinstance(option, dict):
                    if "value" in option:
                        return option["value"]
                    if "id" in option:
                        return option["id"]
                    if "code" in option:
                        return option["code"]
                elif option is not None:
                    return option
    return None


def save_updated_blueprint(original_name: str, blueprint: dict, connection_id: int) -> Path:
    """Write a copy of the source blueprint with fresh connection IDs."""
    clone = json.loads(json.dumps(blueprint))
    updated = 0

    def rewrite(node):
        nonlocal updated
        if not node:
            return
        if isinstance(node, list):
            for item in node:
                rewrite(item)
            return
        if isinstance(node, dict):
            module = node.get("module")
            if isinstance(module, str) and not module.startswith("facebook-conversion-leads"):
                parameters = node.get("parameters", {})
                if "__IMTCONN__" in parameters:
                    parameters["__IMTCONN__"] = connection_id
                    updated += 1
            for value in node.values():
                rewrite(value)

    rewrite(clone.get("flow"))

    UPDATED_DIR.mkdir(parents=True, exist_ok=True)
    target_path = UPDATED_DIR / f"{Path(original_name).stem}-updated.json"
    target_path.write_text(json.dumps(clone, indent=4) + "\n")
    print(f"Updated {updated} module(s) in {target_path}")
    return target_path


def run_workflow(env: Dict[str, str], blueprint_name: str, account_name: Optional[str]) -> dict:
    """End-to-end orchestration: analyse blueprint, create connection, request consent."""
    blueprint = load_blueprint(blueprint_name)
    app_name, module_names = analyse_blueprint(blueprint)

    app_definition = fetch_json(env, f"/api/v2/imt/apps/{app_name}")
    scopes = collect_scopes(app_definition, module_names)
    form_schema = fetch_json(env, f"/api/v2/imt-forms/connections/create?type={app_name}&teamId={env['TEAM_ID']}")
    payload = build_payload(form_schema, app_name, scopes, account_name)

    response = fetch_json(env, f"/api/v2/connections?teamId={env['TEAM_ID']}&inspector=0", method="POST", body=payload)
    connection = response.get("connection") if isinstance(response, dict) else None
    if connection is None and isinstance(response, dict):
        connection = response
    if not isinstance(connection, dict) or "id" not in connection:
        raise RuntimeError(f"Connection response missing id: {json.dumps(response, indent=2)}")
    consent_response = fetch_raw(env, f"/api/v2/oauth/auth/{connection['id']}", allow_redirects=False)
    consent_url = consent_response.headers["Location"]

    updated_path = save_updated_blueprint(blueprint_name, blueprint, connection["id"])

    return {
        "connection": connection,
        "consent_url": consent_url,
        "payload": payload,
        "updated_blueprint": updated_path,
    }


def main(argv: List[str]) -> int:
    """CLI entry point for parity with the other sample languages."""
    if len(argv) < 2:
        print("Usage: python workflow_overview.py <blueprint.json> [account-name]", file=sys.stderr)
        return 1

    blueprint_name = argv[1]
    account_name = argv[2] if len(argv) > 2 else None

    env = {**load_env(ENV_PATH), **os.environ}
    ensure_settings(env)

    result = run_workflow(env, blueprint_name, account_name)
    print(f"Connection created: {result['connection']['id']}")
    print(f"Consent URL: {result['consent_url']}")
    print(f"Updated blueprint written to: {result['updated_blueprint']}")

    try:
        webbrowser.open(result["consent_url"], new=2)
        print("Consent page opened in your browser.")
    except Exception as exc:  # noqa: broad-except
        print(f"Unable to open browser automatically: {exc}")

    input("Complete the consent flow, then press Enter to trigger the connection test...")
    test_result = fetch_json(env, f"/api/v2/connections/{result['connection']['id']}/test", method="POST")
    print("Test response:")
    print(json.dumps(test_result, indent=2))

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
