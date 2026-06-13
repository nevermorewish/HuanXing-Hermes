// Account login + model provisioning (ported from HuanXing-Claw's Electron
// electron/utils/account-session.ts + electron/services/account-api.ts).
//
// Logs in to a newapi-style account server (brand `serviceUrl`), fetches the
// account's usable models and a full `sk-` API key, and registers the selected
// models as a custom OpenAI-compatible provider in the runtime config so they
// become usable in chat.
//
// Security model:
//   - The server authenticates with an HttpOnly `session` cookie that a webview
//     fetch cannot hold, so the cookie + logged-in user id live in main-process
//     memory here (SESSION). Protected endpoints also require a
//     `New-Api-User: <id>` header matching the session user.
//   - The full `sk-` key never crosses the IPC boundary to the frontend. It is
//     held in the OS credential store (keyring on Windows/macOS) and injected
//     into the runtime config by `account_save_models` server-side. Commands
//     only ever return a masked preview + `hasKey`.

use std::sync::LazyLock;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::brand_generated::{BRAND_APP_NAME, BRAND_PROVIDER_KEY};
use crate::error::AppError;
use crate::state::AppState;

/// HTTP client for the account server (newapi). Short timeout, no redirect
/// following so a relay catch-all 404 surfaces as a real status rather than a
/// silent hop.
static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .expect("valid account HTTP client")
});

/// Dashboard client for reading/writing the runtime config (longer timeout to
/// match the api_proxy dashboard client).
static DASHBOARD_HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .expect("valid account dashboard HTTP client")
});

/// In-memory login session. Single user per app lifetime.
static SESSION: LazyLock<Mutex<Option<SessionState>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Clone)]
struct SessionState {
    base_url: String,
    session_cookie: String,
    user: AccountUser,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AccountUser {
    pub id: i64,
    pub username: String,
    pub display_name: String,
    pub role: i64,
    pub status: i64,
    pub group: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountToken {
    pub id: i64,
    pub name: String,
    pub group: String,
    pub status: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBalance {
    pub quota: f64,
    pub used_quota: f64,
    pub quota_per_unit: f64,
    pub display_in_currency: bool,
    pub top_up_url: String,
}

// ---- inputs -------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub base_url: String,
    pub username: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveModelsInput {
    /// Model ids selected in the login dialog.
    pub models: Vec<String>,
    /// Optional model id to set as the runtime's current/primary model.
    #[serde(default)]
    pub primary_model_id: Option<String>,
    /// Optional token id whose key backs the saved models. When omitted the
    /// account's first usable token (or a freshly created one) is used.
    #[serde(default)]
    pub token_id: Option<i64>,
}

// ---- outputs ------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusResult {
    pub logged_in: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<AccountUser>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_url: Option<String>,
    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupResult {
    pub user: AccountUser,
    pub base_url: String,
    pub models: Vec<String>,
    pub has_key: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub masked_key: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestModelResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCredentialsInfo {
    pub has_saved: bool,
    /// Username for prefilling the login form. Never includes the password.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_url: Option<String>,
}

// ---- helpers ------------------------------------------------------------

fn normalize_base_url(input: &str) -> String {
    input.trim().trim_end_matches('/').to_string()
}

/// The runtime config provider id for this brand's account provider. Uses the
/// `custom:` prefix so it is treated (and deletable) like a user-added custom
/// OpenAI-compatible provider.
fn account_provider_id() -> String {
    format!("custom:{}", BRAND_PROVIDER_KEY)
}

/// keyring account name under which the full sk- key is stored.
fn secret_account() -> String {
    format!("{}-account-key", BRAND_PROVIDER_KEY)
}

/// Append `/v1` to the account base URL unless it already ends in `/vN` — the
/// account relay is OpenAI-compatible.
fn account_api_base(base_url: &str) -> String {
    let raw = normalize_base_url(base_url);
    if raw.is_empty() {
        return String::new();
    }
    let already_versioned = raw
        .rsplit('/')
        .next()
        .map(|seg| {
            seg.len() >= 2
                && seg.starts_with('v')
                && seg[1..].chars().all(|c| c.is_ascii_digit())
        })
        .unwrap_or(false);
    if already_versioned {
        raw
    } else {
        format!("{}/v1", raw)
    }
}

/// Mask an sk- key for display: keep the `sk-` prefix + last 4 chars.
fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.len() <= 8 {
        return "****".to_string();
    }
    let tail = &trimmed[trimmed.len() - 4..];
    format!("sk-****{}", tail)
}

fn ensure_sk_prefix(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.starts_with("sk-") {
        trimmed.to_string()
    } else {
        format!("sk-{}", trimmed)
    }
}

/// Whether an embedded key is the full secret rather than a masked preview.
fn is_full_key(key: &str) -> bool {
    !key.is_empty() && !key.contains('*') && !key.contains('…') && !key.contains("...")
}

/// Pull `session=...` out of one or more Set-Cookie header values.
fn extract_session_cookie(values: &[String]) -> Option<String> {
    for v in values {
        for part in v.split(';') {
            let part = part.trim();
            if part.starts_with("session=") {
                return Some(part.to_string());
            }
        }
    }
    None
}

fn snippet(raw: &str) -> String {
    let t = raw.trim();
    if t.len() > 200 {
        format!("{}…", &t[..200])
    } else {
        t.to_string()
    }
}

/// Issue an authenticated GET/POST to the account server and parse the JSON
/// envelope (`{ success, message, data }`). Cookie + New-Api-User are set from
/// the live session.
async fn account_json(
    method: reqwest::Method,
    url: &str,
    cookie: &str,
    user_id: i64,
    body: Option<Value>,
) -> Result<(u16, Value), AppError> {
    let mut req = HTTP
        .request(method, url)
        .header("Cookie", cookie)
        .header("New-Api-User", user_id.to_string());
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await?;
    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    let parsed: Value = if raw.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&raw).map_err(|_| {
            AppError::ProxyError(format!("账户服务返回非 JSON (HTTP {}): {}", status, snippet(&raw)))
        })?
    };
    Ok((status, parsed))
}

fn envelope_error(action: &str, status: u16, body: &Value) -> AppError {
    let msg = body
        .get("message")
        .and_then(|m| m.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());
    match msg {
        Some(m) => AppError::ProxyError(m.to_string()),
        None => AppError::ProxyError(format!("{}失败 (HTTP {})", action, status)),
    }
}

fn require_session() -> Result<SessionState, AppError> {
    SESSION
        .lock()?
        .clone()
        .ok_or_else(|| AppError::InvalidRequest("尚未登录账户".to_string()))
}

// ---- OS secret store (keyring on Windows/macOS, in-memory elsewhere) -----
//
// Packaged targets are Windows (nsis) + macOS (dmg) only, so the in-memory
// fallback is exercised only by the ubuntu CI test runner — which has no
// Secret Service / D-Bus session. This keeps `cargo test` on Linux from
// touching a real credential store.

#[cfg(any(target_os = "windows", target_os = "macos"))]
mod secret_store {
    use crate::error::AppError;

