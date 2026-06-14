//! Desktop shell update support.
//!
//! The desktop app uses the landing-site `latest.json` as the public update
//! manifest. Checking an update only reads that manifest; installing an update
//! re-reads it, selects the current platform installer, downloads it, verifies
//! SHA-256 when available, and opens the installer with the OS.

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::brand_generated::{
    BRAND_APP_NAME, BRAND_UPDATE_MANIFEST_URL as DESKTOP_UPDATE_MANIFEST_URL,
};

const DESKTOP_UPDATE_TIMEOUT: Duration = Duration::from_secs(10);
const DESKTOP_INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);

static DESKTOP_UPDATE_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DESKTOP_UPDATE_TIMEOUT)
        .user_agent("hermes-agent-cn-desktop-update-check")
        .build()
        .expect("valid desktop update HTTP client")
});

static DESKTOP_INSTALL_HTTP_CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(DESKTOP_INSTALL_TIMEOUT)
        .user_agent("hermes-agent-cn-desktop-update-install")
        .build()
        .expect("valid desktop update install HTTP client")
});

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateAsset {
    pub label: Option<String>,
    pub platform: Option<String>,
    pub file_name: Option<String>,
    pub size: Option<u64>,
    pub sha256: Option<String>,
    pub url: Option<String>,
    pub versioned_url: Option<String>,
    pub source_url: Option<String>,
    pub baidu_pan_url: Option<String>,
    pub baidu_pan_code: Option<String>,
    pub quark_pan_url: Option<String>,
    pub quark_pan_code: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateManifest {
    pub repository: Option<String>,
    pub version: Option<String>,
    pub semver: Option<String>,
    pub published_at: Option<String>,
    pub source_url: Option<String>,
    pub updated_at: Option<String>,
    pub assets: Option<BTreeMap<String, DesktopUpdateAsset>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopUpdateManifestFetchResult {
    pub ok: bool,
    pub manifest_url: String,
    pub manifest: Option<DesktopUpdateManifest>,
    pub error: Option<String>,
    pub checked_at_ms: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopInstallUpdateResult {
    pub ok: bool,
    pub manifest_url: String,
    pub asset: Option<DesktopUpdateAsset>,
    pub file_path: Option<String>,
    pub bytes_downloaded: u64,
    pub bytes_total: Option<u64>,
    pub launched: bool,
    pub error: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

async fn fetch_desktop_update_manifest_from(
    client: &reqwest::Client,
    manifest_url: &str,
) -> DesktopUpdateManifestFetchResult {
    let checked_at_ms = now_ms();
    let response = match client
        .get(manifest_url)
        .header(reqwest::header::ACCEPT, "application/json")
        .send()
        .await
    {
        Ok(response) => response,
        Err(error) => {
            return DesktopUpdateManifestFetchResult {
                ok: false,
                manifest_url: manifest_url.to_string(),
                manifest: None,
                error: Some(format!("桌面端更新清单请求失败：{}", error)),
                checked_at_ms,
            }
        }
    };

    let status = response.status();
    if !status.is_success() {
        return DesktopUpdateManifestFetchResult {
            ok: false,
            manifest_url: manifest_url.to_string(),
            manifest: None,
            error: Some(format!("桌面端更新清单返回 HTTP {}", status.as_u16())),
            checked_at_ms,
        };
    }

    match response.json::<DesktopUpdateManifest>().await {
        Ok(manifest) => DesktopUpdateManifestFetchResult {
            ok: true,
            manifest_url: manifest_url.to_string(),
            manifest: Some(manifest),
            error: None,
            checked_at_ms,
        },
        Err(error) => DesktopUpdateManifestFetchResult {
            ok: false,
            manifest_url: manifest_url.to_string(),
            manifest: None,
            error: Some(format!("桌面端更新清单解析失败：{}", error)),
            checked_at_ms,
        },
    }
}

#[tauri::command]
pub async fn desktop_check_update() -> DesktopUpdateManifestFetchResult {
    fetch_desktop_update_manifest_from(&DESKTOP_UPDATE_HTTP_CLIENT, DESKTOP_UPDATE_MANIFEST_URL)
        .await
}

#[tauri::command]
pub async fn desktop_install_update() -> DesktopInstallUpdateResult {
    install_desktop_update_from(
        &DESKTOP_UPDATE_HTTP_CLIENT,
        &DESKTOP_INSTALL_HTTP_CLIENT,
        DESKTOP_UPDATE_MANIFEST_URL,
    )
    .await
}

async fn install_desktop_update_from(
    manifest_client: &reqwest::Client,
    download_client: &reqwest::Client,
    manifest_url: &str,
) -> DesktopInstallUpdateResult {
    let fetched = fetch_desktop_update_manifest_from(manifest_client, manifest_url).await;
    if !fetched.ok {
        return DesktopInstallUpdateResult {
            ok: false,
            manifest_url: fetched.manifest_url,
            asset: None,
            file_path: None,
            bytes_downloaded: 0,
            bytes_total: None,
            launched: false,
            error: fetched.error,
        };
    }

    let Some(manifest) = fetched.manifest else {
        return install_error(manifest_url, None, 0, None, "桌面端更新清单为空");
    };
    let Some(asset) = select_platform_asset(&manifest) else {
        return install_error(
            manifest_url,
            None,
            0,
            None,
            "更新清单中没有当前系统可用的安装包",
        );
    };
    let Some(download_url) = asset_download_url(&asset) else {
        return install_error(manifest_url, Some(asset), 0, None, "安装包缺少下载地址");
    };

    let raw_file_name = asset
        .file_name
        .clone()
        .or_else(|| url_file_name(&download_url))
        .unwrap_or_else(|| default_installer_file_name().to_string());
    let file_name = safe_file_name(&raw_file_name);
    let dir = desktop_update_download_dir();
    if let Err(err) = fs::create_dir_all(&dir) {
        return install_error(
            manifest_url,
            Some(asset),
            0,
            None,
            &format!("创建下载目录失败：{}", err),
        );
    }
    let file_path = dir.join(file_name);

    let downloaded = match download_installer(download_client, &download_url, &file_path).await {
        Ok(downloaded) => downloaded,
        Err(err) => {
            return install_error(
                manifest_url,
                Some(asset),
                err.bytes_downloaded,
                err.bytes_total,
                &err.message,
            )
        }
    };

    if let Some(expected) = asset
        .sha256
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_string)
    {
        match file_sha256(&file_path) {
            Ok(actual) if actual.eq_ignore_ascii_case(&expected) => {}
            Ok(actual) => {
                return install_error(
                    manifest_url,
                    Some(asset),
                    downloaded.bytes_downloaded,
                    downloaded.bytes_total,
                    &format!("安装包 SHA-256 校验失败：期望 {}，实际 {}", expected, actual),
                )
            }
            Err(err) => {
                return install_error(
                    manifest_url,
                    Some(asset),
                    downloaded.bytes_downloaded,
                    downloaded.bytes_total,
                    &format!("读取安装包校验失败：{}", err),
                )
            }
        }
    }

    if let Err(err) = open::that(&file_path) {
        return install_error(
            manifest_url,
            Some(asset),
            downloaded.bytes_downloaded,
            downloaded.bytes_total,
            &format!("启动安装包失败：{}", err),
        );
    }

    DesktopInstallUpdateResult {
        ok: true,
        manifest_url: manifest_url.to_string(),
        asset: Some(asset),
        file_path: Some(file_path.to_string_lossy().to_string()),
        bytes_downloaded: downloaded.bytes_downloaded,
        bytes_total: downloaded.bytes_total,
        launched: true,
        error: None,
    }
}

fn install_error(
    manifest_url: &str,
    asset: Option<DesktopUpdateAsset>,
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
    message: &str,
) -> DesktopInstallUpdateResult {
    DesktopInstallUpdateResult {
        ok: false,
        manifest_url: manifest_url.to_string(),
        asset,
        file_path: None,
        bytes_downloaded,
        bytes_total,
        launched: false,
        error: Some(message.to_string()),
    }
}

struct DownloadedInstaller {
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
}

struct DownloadInstallError {
    message: String,
    bytes_downloaded: u64,
    bytes_total: Option<u64>,
}

async fn download_installer(
    client: &reqwest::Client,
    url: &str,
    target: &Path,
) -> Result<DownloadedInstaller, DownloadInstallError> {
    let response = client.get(url).send().await.map_err(|err| DownloadInstallError {
        message: format!("安装包下载请求失败：{}", err),
        bytes_downloaded: 0,
        bytes_total: None,
    })?;
    let status = response.status();
    let bytes_total = response.content_length();
    if !status.is_success() {
        return Err(DownloadInstallError {
            message: format!("安装包下载返回 HTTP {}", status.as_u16()),
            bytes_downloaded: 0,
            bytes_total,
        });
    }

    let temp_path = target.with_extension(format!(
        "{}download",
        target
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!("{ext}."))
            .unwrap_or_default()
    ));
    let mut file = File::create(&temp_path).map_err(|err| DownloadInstallError {
        message: format!("创建安装包文件失败：{}", err),
        bytes_downloaded: 0,
        bytes_total,
    })?;
    let mut bytes_downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|err| DownloadInstallError {
            message: format!("安装包下载中断：{}", err),
            bytes_downloaded,
            bytes_total,
        })?;
        file.write_all(&chunk).map_err(|err| DownloadInstallError {
            message: format!("写入安装包失败：{}", err),
            bytes_downloaded,
            bytes_total,
        })?;
        bytes_downloaded = bytes_downloaded.saturating_add(chunk.len() as u64);
    }
    file.flush().map_err(|err| DownloadInstallError {
        message: format!("刷新安装包文件失败：{}", err),
        bytes_downloaded,
        bytes_total,
    })?;
    drop(file);
    fs::rename(&temp_path, target).map_err(|err| DownloadInstallError {
        message: format!("保存安装包失败：{}", err),
        bytes_downloaded,
        bytes_total,
    })?;
    Ok(DownloadedInstaller {
        bytes_downloaded,
        bytes_total,
    })
}

