mod library;
mod manual_search;
mod settings;

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::webview::{DownloadEvent, NewWindowResponse, WebviewBuilder};
use tauri::{Emitter, LogicalPosition, LogicalSize, Manager, State, WebviewUrl};

#[derive(Deserialize)]
struct ModelMessage {
    role: String,
    content: String,
}

#[derive(Deserialize)]
struct ModelRequest {
    api_key: String,
    base_url: String,
    model: String,
    messages: Vec<ModelMessage>,
    json_mode: bool,
    proxy_url: String,
}

#[derive(Serialize)]
struct ApiMessage<'a> {
    role: &'a str,
    content: &'a str,
}

#[derive(Deserialize)]
struct ApiResponse {
    choices: Vec<ApiChoice>,
}

#[derive(Deserialize)]
struct ApiChoice {
    message: ApiChoiceMessage,
}

#[derive(Deserialize)]
struct ApiChoiceMessage {
    content: Option<String>,
}

#[derive(Deserialize)]
struct DownloadPdfRequest {
    url: String,
    proxy_url: String,
}

#[derive(Serialize)]
struct DownloadPdfResponse {
    file_name: String,
    data_base64: String,
}

#[derive(Deserialize)]
struct NetworkTestRequest {
    url: String,
    proxy_url: String,
}

#[derive(Serialize)]
struct NetworkTestResponse {
    reachable: bool,
    status: Option<u16>,
    message: String,
}

#[derive(Deserialize)]
struct ManualPanelBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Default)]
struct AppNetworkState {
    manual_proxy: Mutex<String>,
}

const SAME_TAB_BROWSER_SCRIPT: &str = r#"
(() => {
  document.addEventListener('click', (event) => {
    let element = event.target;
    while (element && element.tagName !== 'A') element = element.parentElement;
    if (!element || !element.href) return;
    const target = element.getAttribute('target');
    if (target && target.toLowerCase() !== '_self') element.setAttribute('target', '_self');
  }, true);

  window.open = (url) => {
    if (typeof url === 'string' && url) window.location.assign(url);
    return window;
  };
})();
"#;

fn normalize_proxy(input: &str) -> Result<Option<reqwest::Url>, String> {
    let input = input.trim();
    if input.is_empty() {
        return Ok(None);
    }
    let value = if input.contains("://") {
        input.to_string()
    } else {
        format!("http://{input}")
    };
    let url = reqwest::Url::parse(&value).map_err(|_| "代理地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "socks5") {
        return Err("代理仅支持 http:// 或 socks5://".into());
    }
    if url.host_str().is_none() {
        return Err("代理地址缺少主机名或 IP".into());
    }
    Ok(Some(url))
}

fn build_http_client(proxy_url: &str, timeout_seconds: u64) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::limited(8))
        .timeout(Duration::from_secs(timeout_seconds))
        .user_agent("SpecPilot/0.7.2");
    if let Some(proxy) = normalize_proxy(proxy_url)? {
        builder = builder.proxy(
            reqwest::Proxy::all(proxy.as_str())
                .map_err(|error| format!("无法配置代理：{error}"))?,
        );
    }
    builder
        .build()
        .map_err(|error| format!("无法创建网络客户端：{error}"))
}

fn chat_endpoint(base_url: &str) -> Result<reqwest::Url, String> {
    let raw = base_url.trim().trim_end_matches('/');
    if raw.is_empty() {
        return Err("请填写 API Base URL".into());
    }
    let endpoint = if raw.ends_with("/chat/completions") {
        raw.to_string()
    } else {
        format!("{raw}/chat/completions")
    };
    let url = reqwest::Url::parse(&endpoint).map_err(|_| "API Base URL 格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("API Base URL 仅支持 http:// 或 https://".into());
    }
    Ok(url)
}

fn is_pdf_url(url: &reqwest::Url) -> bool {
    let path = url.path().to_ascii_lowercase();
    path.ends_with(".pdf") || path.contains(".pdf/")
}

fn defer_main_event(
    app: &tauri::AppHandle,
    event: &'static str,
    payload: String,
    focus_main: bool,
) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.emit(event, payload);
            if focus_main {
                let _ = main.show();
                let _ = main.set_focus();
            }
        }
    });
}

fn send_pdf_to_reader(app: &tauri::AppHandle, url: &reqwest::Url) {
    defer_main_event(
        app,
        "manual-pdf-found",
        url.as_str().to_owned(),
        true,
    );
}

