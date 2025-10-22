//! Simplified Make connection workflow in Rust.
//!
//! This program mirrors the single-file examples in Node/Python/Go. It uses
//! `reqwest` and `serde_json` so you can compile it quickly and use the code as
//! a translation guide.
//!
//! Usage:
//!     cargo run --example workflow_overview "Hubspot - FBcapi.json" "Optional Account Name"
use std::collections::{BTreeMap, HashMap, HashSet};
use std::env;
use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use reqwest::blocking::{Client, Response};
use reqwest::header::{HeaderMap, HeaderValue, CONTENT_TYPE};
use serde_json::{json, Value};

fn main() -> anyhow::Result<()> {
    let args: Vec<String> = env::args().collect();
    if args.len() < 2 {
        eprintln!("Usage: cargo run --example workflow_overview <blueprint.json> [account-name]");
        std::process::exit(1);
    }

    let blueprint_name = &args[1];
    let account_override = args.get(2).cloned();

    let root = workspace_root()?;
    let env_path = root.join(".env");
    let env = load_env(&env_path)?;
    ensure_settings(&env)?;

    let client = Client::new();
    let blueprint = load_blueprint(&root, blueprint_name)?;
    let (app_name, modules) = analyse_blueprint(&blueprint);

    let app_definition = fetch_json(&client, &env, &format!("/api/v2/imt/apps/{app_name}"))?;
    let scopes = collect_scopes(&app_definition, &modules);
    let form_schema = fetch_json(&client, &env, &format!(
        "/api/v2/imt-forms/connections/create?type={app_name}&teamId={}",
        env["TEAM_ID"]
    ))?;
    let payload = build_payload(&form_schema, &app_name, &scopes, account_override.as_deref());

    let create_resp = fetch_json_with_body(
        &client,
        &env,
        &format!("/api/v2/connections?teamId={}&inspector=0", env["TEAM_ID"]),
        payload.clone(),
    )?;
    let connection_value = create_resp
        .get("connection")
        .cloned()
        .unwrap_or_else(|| create_resp.clone());
    let connection_obj = connection_value
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("Connection response missing object payload: {}", connection_value))?;
    let connection_id = connection_obj
        .get("id")
        .cloned()
        .ok_or_else(|| anyhow::anyhow!("Connection response missing id: {}", connection_value))?;

    let consent_url = fetch_consent_url(&client, &env, connection_id.clone())?;
    let updated_path = save_blueprint(&root.join("samples/rust"), blueprint_name, &blueprint, &connection_id)?;

    println!("Connection created: {}", connection_id);
    println!("Consent URL: {}", consent_url);
    println!("Updated blueprint written to: {}", updated_path.display());

    if webbrowser::open(&consent_url).is_ok() {
        println!("Consent page opened in your browser.");
    }

    print!("Complete consent, then press Enter to run the connection test...");
    io::stdout().flush().ok();
    let mut buffer = String::new();
    io::stdin().read_line(&mut buffer).ok();

    let test_resp = fetch_json_with_body(
        &client,
        &env,
        &format!("/api/v2/connections/{}/test", connection_id),
        Value::Null,
    )?;
    println!("Test response:\n{}", serde_json::to_string_pretty(&test_resp)?);

    Ok(())
}

/// Locate the repository root so the script mirrors the behaviour of the other samples.
fn workspace_root() -> anyhow::Result<PathBuf> {
    let exe = env::current_exe()?;
    Ok(exe.parent().unwrap().join("..").join(".."))
}

/// Read a minimal `.env` file without pulling in an external parser crate.
fn load_env(path: &Path) -> anyhow::Result<HashMap<String, String>> {
    let mut values = HashMap::new();
    if !path.exists() {
        return Ok(values);
    }
    for line in fs::read_to_string(path)?.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if let Some((key, value)) = trimmed.split_once('=') {
            values.insert(key.trim().to_owned(), value.trim_matches('"').to_owned());
        }
    }
    Ok(values)
}

/// Stop early if the core Make settings are missing instead of failing mid-request.
fn ensure_settings(env: &HashMap<String, String>) -> anyhow::Result<()> {
    let mut missing = Vec::new();
    for key in ["INSTANCE_URL", "AUTH_TOKEN", "TEAM_ID"] {
        if env.get(key).map(|s| s.is_empty()).unwrap_or(true) {
            missing.push(key);
        }
    }
    if !missing.is_empty() {
        anyhow::bail!("Missing required env vars: {}", missing.join(", "));
    }
    Ok(())
}