fn desktop_update_download_dir() -> PathBuf {
    dirs::download_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join(format!("{} Updates", BRAND_APP_NAME))
}

fn safe_file_name(input: &str) -> String {
    let cleaned = input
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        default_installer_file_name().to_string()
    } else {
        trimmed.to_string()
    }
}

fn default_installer_file_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "desktop-update-setup.exe"
    } else if cfg!(target_os = "macos") {
        "desktop-update.dmg"
    } else {
        "desktop-update"
    }
}

fn url_file_name(raw: &str) -> Option<String> {
    let url = url::Url::parse(raw).ok()?;
    url.path_segments()
        .and_then(|segments| segments.filter(|s| !s.is_empty()).last())
        .map(urlencoding::decode)
        .and_then(Result::ok)
        .map(|cow| cow.into_owned())
}

fn asset_download_url(asset: &DesktopUpdateAsset) -> Option<String> {
    [
        asset.versioned_url.as_deref(),
        asset.url.as_deref(),
        asset.source_url.as_deref(),
    ]
    .into_iter()
    .flatten()
    .map(str::trim)
    .find(|url| url.starts_with("https://") || url.starts_with("http://"))
    .map(str::to_string)
}

fn select_platform_asset(manifest: &DesktopUpdateManifest) -> Option<DesktopUpdateAsset> {
    let assets = manifest.assets.as_ref()?;
    assets
        .iter()
        .filter_map(|(key, asset)| {
            let score = platform_asset_score(key, asset);
            (score > 0).then_some((score, asset.clone()))
        })
        .max_by_key(|(score, _)| *score)
        .map(|(_, asset)| asset)
}

