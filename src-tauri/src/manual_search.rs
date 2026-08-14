use futures::stream::{FuturesUnordered, StreamExt};
use quick_xml::de::from_str;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{collections::HashSet, time::Duration};

#[derive(Debug, Deserialize)]
pub struct ManualSearchRequest {
    pub query: String,
    pub queries: Vec<String>,
    pub part_number: String,
    pub manufacturer: String,
    pub official_domains: Vec<String>,
    pub proxy_url: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ManualCandidate {
    pub title: String,
    pub url: String,
    pub host: String,
    pub snippet: String,
    pub score: u8,
    pub official: bool,
    pub verified_pdf: bool,
    pub reason: String,
}

#[derive(Debug, Deserialize)]
struct Rss {
    channel: RssChannel,
}

#[derive(Debug, Deserialize)]
struct RssChannel {
    #[serde(rename = "item", default)]
    items: Vec<RssItem>,
}

#[derive(Debug, Clone, Deserialize)]
struct RssItem {
    #[serde(default)]
    title: String,
    #[serde(default)]
    link: String,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Clone)]
struct CandidateSeed {
    title: String,
    url: reqwest::Url,
    snippet: String,
    verified_pdf: bool,
}

fn normalize_token(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn looks_like_pdf(url: &reqwest::Url) -> bool {
    let value = format!("{}?{}", url.path(), url.query().unwrap_or_default()).to_ascii_lowercase();
    value.contains(".pdf") || value.contains("downloadpdf") || value.contains("datasheetpdf")
}

fn is_official_host(host: &str, domains: &[String]) -> bool {
    let host = host.trim_start_matches("www.").to_ascii_lowercase();
    domains.iter().any(|domain| {
        let domain = domain
            .trim()
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("www.")
            .trim_end_matches('/')
            .to_ascii_lowercase();
        !domain.is_empty() && (host == domain || host.ends_with(&format!(".{domain}")))
    })
}

fn vendor_domains(manufacturer: &str) -> Vec<String> {
    let value = manufacturer.to_ascii_lowercase();
    let known = [
        (["st", "stmicro", "stmicroelectronics"].as_slice(), "st.com"),
        (["ti", "texas instruments"].as_slice(), "ti.com"),
        (["nxp"].as_slice(), "nxp.com"),
        (["analog devices", "adi", "linear technology"].as_slice(), "analog.com"),
        (["infineon", "cypress"].as_slice(), "infineon.com"),
        (["microchip", "atmel"].as_slice(), "microchip.com"),
        (["renesas"].as_slice(), "renesas.com"),
        (["nordic"].as_slice(), "nordicsemi.com"),
        (["onsemi", "on semiconductor"].as_slice(), "onsemi.com"),
    ];
    known
        .iter()
        .filter(|(names, _)| {
            names.iter().any(|name| {
                if name.len() <= 3 {
                    value
                        .split(|character: char| !character.is_ascii_alphanumeric())
                        .any(|token| token == *name)
                } else {
                    value.contains(name)
                }
            })
        })
        .map(|(_, domain)| (*domain).to_string())
        .collect()
}

fn part_vendor_domains(part_number: &str) -> Vec<String> {
    let part = normalize_token(part_number);
    let domain = if part.starts_with("stm32") || part.starts_with("stm8") {
        Some("st.com")
    } else if ["tps", "tms", "msp430", "cc13", "cc26", "cc32"]
        .iter()
        .any(|prefix| part.starts_with(prefix))
    {
        Some("ti.com")
    } else if ["lpc", "mcx", "mimx", "s32"]
        .iter()
        .any(|prefix| part.starts_with(prefix))
    {
        Some("nxp.com")
    } else if ["pic", "atsam", "atmega", "attiny"]
        .iter()
        .any(|prefix| part.starts_with(prefix))
    {
        Some("microchip.com")
    } else if part.starts_with("nrf") {
        Some("nordicsemi.com")
    } else {
        None
    };
    domain.into_iter().map(str::to_string).collect()
}

fn official_pdf_guesses(part_number: &str, domains: &[String]) -> Vec<CandidateSeed> {
    let normalized = normalize_token(part_number);
    if normalized.is_empty() {
        return Vec::new();
    }
    let mut urls = Vec::new();
    if domains.iter().any(|domain| domain == "st.com") {
        urls.push(format!(
            "https://www.st.com/resource/en/datasheet/{normalized}.pdf"
        ));
        if normalized.starts_with("stm32") && normalized.len() > 2 {
            let stem = &normalized[..normalized.len() - 1];
            for density in ["b", "c", "e", "g"] {
                urls.push(format!(
                    "https://www.st.com/resource/en/datasheet/{stem}{density}.pdf"
                ));
            }
        }
    }
    if domains.iter().any(|domain| domain == "ti.com") {
        urls.push(format!(
            "https://www.ti.com/lit/ds/symlink/{normalized}.pdf"
        ));
    }
    if domains.iter().any(|domain| domain == "nxp.com") {
        urls.push(format!(
            "https://www.nxp.com/docs/en/data-sheet/{}.pdf",
            normalized.to_ascii_uppercase()
        ));
    }
    urls.into_iter()
        .filter_map(|value| reqwest::Url::parse(&value).ok())
        .map(|url| CandidateSeed {
            title: format!("{part_number} 官方 datasheet"),
            url,
            snippet: "根据厂商官方文档路径生成，并已实际检查文件内容。".into(),
            verified_pdf: false,
        })
        .collect()
}

async fn search_bing_rss(client: &reqwest::Client, query: &str) -> Vec<RssItem> {
    let url = match reqwest::Url::parse_with_params(
        "https://www.bing.com/search",
        &[("format", "rss"), ("q", query)],
    ) {
        Ok(url) => url,
        Err(_) => return Vec::new(),
    };
    let response = match client.get(url).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => return Vec::new(),
    };
    let text = match response.text().await {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    from_str::<Rss>(&text)
        .map(|rss| rss.channel.items)
        .unwrap_or_default()
}

fn decode_duckduckgo_url(value: &str) -> Option<reqwest::Url> {
    let value = value.replace("&amp;", "&");
    let absolute = if value.starts_with("//") {
        format!("https:{value}")
    } else {
        value
    };
    let url = reqwest::Url::parse(&absolute).ok()?;
    if url
        .host_str()
        .is_some_and(|host| host.ends_with("duckduckgo.com"))
    {
        if let Some((_, destination)) = url.query_pairs().find(|(key, _)| key == "uddg") {
            return reqwest::Url::parse(&destination).ok();
        }
    }
    matches!(url.scheme(), "http" | "https").then_some(url)
}

fn clean_html_text(value: &str) -> String {
    let without_tags = Regex::new(r"(?is)<[^>]+>")
        .map(|pattern| pattern.replace_all(value, " ").into_owned())
        .unwrap_or_else(|_| value.to_string());
    without_tags
        .replace("&amp;", "&")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

async fn search_duckduckgo(client: &reqwest::Client, query: &str) -> Vec<RssItem> {
    let url = match reqwest::Url::parse_with_params(
        "https://html.duckduckgo.com/html/",
        &[("q", query)],
    ) {
        Ok(url) => url,
        Err(_) => return Vec::new(),
    };
    let response = match client
        .get(url)
        .header(reqwest::header::ACCEPT, "text/html,application/xhtml+xml")
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        _ => return Vec::new(),
    };
    let html = match response.text().await {
        Ok(html) => html,
        Err(_) => return Vec::new(),
    };
    let anchor_pattern = match Regex::new(
        r#"(?is)<a\s+[^>]*class\s*=\s*[\"'][^\"']*result__a[^\"']*[\"'][^>]*>.*?</a>"#,
    ) {
        Ok(pattern) => pattern,
        Err(_) => return Vec::new(),
    };
    let href_pattern = Regex::new(r#"(?is)href\s*=\s*[\"']([^\"']+)[\"']"#).unwrap();
    let mut seen = HashSet::new();
    anchor_pattern
        .find_iter(&html)
        .filter_map(|anchor| {
            let value = anchor.as_str();
            let href = href_pattern
                .captures(value)
                .and_then(|capture| capture.get(1))?
                .as_str();
            let url = decode_duckduckgo_url(href)?;
            seen.insert(url.to_string()).then(|| RssItem {
                title: clean_html_text(value),
                link: url.to_string(),
                description: String::new(),
            })
        })
        .take(10)
        .collect()
}

async fn search_web(client: &reqwest::Client, query: String) -> Vec<RssItem> {
    let results = tokio::time::timeout(
        Duration::from_secs(4),
        search_bing_rss(client, &query),
    )
    .await
    .unwrap_or_default();
    if results.is_empty() {
        search_duckduckgo(client, &query).await
    } else {
        results
    }
}

async fn extract_pdf_links(client: &reqwest::Client, item: RssItem) -> Vec<CandidateSeed> {
    let requested_url = match reqwest::Url::parse(item.link.trim()) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => url,
        _ => return Vec::new(),
    };
    if looks_like_pdf(&requested_url) {
        return vec![CandidateSeed {
            title: item.title,
            url: requested_url,
            snippet: item.description,
            verified_pdf: false,
        }];
    }

    let response = match client.get(requested_url).send().await {
        Ok(response) if response.status().is_success() => response,
        _ => return Vec::new(),
    };
    let final_url = response.url().clone();
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if content_type.contains("application/pdf") {
        return vec![CandidateSeed {
            title: item.title,
            url: final_url,
            snippet: item.description,
            verified_pdf: true,
        }];
    }
    if response.content_length().is_some_and(|length| length > 3 * 1024 * 1024) {
        return Vec::new();
    }
    let html = match response.text().await {
        Ok(text) => text,
        Err(_) => return Vec::new(),
    };
    let link_pattern = match Regex::new(r#"(?is)href\s*=\s*[\"']([^\"']+?(?:\.pdf|downloadpdf)[^\"']*)[\"']"#) {
        Ok(pattern) => pattern,
        Err(_) => return Vec::new(),
    };
    let mut seen = HashSet::new();
    link_pattern
        .captures_iter(&html)
        .filter_map(|capture| capture.get(1))
        .filter_map(|value| {
            let href = value.as_str().replace("&amp;", "&");
            final_url.join(&href).ok()
        })
        .filter(|url| matches!(url.scheme(), "http" | "https"))
        .filter(|url| seen.insert(url.to_string()))
        .take(4)
        .map(|url| CandidateSeed {
            title: format!("{} · PDF", item.title),
            url,
            snippet: item.description.clone(),
            verified_pdf: false,
        })
        .collect()
}

async fn verify_pdf(client: &reqwest::Client, mut seed: CandidateSeed) -> CandidateSeed {
    if seed.verified_pdf {
        return seed;
    }
    let response = client
        .get(seed.url.clone())
        .header(reqwest::header::RANGE, "bytes=0-8191")
        .send()
        .await;
    if let Ok(mut response) = response {
        if response.status().is_success() || response.status() == reqwest::StatusCode::PARTIAL_CONTENT {
            let final_url = response.url().clone();
            let content_type = response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|value| value.to_str().ok())
                .unwrap_or_default()
                .to_ascii_lowercase();
            let magic = response
                .chunk()
                .await
                .ok()
                .flatten()
                .is_some_and(|chunk| chunk.starts_with(b"%PDF-"));
            seed.url = final_url;
            seed.verified_pdf = magic || content_type.contains("application/pdf");
        }
    }
    seed
}