/// Load a blueprint either via absolute path or by name from the standard folder.
fn load_blueprint(root: &Path, name: &str) -> anyhow::Result<Value> {
    let candidates = [Path::new(name).to_path_buf(), root.join("blueprints").join(name)];
    for candidate in &candidates {
        if candidate.exists() {
            let text = fs::read_to_string(candidate)?;
            return Ok(serde_json::from_str(&text)?);
        }
    }
    anyhow::bail!("Blueprint not found: {name}");
}

/// Return the first non-Facebook app and all module names tied to it.
fn analyse_blueprint(blueprint: &Value) -> (String, Vec<String>) {
    let mut modules = Vec::<(String, String)>::new();

    fn walk(node: &Value, acc: &mut Vec<(String, String)>) {
        match node {
            Value::Array(items) => items.iter().for_each(|item| walk(item, acc)),
            Value::Object(map) => {
                if let Some(Value::String(module)) = map.get("module") {
                    if let Some((app, action)) = module.split_once(':') {
                        acc.push((app.to_string(), action.to_string()));
                    }
                }
                map.values().for_each(|value| walk(value, acc));
            }
            _ => {}
        }
    }

    walk(&blueprint["flow"], &mut modules);
    for (app, _) in &modules {
        if app != "facebook-conversion-leads" {
            let actions = modules
                .iter()
                .filter(|(candidate, _)| candidate == app)
                .map(|(_, action)| action.clone())
                .collect();
            return (app.clone(), actions);
        }
    }
    panic!("No eligible modules found");
}

/// Cross-reference module names against the app definition to gather required scopes.
fn collect_scopes(app_definition: &Value, module_names: &[String]) -> Vec<String> {
    let mut lookup: HashMap<String, Vec<String>> = HashMap::new();
    if let Some(app) = app_definition.get("app") {
        for bucket in ["actions", "searches", "triggers"] {
            if let Some(Value::Array(items)) = app.get(bucket) {
                for item in items {
                    if let Some(Value::String(name)) = item.get("name") {
                        if let Some(scopes) = item.get("scopes") {
                            lookup.insert(name.to_lowercase(), to_string_vec(scopes));
                        }
                    }
                }
            }
        }
    }
    let mut combined = HashSet::new();
    for name in module_names {
        if let Some(scopes) = lookup.get(&name.to_lowercase()) {
            combined.extend(scopes.iter().cloned());
        }
    }
    combined.into_iter().collect()
}