fn manual_target(input: &str, search_engine: &str) -> Result<reqwest::Url, String> {
    let input = input.trim();
    if input.is_empty() {
        return Err("请输入芯片型号、手册关键词或网页地址".into());
    }

    if let Ok(url) = reqwest::Url::parse(input) {
        if matches!(url.scheme(), "http" | "https") {
            return Ok(url);
        }
    }
    if !input.contains(char::is_whitespace) && input.contains('.') {
        if let Ok(url) = reqwest::Url::parse(&format!("https://{input}")) {
            return Ok(url);
        }
    }

    let search = format!("{input} datasheet PDF");
    let (base, key) = match search_engine {
        "google" => ("https://www.google.com/search", "q"),
        "duckduckgo" => ("https://duckduckgo.com/", "q"),
        "baidu" => ("https://www.baidu.com/s", "wd"),
        _ => ("https://www.bing.com/search", "q"),
    };
    reqwest::Url::parse_with_params(base, &[(key, search)])
        .map_err(|error| format!("无法创建搜索地址：{error}"))
}

fn apply_manual_bounds(webview: &tauri::Webview, bounds: &ManualPanelBounds) -> Result<(), String> {
    let x = bounds.x.max(0.0);
    let y = bounds.y.max(0.0);
    let width = bounds.width.max(1.0);
    let height = bounds.height.max(1.0);
    webview
        .set_position(LogicalPosition::new(x, y))
        .map_err(|error| format!("无法定位在线手册区域：{error}"))?;
    webview
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| format!("无法调整在线手册区域：{error}"))?;
    Ok(())
}

#[tauri::command]
async fn manual_panel_create(
    app: tauri::AppHandle,
    state: State<'_, AppNetworkState>,
    bounds: ManualPanelBounds,
    proxy_url: String,
) -> Result<(), String> {
    let normalized_proxy = normalize_proxy(&proxy_url)?
        .map(|url| url.to_string())
        .unwrap_or_default();
    let proxy_changed = {
        let configured = state
            .manual_proxy
            .lock()
            .map_err(|_| "无法读取代理配置".to_string())?;
        app.get_webview("manual-panel").is_some() && *configured != normalized_proxy
    };

    if proxy_changed {
        if let Some(webview) = app.get_webview("manual-panel") {
            webview
                .close()
                .map_err(|error| format!("无法重新创建在线手册区域：{error}"))?;
        }
    } else if let Some(webview) = app.get_webview("manual-panel") {
        apply_manual_bounds(&webview, &bounds)?;
        webview
            .show()
            .map_err(|error| format!("无法显示在线手册：{error}"))?;
        return Ok(());
    }

    let main = app
        .get_window("main")
        .ok_or_else(|| "找不到 SpecPilot 主窗口".to_string())?;
    let navigation_app = app.clone();
    let download_app = app.clone();
    let popup_app = app.clone();
    let page_app = app.clone();
    let mut builder = WebviewBuilder::new(
        "manual-panel",
        WebviewUrl::App("manual-start.html".into()),
    )
    .initialization_script_for_all_frames(SAME_TAB_BROWSER_SCRIPT)
    .on_navigation(move |url| {
        if matches!(url.scheme(), "http" | "https") && is_pdf_url(url) {
            send_pdf_to_reader(&navigation_app, url);
            return false;
        }
        matches!(url.scheme(), "http" | "https" | "tauri")
    })
    .on_new_window(move |url, _features| {
        if matches!(url.scheme(), "http" | "https") {
            if is_pdf_url(&url) {
                send_pdf_to_reader(&popup_app, &url);
            } else {
                let navigation_app = popup_app.clone();
                std::thread::spawn(move || {
                    // Let WebView2 finish NewWindowRequested before navigating the
                    // existing view. This behaves like a browser's same-tab policy.
                    std::thread::sleep(Duration::from_millis(50));
                    if let Some(webview) = navigation_app.get_webview("manual-panel") {
                        let _ = webview.navigate(url);
                    }
                });
            }
        }
        NewWindowResponse::Deny
    })
    .on_download(move |_webview, event| {
        if let DownloadEvent::Requested { url, .. } = event {
            send_pdf_to_reader(&download_app, &url);
            return false;
        }
        true
    })
    .on_page_load(move |_webview, payload| {
        let url = payload.url();
        if matches!(url.scheme(), "http" | "https") && url.host_str() != Some("tauri.localhost") {
            defer_main_event(
                &page_app,
                "manual-page-changed",
                url.as_str().to_owned(),
                false,
            );
        }
    });

    if let Some(proxy) = normalize_proxy(&normalized_proxy)? {
        builder = builder.proxy_url(proxy);
    }

    let webview = main
        .add_child(
            builder,
            LogicalPosition::new(bounds.x.max(0.0), bounds.y.max(0.0)),
            LogicalSize::new(bounds.width.max(1.0), bounds.height.max(1.0)),
        )
        .map_err(|error| format!("无法创建右侧在线手册：{error}"))?;
    webview
        .show()
        .map_err(|error| format!("无法显示在线手册：{error}"))?;
    *state
        .manual_proxy
        .lock()
        .map_err(|_| "无法保存代理配置".to_string())? = normalized_proxy;
    Ok(())
}

