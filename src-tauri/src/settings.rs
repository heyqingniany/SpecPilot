use keyring::v1::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, fs, path::PathBuf};
use tauri::Manager;

const CREDENTIAL_SERVICE: &str = "io.specpilot.desktop.api";
const PROVIDERS: [&str; 5] = ["deepseek", "openai", "openrouter", "siliconflow", "custom"];
const SEARCH_ENGINES: [&str; 4] = ["bing", "google", "duckduckgo", "baidu"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct StoredSettings {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    pub proxy_url: String,
    pub search_engine: String,
    pub remember_api_keys: bool,
}

impl Default for StoredSettings {
    fn default() -> Self {
        Self {
            provider: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-v4-flash".into(),
            proxy_url: String::new(),
            search_engine: "bing".into(),
            remember_api_keys: true,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CredentialsSaveRequest {
    pub credentials: HashMap<String, String>,
    pub remember: bool,
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("无法读取应用数据目录：{error}"))?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建应用数据目录：{error}"))?;
    Ok(directory.join("settings.json"))
}

fn validate_settings(settings: &StoredSettings) -> Result<(), String> {
    if !PROVIDERS.contains(&settings.provider.as_str()) {
        return Err("模型服务商设置无效".into());
    }
    if !SEARCH_ENGINES.contains(&settings.search_engine.as_str()) {
        return Err("在线手册搜索引擎设置无效".into());
    }
    if settings.base_url.len() > 2_048 || settings.model.len() > 256 || settings.proxy_url.len() > 2_048 {
        return Err("设置内容过长，无法保存".into());
    }
    Ok(())
}

fn credential_entry(provider: &str) -> Result<Entry, String> {
    if !PROVIDERS.contains(&provider) {
        return Err("模型服务商无效，拒绝访问凭据".into());
    }
    Entry::new(CREDENTIAL_SERVICE, provider)
        .map_err(|error| format!("无法访问系统凭据管理器：{error}"))
}

fn delete_entry(provider: &str) -> Result<(), String> {
    match credential_entry(provider)?.delete_credential() {
        Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("无法删除 {provider} 的已保存密钥：{error}")),
    }
}

pub fn load(app: &tauri::AppHandle) -> Result<StoredSettings, String> {
    let path = settings_path(app)?;
    if !path.exists() {
        return Ok(StoredSettings::default());
    }
    let contents = fs::read_to_string(path).map_err(|error| format!("无法读取已保存设置：{error}"))?;
    let settings: StoredSettings =
        serde_json::from_str(&contents).map_err(|error| format!("已保存设置格式损坏：{error}"))?;
    validate_settings(&settings)?;
    Ok(settings)
}

pub fn save(app: &tauri::AppHandle, settings: StoredSettings) -> Result<(), String> {
    validate_settings(&settings)?;
    let contents = serde_json::to_string_pretty(&settings)
        .map_err(|error| format!("无法序列化应用设置：{error}"))?;
    fs::write(settings_path(app)?, contents).map_err(|error| format!("无法保存应用设置：{error}"))
}

pub fn load_credentials() -> Result<HashMap<String, String>, String> {
    let mut credentials = HashMap::new();
    for provider in PROVIDERS {
        match credential_entry(provider)?.get_password() {
            Ok(value) if !value.is_empty() => {
                credentials.insert(provider.to_string(), value);
            }
            Ok(_) | Err(KeyringError::NoEntry) => {}
            Err(error) => return Err(format!("无法读取 {provider} 的已保存密钥：{error}")),
        }
    }
    Ok(credentials)
}

pub fn save_credentials(request: CredentialsSaveRequest) -> Result<(), String> {
    if !request.remember {
        return clear_credentials();
    }
    for (provider, value) in request.credentials {
        let value = value.trim();
        if value.len() > 8_192 {
            return Err(format!("{provider} 的 API Key 过长，无法保存"));
        }
        if value.is_empty() {
            delete_entry(&provider)?;
        } else {
            credential_entry(&provider)?
                .set_password(value)
                .map_err(|error| format!("无法保存 {provider} 的 API Key：{error}"))?;
        }
    }
    Ok(())
}

pub fn clear_credentials() -> Result<(), String> {
    for provider in PROVIDERS {
        delete_entry(provider)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_valid() {
        validate_settings(&StoredSettings::default()).unwrap();
    }

    #[test]
    fn rejects_unknown_provider_and_search_engine() {
        let mut settings = StoredSettings::default();
        settings.provider = "unknown".into();
        assert!(validate_settings(&settings).is_err());
        settings.provider = "deepseek".into();
        settings.search_engine = "unknown".into();
        assert!(validate_settings(&settings).is_err());
    }

    #[test]
    #[cfg(target_os = "windows")]
    #[ignore = "writes and immediately removes a temporary Windows credential"]
    fn windows_credential_manager_round_trip() {
        let entry = Entry::new("io.specpilot.desktop.test", "credential-round-trip").unwrap();
        let _ = entry.delete_credential();
        let result = (|| {
            entry.set_password("specpilot-test-secret")?;
            assert_eq!(entry.get_password()?, "specpilot-test-secret");
            Ok::<(), KeyringError>(())
        })();
        let cleanup = entry.delete_credential();
        result.unwrap();
        cleanup.unwrap();
    }
}