/// Combine default form fields, the computed scopes, and the optional account override.
fn build_payload(
    schema: &Value,
    app_name: &str,
    scopes: &[String],
    account_override: Option<&str>,
) -> Value {
    let mut payload = BTreeMap::<String, Value>::new();
    let mut fields: Vec<serde_json::Map<String, Value>> = Vec::new();

    fn collect(node: &Value, bucket: &mut Vec<serde_json::Map<String, Value>>) {
        match node {
            Value::Array(items) => items.iter().for_each(|item| collect(item, bucket)),
            Value::Object(map) => {
                let identifier = map
                    .get("key")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .or_else(|| map.get("name").and_then(Value::as_str).map(|s| s.to_string()));

                let resolved_type = map
                    .get("type")
                    .and_then(Value::as_str)
                    .map(|s| s.to_string())
                    .or_else(|| map
                        .get("templateOptions")
                        .and_then(|value| value.get("type"))
                        .and_then(Value::as_str)
                        .map(|s| s.to_string()));

                let lower_type = resolved_type.as_deref().unwrap_or("").to_lowercase();
                if let Some(key) = identifier {
                    if !matches!(lower_type.as_str(), "button" | "content" | "htmlelement") {
                        let mut field = serde_json::Map::new();
                        field.insert("key".into(), Value::String(key));
                        if let Some(t) = resolved_type {
                            field.insert("type".into(), Value::String(t));
                        }
                        if let Some(data) = map.get("data") {
                            field.insert("data".into(), data.clone());
                        }
                        if let Some(template) = map.get("templateOptions") {
                            field.insert("templateOptions".into(), template.clone());
                        }

                        let mut default_value = map.get("defaultValue").cloned();
                        if default_value.is_none() {
                            default_value = map
                                .get("templateOptions")
                                .and_then(|value| value.get("defaultValue").cloned())
                                .or_else(|| map
                                    .get("templateOptions")
                                    .and_then(|value| value.get("default").cloned()))
                                .or_else(|| map.get("default").cloned());
                        }
                        if let Some(value) = default_value {
                            field.insert("defaultValue".into(), value);
                        }

                        bucket.push(field);
                    }
                }

                for (prop_key, value) in map {
                    match prop_key.as_str() {
                        "components" => {}
                        "options" => {
                            if let Value::Object(inner) = value {
                                if let Some(Value::Array(store)) = inner.get("store") {
                                    let mut selected: Option<&Value> = None;
                                    for option in store {
                                        if let Some(default_flag) = option.get("default").and_then(Value::as_bool) {
                                            if default_flag {
                                                selected = Some(option);
                                                break;
                                            }
                                        }
                                        if let Some(selected_flag) = option.get("selected").and_then(Value::as_bool) {
                                            if selected_flag {
                                                selected = Some(option);
                                                break;
                                            }
                                        }
                                        if selected.is_none() {
                                            selected = Some(option);
                                        }
                                    }
                                    if let Some(option) = selected {
                                        collect(option, bucket);
                                    }
                                    continue;
                                }
                            }
                            collect(value, bucket);
                        }
                        "nested" => {
                            if let Value::Array(items) = value {
                                for entry in items {
                                    collect(entry, bucket);
                                }
                            }
                        }
                        _ => collect(value, bucket),
                    }
                }
            }
            _ => {}
        }
    }

    collect(schema, &mut fields);


    for field in fields {
        if let Some(Value::String(key)) = field.get("key") {
            if let Some(value) = field.get("defaultValue") {
                payload.insert(key.clone(), value.clone());
            } else {
                payload.insert(key.clone(), fallback_for_field(&field));
            }
        }
    }

    if let Some(Value::String(name)) = payload.get("accountName") {
        if name.contains("{{") && name.contains("}}") {
            payload.insert("accountName".into(), Value::String(String::new()));
        }
    }

    payload.entry("accountType".into()).or_insert(Value::String(app_name.to_string()));
    if let Some(override_name) = account_override {
        payload.insert("accountName".into(), Value::String(override_name.to_string()));
    } else {
        payload.entry("accountName".into()).or_insert(Value::String(format!("{app_name} connection")));
    }
    payload.insert("customScopes".into(), Value::Array(scopes.iter().cloned().map(Value::String).collect()));
    if let Some(Value::String(prop)) = payload.get("property") {
        if prop.is_empty() {
            panic!("The connection form expects a property value");
        }
    }
    Value::Object(payload)
}

fn fallback_for_field(map: &serde_json::Map<String, Value>) -> Value {
    let template_type = map
        .get("templateOptions")
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .map(|s| s.eq_ignore_ascii_case("boolean"))
        .unwrap_or(false);
    if let Some(Value::String(field_type)) = map.get("type") {
        if field_type.eq_ignore_ascii_case("boolean") || template_type {
            return Value::Bool(false);
        }
    } else if template_type {
        return Value::Bool(false);
    }
    if let Some(candidate) = option_fallback(map) {
        return candidate;
    }
    Value::String(String::new())
}

fn option_fallback(map: &serde_json::Map<String, Value>) -> Option<Value> {
    let mut sources = Vec::new();
    if let Some(Value::Object(data)) = map.get("data") {
        sources.push(data);
    }
    if let Some(Value::Object(template)) = map.get("templateOptions") {
        sources.push(template);
    }
    if sources.is_empty() {
        return None;
    }

    for source in &sources {
        if let Some(value) = source.get("defaultValue") {
            return Some(value.clone());
        }
    }

    for source in sources {
        for key in ["options", "values", "items", "enum"] {
            let mut candidates: Vec<Value> = Vec::new();
            match source.get(key) {
                Some(Value::Array(items)) => candidates.extend(items.clone()),
                Some(Value::Object(map)) => {
                    if let Some(Value::Array(store)) = map.get("store") {
                        candidates.extend(store.clone());
                    }
                }
                _ => {}
            }
            let preferred = candidates.iter().find(|item| {
                item.get("default").and_then(Value::as_bool) == Some(true)
                    || item.get("selected").and_then(Value::as_bool) == Some(true)
            }).cloned();

            let iter: Vec<Value> = if let Some(pref) = preferred {
                vec![pref]
            } else {
                candidates.clone()
            };

            for item in iter {
                if let Value::Object(option) = item {
                    for candidate_key in ["value", "id", "code"] {
                        if let Some(value) = option.get(candidate_key) {
                            return Some(value.clone());
                        }
                    }
                } else if !item.is_null() {
                    return Some(item.clone());
                }
            }
        }
    }
    None
}