fn platform_asset_score(key: &str, asset: &DesktopUpdateAsset) -> i32 {
    let mut haystack = vec![
        key.to_ascii_lowercase(),
        asset.platform.clone().unwrap_or_default().to_ascii_lowercase(),
        asset.file_name.clone().unwrap_or_default().to_ascii_lowercase(),
        asset.label.clone().unwrap_or_default().to_ascii_lowercase(),
    ]
    .join(" ");

    if cfg!(target_os = "windows") {
        if haystack.contains("windows") || haystack.contains("win32") {
            return 100 + if haystack.contains("x64") { 10 } else { 0 };
        }
        if haystack.ends_with(".exe") || haystack.contains("setup.exe") {
            return 70;
        }
    } else if cfg!(target_os = "macos") {
        let arch_match = if cfg!(target_arch = "aarch64") {
            haystack.contains("arm64") || haystack.contains("aarch64") || haystack.contains("apple")
        } else {
            haystack.contains("x64") || haystack.contains("x86_64") || haystack.contains("intel")
        };
        if (haystack.contains("macos") || haystack.contains("darwin")) && arch_match {
            return 110;
        }
        if haystack.contains("macos") || haystack.contains("darwin") || haystack.ends_with(".dmg")
        {
            return 80;
        }
    }
    haystack.clear();
    0
}