#[tauri::command]
async fn manual_panel_set_bounds(app: tauri::AppHandle, bounds: ManualPanelBounds) -> Result<(), String> {
    if let Some(webview) = app.get_webview("manual-panel") {
        apply_manual_bounds(&webview, &bounds)?;
    }
    Ok(())
}

#[tauri::command]
async fn manual_panel_visibility(app: tauri::AppHandle, visible: bool) -> Result<(), String> {
    if let Some(webview) = app.get_webview("manual-panel") {
        if visible {
            webview.show()
        } else {
            webview.hide()
        }
        .map_err(|error| format!("无法切换在线手册：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
async fn manual_panel_navigate(
    app: tauri::AppHandle,
    query: String,
    search_engine: String,
) -> Result<(), String> {
    let target = manual_target(&query, &search_engine)?;
    let webview = app
        .get_webview("manual-panel")
        .ok_or_else(|| "在线手册区域尚未就绪".to_string())?;
    webview
        .navigate(target)
        .map_err(|error| format!("无法打开网页：{error}"))
}

#[tauri::command]
async fn manual_panel_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    let webview = app
        .get_webview("manual-panel")
        .ok_or_else(|| "在线手册区域尚未就绪".to_string())?;
    match action.as_str() {
        "back" => webview.eval("history.back()"),
        "forward" => webview.eval("history.forward()"),
        "reload" => webview.reload(),
        _ => return Err("不支持的浏览器操作".into()),
    }
    .map_err(|error| format!("浏览器操作失败：{error}"))
}

#[tauri::command]
async fn manual_panel_current_url(app: tauri::AppHandle) -> Result<String, String> {
    let webview = app
        .get_webview("manual-panel")
        .ok_or_else(|| "在线手册区域尚未就绪".to_string())?;
    let url = webview
        .url()
        .map_err(|error| format!("无法读取当前网址：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str() == Some("tauri.localhost") {
        return Err("请先打开 PDF 直链；普通说明网页不能直接当作 PDF 导入".into());
    }
    Ok(url.to_string())
}

#[tauri::command]
async fn manual_panel_destroy(
    app: tauri::AppHandle,
    state: State<'_, AppNetworkState>,
) -> Result<(), String> {
    if let Some(webview) = app.get_webview("manual-panel") {
        webview
            .close()
            .map_err(|error| format!("无法重置在线手册：{error}"))?;
    }
    *state
        .manual_proxy
        .lock()
        .map_err(|_| "无法重置代理状态".to_string())? = String::new();
    Ok(())
}

#[tauri::command]
async fn download_pdf(request: DownloadPdfRequest) -> Result<DownloadPdfResponse, String> {
    const MAX_PDF_BYTES: u64 = 100 * 1024 * 1024;
    let url = reqwest::Url::parse(request.url.trim()).map_err(|_| "PDF 地址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("只支持 http:// 或 https:// PDF 地址".into());
    }

    let response = build_http_client(&request.proxy_url, 90)?
        .get(url.clone())
        .send()
        .await
        .map_err(|error| format!("无法下载 PDF：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载失败，服务器返回 {status}"));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_PDF_BYTES)
    {
        return Err("PDF 超过 100 MB 安全上限".into());
    }
    let final_url = response.url().clone();
    let disposition_name = response
        .headers()
        .get(reqwest::header::CONTENT_DISPOSITION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value
                .split(';')
                .find_map(|part| part.trim().strip_prefix("filename="))
        })
        .map(|value| value.trim_matches(['"', '\'']).to_string());
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("读取 PDF 下载内容失败：{error}"))?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err("PDF 超过 100 MB 安全上限".into());
    }
    if !bytes.starts_with(b"%PDF-") {
        return Err("该地址返回的不是 PDF 文件，请使用真正的 PDF 直链".into());
    }

    let url_name = final_url
        .path_segments()
        .and_then(|segments| segments.last())
        .filter(|name| !name.is_empty())
        .map(str::to_owned);
    let mut file_name = disposition_name
        .or(url_name)
        .unwrap_or_else(|| "downloaded-manual.pdf".into());
    file_name = file_name
        .chars()
        .map(|character| {
            if "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect();
    if !file_name.to_lowercase().ends_with(".pdf") {
        file_name.push_str(".pdf");
    }
    Ok(DownloadPdfResponse {
        file_name,
        data_base64: BASE64.encode(bytes),
    })
}

#[tauri::command]
async fn network_test(request: NetworkTestRequest) -> Result<NetworkTestResponse, String> {
    let url = reqwest::Url::parse(request.url.trim()).map_err(|_| "测试网址格式无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("测试网址仅支持 http:// 或 https://".into());
    }
    match build_http_client(&request.proxy_url, 15)?.get(url).send().await {
        Ok(response) => Ok(NetworkTestResponse {
            reachable: true,
            status: Some(response.status().as_u16()),
            message: format!("网络可达，HTTP {}", response.status().as_u16()),
        }),
        Err(error) => Ok(NetworkTestResponse {
            reachable: false,
            status: None,
            message: format!("连接失败：{error}"),
        }),
    }
}

#[tauri::command]
async fn search_manuals(
    request: manual_search::ManualSearchRequest,
) -> Result<Vec<manual_search::ManualCandidate>, String> {
    manual_search::search_manuals(request).await
}

#[tauri::command]
async fn library_save_document(
    app: tauri::AppHandle,
    request: library::LibrarySaveRequest,
) -> Result<library::LibraryDocument, String> {
    tauri::async_runtime::spawn_blocking(move || library::save_document(&app, request))
        .await
        .map_err(|error| format!("文档库后台任务失败：{error}"))?
}

#[tauri::command]
async fn library_list_documents(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<library::LibraryDocument>, String> {
    tauri::async_runtime::spawn_blocking(move || library::list_documents(&app, &query))
        .await
        .map_err(|error| format!("文档库后台任务失败：{error}"))?
}

#[tauri::command]
async fn library_load_document(
    app: tauri::AppHandle,
    id: i64,
) -> Result<library::LibraryLoadedDocument, String> {
    tauri::async_runtime::spawn_blocking(move || library::load_document(&app, id))
        .await
        .map_err(|error| format!("文档库后台任务失败：{error}"))?
}

#[tauri::command]
async fn library_update_document(
    app: tauri::AppHandle,
    request: library::LibraryUpdateRequest,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || library::update_document(&app, request))
        .await
        .map_err(|error| format!("文档库后台任务失败：{error}"))?
}

#[tauri::command]
async fn library_delete_document(app: tauri::AppHandle, id: i64) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || library::delete_document(&app, id))
        .await
        .map_err(|error| format!("文档库后台任务失败：{error}"))?
}