    const SERVICE: &str = "hermes-agent-cn-desktop.account";

    fn map(e: keyring::Error) -> AppError {
        AppError::Internal(format!("凭证存储错误: {}", e))
    }

    pub fn set(account: &str, secret: &str) -> Result<(), AppError> {
        keyring::Entry::new(SERVICE, account)
            .map_err(map)?
            .set_password(secret)
            .map_err(map)
    }

    pub fn get(account: &str) -> Result<Option<String>, AppError> {
        match keyring::Entry::new(SERVICE, account).map_err(map)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(map(e)),
        }
    }

    pub fn delete(account: &str) -> Result<(), AppError> {
        match keyring::Entry::new(SERVICE, account).map_err(map)?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(map(e)),
        }
    }
}

#[cfg(not(any(target_os = "windows", target_os = "macos")))]
mod secret_store {
    use crate::error::AppError;
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    static STORE: LazyLock<Mutex<HashMap<String, String>>> =
        LazyLock::new(|| Mutex::new(HashMap::new()));

    pub fn set(account: &str, secret: &str) -> Result<(), AppError> {
        STORE.lock()?.insert(account.to_string(), secret.to_string());
        Ok(())
    }

    pub fn get(account: &str) -> Result<Option<String>, AppError> {
        Ok(STORE.lock()?.get(account).cloned())
    }

    pub fn delete(account: &str) -> Result<(), AppError> {
        STORE.lock()?.remove(account);
        Ok(())
    }
}

fn stored_key() -> Result<Option<String>, AppError> {
    secret_store::get(&secret_account())
}

fn store_key(key: &str) -> Result<(), AppError> {
    secret_store::set(&secret_account(), key)
}