fn score_candidate(
    seed: CandidateSeed,
    part_number: &str,
    manufacturer: &str,
    official_domains: &[String],
) -> ManualCandidate {
    let host = seed.url.host_str().unwrap_or_default().to_string();
    let official = is_official_host(&host, official_domains);
    let haystack = format!("{} {} {}", seed.title, seed.url, seed.snippet);
    let normalized_haystack = normalize_token(&haystack);
    let normalized_part = normalize_token(part_number);
    let part_match = !normalized_part.is_empty() && normalized_haystack.contains(&normalized_part);
    let manufacturer_match = !manufacturer.trim().is_empty()
        && normalized_haystack.contains(&normalize_token(manufacturer));
    let datasheet_match = haystack.to_ascii_lowercase().contains("datasheet");
    let mut score = 20u16;
    if seed.verified_pdf { score += 25; }
    if part_match { score += 30; }
    if official { score += 20; }
    if manufacturer_match { score += 5; }
    if datasheet_match { score += 5; }
    let mut reasons = Vec::new();
    if official { reasons.push("官方域名"); }
    if part_match { reasons.push("型号匹配"); }
    if seed.verified_pdf { reasons.push("已验证 PDF"); } else { reasons.push("待下载验证"); }
    ManualCandidate {
        title: seed.title,
        url: seed.url.to_string(),
        host,
        snippet: seed.snippet,
        score: score.min(99) as u8,
        official,
        verified_pdf: seed.verified_pdf,
        reason: reasons.join(" · "),
    }
}