fn file_sha256(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0_u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn test_client(timeout: Duration) -> reqwest::Client {
        reqwest::Client::builder().timeout(timeout).build().unwrap()
    }

    #[tokio::test]
    async fn fetch_manifest_successfully() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "repository": "example/desktop",
                "version": "v0.3.1",
                "semver": "0.3.1",
                "assets": {
                    "windows": {
                        "label": "Windows 安装包",
                        "fileName": "Desktop_0.3.1_x64-setup.exe",
                        "url": "https://desktop.example.com/download/windows/latest.exe"
                    }
                }
            })))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(result.ok, "{:?}", result.error);
        let manifest = result.manifest.expect("manifest");
        assert_eq!(manifest.semver.as_deref(), Some("0.3.1"));
        assert_eq!(manifest.version.as_deref(), Some("v0.3.1"));
        assert!(manifest.assets.unwrap().contains_key("windows"));
    }

    #[tokio::test]
    async fn reports_http_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("HTTP 404"));
    }

    #[tokio::test]
    async fn reports_invalid_json() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(ResponseTemplate::new(200).set_body_string("{"))
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_secs(1)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("解析失败"));
    }

    #[tokio::test]
    async fn reports_timeout() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/latest.json"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_delay(Duration::from_millis(120))
                    .set_body_json(serde_json::json!({ "semver": "0.3.1" })),
            )
            .mount(&server)
            .await;

        let result = fetch_desktop_update_manifest_from(
            &test_client(Duration::from_millis(20)),
            &format!("{}/latest.json", server.uri()),
        )
        .await;

        assert!(!result.ok);
        assert!(result.error.unwrap_or_default().contains("请求失败"));
    }

    #[test]
    fn safe_file_name_removes_path_separators() {
        assert_eq!(safe_file_name("..\\bad/name?.exe"), "_bad_name_.exe");
        assert_eq!(safe_file_name("..."), default_installer_file_name());
    }

    #[test]
    fn url_file_name_decodes_last_segment() {
        assert_eq!(
            url_file_name("https://example.com/download/Hermes%20Setup.exe").as_deref(),
            Some("Hermes Setup.exe")
        );
    }

    #[test]
    fn platform_asset_score_matches_current_platform() {
        let windows = DesktopUpdateAsset {
            file_name: Some("Hermes_0.3.8_x64-setup.exe".into()),
            ..Default::default()
        };
        let mac = DesktopUpdateAsset {
            file_name: Some("Hermes_0.3.8_aarch64.dmg".into()),
            platform: Some("macos-arm64".into()),
            ..Default::default()
        };
        if cfg!(target_os = "windows") {
            assert!(platform_asset_score("windows", &windows) > platform_asset_score("macos", &mac));
        } else if cfg!(target_os = "macos") {
            assert!(platform_asset_score("macos", &mac) > platform_asset_score("windows", &windows));
        }
    }
}