/// keyring account name under which the login credentials (base url + username
/// + password) are stored as a JSON blob. Separate entry from the sk- key so
/// logout can clear the session key without forgetting the saved login.
fn credentials_account() -> String {
    format!("{}-account-login", BRAND_PROVIDER_KEY)
}

/// Persist login credentials in the OS keyring. The password never leaves the
/// secret store after this — it is only read back by `account_login_saved`.
fn store_credentials(base_url: &str, username: &str, password: &str) -> Result<(), AppError> {
    let blob = json!({
        "baseUrl": base_url,
        "username": username,
        "password": password,
    })
    .to_string();
    secret_store::set(&credentials_account(), &blob)
}

/// Read saved credentials, if any. Returns (base_url, username, password).
fn load_credentials() -> Result<Option<(String, String, String)>, AppError> {
    let Some(blob) = secret_store::get(&credentials_account())? else {
        return Ok(None);
    };
    let parsed: Value = serde_json::from_str(&blob)
        .map_err(|e| AppError::Internal(format!("已保存凭据解析失败: {}", e)))?;
    let base_url = parsed.get("baseUrl").and_then(Value::as_str).unwrap_or("").to_string();
    let username = parsed.get("username").and_then(Value::as_str).unwrap_or("").to_string();
    let password = parsed.get("password").and_then(Value::as_str).unwrap_or("").to_string();
    if username.is_empty() || password.is_empty() {
        return Ok(None);
    }
    Ok(Some((base_url, username, password)))
}

// ---- account server calls ----------------------------------------------

/// POST /api/user/login — stores the session cookie + user on success.
async fn do_login(base_url: &str, username: &str, password: &str) -> Result<AccountUser, AppError> {
    let normalized = normalize_base_url(base_url);
    if normalized.is_empty() {
        return Err(AppError::InvalidRequest("服务地址不能为空".to_string()));
    }
    let res = HTTP
        .post(format!("{}/api/user/login", normalized))
        .json(&json!({ "username": username, "password": password }))
        .send()
        .await?;
    let status = res.status().as_u16();
    let set_cookies: Vec<String> = res
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();
    let raw = res.text().await.unwrap_or_default();
    let body: Value = serde_json::from_str(&raw).map_err(|_| {
        AppError::ProxyError(format!("账户服务返回非 JSON (HTTP {}): {}", status, snippet(&raw)))
    })?;

    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(envelope_error("登录", status, &body));
    }
    let data = body.get("data").cloned().unwrap_or_else(|| json!({}));
    if data.get("require_2fa").and_then(Value::as_bool) == Some(true) {
        return Err(AppError::InvalidRequest(
            "该账号开启了两步验证，暂不支持".to_string(),
        ));
    }
    let cookie = extract_session_cookie(&set_cookies)
        .ok_or_else(|| AppError::ProxyError("登录失败：服务未返回会话凭证".to_string()))?;
    let id = data.get("id").and_then(Value::as_i64).ok_or_else(|| {
        AppError::ProxyError("登录失败：服务未返回用户信息".to_string())
    })?;
    let username_s = data
        .get("username")
        .and_then(Value::as_str)
        .unwrap_or(username)
        .to_string();
    let user = AccountUser {
        id,
        username: username_s.clone(),
        display_name: data
            .get("display_name")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
            .unwrap_or(&username_s)
            .to_string(),
        role: data.get("role").and_then(Value::as_i64).unwrap_or(0),
        status: data.get("status").and_then(Value::as_i64).unwrap_or(0),
        group: data
            .get("group")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_string(),
    };

    *SESSION.lock()? = Some(SessionState {
        base_url: normalized,
        session_cookie: cookie,
        user: user.clone(),
    });
    Ok(user)
}

/// Fetch the model names usable by this account: try GET /api/pricing first
/// (newer newapi), fall back to the legacy flat list.
async fn fetch_models(session: &SessionState) -> Result<Vec<String>, AppError> {
    match fetch_models_pricing(session).await {
        Ok(models) => Ok(models),
        Err(pricing_err) => match fetch_models_legacy(session).await {
            Ok(models) => Ok(models),
            Err(_) => Err(pricing_err),
        },
    }
}