#[tauri::command]
async fn app_settings_load(app: tauri::AppHandle) -> Result<settings::StoredSettings, String> {
    tauri::async_runtime::spawn_blocking(move || settings::load(&app))
        .await
        .map_err(|error| format!("设置读取后台任务失败：{error}"))?
}

#[tauri::command]
async fn app_settings_save(
    app: tauri::AppHandle,
    settings: settings::StoredSettings,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::save(&app, settings))
        .await
        .map_err(|error| format!("设置保存后台任务失败：{error}"))?
}

#[tauri::command]
async fn credentials_load() -> Result<std::collections::HashMap<String, String>, String> {
    tauri::async_runtime::spawn_blocking(settings::load_credentials)
        .await
        .map_err(|error| format!("凭据读取后台任务失败：{error}"))?
}

#[tauri::command]
async fn credentials_save(request: settings::CredentialsSaveRequest) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || settings::save_credentials(request))
        .await
        .map_err(|error| format!("凭据保存后台任务失败：{error}"))?
}

#[tauri::command]
async fn credentials_clear() -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(settings::clear_credentials)
        .await
        .map_err(|error| format!("凭据清除后台任务失败：{error}"))?
}

#[tauri::command]
async fn model_chat(request: ModelRequest) -> Result<String, String> {
    if request.api_key.trim().is_empty() {
        return Err("请先填写所选服务商的 API Key".into());
    }
    if request.model.trim().is_empty() {
        return Err("请填写模型名称".into());
    }

    let messages: Vec<ApiMessage<'_>> = request
        .messages
        .iter()
        .map(|message| ApiMessage {
            role: &message.role,
            content: &message.content,
        })
        .collect();
    let mut payload = serde_json::json!({
        "model": request.model,
        "messages": messages,
        "max_tokens": 1800
    });
    if request.json_mode {
        payload["response_format"] = serde_json::json!({ "type": "json_object" });
    }

    let endpoint = chat_endpoint(&request.base_url)?;
    let client = build_http_client(&request.proxy_url, 90)?;
    let response = client
        .post(endpoint.clone())
        .bearer_auth(request.api_key.trim())
        .header("X-Title", "SpecPilot")
        .json(&payload)
        .send()
        .await
        .map_err(|error| format!("无法连接模型服务：{error}"))?;

    let mut status = response.status();
    let mut response_text = response
        .text()
        .await
        .map_err(|error| format!("读取模型响应失败：{error}"))?;
    if request.json_mode
        && matches!(status.as_u16(), 400 | 422)
        && payload.as_object_mut().is_some_and(|body| body.remove("response_format").is_some())
    {
        let retry = client
            .post(endpoint)
            .bearer_auth(request.api_key.trim())
            .header("X-Title", "SpecPilot")
            .json(&payload)
            .send()
            .await
            .map_err(|error| format!("模型服务不支持 JSON 模式，兼容重试也失败：{error}"))?;
        status = retry.status();
        response_text = retry
            .text()
            .await
            .map_err(|error| format!("读取模型兼容响应失败：{error}"))?;
    }
    if !status.is_success() {
        let detail = serde_json::from_str::<serde_json::Value>(&response_text)
            .ok()
            .and_then(|value| {
                value
                    .pointer("/error/message")
                    .and_then(|item| item.as_str())
                    .map(str::to_owned)
            })
            .unwrap_or(response_text);
        return Err(format!("模型请求失败（{status}）：{detail}"));
    }

    let parsed: ApiResponse = serde_json::from_str(&response_text)
        .map_err(|error| format!("模型响应格式错误：{error}"))?;
    parsed
        .choices
        .first()
        .and_then(|choice| choice.message.content.clone())
        .filter(|content| !content.trim().is_empty())
        .ok_or_else(|| "模型返回了空内容，请重试".into())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppNetworkState::default())
        .invoke_handler(tauri::generate_handler![
            model_chat,
            network_test,
            search_manuals,
            library_save_document,
            library_list_documents,
            library_load_document,
            library_update_document,
            library_delete_document,
            app_settings_load,
            app_settings_save,
            credentials_load,
            credentials_save,
            credentials_clear,
            download_pdf,
            manual_panel_create,
            manual_panel_set_bounds,
            manual_panel_visibility,
            manual_panel_navigate,
            manual_panel_action,
            manual_panel_current_url,
            manual_panel_destroy,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run SpecPilot");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_compatible_chat_endpoints() {
        assert_eq!(
            chat_endpoint("https://api.deepseek.com").unwrap().as_str(),
            "https://api.deepseek.com/chat/completions"
        );
        assert_eq!(
            chat_endpoint("https://api.openai.com/v1/").unwrap().as_str(),
            "https://api.openai.com/v1/chat/completions"
        );
    }

    #[test]
    fn creates_search_and_direct_manual_targets() {
        let search = manual_target("STM32H743", "duckduckgo").unwrap();
        assert_eq!(search.host_str(), Some("duckduckgo.com"));
        assert!(search.query().unwrap().contains("STM32H743"));
        let direct = manual_target("st.com/resource.pdf", "bing").unwrap();
        assert_eq!(direct.as_str(), "https://st.com/resource.pdf");
    }

    #[test]
    fn validates_manual_proxy_schemes() {
        assert_eq!(
            normalize_proxy("127.0.0.1:7890")
                .unwrap()
                .unwrap()
                .scheme(),
            "http"
        );
        assert!(normalize_proxy("https://127.0.0.1:7890").is_err());
    }
}