/// Clone the blueprint and swap `__IMTCONN__` for the new connection everywhere.
fn rewrite_blueprint(original: &Value, connection_id: &Value) -> (Value, usize) {
    let mut clone = original.clone();
    let mut updated = 0;

    fn walk(node: &mut Value, connection_id: &Value, updated: &mut usize) {
        match node {
            Value::Array(items) => items.iter_mut().for_each(|item| walk(item, connection_id, updated)),
            Value::Object(map) => {
                if let Some(Value::String(module)) = map.get("module") {
                    if !module.starts_with("facebook-conversion-leads") {
                        if let Some(Value::Object(params)) = map.get_mut("parameters") {
                            if params.contains_key("__IMTCONN__") {
                                params.insert("__IMTCONN__".into(), connection_id.clone());
                                *updated += 1;
                            }
                        }
                    }
                }
                map.values_mut().for_each(|value| walk(value, connection_id, updated));
            }
            _ => {}
        }
    }

    walk(&mut clone["flow"], connection_id, &mut updated);
    (clone, updated)
}

/// Persist the updated blueprint next to the sample so everything stays portable.
fn save_blueprint(dir: &Path, original_name: &str, blueprint: &Value, connection_id: &Value) -> anyhow::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let base = Path::new(original_name).file_stem().unwrap().to_string_lossy();
    let path = dir.join(format!("{base}-updated.json"));
    let (rewritten, updated) = rewrite_blueprint(blueprint, connection_id);
    println!("Updated {} module(s) in {}", updated, path.display());
    fs::write(&path, serde_json::to_string_pretty(&rewritten)? + "\n")?;
    Ok(path)
}

/// Convenience wrapper for GET requests that expect JSON bodies.
fn fetch_json(client: &Client, env: &HashMap<String, String>, path: &str) -> anyhow::Result<Value> {
    let response = fetch(client, env, path, reqwest::Method::GET, Value::Null, true)?;
    Ok(response.json()?)
}

/// POST helper that mirrors `fetch_json` but accepts an explicit JSON body.
fn fetch_json_with_body(
    client: &Client,
    env: &HashMap<String, String>,
    path: &str,
    body: Value,
) -> anyhow::Result<Value> {
    let response = fetch(client, env, path, reqwest::Method::POST, body, true)?;
    Ok(response.json()?)
}

/// Retrieve the consent redirect without following it to keep the browser in charge.
fn fetch_consent_url(client: &Client, env: &HashMap<String, String>, connection_id: Value) -> anyhow::Result<String> {
    let path = format!("/api/v2/oauth/auth/{}", connection_id);
    let response = fetch(client, env, &path, reqwest::Method::GET, Value::Null, false)?;
    if let Some(location) = response.headers().get("Location") {
        Ok(location.to_str()?.to_string())
    } else {
        anyhow::bail!("Missing Location header when requesting consent URL");
    }
}

/// Shared HTTP helper so all requests reuse the same error handling and headers.
fn fetch(
    client: &Client,
    env: &HashMap<String, String>,
    path: &str,
    method: reqwest::Method,
    body: Value,
    allow_redirects: bool,
) -> anyhow::Result<Response> {
    let url = format!("{}{}", env["INSTANCE_URL"].trim_end_matches('/'), path);
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert("Authorization", HeaderValue::from_str(&format!("Token {}", env["AUTH_TOKEN"]))?);

    let builder = client.request(method, &url).headers(headers);
    let builder = if body.is_null() { builder } else { builder.body(body.to_string()) };
    let client = if allow_redirects { client.clone() } else { Client::builder().redirect(reqwest::redirect::Policy::none()).build()? };
    let response = client.execute(builder.build()?)?;
    if response.status().is_success() || (!allow_redirects && response.status().is_redirection()) {
        Ok(response)
    } else {
        anyhow::bail!("Request failed: {}", response.status())
    }
}

/// Convert a JSON array into a vector of strings while dropping non-string entries.
fn to_string_vec(value: &Value) -> Vec<String> {
    value
        .as_array()
        .unwrap_or(&vec![])
        .iter()
        .filter_map(|item| item.as_str().map(|s| s.to_string()))
        .collect()
}

/// Mirrors the helper used in other languages; handy if you expand the sample further.
fn firstNonEmpty(values: &[String]) -> String {
    for value in values {
        if !value.trim().is_empty() {
            return value.clone();
        }
    }
    String::new()
}