async fn fetch_models_pricing(session: &SessionState) -> Result<Vec<String>, AppError> {
    let (status, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/pricing", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    // /api/pricing usually omits `success` on success; only an explicit false
    // is an error.
    if body.get("success").and_then(Value::as_bool) == Some(false) {
        return Err(envelope_error("获取模型列表", status, &body));
    }

    let mut usable_groups: std::collections::HashSet<String> = body
        .get("usable_group")
        .and_then(Value::as_object)
        .map(|m| m.keys().cloned().collect())
        .unwrap_or_default();
    if !session.user.group.is_empty() {
        usable_groups.insert(session.user.group.clone());
    }

    let data = body.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut names: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for entry in data {
        let name = match entry.get("model_name").and_then(Value::as_str) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => continue,
        };
        let groups = entry.get("enable_groups").and_then(Value::as_array);
        let allowed = match groups {
            Some(g) if !g.is_empty() && !usable_groups.is_empty() => g
                .iter()
                .filter_map(Value::as_str)
                .any(|gr| usable_groups.contains(gr)),
            _ => true, // no group info → don't over-filter
        };
        if allowed && seen.insert(name.clone()) {
            names.push(name);
        }
    }
    Ok(names)
}

async fn fetch_models_legacy(session: &SessionState) -> Result<Vec<String>, AppError> {
    let mut last_err: Option<AppError> = None;
    for path in ["/api/user/self/models", "/api/user/models"] {
        match account_json(
            reqwest::Method::GET,
            &format!("{}{}", session.base_url, path),
            &session.session_cookie,
            session.user.id,
            None,
        )
        .await
        {
            Ok((status, body)) => {
                if body.get("success").and_then(Value::as_bool) == Some(false) {
                    last_err = Some(envelope_error("获取模型列表", status, &body));
                    continue;
                }
                let data = body.get("data").and_then(Value::as_array).cloned().unwrap_or_default();
                let mut names = Vec::new();
                let mut seen = std::collections::HashSet::new();
                for v in data {
                    if let Some(s) = v.as_str() {
                        if !s.is_empty() && seen.insert(s.to_string()) {
                            names.push(s.to_string());
                        }
                    }
                }
                return Ok(names);
            }
            Err(e) => last_err = Some(e),
        }
    }
    Err(last_err.unwrap_or_else(|| AppError::ProxyError("获取模型列表失败".to_string())))
}

/// GET /api/token/?p=0&size=100 — raw token rows (id, name, group, status, key).
async fn fetch_token_items(session: &SessionState) -> Result<Vec<Value>, AppError> {
    let (status, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/token/?p=0&size=100", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(envelope_error("获取令牌列表", status, &body));
    }
    Ok(body
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default())
}

async fn create_token(session: &SessionState) -> Result<(), AppError> {
    let (status, body) = account_json(
        reqwest::Method::POST,
        &format!("{}/api/token/", session.base_url),
        &session.session_cookie,
        session.user.id,
        Some(json!({
            "name": BRAND_APP_NAME,
            "unlimited_quota": true,
            "expired_time": -1,
            "remain_quota": 0,
        })),
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(envelope_error("创建 API 令牌", status, &body));
    }
    Ok(())
}