pub async fn search_manuals(request: ManualSearchRequest) -> Result<Vec<ManualCandidate>, String> {
    tokio::time::timeout(Duration::from_secs(35), search_manuals_inner(request))
        .await
        .map_err(|_| "手册搜索超过 35 秒，已停止等待。请检查代理或换用更准确的型号".to_string())?
}

async fn search_manuals_inner(
    request: ManualSearchRequest,
) -> Result<Vec<ManualCandidate>, String> {
    let query = request.query.trim();
    if query.is_empty() {
        return Err("请输入芯片型号或手册名称".into());
    }
    let client = crate::build_http_client(&request.proxy_url, 10)?;
    let mut official_domains = request.official_domains.clone();
    official_domains.extend(vendor_domains(&request.manufacturer));
    official_domains.extend(part_vendor_domains(&request.part_number));
    official_domains.sort();
    official_domains.dedup();

    let mut guesses = FuturesUnordered::new();
    for seed in official_pdf_guesses(&request.part_number, &official_domains) {
        guesses.push(verify_pdf(&client, seed));
    }
    let guess_deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    loop {
        let remaining = guess_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, guesses.next()).await {
            Ok(Some(seed)) if seed.verified_pdf => {
                return Ok(vec![score_candidate(
                    seed,
                    &request.part_number,
                    &request.manufacturer,
                    &official_domains,
                )]);
            }
            Ok(Some(_)) => {}
            _ => break,
        }
    }

    let mut queries = request
        .queries
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>();
    queries.insert(0, format!("\"{query}\" datasheet filetype:pdf"));
    for domain in official_domains.iter().take(2) {
        queries.push(format!("site:{domain} \"{query}\" datasheet PDF"));
    }
    queries.sort();
    queries.dedup();
    queries.truncate(5);

    let mut searches = FuturesUnordered::new();
    for search in queries {
        searches.push(search_web(&client, search));
    }
    let mut items = Vec::new();
    let mut item_urls = HashSet::new();
    let search_deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    while items.len() < 12 {
        let remaining = search_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, searches.next()).await {
            Ok(Some(result)) => {
                for item in result {
                    if item_urls.insert(item.link.clone()) {
                        items.push(item);
                    }
                    if items.len() >= 12 {
                        break;
                    }
                }
            }
            _ => break,
        }
    }
    if items.is_empty() {
        return Err("搜索服务没有返回结果。请检查网络/代理，或换用更完整的型号".into());
    }

    let mut seeds = Vec::new();
    let mut pdf_urls = HashSet::new();
    let mut extractions = FuturesUnordered::new();
    for item in items {
        if let Ok(url) = reqwest::Url::parse(item.link.trim()) {
            if matches!(url.scheme(), "http" | "https") && looks_like_pdf(&url) {
                if pdf_urls.insert(url.to_string()) {
                    seeds.push(CandidateSeed {
                        title: item.title,
                        url,
                        snippet: item.description,
                        verified_pdf: false,
                    });
                }
                continue;
            }
        }
        extractions.push(extract_pdf_links(&client, item));
    }
    let extraction_deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while seeds.len() < 16 {
        let remaining = extraction_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, extractions.next()).await {
            Ok(Some(group)) => {
                for seed in group {
                    if pdf_urls.insert(seed.url.to_string()) {
                        seeds.push(seed);
                    }
                    if seeds.len() >= 16 {
                        break;
                    }
                }
            }
            _ => break,
        }
    }
    if seeds.is_empty() {
        return Err("找到了相关网页，但没有提取到 PDF 直链。可以换用更完整型号或进入网页备用浏览".into());
    }

    let originals = seeds.clone();
    let mut verifications = FuturesUnordered::new();
    for seed in seeds {
        verifications.push(verify_pdf(&client, seed));
    }
    let verification_deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    let mut checked = Vec::new();
    while checked.len() < originals.len() {
        let remaining = verification_deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, verifications.next()).await {
            Ok(Some(seed)) => checked.push(seed),
            _ => break,
        }
    }
    let checked_urls = checked
        .iter()
        .map(|seed| seed.url.to_string())
        .collect::<HashSet<_>>();
    checked.extend(
        originals
            .into_iter()
            .filter(|seed| !checked_urls.contains(seed.url.as_str())),
    );
    let mut candidates = checked
        .into_iter()
        .map(|seed| {
            score_candidate(
                seed,
                &request.part_number,
                &request.manufacturer,
                &official_domains,
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .verified_pdf
            .cmp(&left.verified_pdf)
            .then_with(|| right.score.cmp(&left.score))
            .then_with(|| right.official.cmp(&left.official))
    });
    candidates.truncate(10);
    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recognizes_vendor_and_subdomains() {
        assert_eq!(vendor_domains("STMicroelectronics"), vec!["st.com"]);
        assert_eq!(vendor_domains("Texas Instruments (TI)"), vec!["ti.com"]);
        assert!(is_official_host("www.st.com", &["st.com".into()]));
        assert!(is_official_host("assets.st.com", &["https://st.com/".into()]));
        assert!(!is_official_host("st.com.example.org", &["st.com".into()]));
        let redirected = decode_duckduckgo_url(
            "//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.st.com%2Fmanual.pdf&amp;rut=test",
        )
        .unwrap();
        assert_eq!(redirected.as_str(), "https://www.st.com/manual.pdf");
        assert_eq!(part_vendor_domains("STM32G474RE"), vec!["st.com"]);
        assert!(official_pdf_guesses("TPS5430", &["ti.com".into()])
            .iter()
            .any(|seed| seed.url.as_str().contains("/tps5430.pdf")));
    }

    #[test]
    fn ranks_verified_official_exact_match_highly() {
        let seed = CandidateSeed {
            title: "STM32G474xB STM32G474xC STM32G474xE datasheet".into(),
            url: reqwest::Url::parse("https://www.st.com/resource/en/datasheet/stm32g474re.pdf").unwrap(),
            snippet: "Official STM32G474RE product datasheet".into(),
            verified_pdf: true,
        };
        let result = score_candidate(
            seed,
            "STM32G474RE",
            "STMicroelectronics",
            &["st.com".into()],
        );
        assert!(result.official);
        assert!(result.verified_pdf);
        assert!(result.score >= 90);
        assert!(result.reason.contains("型号匹配"));
    }

    #[test]
    #[ignore = "requires public internet access"]
    fn live_search_finds_a_real_datasheet() {
        let results = tauri::async_runtime::block_on(search_manuals(ManualSearchRequest {
            query: "STM32G474RE".into(),
            queries: vec!["STM32G474RE datasheet PDF".into()],
            part_number: "STM32G474RE".into(),
            manufacturer: "STMicroelectronics".into(),
            official_domains: vec!["st.com".into()],
            proxy_url: String::new(),
        }))
        .expect("live datasheet search should return candidates");
        assert!(!results.is_empty());
        assert!(results.iter().any(|candidate| looks_like_pdf(
            &reqwest::Url::parse(&candidate.url).unwrap()
        )));
    }
}