/// Fetch the full key for a token id: POST /api/token/{id}/key, fall back to
/// GET /api/token/{id} (inline key on the detail).
async fn fetch_token_key(session: &SessionState, token_id: i64) -> Result<String, AppError> {
    // 1. dedicated key endpoint
    if let Ok((_, body)) = account_json(
        reqwest::Method::POST,
        &format!("{}/api/token/{}/key", session.base_url, token_id),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await
    {
        if body.get("success").and_then(Value::as_bool) == Some(true) {
            if let Some(k) = body.get("data").and_then(|d| d.get("key")).and_then(Value::as_str) {
                if is_full_key(k) {
                    return Ok(ensure_sk_prefix(k));
                }
            }
        }
    }
    // 2. token detail
    let (_, body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/token/{}", session.base_url, token_id),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    if body.get("success").and_then(Value::as_bool) == Some(true) {
        if let Some(k) = body.get("data").and_then(|d| d.get("key")).and_then(Value::as_str) {
            if is_full_key(k) {
                return Ok(ensure_sk_prefix(k));
            }
        }
    }
    Err(AppError::ProxyError(
        "获取令牌密钥失败：服务未提供可用的密钥接口".to_string(),
    ))
}

/// Resolve a usable sk- key, creating a token if needed, and cache it in the
/// OS secret store.
async fn ensure_api_key(session: &SessionState, token_id: Option<i64>) -> Result<String, AppError> {
    let mut items = fetch_token_items(session).await?;
    let mut picked = pick_token(&items, token_id);
    if picked.is_none() && token_id.is_none() {
        create_token(session).await?;
        items = fetch_token_items(session).await?;
        picked = pick_token(&items, None);
    }
    let token = picked.ok_or_else(|| {
        AppError::ProxyError(match token_id {
            Some(id) => format!("未找到指定的 API 令牌 (id {})", id),
            None => "未找到可用的 API 令牌，且自动创建失败".to_string(),
        })
    })?;

    // Newer backends return the full key inline on the row.
    if let Some(k) = token.get("key").and_then(Value::as_str) {
        if is_full_key(k) {
            let key = ensure_sk_prefix(k);
            store_key(&key)?;
            return Ok(key);
        }
    }
    let id = token.get("id").and_then(Value::as_i64).ok_or_else(|| {
        AppError::ProxyError("令牌缺少 id".to_string())
    })?;
    let key = fetch_token_key(session, id).await?;
    store_key(&key)?;
    Ok(key)
}

fn pick_token(items: &[Value], token_id: Option<i64>) -> Option<Value> {
    match token_id {
        Some(id) => items
            .iter()
            .find(|t| t.get("id").and_then(Value::as_i64) == Some(id))
            .cloned(),
        None => items
            .iter()
            .find(|t| t.get("status").and_then(Value::as_i64) == Some(1))
            .or_else(|| items.first())
            .cloned(),
    }
}

// ---- dashboard config I/O ------------------------------------------------

fn dashboard_state(state: &State<'_, AppState>) -> Result<(String, Option<String>), AppError> {
    let inner = state.inner.lock()?;
    Ok((inner.api_base_url.clone(), inner.session_token.clone()))
}

fn apply_auth(mut req: reqwest::RequestBuilder, token: Option<&str>) -> reqwest::RequestBuilder {
    if let Some(t) = token {
        req = req
            .header("Authorization", format!("Bearer {}", t))
            .header("X-Hermes-Session-Token", t);
    }
    req
}

/// GET /api/config from the dashboard, returning the parsed config object.
async fn read_config(api_base: &str, token: Option<&str>) -> Result<Value, AppError> {
    let url = format!("{}/api/config", api_base.trim_end_matches('/'));
    let res = apply_auth(DASHBOARD_HTTP.get(&url), token).send().await?;
    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(AppError::ProxyError(format!(
            "读取配置失败 (HTTP {}): {}",
            status,
            snippet(&raw)
        )));
    }
    serde_json::from_str(&raw)
        .map_err(|e| AppError::ProxyError(format!("配置解析失败: {}", e)))
}

/// PUT /api/config with the `{ config }` envelope the dashboard expects.
async fn write_config(api_base: &str, token: Option<&str>, config: &Value) -> Result<(), AppError> {
    let url = format!("{}/api/config", api_base.trim_end_matches('/'));
    let res = apply_auth(DASHBOARD_HTTP.put(&url), token)
        .json(&json!({ "config": config }))
        .send()
        .await?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        let raw = res.text().await.unwrap_or_default();
        return Err(AppError::ProxyError(format!(
            "保存配置失败 (HTTP {}): {}",
            status,
            snippet(&raw)
        )));
    }
    Ok(())
}

/// Build the `providers.<id>` entry for the account provider (custom OpenAI
/// provider with inline api_key, mirroring Hermes's own custom-provider shape).
fn build_provider_entry(
    existing: &Value,
    api_base: &str,
    models: &[String],
    primary_model: &str,
    api_key: &str,
) -> Value {
    let mut entry = existing.as_object().cloned().unwrap_or_default();
    entry.insert("name".into(), json!(BRAND_APP_NAME));
    entry.insert("base_url".into(), json!(api_base));
    entry.insert("api_mode".into(), json!("chat_completions"));
    entry.insert("transport".into(), json!("openai_chat"));
    // Pin the picker to exactly the models the user selected. Without this,
    // Core defaults discover_models=True and probes the relay's /v1/models,
    // which advertises models the user never chose (e.g. claude-*) and
    // overrides the configured `models` map entirely (see Core
    // model_switch.py list_authenticated_providers).
    entry.insert("discover_models".into(), json!(false));
    entry.insert("model".into(), json!(primary_model));
    // Core's config normalizer (_normalize_custom_provider_entry) only keeps a
    // `models` map when it is a dict {id: {...}} — a list of {id} objects is
    // silently dropped (it only preserves list items that are plain strings),
    // which made the account's models vanish from the picker. Write the dict
    // shape Core expects.
    entry.insert(
        "models".into(),
        Value::Object(
            models
                .iter()
                .map(|id| (id.clone(), json!({})))
                .collect::<serde_json::Map<String, Value>>(),
        ),
    );
    if !api_key.is_empty() {
        entry.insert("api_key".into(), json!(api_key));
    }
    Value::Object(entry)
}

/// Merge the account provider (and optional primary model) into a config value.
fn merge_account_provider(
    mut config: Value,
    api_base: &str,
    models: &[String],
    primary_model_id: Option<&str>,
    api_key: &str,
) -> Value {
    let provider_id = account_provider_id();
    let primary_model = primary_model_id
        .filter(|m| !m.is_empty())
        .map(str::to_string)
        .or_else(|| models.first().cloned())
        .unwrap_or_default();

    let root = config.as_object_mut().expect("config is a JSON object");
    let providers = root
        .entry("providers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .expect("providers is an object");
    let existing = providers.get(&provider_id).cloned().unwrap_or_else(|| json!({}));
    let entry = build_provider_entry(&existing, api_base, models, &primary_model, api_key);
    providers.insert(provider_id.clone(), entry);

    if let Some(model_id) = primary_model_id.filter(|m| !m.is_empty()) {
        root.insert(
            "model".into(),
            json!({
                "provider": provider_id,
                "model": model_id,
                "api_key": api_key,
            }),
        );
    }
    config
}

// ---- commands -----------------------------------------------------------

#[tauri::command]
pub async fn account_login(input: LoginInput) -> Result<AccountUser, AppError> {
    do_login(&input.base_url, &input.username, &input.password).await
}

#[tauri::command]
pub async fn account_status() -> Result<StatusResult, AppError> {
    let session = SESSION.lock()?.clone();
    let key = stored_key()?;
    Ok(match session {
        Some(s) => StatusResult {
            logged_in: true,
            user: Some(s.user.clone()),
            server_url: Some(s.base_url.clone()),
            has_key: key.is_some(),
            masked_key: key.as_deref().map(mask_key),
        },
        None => StatusResult {
            logged_in: false,
            user: None,
            server_url: None,
            has_key: key.is_some(),
            masked_key: key.as_deref().map(mask_key),
        },
    })
}

/// Fetch usable models + ensure an sk- key (cached in the secret store). The
/// key itself is never returned — only a masked preview.
#[tauri::command]
pub async fn account_fetch_setup() -> Result<SetupResult, AppError> {
    let session = require_session()?;
    let models = fetch_models(&session).await?;
    let key = ensure_api_key(&session, None).await?;
    Ok(SetupResult {
        user: session.user.clone(),
        base_url: session.base_url.clone(),
        models,
        has_key: true,
        masked_key: Some(mask_key(&key)),
    })
}

#[tauri::command]
pub async fn account_list_tokens() -> Result<Vec<AccountToken>, AppError> {
    let session = require_session()?;
    let items = fetch_token_items(&session).await?;
    Ok(items
        .iter()
        .map(|t| {
            let id = t.get("id").and_then(Value::as_i64).unwrap_or(0);
            AccountToken {
                id,
                name: t
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .unwrap_or_else(|| format!("令牌 #{}", id)),
                group: t.get("group").and_then(Value::as_str).unwrap_or("").to_string(),
                status: t.get("status").and_then(Value::as_i64).unwrap_or(0),
            }
        })
        .collect())
}

#[tauri::command]
pub async fn account_balance() -> Result<AccountBalance, AppError> {
    let session = require_session()?;
    let (_, self_body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/user/self", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    let data = self_body.get("data").cloned().unwrap_or_else(|| json!({}));
    let quota = data.get("quota").and_then(Value::as_f64).unwrap_or(0.0);
    let used_quota = data.get("used_quota").and_then(Value::as_f64).unwrap_or(0.0);

    let (_, status_body) = account_json(
        reqwest::Method::GET,
        &format!("{}/api/status", session.base_url),
        &session.session_cookie,
        session.user.id,
        None,
    )
    .await?;
    let sdata = status_body.get("data").cloned().unwrap_or_else(|| json!({}));
    let quota_per_unit = sdata
        .get("quota_per_unit")
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.0)
        .unwrap_or(500000.0);
    let display_in_currency = sdata.get("display_in_currency").and_then(Value::as_bool) != Some(false);
    let top_up_link = sdata.get("top_up_link").and_then(Value::as_str).unwrap_or("");

    let base = session.base_url.trim_end_matches('/');
    let top_up_url = if top_up_link.is_empty() {
        format!("{}/topup", base)
    } else if top_up_link.starts_with("http://") || top_up_link.starts_with("https://") {
        top_up_link.to_string()
    } else {
        format!("{}/{}", base, top_up_link.trim_start_matches('/'))
    };

    Ok(AccountBalance {
        quota,
        used_quota,
        quota_per_unit,
        display_in_currency,
        top_up_url,
    })
}

/// Write the selected models into the runtime config as the account provider.
/// The sk- key is injected here (server-side) and never crosses to the
/// frontend.
#[tauri::command]
pub async fn account_save_models(
    input: SaveModelsInput,
    state: State<'_, AppState>,
) -> Result<StatusResult, AppError> {
    if input.models.is_empty() {
        return Err(AppError::InvalidRequest("未选择任何模型".to_string()));
    }
    let session = require_session()?;
    let api_base = account_api_base(&session.base_url);
    if api_base.is_empty() {
        return Err(AppError::InvalidRequest("缺少服务地址，请重新登录账户".to_string()));
    }
    let key = ensure_api_key(&session, input.token_id).await?;

    let (dash_base, token) = dashboard_state(&state)?;
    let config = read_config(&dash_base, token.as_deref()).await?;
    if !config.is_object() {
        return Err(AppError::ProxyError("配置格式异常，应为 JSON 对象".to_string()));
    }
    let merged = merge_account_provider(
        config,
        &api_base,
        &input.models,
        input.primary_model_id.as_deref(),
        &key,
    );
    write_config(&dash_base, token.as_deref(), &merged).await?;

    account_status().await
}

#[tauri::command]
pub async fn account_test_model(model_id: String) -> Result<TestModelResult, AppError> {
    let session = require_session()?;
    let api_base = account_api_base(&session.base_url);
    let key = match stored_key()? {
        Some(k) => k,
        None => ensure_api_key(&session, None).await?,
    };
    let started = std::time::Instant::now();
    let res = HTTP
        .post(format!("{}/chat/completions", api_base))
        .bearer_auth(&key)
        .json(&json!({
            "model": model_id,
            "messages": [{ "role": "user", "content": "ping" }],
            "max_tokens": 1,
            "stream": false,
        }))
        .send()
        .await?;
    let status = res.status().as_u16();
    let raw = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Ok(TestModelResult {
            ok: false,
            latency_ms: None,
            reply: None,
            error: Some(format!("HTTP {}: {}", status, snippet(&raw))),
        });
    }
    let latency = started.elapsed().as_millis() as u64;
    let reply = serde_json::from_str::<Value>(&raw)
        .ok()
        .and_then(|v| {
            v.get("choices")
                .and_then(|c| c.get(0))
                .and_then(|c| c.get("message"))
                .and_then(|m| m.get("content"))
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    Ok(TestModelResult {
        ok: true,
        latency_ms: Some(latency),
        reply,
        error: None,
    })
}

#[tauri::command]
pub async fn account_save_credentials(input: LoginInput) -> Result<(), AppError> {
    store_credentials(&input.base_url, &input.username, &input.password)
}

/// Report whether login credentials are saved, returning the username + base
/// url for prefilling the login form. The password is never returned.
#[tauri::command]
pub async fn account_has_saved_credentials() -> Result<SavedCredentialsInfo, AppError> {
    match load_credentials()? {
        Some((base_url, username, _password)) => Ok(SavedCredentialsInfo {
            has_saved: true,
            username: Some(username),
            base_url: if base_url.is_empty() { None } else { Some(base_url) },
        }),
        None => Ok(SavedCredentialsInfo {
            has_saved: false,
            username: None,
            base_url: None,
        }),
    }
}

/// Log in using credentials read from the OS keyring, so the password never
/// crosses the IPC boundary. Errors if nothing is saved.
#[tauri::command]
pub async fn account_login_saved() -> Result<AccountUser, AppError> {
    let (base_url, username, password) = load_credentials()?
        .ok_or_else(|| AppError::InvalidRequest("没有已保存的登录凭据".to_string()))?;
    do_login(&base_url, &username, &password).await
}

#[tauri::command]
pub async fn account_clear_credentials() -> Result<(), AppError> {
    secret_store::delete(&credentials_account())
}

#[tauri::command]
pub async fn account_logout() -> Result<StatusResult, AppError> {
    *SESSION.lock()? = None;
    secret_store::delete(&secret_account())?;
    account_status().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;

    #[test]
    fn account_api_base_appends_v1() {
        assert_eq!(account_api_base("https://api.huanxing.ai/"), "https://api.huanxing.ai/v1");
        assert_eq!(account_api_base("https://api.huanxing.ai"), "https://api.huanxing.ai/v1");
        assert_eq!(account_api_base("https://x.ai/v1"), "https://x.ai/v1");
        assert_eq!(account_api_base("https://x.ai/v2/"), "https://x.ai/v2");
        assert_eq!(account_api_base(""), "");
    }

    #[test]
    fn mask_key_keeps_prefix_and_tail() {
        assert_eq!(mask_key("sk-abcdefabcdef1234"), "sk-****1234");
        assert_eq!(mask_key("short"), "****");
    }

    #[serial_test::serial]
    #[test]
    fn credentials_round_trip_and_clear() {
        // Uses the in-memory secret_store backend on Linux CI.
        secret_store::delete(&credentials_account()).unwrap();
        assert!(load_credentials().unwrap().is_none());

        store_credentials("https://api.example.com/", "alice", "pw-secret").unwrap();
        let (base, user, pass) = load_credentials().unwrap().expect("saved");
        assert_eq!(base, "https://api.example.com/");
        assert_eq!(user, "alice");
        assert_eq!(pass, "pw-secret");

        secret_store::delete(&credentials_account()).unwrap();
        assert!(load_credentials().unwrap().is_none());
    }

    #[serial_test::serial]
    #[test]
    fn load_credentials_ignores_blank_username_or_password() {
        secret_store::set(&credentials_account(), r#"{"baseUrl":"x","username":"","password":"p"}"#)
            .unwrap();
        assert!(load_credentials().unwrap().is_none());
        secret_store::delete(&credentials_account()).unwrap();
    }

    #[test]
    fn ensure_sk_prefix_is_idempotent() {
        assert_eq!(ensure_sk_prefix("sk-abc"), "sk-abc");
        assert_eq!(ensure_sk_prefix("abc"), "sk-abc");
        assert_eq!(ensure_sk_prefix("  def "), "sk-def");
    }

    #[test]
    fn is_full_key_rejects_masked() {
        assert!(is_full_key("sk-abcdef123456"));
        assert!(!is_full_key("sk-abc...xyz"));
        assert!(!is_full_key("sk-abc****"));
        assert!(!is_full_key(""));
    }

    #[test]
    fn extract_session_cookie_finds_session_pair() {
        let cookies = vec![
            "other=1; Path=/".to_string(),
            "session=abc123; HttpOnly; Path=/".to_string(),
        ];
        assert_eq!(extract_session_cookie(&cookies), Some("session=abc123".to_string()));
        assert_eq!(extract_session_cookie(&["nope=1".to_string()]), None);
    }

    #[test]
    fn merge_account_provider_writes_custom_entry() {
        let config = json!({ "providers": {} });
        let merged = merge_account_provider(
            config,
            "https://api.huanxing.ai/v1",
            &["gpt-x".to_string(), "claude-y".to_string()],
            Some("gpt-x"),
            "sk-secret",
        );
        let id = account_provider_id();
        let entry = &merged["providers"][&id];
        assert_eq!(entry["base_url"], "https://api.huanxing.ai/v1");
        assert_eq!(entry["api_mode"], "chat_completions");
        assert_eq!(entry["transport"], "openai_chat");
        assert_eq!(entry["model"], "gpt-x");
        assert_eq!(entry["api_key"], "sk-secret");
        assert_eq!(entry["models"][0]["id"], "gpt-x");
        assert_eq!(entry["models"][1]["id"], "claude-y");
        // primary model also written to config.model
        assert_eq!(merged["model"]["provider"], id);
        assert_eq!(merged["model"]["model"], "gpt-x");
    }

    #[test]
    fn merge_account_provider_defaults_primary_to_first_model() {
        let merged = merge_account_provider(
            json!({}),
            "https://x/v1",
            &["a".to_string(), "b".to_string()],
            None,
            "sk-k",
        );
        let id = account_provider_id();
        assert_eq!(merged["providers"][&id]["model"], "a");
        // no primary_model_id → config.model is not overwritten
        assert!(merged.get("model").is_none());
    }
}
