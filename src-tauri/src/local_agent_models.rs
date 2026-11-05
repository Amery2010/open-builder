use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::net::IpAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, ACCEPT};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::sync::Mutex;

use crate::local_agent::{LocalAgentModel, LocalAgentProvider};

const SUCCESS_TTL: Duration = Duration::from_secs(60);
const FAILURE_TTL: Duration = Duration::from_secs(15);
const GATEWAY_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_GATEWAY_PAGES: usize = 16;
const MAX_GATEWAY_MODELS: usize = 4_096;
const MAX_GATEWAY_CACHE_KEYS: usize = 32;
const MAX_LOCAL_MODELS: usize = 128;
const MAX_GATEWAY_RESPONSE_BYTES: usize = 4 * 1024 * 1024;
const MAX_MODEL_ID_BYTES: usize = 256;
const MAX_DISPLAY_NAME_CHARS: usize = 160;
const MAX_EFFORT_BYTES: usize = 64;
const MAX_EFFORTS_PER_MODEL: usize = 64;
const MAX_CURSOR_BYTES: usize = 2_048;
const MAX_CUSTOM_HEADER_BYTES: usize = 256 * 1024;
const MAX_CUSTOM_HEADERS: usize = 128;

const GATEWAY_STALE_WARNING: &str =
    "Claude gateway model discovery is degraded; the last successful catalog is being used.";
const GATEWAY_UNAVAILABLE_WARNING: &str =
    "Claude gateway model discovery is unavailable; locally declared models are retained as unverified.";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CatalogAuthority {
    Authoritative,
    Partial,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EffortKnowledge {
    Known,
    Unknown,
}

#[derive(Clone, Debug)]
pub(crate) struct ModelCandidate {
    pub model: LocalAgentModel,
    pub effort_knowledge: EffortKnowledge,
}

impl ModelCandidate {
    pub(crate) fn known(mut model: LocalAgentModel, efforts: Vec<String>) -> Self {
        model.efforts = efforts;
        Self {
            model,
            effort_knowledge: EffortKnowledge::Known,
        }
    }

    pub(crate) fn unknown(mut model: LocalAgentModel) -> Self {
        model.efforts.clear();
        model.default_effort = None;
        Self {
            model,
            effort_knowledge: EffortKnowledge::Unknown,
        }
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModelPreference {
    pub model: Option<String>,
    pub effort: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(crate) enum PreferenceDecision {
    Keep { unverified: bool },
    Replace { preference: ModelPreference },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum LaunchValidation {
    Allowed {
        preference: ModelPreference,
        actual: ModelPreference,
        unverified: bool,
    },
    Rejected {
        message: String,
    },
}

#[derive(Clone)]
enum ClaudeGatewayCredential {
    ApiKey(String),
    BearerToken(String),
}

/// Secret-bearing input. Deliberately has no `Debug` or serialization implementation.
#[derive(Clone)]
pub(crate) struct ClaudeGatewayCatalog {
    base_url: String,
    credential: ClaudeGatewayCredential,
    custom_headers: Option<String>,
}

impl ClaudeGatewayCatalog {
    pub(crate) fn with_api_key(
        base_url: String,
        api_key: String,
        custom_headers: Option<String>,
    ) -> Self {
        Self {
            base_url,
            credential: ClaudeGatewayCredential::ApiKey(api_key),
            custom_headers,
        }
    }

    pub(crate) fn with_bearer_token(
        base_url: String,
        bearer_token: String,
        custom_headers: Option<String>,
    ) -> Self {
        Self {
            base_url,
            credential: ClaudeGatewayCredential::BearerToken(bearer_token),
            custom_headers,
        }
    }
}

/// Provider observations supplied to the strategy. Secret-bearing because it may contain a
/// Claude gateway catalog, so this type is intentionally not printable or serializable.
#[derive(Clone)]
pub(crate) struct ModelResolutionRequest {
    pub provider: LocalAgentProvider,
    pub candidates: Vec<ModelCandidate>,
    pub authority: CatalogAuthority,
    pub preference: ModelPreference,
    pub configured: ModelPreference,
    pub gateway: Option<ClaudeGatewayCatalog>,
    pub force_refresh: bool,
}

pub(crate) struct ModelResolution {
    pub models: Vec<LocalAgentModel>,
    pub efforts: Vec<String>,
    pub preference_decision: PreferenceDecision,
    pub warning: Option<String>,
    pub launch_validation: LaunchValidation,
}

pub(crate) struct ModelStrategy {
    fetcher: Arc<dyn GatewayFetcher>,
    cache: Mutex<GatewayCache>,
    success_ttl: Duration,
    failure_ttl: Duration,
}

impl Default for ModelStrategy {
    fn default() -> Self {
        Self {
            fetcher: Arc::new(ReqwestGatewayFetcher::new(GATEWAY_TIMEOUT)),
            cache: Mutex::new(GatewayCache::default()),
            success_ttl: SUCCESS_TTL,
            failure_ttl: FAILURE_TTL,
        }
    }
}

impl ModelStrategy {
    pub(crate) async fn resolve(&self, request: ModelResolutionRequest) -> ModelResolution {
        let mut candidates = request.candidates;
        let mut authority = request.authority;
        let mut warning = None;

        if request.provider == LocalAgentProvider::Claude {
            if let Some(gateway) = request.gateway {
                match self.gateway_catalog(gateway, request.force_refresh).await {
                    GatewayCatalogResult::Fresh(remote) => {
                        candidates.extend(remote);
                        authority = CatalogAuthority::Authoritative;
                    }
                    GatewayCatalogResult::Stale(remote) => {
                        candidates.extend(remote);
                        authority = CatalogAuthority::Partial;
                        warning = Some(GATEWAY_STALE_WARNING.to_string());
                    }
                    GatewayCatalogResult::Unavailable => {
                        authority = CatalogAuthority::Partial;
                        warning = Some(GATEWAY_UNAVAILABLE_WARNING.to_string());
                    }
                }
            }
        }

        let mut normalized = normalize_candidates(candidates);
        if let Some(configured_model) = request.configured.model.as_deref().filter(|configured| {
            normalized
                .iter()
                .any(|candidate| candidate.model.id == *configured)
        }) {
            for candidate in &mut normalized {
                candidate.model.is_default = candidate.model.id == configured_model;
            }
        }
        let efforts = normalize_fallback_efforts(&normalized);
        let (preference_decision, launch_validation) = decide_preference(
            &request.preference,
            &request.configured,
            &normalized,
            &efforts,
            authority,
        );
        if warning.is_none()
            && matches!(
                launch_validation,
                LaunchValidation::Allowed {
                    unverified: true,
                    ..
                }
            )
        {
            warning = Some(
                "The selected local model or reasoning effort could not be verified against the available catalog."
                    .to_string(),
            );
        }

        ModelResolution {
            models: normalized
                .into_iter()
                .map(|candidate| candidate.model)
                .collect(),
            efforts,
            preference_decision,
            warning,
            launch_validation,
        }
    }

    async fn gateway_catalog(
        &self,
        gateway: ClaudeGatewayCatalog,
        force_refresh: bool,
    ) -> GatewayCatalogResult {
        let key = gateway.cache_key();
        let (flight, observed_attempt, cached) = {
            let mut cache = self.cache.lock().await;
            if !cache.ensure_capacity_for(key) {
                return GatewayCatalogResult::Unavailable;
            }
            let access = cache.next_access();
            let entry = cache.entries.entry(key).or_default();
            entry.last_access = access;
            let observed_attempt = entry.attempt;
            let cached = entry.cached_result(Instant::now(), force_refresh);
            let flight = cache
                .flights
                .entry(key)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone();
            (flight, observed_attempt, cached)
        };
        if let Some(cached) = cached {
            return cached;
        }

        let _flight_guard = flight.lock().await;
        {
            let cache = self.cache.lock().await;
            if let Some(entry) = cache.entries.get(&key) {
                // A concurrent force refresh satisfies every waiter that observed the older
                // attempt. Without this check, force-refresh callers would serialize duplicate
                // network requests instead of sharing one flight.
                if entry.attempt != observed_attempt {
                    return entry
                        .cached_result(Instant::now(), false)
                        .unwrap_or_else(|| entry.latest_result());
                }
                if let Some(cached) = entry.cached_result(Instant::now(), force_refresh) {
                    return cached;
                }
            }
        }

        let fetched = self.fetcher.fetch(gateway).await;
        let now = Instant::now();
        let mut cache = self.cache.lock().await;
        let access = cache.next_access();
        let result = {
            let entry = cache.entries.entry(key).or_default();
            entry.last_access = access;
            entry.attempt = entry.attempt.wrapping_add(1);
            match fetched {
                Ok(models) => {
                    entry.last_success = Some(models.clone());
                    entry.success_until = Some(now + self.success_ttl);
                    entry.failure_until = None;
                    GatewayCatalogResult::Fresh(models)
                }
                Err(_) => {
                    entry.failure_until = Some(now + self.failure_ttl);
                    entry.success_until = None;
                    entry
                        .last_success
                        .clone()
                        .map(GatewayCatalogResult::Stale)
                        .unwrap_or(GatewayCatalogResult::Unavailable)
                }
            }
        };
        cache.trim_to_limit(Some(key));
        result
    }

    #[cfg(test)]
    fn with_fetcher(
        fetcher: Arc<dyn GatewayFetcher>,
        success_ttl: Duration,
        failure_ttl: Duration,
    ) -> Self {
        Self {
            fetcher,
            cache: Mutex::new(GatewayCache::default()),
            success_ttl,
            failure_ttl,
        }
    }
}

#[derive(Clone, Copy, Hash, PartialEq, Eq)]
struct CacheKey([u8; 32]);

impl ClaudeGatewayCatalog {
    fn cache_key(&self) -> CacheKey {
        let mut digest = Sha256::new();
        digest.update(b"open-builder-claude-model-catalog-v1\0");
        digest.update(self.base_url.as_bytes());
        digest.update([0]);
        match &self.credential {
            ClaudeGatewayCredential::ApiKey(secret) => {
                digest.update(b"api-key\0");
                digest.update(secret.as_bytes());
            }
            ClaudeGatewayCredential::BearerToken(secret) => {
                digest.update(b"bearer\0");
                digest.update(secret.as_bytes());
            }
        }
        if let Some(headers) = &self.custom_headers {
            digest.update([0]);
            digest.update(headers.as_bytes());
        }
        CacheKey(digest.finalize().into())
    }
}

#[derive(Default)]
struct GatewayCache {
    entries: HashMap<CacheKey, GatewayCacheEntry>,
    flights: HashMap<CacheKey, Arc<Mutex<()>>>,
    access_clock: u64,
}

#[derive(Default)]
struct GatewayCacheEntry {
    last_success: Option<Vec<ModelCandidate>>,
    success_until: Option<Instant>,
    failure_until: Option<Instant>,
    attempt: u64,
    last_access: u64,
}

impl GatewayCache {
    fn next_access(&mut self) -> u64 {
        self.access_clock = self.access_clock.wrapping_add(1).max(1);
        self.access_clock
    }

    fn ensure_capacity_for(&mut self, key: CacheKey) -> bool {
        if self.entries.contains_key(&key) {
            return true;
        }
        while self.entries.len() >= MAX_GATEWAY_CACHE_KEYS {
            if !self.evict_oldest_inactive(None) {
                return false;
            }
        }
        true
    }

    fn trim_to_limit(&mut self, protected: Option<CacheKey>) {
        while self.entries.len() > MAX_GATEWAY_CACHE_KEYS {
            if !self.evict_oldest_inactive(protected) {
                break;
            }
        }
    }

    fn evict_oldest_inactive(&mut self, protected: Option<CacheKey>) -> bool {
        let candidate = self
            .entries
            .iter()
            .filter(|(candidate, _)| protected != Some(**candidate))
            .filter(|(candidate, _)| {
                self.flights
                    .get(*candidate)
                    .is_none_or(|flight| Arc::strong_count(flight) == 1)
            })
            .min_by_key(|(_, entry)| entry.last_access)
            .map(|(candidate, _)| *candidate);
        let Some(candidate) = candidate else {
            return false;
        };
        self.entries.remove(&candidate);
        self.flights.remove(&candidate);
        true
    }
}

impl GatewayCacheEntry {
    fn cached_result(&self, now: Instant, force_refresh: bool) -> Option<GatewayCatalogResult> {
        if force_refresh {
            return None;
        }
        if self.failure_until.is_some_and(|until| until > now) {
            return Some(self.latest_result());
        }
        if self.success_until.is_some_and(|until| until > now) {
            return self.last_success.clone().map(GatewayCatalogResult::Fresh);
        }
        None
    }

    fn latest_result(&self) -> GatewayCatalogResult {
        self.last_success
            .clone()
            .map(GatewayCatalogResult::Stale)
            .unwrap_or(GatewayCatalogResult::Unavailable)
    }
}

enum GatewayCatalogResult {
    Fresh(Vec<ModelCandidate>),
    Stale(Vec<ModelCandidate>),
    Unavailable,
}

type GatewayFuture =
    Pin<Box<dyn Future<Output = Result<Vec<ModelCandidate>, GatewayFailure>> + Send + 'static>>;

/// Private port: callers provide configuration data, never an HTTP implementation.
trait GatewayFetcher: Send + Sync {
    fn fetch(&self, gateway: ClaudeGatewayCatalog) -> GatewayFuture;
}

struct ReqwestGatewayFetcher {
    client: Option<reqwest::Client>,
    timeout: Duration,
}

impl ReqwestGatewayFetcher {
    fn new(timeout: Duration) -> Self {
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(timeout * crate::timeouts::TIMEOUT_ATTEMPTS)
            .build()
            .ok();
        Self { client, timeout }
    }

    async fn fetch_catalog(
        client: reqwest::Client,
        gateway: ClaudeGatewayCatalog,
    ) -> Result<Vec<ModelCandidate>, GatewayFailure> {
        let mut page_url = models_url(&gateway.base_url)?;
        let headers = gateway_headers(&gateway)?;
        let mut models = Vec::new();
        let mut response_bytes = 0_usize;
        let mut cursor: Option<GatewayCursor> = None;

        for page_index in 0..MAX_GATEWAY_PAGES {
            {
                let mut pairs = page_url.query_pairs_mut();
                pairs.clear().append_pair("limit", "1000");
                if let Some(cursor) = cursor.as_ref() {
                    pairs.append_pair(cursor.parameter.query_name(), &cursor.value);
                }
            }
            let response = client
                .get(page_url.clone())
                .headers(headers.clone())
                .send()
                .await
                .map_err(|error| {
                    if error.is_timeout() {
                        GatewayFailure::TimedOut
                    } else {
                        GatewayFailure::Transport
                    }
                })?;

            let status = response.status();
            if status.is_redirection() {
                return Err(GatewayFailure::Redirected);
            }
            if !status.is_success() {
                return Err(match status.as_u16() {
                    401 | 403 => GatewayFailure::Unauthorized,
                    404 => GatewayFailure::NotFound,
                    429 => GatewayFailure::RateLimited,
                    500..=599 => GatewayFailure::Temporary,
                    _ => GatewayFailure::Transport,
                });
            }

            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|_| GatewayFailure::Transport)?;
                response_bytes = response_bytes
                    .checked_add(chunk.len())
                    .ok_or(GatewayFailure::ResponseTooLarge)?;
                if response_bytes > MAX_GATEWAY_RESPONSE_BYTES {
                    return Err(GatewayFailure::ResponseTooLarge);
                }
                body.extend_from_slice(&chunk);
            }

            let page = parse_gateway_page(&body, MAX_GATEWAY_MODELS - models.len())?;
            models.extend(page.models);
            if !page.has_more {
                return Ok(models);
            }
            if page_index + 1 == MAX_GATEWAY_PAGES {
                return Err(GatewayFailure::TooManyPages);
            }
            cursor = Some(page.next_cursor.ok_or(GatewayFailure::MalformedResponse)?);
        }
        Err(GatewayFailure::TooManyPages)
    }
}

impl GatewayFetcher for ReqwestGatewayFetcher {
    fn fetch(&self, gateway: ClaudeGatewayCatalog) -> GatewayFuture {
        let client = self.client.clone();
        let timeout = self.timeout;
        Box::pin(async move {
            let client = client.ok_or(GatewayFailure::Transport)?;
            crate::timeouts::wait_with_timeout_retries(
                Self::fetch_catalog(client, gateway),
                timeout,
            )
            .await
            .map_err(|_| GatewayFailure::TimedOut)?
        })
    }
}

#[derive(Debug)]
enum GatewayFailure {
    InvalidConfiguration,
    Unauthorized,
    NotFound,
    RateLimited,
    Temporary,
    Redirected,
    ResponseTooLarge,
    TooManyPages,
    TooManyModels,
    TooManyEfforts,
    MalformedResponse,
    TimedOut,
    Transport,
}

impl GatewayFailure {
    #[cfg(test)]
    fn safe_message(&self) -> &'static str {
        match self {
            Self::InvalidConfiguration => {
                "Claude gateway model discovery configuration is invalid."
            }
            Self::Unauthorized => "Claude gateway model discovery was not authorized.",
            Self::NotFound => "Claude gateway model discovery endpoint is unavailable.",
            Self::RateLimited => "Claude gateway model discovery was rate limited.",
            Self::Temporary => "Claude gateway model discovery is temporarily unavailable.",
            Self::Redirected => "Claude gateway model discovery does not permit redirects.",
            Self::ResponseTooLarge => "Claude gateway model discovery exceeded its response limit.",
            Self::TooManyPages => "Claude gateway model discovery exceeded its page limit.",
            Self::TooManyModels => "Claude gateway model discovery exceeded its model limit.",
            Self::TooManyEfforts => {
                "Claude gateway model discovery exceeded its per-model effort limit."
            }
            Self::MalformedResponse => "Claude gateway model discovery returned malformed data.",
            Self::TimedOut => "Claude gateway model discovery timed out.",
            Self::Transport => "Claude gateway model discovery failed.",
        }
    }
}

fn models_url(base_url: &str) -> Result<reqwest::Url, GatewayFailure> {
    let mut url =
        reqwest::Url::parse(base_url).map_err(|_| GatewayFailure::InvalidConfiguration)?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(GatewayFailure::InvalidConfiguration);
    }
    let host = url.host_str().ok_or(GatewayFailure::InvalidConfiguration)?;
    let loopback = host.eq_ignore_ascii_case("localhost")
        || host
            .parse::<IpAddr>()
            .is_ok_and(|address| address.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err(GatewayFailure::InvalidConfiguration);
    }

    let path = url.path().trim_end_matches('/');
    let models_path = if path.is_empty() || path == "/" {
        "/v1/models".to_string()
    } else if path.ends_with("/v1/messages") {
        format!("{}/models", path.trim_end_matches("/messages"))
    } else if path.ends_with("/v1") {
        format!("{path}/models")
    } else {
        format!("{path}/v1/models")
    };
    url.set_path(&models_path);
    Ok(url)
}

fn gateway_headers(gateway: &ClaudeGatewayCatalog) -> Result<HeaderMap, GatewayFailure> {
    let mut headers = HeaderMap::new();
    headers.insert(ACCEPT, HeaderValue::from_static("application/json"));
    headers.insert(
        HeaderName::from_static("anthropic-version"),
        HeaderValue::from_static("2023-06-01"),
    );
    let mut seen = HashSet::new();
    for (name, value) in parse_custom_headers(gateway.custom_headers.as_deref())? {
        let name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| GatewayFailure::InvalidConfiguration)?;
        if is_forbidden_custom_header(&name) || !seen.insert(name.clone()) {
            return Err(GatewayFailure::InvalidConfiguration);
        }
        let value =
            HeaderValue::from_str(&value).map_err(|_| GatewayFailure::InvalidConfiguration)?;
        headers.insert(name, value);
    }
    match &gateway.credential {
        ClaudeGatewayCredential::ApiKey(secret) => {
            let value =
                HeaderValue::from_str(secret).map_err(|_| GatewayFailure::InvalidConfiguration)?;
            if value.is_empty() {
                return Err(GatewayFailure::InvalidConfiguration);
            }
            headers.insert(HeaderName::from_static("x-api-key"), value);
        }
        ClaudeGatewayCredential::BearerToken(secret) => {
            if secret.is_empty() {
                return Err(GatewayFailure::InvalidConfiguration);
            }
            let value = HeaderValue::from_str(&format!("Bearer {secret}"))
                .map_err(|_| GatewayFailure::InvalidConfiguration)?;
            headers.insert(reqwest::header::AUTHORIZATION, value);
        }
    }
    Ok(headers)
}

fn parse_custom_headers(raw: Option<&str>) -> Result<Vec<(String, String)>, GatewayFailure> {
    let Some(raw) = raw else {
        return Ok(Vec::new());
    };
    if raw.len() > MAX_CUSTOM_HEADER_BYTES {
        return Err(GatewayFailure::InvalidConfiguration);
    }
    let mut headers = Vec::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if headers.len() == MAX_CUSTOM_HEADERS {
            return Err(GatewayFailure::InvalidConfiguration);
        }
        let (name, value) = line
            .split_once(':')
            .ok_or(GatewayFailure::InvalidConfiguration)?;
        let name = name.trim();
        let value = value.trim();
        if name.is_empty() || value.is_empty() {
            return Err(GatewayFailure::InvalidConfiguration);
        }
        headers.push((name.to_string(), value.to_string()));
    }
    Ok(headers)
}

fn is_forbidden_custom_header(name: &HeaderName) -> bool {
    matches!(
        name.as_str(),
        "host"
            | "content-length"
            | "transfer-encoding"
            | "connection"
            | "proxy-authorization"
            | "proxy-authenticate"
            | "authorization"
            | "x-api-key"
            | "anthropic-version"
            | "upgrade"
            | "te"
            | "trailer"
    )
}

#[derive(Debug)]
struct ParsedGatewayPage {
    models: Vec<ModelCandidate>,
    has_more: bool,
    next_cursor: Option<GatewayCursor>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CursorParameter {
    After,
    AfterId,
    Cursor,
}

impl CursorParameter {
    fn query_name(self) -> &'static str {
        match self {
            Self::After => "after",
            Self::AfterId => "after_id",
            Self::Cursor => "cursor",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct GatewayCursor {
    value: String,
    parameter: CursorParameter,
}

fn parse_gateway_page(
    body: &[u8],
    remaining_models: usize,
) -> Result<ParsedGatewayPage, GatewayFailure> {
    let value: Value =
        serde_json::from_slice(body).map_err(|_| GatewayFailure::MalformedResponse)?;
    if value
        .get("success")
        .and_then(Value::as_bool)
        .is_some_and(|success| !success)
    {
        return Err(GatewayFailure::MalformedResponse);
    }
    let raw_models = if let Some(models) = value.as_array() {
        models
    } else if let Some(models) = value.get("data").and_then(Value::as_array) {
        models
    } else if let Some(models) = value.get("models").and_then(Value::as_array) {
        models
    } else if let Some(models) = value
        .get("data")
        .and_then(|data| data.get("models"))
        .and_then(Value::as_array)
    {
        models
    } else {
        return Err(GatewayFailure::MalformedResponse);
    };
    if raw_models.len() > remaining_models {
        return Err(GatewayFailure::TooManyModels);
    }

    let mut models = Vec::with_capacity(raw_models.len());
    for raw in raw_models {
        models.push(parse_gateway_model(raw)?);
    }

    let has_more = find_bool(&value, &["has_more", "hasMore"]).unwrap_or_else(|| {
        find_string(
            &value,
            &[
                "next_cursor",
                "nextCursor",
                "next",
                "after_id",
                "afterId",
                "after",
            ],
        )
        .is_some()
    });
    let next_cursor = if has_more {
        parse_gateway_cursor(&value, raw_models)
    } else {
        None
    };

    Ok(ParsedGatewayPage {
        models,
        has_more,
        next_cursor,
    })
}

fn find_bool(value: &Value, keys: &[&str]) -> Option<bool> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_bool))
        .or_else(|| {
            ["pagination", "meta", "data"]
                .iter()
                .filter_map(|key| value.get(*key))
                .find_map(|nested| {
                    keys.iter()
                        .find_map(|key| nested.get(*key).and_then(Value::as_bool))
                })
        })
        .or_else(|| {
            value.get("data").and_then(|data| {
                ["pagination", "meta"]
                    .iter()
                    .filter_map(|key| data.get(*key))
                    .find_map(|nested| {
                        keys.iter()
                            .find_map(|key| nested.get(*key).and_then(Value::as_bool))
                    })
            })
        })
}

fn find_string<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_str))
        .or_else(|| {
            ["pagination", "meta", "data"]
                .iter()
                .filter_map(|key| value.get(*key))
                .find_map(|nested| {
                    keys.iter()
                        .find_map(|key| nested.get(*key).and_then(Value::as_str))
                })
        })
        .or_else(|| {
            value.get("data").and_then(|data| {
                ["pagination", "meta"]
                    .iter()
                    .filter_map(|key| data.get(*key))
                    .find_map(|nested| {
                        keys.iter()
                            .find_map(|key| nested.get(*key).and_then(Value::as_str))
                    })
            })
        })
}

fn parse_gateway_cursor(value: &Value, raw_models: &[Value]) -> Option<GatewayCursor> {
    let (cursor, parameter) = if let Some(cursor) = find_string(value, &["after_id", "afterId"]) {
        (cursor, CursorParameter::AfterId)
    } else if let Some(cursor) = find_string(value, &["after"]) {
        (cursor, CursorParameter::After)
    } else if let Some(cursor) = find_string(value, &["next_cursor", "nextCursor", "next"]) {
        (cursor, CursorParameter::Cursor)
    } else {
        let cursor = find_string(value, &["last_id", "lastId"])?;
        let openai_envelope = value.get("object").and_then(Value::as_str) == Some("list")
            || value
                .get("data")
                .and_then(|data| data.get("object"))
                .and_then(Value::as_str)
                == Some("list")
            || raw_models.iter().any(|model| {
                model.as_object().is_some_and(|model| {
                    model.get("object").and_then(Value::as_str) == Some("model")
                        || model.contains_key("owned_by")
                        || model.contains_key("created")
                })
            });
        let anthropic_envelope = !openai_envelope
            && (value.get("type").and_then(Value::as_str) == Some("list")
                || raw_models.iter().any(|model| {
                    model.as_object().is_some_and(|model| {
                        model.get("type").and_then(Value::as_str) == Some("model")
                            || model.contains_key("created_at")
                            || model.contains_key("display_name")
                    })
                }));
        (
            cursor,
            if anthropic_envelope {
                CursorParameter::AfterId
            } else {
                CursorParameter::After
            },
        )
    };
    is_safe_cursor(cursor).then(|| GatewayCursor {
        value: cursor.to_string(),
        parameter,
    })
}

fn parse_gateway_model(value: &Value) -> Result<ModelCandidate, GatewayFailure> {
    let (id, object) = match value {
        Value::String(id) => (id.as_str(), None),
        Value::Object(object) => {
            let id = object
                .get("id")
                .or_else(|| object.get("slug"))
                .or_else(|| object.get("name"))
                .and_then(Value::as_str)
                .ok_or(GatewayFailure::MalformedResponse)?;
            (id, Some(object))
        }
        _ => return Err(GatewayFailure::MalformedResponse),
    };
    if !is_safe_model_id(id) {
        return Err(GatewayFailure::MalformedResponse);
    }

    let display_name = object
        .and_then(|object| {
            object
                .get("display_name")
                .or_else(|| object.get("displayName"))
                .or_else(|| object.get("name"))
                .and_then(Value::as_str)
        })
        .filter(|name| is_safe_display_name(name))
        .unwrap_or(id)
        .chars()
        .take(MAX_DISPLAY_NAME_CHARS)
        .collect();
    let direct_efforts = object.and_then(|object| {
        object
            .get("efforts")
            .or_else(|| object.get("supported_efforts"))
            .or_else(|| object.get("supportedEfforts"))
    });
    let effort_values = match direct_efforts {
        Some(efforts) => Some(parse_effort_array(efforts)?),
        None => object.map(parse_capability_efforts).transpose()?.flatten(),
    };
    let effort_knowledge = if effort_values.is_some() {
        EffortKnowledge::Known
    } else {
        EffortKnowledge::Unknown
    };
    let efforts = effort_values.unwrap_or_default();
    let default_effort = object
        .and_then(|object| {
            object
                .get("default_effort")
                .or_else(|| object.get("defaultEffort"))
                .or_else(|| object.get("default_reasoning_effort"))
                .or_else(|| object.get("defaultReasoningEffort"))
                .and_then(Value::as_str)
        })
        .filter(|effort| efforts.iter().any(|candidate| candidate == *effort))
        .map(str::to_string);

    Ok(ModelCandidate {
        model: LocalAgentModel {
            id: id.to_string(),
            display_name,
            is_default: object
                .and_then(|object| {
                    object
                        .get("is_default")
                        .or_else(|| object.get("isDefault"))
                        .or_else(|| object.get("default"))
                        .and_then(Value::as_bool)
                })
                .unwrap_or(false),
            default_effort,
            efforts,
        },
        effort_knowledge,
    })
}

fn parse_effort_array(value: &Value) -> Result<Vec<String>, GatewayFailure> {
    let values = value.as_array().ok_or(GatewayFailure::MalformedResponse)?;
    if values.len() > MAX_EFFORTS_PER_MODEL {
        return Err(GatewayFailure::TooManyEfforts);
    }
    let mut seen = HashSet::new();
    let mut efforts = Vec::with_capacity(values.len());
    for value in values {
        let effort = value
            .as_str()
            .filter(|effort| is_safe_effort(effort))
            .ok_or(GatewayFailure::MalformedResponse)?;
        if seen.insert(effort.to_string()) {
            efforts.push(effort.to_string());
        }
    }
    Ok(efforts)
}

fn parse_capability_efforts(
    object: &serde_json::Map<String, Value>,
) -> Result<Option<Vec<String>>, GatewayFailure> {
    let Some(effort) = object
        .get("capabilities")
        .and_then(Value::as_object)
        .and_then(|capabilities| capabilities.get("effort"))
    else {
        return Ok(None);
    };
    let levels = effort
        .as_object()
        .ok_or(GatewayFailure::MalformedResponse)?;
    if levels.len() > MAX_EFFORTS_PER_MODEL {
        return Err(GatewayFailure::TooManyEfforts);
    }
    let canonical = ["low", "medium", "high", "xhigh", "max", "ultra"];
    let mut supported = Vec::new();
    let mut seen = HashSet::new();
    for level in canonical {
        if levels
            .get(level)
            .and_then(Value::as_object)
            .and_then(|value| value.get("supported"))
            .and_then(Value::as_bool)
            == Some(true)
        {
            supported.push(level.to_string());
            seen.insert(level);
        }
    }
    let mut future_levels = levels
        .iter()
        .filter_map(|(level, value)| {
            (is_safe_effort(level)
                && !seen.contains(level.as_str())
                && value
                    .as_object()
                    .and_then(|value| value.get("supported"))
                    .and_then(Value::as_bool)
                    == Some(true))
            .then_some(level.clone())
        })
        .collect::<Vec<_>>();
    future_levels.sort();
    supported.extend(future_levels);
    Ok(Some(supported))
}

fn normalize_candidates(candidates: Vec<ModelCandidate>) -> Vec<NormalizedCandidate> {
    let mut normalized = Vec::<NormalizedCandidate>::new();
    let mut positions = HashMap::<String, usize>::new();
    let mut default_id = None;
    for candidate in candidates {
        if !is_safe_model_id(&candidate.model.id) {
            continue;
        }
        if candidate.model.is_default && default_id.is_none() {
            default_id = Some(candidate.model.id.clone());
        }
        let model = normalize_model(candidate);
        if let Some(position) = positions.get(&model.model.id).copied() {
            merge_duplicate(&mut normalized[position], model);
        } else if normalized.len() < MAX_GATEWAY_MODELS + MAX_LOCAL_MODELS {
            positions.insert(model.model.id.clone(), normalized.len());
            normalized.push(model);
        }
    }

    let default = default_id.as_deref().and_then(|id| {
        normalized
            .iter()
            .position(|candidate| candidate.model.id == id)
    });
    for (index, candidate) in normalized.iter_mut().enumerate() {
        candidate.model.is_default = Some(index) == default;
    }
    normalized
}

fn normalize_model(mut candidate: ModelCandidate) -> NormalizedCandidate {
    candidate.model.display_name = if is_safe_display_name(&candidate.model.display_name) {
        candidate
            .model
            .display_name
            .chars()
            .take(MAX_DISPLAY_NAME_CHARS)
            .collect()
    } else {
        candidate.model.id.clone()
    };
    if candidate.effort_knowledge == EffortKnowledge::Known {
        let mut seen = HashSet::new();
        candidate
            .model
            .efforts
            .retain(|effort| is_safe_effort(effort) && seen.insert(effort.clone()));
        if !candidate
            .model
            .default_effort
            .as_ref()
            .is_some_and(|effort| candidate.model.efforts.contains(effort))
        {
            candidate.model.default_effort = None;
        }
    } else {
        candidate.model.efforts.clear();
        candidate.model.default_effort = None;
    }
    NormalizedCandidate {
        model: candidate.model,
        effort_knowledge: candidate.effort_knowledge,
    }
}

fn merge_duplicate(existing: &mut NormalizedCandidate, duplicate: NormalizedCandidate) {
    existing.model.is_default |= duplicate.model.is_default;
    if existing.effort_knowledge == EffortKnowledge::Unknown
        && duplicate.effort_knowledge == EffortKnowledge::Known
    {
        existing.model.efforts = duplicate.model.efforts;
        existing.model.default_effort = duplicate.model.default_effort;
        existing.effort_knowledge = EffortKnowledge::Known;
    }
}

#[derive(Clone)]
struct NormalizedCandidate {
    model: LocalAgentModel,
    effort_knowledge: EffortKnowledge,
}

fn normalize_fallback_efforts(candidates: &[NormalizedCandidate]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut efforts = Vec::new();
    for effort in candidates
        .iter()
        .filter(|candidate| candidate.effort_knowledge == EffortKnowledge::Known)
        .flat_map(|candidate| candidate.model.efforts.iter().cloned())
    {
        if is_safe_effort(&effort) && seen.insert(effort.clone()) {
            efforts.push(effort);
        }
    }
    efforts
}

fn decide_preference(
    preference: &ModelPreference,
    configured: &ModelPreference,
    candidates: &[NormalizedCandidate],
    fallback_efforts: &[String],
    authority: CatalogAuthority,
) -> (PreferenceDecision, LaunchValidation) {
    let current = normalized_preference(preference);
    let configured = normalized_preference(configured);
    let default = candidates
        .iter()
        .find(|candidate| candidate.model.is_default);

    if current
        .model
        .as_deref()
        .is_some_and(|model| !is_safe_model_id(model))
    {
        return rejected(
            ModelPreference::default(),
            "the selected model identifier is invalid",
        );
    }
    if current
        .effort
        .as_deref()
        .is_some_and(|effort| !is_safe_effort(effort))
    {
        return rejected(
            clear_ui_effort(&current),
            "the selected reasoning effort is invalid",
        );
    }

    let actual_model = current.model.as_ref().or(configured.model.as_ref());
    let actual_effort = current.effort.as_ref().or(configured.effort.as_ref());
    if current.model.is_none()
        && configured
            .model
            .as_deref()
            .is_some_and(|model| !is_safe_model_id(model))
    {
        return (
            PreferenceDecision::Keep { unverified: false },
            LaunchValidation::Rejected {
                message: "the configured model identifier is invalid".to_string(),
            },
        );
    }
    if current.effort.is_none()
        && configured
            .effort
            .as_deref()
            .is_some_and(|effort| !is_safe_effort(effort))
    {
        return (
            PreferenceDecision::Keep { unverified: false },
            LaunchValidation::Rejected {
                message: "the configured reasoning effort is invalid".to_string(),
            },
        );
    }

    let selected = actual_model
        .map(String::as_str)
        .and_then(|id| candidates.iter().find(|candidate| candidate.model.id == id));
    if actual_model.is_some() && selected.is_none() {
        if authority == CatalogAuthority::Authoritative {
            if current.model.is_some() {
                return rejected(
                    ModelPreference::default(),
                    "the selected model is not reported by the local CLI",
                );
            }
            return (
                PreferenceDecision::Keep { unverified: false },
                LaunchValidation::Rejected {
                    message: "the configured model is not reported by the local CLI".to_string(),
                },
            );
        }
        let actual = ModelPreference {
            model: actual_model.cloned(),
            effort: actual_effort.cloned(),
        };
        return (
            PreferenceDecision::Keep { unverified: true },
            LaunchValidation::Allowed {
                preference: current,
                actual,
                unverified: true,
            },
        );
    }

    let selected = selected.or(default);
    let effort_knowledge = selected
        .map(|candidate| candidate.effort_knowledge)
        .unwrap_or_else(|| {
            if fallback_efforts.is_empty() {
                EffortKnowledge::Unknown
            } else {
                EffortKnowledge::Known
            }
        });
    let supported_efforts = selected
        .map(|candidate| candidate.model.efforts.as_slice())
        .unwrap_or(fallback_efforts);
    if let Some(effort) = actual_effort.map(String::as_str) {
        if effort_knowledge == EffortKnowledge::Known
            && !supported_efforts
                .iter()
                .any(|supported| supported == effort)
        {
            if current.effort.is_some() {
                return rejected(
                    clear_ui_effort(&current),
                    "the selected reasoning effort is not reported for the selected model",
                );
            }
            return (
                PreferenceDecision::Keep { unverified: false },
                LaunchValidation::Rejected {
                    message:
                        "the configured reasoning effort is not reported for the configured model"
                            .to_string(),
                },
            );
        }
    }

    let has_explicit_selection = actual_model.is_some() || actual_effort.is_some();
    let unverified = (has_explicit_selection && authority == CatalogAuthority::Partial)
        || (actual_effort.is_some() && effort_knowledge == EffortKnowledge::Unknown);
    let actual = ModelPreference {
        model: actual_model
            .cloned()
            .or_else(|| selected.map(|candidate| candidate.model.id.clone())),
        effort: actual_effort
            .cloned()
            .or_else(|| selected.and_then(|candidate| candidate.model.default_effort.clone())),
    };
    (
        PreferenceDecision::Keep { unverified },
        LaunchValidation::Allowed {
            preference: current,
            actual,
            unverified,
        },
    )
}

fn normalized_preference(preference: &ModelPreference) -> ModelPreference {
    ModelPreference {
        model: preference
            .model
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(str::to_string),
        effort: preference
            .effort
            .as_deref()
            .filter(|value| !value.is_empty())
            .map(str::to_string),
    }
}

fn clear_ui_effort(preference: &ModelPreference) -> ModelPreference {
    ModelPreference {
        model: preference.model.clone(),
        effort: None,
    }
}

fn rejected(replacement: ModelPreference, message: &str) -> (PreferenceDecision, LaunchValidation) {
    (
        PreferenceDecision::Replace {
            preference: replacement,
        },
        LaunchValidation::Rejected {
            message: message.to_string(),
        },
    )
}

fn is_safe_model_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_MODEL_ID_BYTES
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() || character.is_whitespace())
}

fn is_safe_display_name(value: &str) -> bool {
    !value.trim().is_empty() && value.trim() == value && !value.chars().any(char::is_control)
}

fn is_safe_effort(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_EFFORT_BYTES
        && value.as_bytes()[0].is_ascii_alphanumeric()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b':'))
}

fn is_safe_cursor(value: &str) -> bool {
    !value.is_empty() && value.len() <= MAX_CURSOR_BYTES && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Barrier;

    use super::*;

    fn model(
        id: &str,
        default: bool,
        efforts: &[&str],
        knowledge: EffortKnowledge,
    ) -> ModelCandidate {
        ModelCandidate {
            model: LocalAgentModel {
                id: id.to_string(),
                display_name: id.to_string(),
                is_default: default,
                default_effort: efforts.first().map(|effort| (*effort).to_string()),
                efforts: efforts.iter().map(|effort| (*effort).to_string()).collect(),
            },
            effort_knowledge: knowledge,
        }
    }

    fn request(
        provider: LocalAgentProvider,
        models: Vec<ModelCandidate>,
        authority: CatalogAuthority,
        preference: ModelPreference,
    ) -> ModelResolutionRequest {
        ModelResolutionRequest {
            provider,
            candidates: models,
            authority,
            preference,
            configured: ModelPreference::default(),
            gateway: None,
            force_refresh: false,
        }
    }

    fn gateway(base_url: &str) -> ClaudeGatewayCatalog {
        ClaudeGatewayCatalog::with_bearer_token(
            base_url.to_string(),
            "secret-token".to_string(),
            Some("x-gateway-tenant: private".to_string()),
        )
    }

    #[tokio::test]
    async fn codex_accepts_model_specific_max_and_ultra() {
        let strategy = ModelStrategy::default();
        for effort in ["max", "ultra"] {
            let resolution = strategy
                .resolve(request(
                    LocalAgentProvider::Codex,
                    vec![model(
                        "gpt-5.6-sol",
                        true,
                        &["low", "medium", "high", "xhigh", "max", "ultra"],
                        EffortKnowledge::Known,
                    )],
                    CatalogAuthority::Authoritative,
                    ModelPreference {
                        model: Some("gpt-5.6-sol".to_string()),
                        effort: Some(effort.to_string()),
                    },
                ))
                .await;
            assert!(matches!(
                resolution.launch_validation,
                LaunchValidation::Allowed {
                    unverified: false,
                    ..
                }
            ));
        }
    }

    #[tokio::test]
    async fn partial_unknown_capabilities_keep_future_safe_effort_unverified() {
        let resolution = ModelStrategy::default()
            .resolve(request(
                LocalAgentProvider::Codex,
                vec![model("future-model", true, &[], EffortKnowledge::Unknown)],
                CatalogAuthority::Partial,
                ModelPreference {
                    model: Some("future-model".to_string()),
                    effort: Some("ultra-v2".to_string()),
                },
            ))
            .await;
        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: true }
        );
        assert!(resolution.models[0].efforts.is_empty());
    }

    #[tokio::test]
    async fn authoritative_gateway_membership_does_not_invent_effort_capabilities() {
        let resolution = ModelStrategy::default()
            .resolve(request(
                LocalAgentProvider::Claude,
                vec![model("gpt-5.6-sol", true, &[], EffortKnowledge::Unknown)],
                CatalogAuthority::Authoritative,
                ModelPreference {
                    model: Some("gpt-5.6-sol".to_string()),
                    effort: Some("max".to_string()),
                },
            ))
            .await;

        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: true }
        );
        assert!(resolution.models[0].efforts.is_empty());
        assert!(resolution.warning.is_some());
        assert!(matches!(
            resolution.launch_validation,
            LaunchValidation::Allowed {
                unverified: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn authoritative_catalog_rejects_unknown_model_and_unsupported_effort() {
        let strategy = ModelStrategy::default();
        let base = vec![model(
            "known",
            true,
            &["low", "high"],
            EffortKnowledge::Known,
        )];
        let missing = strategy
            .resolve(request(
                LocalAgentProvider::Pi,
                base.clone(),
                CatalogAuthority::Authoritative,
                ModelPreference {
                    model: Some("missing".to_string()),
                    effort: None,
                },
            ))
            .await;
        assert!(matches!(
            missing.launch_validation,
            LaunchValidation::Rejected { .. }
        ));
        assert_eq!(
            missing.preference_decision,
            PreferenceDecision::Replace {
                preference: ModelPreference::default()
            }
        );
        let unsupported = strategy
            .resolve(request(
                LocalAgentProvider::Pi,
                base,
                CatalogAuthority::Authoritative,
                ModelPreference {
                    model: Some("known".to_string()),
                    effort: Some("max".to_string()),
                },
            ))
            .await;
        assert!(matches!(
            unsupported.launch_validation,
            LaunchValidation::Rejected { .. }
        ));
        assert_eq!(
            unsupported.preference_decision,
            PreferenceDecision::Replace {
                preference: ModelPreference {
                    model: Some("known".to_string()),
                    effort: None,
                }
            }
        );
    }

    #[tokio::test]
    async fn empty_ui_preference_preserves_cli_default_without_persisting_catalog_default() {
        let resolution = ModelStrategy::default()
            .resolve(request(
                LocalAgentProvider::Codex,
                vec![model(
                    "catalog-default",
                    true,
                    &["high"],
                    EffortKnowledge::Known,
                )],
                CatalogAuthority::Authoritative,
                ModelPreference::default(),
            ))
            .await;
        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: false }
        );
        assert!(matches!(
            resolution.launch_validation,
            LaunchValidation::Allowed {
                preference: ModelPreference {
                    model: None,
                    effort: None
                },
                actual: ModelPreference {
                    model: Some(ref model),
                    effort: Some(ref effort)
                },
                unverified: false
            } if model == "catalog-default" && effort == "high"
        ));
    }

    #[tokio::test]
    async fn pure_cli_default_does_not_warn_for_partial_or_invent_a_catalog_default() {
        let resolution = ModelStrategy::default()
            .resolve(request(
                LocalAgentProvider::Antigravity,
                vec![model(
                    "first-reported",
                    false,
                    &["high"],
                    EffortKnowledge::Known,
                )],
                CatalogAuthority::Partial,
                ModelPreference::default(),
            ))
            .await;
        assert!(!resolution.models[0].is_default);
        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: false }
        );
        assert!(resolution.warning.is_none());
    }

    #[tokio::test]
    async fn configured_values_are_validated_without_becoming_ui_preferences() {
        let strategy = ModelStrategy::default();
        for effort in ["max", "ultra"] {
            let mut configured = request(
                LocalAgentProvider::Codex,
                vec![model(
                    "gpt-5.6-sol",
                    true,
                    &["max", "ultra"],
                    EffortKnowledge::Known,
                )],
                CatalogAuthority::Authoritative,
                ModelPreference::default(),
            );
            configured.configured = ModelPreference {
                model: Some("gpt-5.6-sol".to_string()),
                effort: Some(effort.to_string()),
            };
            let resolution = strategy.resolve(configured).await;
            assert_eq!(
                resolution.preference_decision,
                PreferenceDecision::Keep { unverified: false }
            );
            assert!(matches!(
                resolution.launch_validation,
                LaunchValidation::Allowed {
                    preference: ModelPreference {
                        model: None,
                        effort: None
                    },
                    actual: ModelPreference {
                        model: Some(ref model),
                        effort: Some(ref actual_effort)
                    },
                    unverified: false
                } if model == "gpt-5.6-sol" && actual_effort == effort
            ));
        }

        let mut unsupported = request(
            LocalAgentProvider::Codex,
            vec![model(
                "gpt-5.6-luna",
                true,
                &["max"],
                EffortKnowledge::Known,
            )],
            CatalogAuthority::Authoritative,
            ModelPreference::default(),
        );
        unsupported.configured = ModelPreference {
            model: Some("gpt-5.6-luna".to_string()),
            effort: Some("ultra".to_string()),
        };
        let resolution = strategy.resolve(unsupported).await;
        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: false }
        );
        assert!(matches!(
            resolution.launch_validation,
            LaunchValidation::Rejected { ref message }
                if message.contains("configured reasoning effort")
        ));
    }

    #[tokio::test]
    async fn configured_custom_provider_future_effort_is_allowed_unverified() {
        let mut configured = request(
            LocalAgentProvider::Codex,
            Vec::new(),
            CatalogAuthority::Partial,
            ModelPreference::default(),
        );
        configured.configured = ModelPreference {
            model: Some("custom-provider/future-model".to_string()),
            effort: Some("ultra-v2".to_string()),
        };
        let resolution = ModelStrategy::default().resolve(configured).await;
        assert!(matches!(
            resolution.launch_validation,
            LaunchValidation::Allowed {
                unverified: true,
                ..
            }
        ));
        assert!(resolution.warning.is_some());
    }

    #[tokio::test]
    async fn partial_catalog_retains_missing_safe_model() {
        let resolution = ModelStrategy::default()
            .resolve(request(
                LocalAgentProvider::Antigravity,
                vec![model("known", true, &["high"], EffortKnowledge::Known)],
                CatalogAuthority::Partial,
                ModelPreference {
                    model: Some("custom/provider:model".to_string()),
                    effort: Some("future".to_string()),
                },
            ))
            .await;
        assert_eq!(
            resolution.preference_decision,
            PreferenceDecision::Keep { unverified: true }
        );
        assert!(matches!(
            resolution.launch_validation,
            LaunchValidation::Allowed {
                unverified: true,
                ..
            }
        ));
    }

    #[tokio::test]
    async fn models_are_stably_deduplicated_and_gain_known_capabilities() {
        let resolution = ModelStrategy::default()
            .resolve(request(
                LocalAgentProvider::Claude,
                vec![
                    model("opus", false, &[], EffortKnowledge::Unknown),
                    model("sonnet", true, &["low", "high"], EffortKnowledge::Known),
                    model("opus", true, &["max"], EffortKnowledge::Known),
                    model("haiku", false, &[], EffortKnowledge::Unknown),
                ],
                CatalogAuthority::Authoritative,
                ModelPreference::default(),
            ))
            .await;
        assert_eq!(
            resolution
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["opus", "sonnet", "haiku"]
        );
        assert_eq!(resolution.models[0].efforts, ["max"]);
        assert!(!resolution.models[0].is_default);
        assert!(resolution.models[1].is_default);
    }

    #[test]
    fn parses_anthropic_openai_and_cursor_shapes() {
        let anthropic = parse_gateway_page(
            br#"{"data":[{"id":"claude-opus-4-6","display_name":"Opus"}],"has_more":true,"last_id":"cursor-1"}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert_eq!(anthropic.models[0].model.id, "claude-opus-4-6");
        assert!(anthropic.has_more);
        assert_eq!(
            anthropic
                .next_cursor
                .as_ref()
                .map(|cursor| cursor.value.as_str()),
            Some("cursor-1")
        );
        assert_eq!(
            anthropic.next_cursor.unwrap().parameter,
            CursorParameter::AfterId
        );

        let openai = parse_gateway_page(
            br#"{"success":true,"models":[{"id":"gpt-5.6-sol","supportedEfforts":["max","ultra"]}],"pagination":{"next_cursor":"cursor-2"}}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert_eq!(openai.models[0].model.efforts, ["max", "ultra"]);
        assert_eq!(
            openai.next_cursor.unwrap(),
            GatewayCursor {
                value: "cursor-2".to_string(),
                parameter: CursorParameter::Cursor,
            }
        );

        let openai_last_id = parse_gateway_page(
            br#"{"object":"list","data":[{"id":"gpt-5.6-sol","object":"model","display_name":"Sol"}],"has_more":true,"last_id":"cursor-openai"}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert_eq!(
            openai_last_id.next_cursor.unwrap().parameter,
            CursorParameter::After
        );

        let nested = parse_gateway_page(
            br#"{"data":{"models":["gemini-2.5-pro"]},"meta":{"hasMore":false}}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert_eq!(nested.models[0].model.id, "gemini-2.5-pro");

        let nested_cursor = parse_gateway_page(
            br#"{"data":{"models":["gateway-model"],"has_more":true,"last_id":"cursor-3"}}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert!(nested_cursor.has_more);
        assert_eq!(
            nested_cursor.next_cursor.unwrap(),
            GatewayCursor {
                value: "cursor-3".to_string(),
                parameter: CursorParameter::After,
            }
        );

        let nested_pagination = parse_gateway_page(
            br#"{"data":{"models":["nested-model"],"pagination":{"has_more":true,"last_id":"cursor-4"}}}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert!(nested_pagination.has_more);
        assert_eq!(nested_pagination.next_cursor.unwrap().value, "cursor-4");

        let capabilities = parse_gateway_page(
            br#"{"data":[{"id":"claude-opus","capabilities":{"effort":{"low":{"supported":true},"medium":{"supported":false},"high":{"supported":true},"xhigh":{"supported":true},"max":{"supported":true}}}},{"id":"claude-haiku","capabilities":{"effort":{}}}]}"#,
            MAX_GATEWAY_MODELS,
        )
        .unwrap();
        assert_eq!(
            capabilities.models[0].model.efforts,
            ["low", "high", "xhigh", "max"]
        );
        assert_eq!(
            capabilities.models[0].effort_knowledge,
            EffortKnowledge::Known
        );
        assert!(capabilities.models[1].model.efforts.is_empty());
        assert_eq!(
            capabilities.models[1].effort_knowledge,
            EffortKnowledge::Known
        );

        let too_many_efforts = (0..=MAX_EFFORTS_PER_MODEL)
            .map(|index| format!("effort-{index}"))
            .collect::<Vec<_>>();
        let body = serde_json::json!({
            "data": [{"id": "too-many-efforts", "efforts": too_many_efforts}]
        });
        assert!(matches!(
            parse_gateway_page(body.to_string().as_bytes(), MAX_GATEWAY_MODELS),
            Err(GatewayFailure::TooManyEfforts)
        ));

        let capability_levels = (0..=MAX_EFFORTS_PER_MODEL)
            .map(|index| {
                (
                    format!("future-{index}"),
                    serde_json::json!({"supported": true}),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let body = serde_json::json!({
            "data": [{
                "id": "too-many-capabilities",
                "capabilities": {"effort": capability_levels}
            }]
        });
        assert!(matches!(
            parse_gateway_page(body.to_string().as_bytes(), MAX_GATEWAY_MODELS),
            Err(GatewayFailure::TooManyEfforts)
        ));
    }

    #[test]
    fn rejects_malformed_catalog_without_echoing_body() {
        let secret_body = br#"{"data":[{"id":"bad id","credential":"do-not-echo"}]}"#;
        let error = parse_gateway_page(secret_body, MAX_GATEWAY_MODELS).unwrap_err();
        assert_eq!(
            error.safe_message(),
            "Claude gateway model discovery returned malformed data."
        );
        assert!(!error.safe_message().contains("do-not-echo"));
        let long_id = "x".repeat(MAX_MODEL_ID_BYTES + 1);
        let body = serde_json::json!({"data":[{"id":long_id}]}).to_string();
        assert!(matches!(
            parse_gateway_page(body.as_bytes(), MAX_GATEWAY_MODELS),
            Err(GatewayFailure::MalformedResponse)
        ));
    }

    #[test]
    fn validates_gateway_transport_and_headers_without_echoing_secrets() {
        for invalid in [
            "http://example.com",
            "https://user:secret@example.com",
            "https://example.com/path?token=secret",
            "not a url",
        ] {
            let error = models_url(invalid).unwrap_err();
            assert_eq!(
                error.safe_message(),
                "Claude gateway model discovery configuration is invalid."
            );
            assert!(!error.safe_message().contains(invalid));
        }
        assert_eq!(
            models_url("http://127.2.3.4:8123/prefix").unwrap().path(),
            "/prefix/v1/models"
        );
        assert_eq!(
            models_url("https://example.com/v1/messages")
                .unwrap()
                .path(),
            "/v1/models"
        );
        let mut invalid_header = gateway("https://example.com");
        for name in ["host", "authorization", "x-api-key", "anthropic-version"] {
            invalid_header.custom_headers = Some(format!("{name}: secret"));
            let error = gateway_headers(&invalid_header).unwrap_err();
            assert!(!error.safe_message().contains("secret"));
        }
    }

    struct ScriptedFetcher {
        calls: AtomicUsize,
        responses: std::sync::Mutex<VecDeque<Result<Vec<ModelCandidate>, GatewayFailure>>>,
        barrier: Option<Arc<Barrier>>,
    }

    impl ScriptedFetcher {
        fn new(responses: Vec<Result<Vec<ModelCandidate>, GatewayFailure>>) -> Self {
            Self {
                calls: AtomicUsize::new(0),
                responses: std::sync::Mutex::new(responses.into()),
                barrier: None,
            }
        }
    }

    impl GatewayFetcher for ScriptedFetcher {
        fn fetch(&self, _gateway: ClaudeGatewayCatalog) -> GatewayFuture {
            self.calls.fetch_add(1, Ordering::SeqCst);
            let response = self.responses.lock().unwrap().pop_front().unwrap();
            let barrier = self.barrier.clone();
            Box::pin(async move {
                if let Some(barrier) = barrier {
                    barrier.wait().await;
                }
                response
            })
        }
    }

    fn gateway_request(force_refresh: bool) -> ModelResolutionRequest {
        let mut request = request(
            LocalAgentProvider::Claude,
            vec![model("opus", true, &["high"], EffortKnowledge::Known)],
            CatalogAuthority::Partial,
            ModelPreference {
                model: Some("opus".to_string()),
                effort: Some("high".to_string()),
            },
        );
        request.gateway = Some(gateway("https://gateway.invalid"));
        request.force_refresh = force_refresh;
        request
    }

    #[tokio::test]
    async fn claude_keeps_local_aliases_before_sixteen_mixed_gateway_models() {
        let remote_ids = [
            "claude-3-5-haiku-20241022",
            "claude-3-5-sonnet-20241022",
            "claude-3-7-sonnet-20250219",
            "claude-haiku-4-5-20251001",
            "claude-opus-4-1-20250805",
            "claude-opus-4-20250514",
            "claude-opus-4-5-20251101",
            "claude-opus-4-6",
            "claude-opus-4-7",
            "claude-opus-4-8",
            "claude-opus-5",
            "claude-sonnet-4-20250514",
            "claude-sonnet-4-5-20250929",
            "gemini-2.5-pro",
            "gpt-5-codex",
            "gpt-5.6-sol",
        ];
        let fetcher = Arc::new(ScriptedFetcher::new(vec![Ok(remote_ids
            .iter()
            .map(|id| model(id, false, &[], EffortKnowledge::Unknown))
            .collect())]));
        let strategy =
            ModelStrategy::with_fetcher(fetcher, Duration::from_secs(60), Duration::from_secs(15));
        let mut request = request(
            LocalAgentProvider::Claude,
            ["fable", "opus", "sonnet", "haiku", "custom-route"]
                .into_iter()
                .map(|id| model(id, id == "opus", &[], EffortKnowledge::Unknown))
                .collect(),
            CatalogAuthority::Partial,
            ModelPreference::default(),
        );
        request.configured.model = Some("gpt-5.6-sol".to_string());
        request.gateway = Some(gateway("https://gateway.invalid"));

        let resolution = strategy.resolve(request).await;
        let ids = resolution
            .models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(
            &ids[..5],
            ["fable", "opus", "sonnet", "haiku", "custom-route"]
        );
        assert_eq!(&ids[5..], remote_ids);
        assert!(resolution
            .models
            .iter()
            .find(|model| model.id == "gpt-5.6-sol")
            .is_some_and(|model| model.is_default));
    }

    #[tokio::test]
    async fn successful_gateway_catalog_is_cached_and_force_refresh_bypasses_ttl() {
        let fetcher = Arc::new(ScriptedFetcher::new(vec![
            Ok(vec![model(
                "remote-one",
                false,
                &[],
                EffortKnowledge::Unknown,
            )]),
            Ok(vec![model(
                "remote-two",
                false,
                &[],
                EffortKnowledge::Unknown,
            )]),
        ]));
        let strategy = ModelStrategy::with_fetcher(
            fetcher.clone(),
            Duration::from_secs(60),
            Duration::from_secs(15),
        );
        let first = strategy.resolve(gateway_request(false)).await;
        let cached = strategy.resolve(gateway_request(false)).await;
        let forced = strategy.resolve(gateway_request(true)).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
        assert_eq!(
            first
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["opus", "remote-one"]
        );
        assert_eq!(
            cached
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["opus", "remote-one"]
        );
        assert_eq!(
            forced
                .models
                .iter()
                .map(|model| model.id.as_str())
                .collect::<Vec<_>>(),
            ["opus", "remote-two"]
        );
    }

    #[tokio::test]
    async fn failure_cache_and_stale_if_error_preserve_last_success() {
        let fetcher = Arc::new(ScriptedFetcher::new(vec![
            Ok(vec![model("remote", false, &[], EffortKnowledge::Unknown)]),
            Err(GatewayFailure::RateLimited),
        ]));
        let strategy = ModelStrategy::with_fetcher(
            fetcher.clone(),
            Duration::from_secs(60),
            Duration::from_secs(15),
        );
        let _ = strategy.resolve(gateway_request(false)).await;
        let stale = strategy.resolve(gateway_request(true)).await;
        let cached_failure = strategy.resolve(gateway_request(false)).await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 2);
        assert_eq!(stale.warning.as_deref(), Some(GATEWAY_STALE_WARNING));
        assert_eq!(
            cached_failure.warning.as_deref(),
            Some(GATEWAY_STALE_WARNING)
        );
        assert!(stale.models.iter().any(|model| model.id == "remote"));
    }

    #[tokio::test]
    async fn concurrent_force_refreshes_share_one_flight() {
        let barrier = Arc::new(Barrier::new(2));
        let fetcher = Arc::new(ScriptedFetcher {
            calls: AtomicUsize::new(0),
            responses: std::sync::Mutex::new(
                vec![Ok(vec![model(
                    "remote",
                    false,
                    &[],
                    EffortKnowledge::Unknown,
                )])]
                .into(),
            ),
            barrier: Some(barrier.clone()),
        });
        let strategy = Arc::new(ModelStrategy::with_fetcher(
            fetcher.clone(),
            Duration::from_secs(60),
            Duration::from_secs(15),
        ));
        let first = tokio::spawn({
            let strategy = strategy.clone();
            async move { strategy.resolve(gateway_request(true)).await }
        });
        while fetcher.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let second = tokio::spawn({
            let strategy = strategy.clone();
            async move { strategy.resolve(gateway_request(true)).await }
        });
        barrier.wait().await;
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        assert!(first.warning.is_none());
        assert!(second.warning.is_none());
    }

    #[tokio::test]
    async fn concurrent_initial_reads_share_one_fresh_result() {
        let barrier = Arc::new(Barrier::new(2));
        let fetcher = Arc::new(ScriptedFetcher {
            calls: AtomicUsize::new(0),
            responses: std::sync::Mutex::new(
                vec![Ok(vec![model(
                    "remote",
                    false,
                    &[],
                    EffortKnowledge::Unknown,
                )])]
                .into(),
            ),
            barrier: Some(barrier.clone()),
        });
        let strategy = Arc::new(ModelStrategy::with_fetcher(
            fetcher.clone(),
            Duration::from_secs(60),
            Duration::from_secs(15),
        ));
        let first = tokio::spawn({
            let strategy = strategy.clone();
            async move { strategy.resolve(gateway_request(false)).await }
        });
        while fetcher.calls.load(Ordering::SeqCst) == 0 {
            tokio::task::yield_now().await;
        }
        let second = tokio::spawn({
            let strategy = strategy.clone();
            async move { strategy.resolve(gateway_request(false)).await }
        });
        barrier.wait().await;
        let first = first.await.unwrap();
        let second = second.await.unwrap();
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), 1);
        assert!(first.warning.is_none());
        assert!(second.warning.is_none());
    }

    #[tokio::test]
    async fn gateway_cache_evicts_inactive_catalogs_at_the_key_limit() {
        let catalog_count = MAX_GATEWAY_CACHE_KEYS + 8;
        let fetcher = Arc::new(ScriptedFetcher::new(
            (0..catalog_count)
                .map(|index| {
                    Ok(vec![model(
                        &format!("remote-{index}"),
                        false,
                        &[],
                        EffortKnowledge::Unknown,
                    )])
                })
                .collect(),
        ));
        let strategy = ModelStrategy::with_fetcher(
            fetcher.clone(),
            Duration::from_secs(60),
            Duration::from_secs(15),
        );

        for index in 0..catalog_count {
            let mut request = gateway_request(false);
            request.gateway = Some(gateway(&format!("https://gateway-{index}.invalid")));
            let resolution = strategy.resolve(request).await;
            assert!(resolution.warning.is_none());
        }

        let cache = strategy.cache.lock().await;
        assert_eq!(fetcher.calls.load(Ordering::SeqCst), catalog_count);
        assert!(cache.entries.len() <= MAX_GATEWAY_CACHE_KEYS);
        assert!(cache.flights.len() <= MAX_GATEWAY_CACHE_KEYS);
    }

    #[test]
    fn gateway_cache_never_exceeds_its_limit_when_every_slot_is_active() {
        let mut cache = GatewayCache::default();
        let mut active_flights = Vec::new();
        for index in 0..MAX_GATEWAY_CACHE_KEYS {
            let key = gateway(&format!("https://active-{index}.invalid")).cache_key();
            cache.entries.insert(key, GatewayCacheEntry::default());
            let flight = Arc::new(Mutex::new(()));
            cache.flights.insert(key, flight.clone());
            active_flights.push(flight);
        }
        let extra = gateway("https://extra.invalid").cache_key();

        assert!(!cache.ensure_capacity_for(extra));
        assert_eq!(cache.entries.len(), MAX_GATEWAY_CACHE_KEYS);
        assert_eq!(cache.flights.len(), MAX_GATEWAY_CACHE_KEYS);

        drop(active_flights);
        assert!(cache.ensure_capacity_for(extra));
        assert_eq!(cache.entries.len(), MAX_GATEWAY_CACHE_KEYS - 1);
        assert_eq!(cache.flights.len(), MAX_GATEWAY_CACHE_KEYS - 1);
    }

    async fn one_shot_server(response: &'static [u8], hold_open: bool) -> String {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0_u8; 4096];
            let _ = socket.read(&mut request).await;
            if hold_open {
                tokio::time::sleep(Duration::from_secs(1)).await;
            } else {
                socket.write_all(response).await.unwrap();
            }
        });
        format!("http://{address}")
    }

    async fn scripted_http_server(
        responses: Vec<(Vec<u8>, Duration)>,
    ) -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(std::sync::Mutex::new(Vec::new()));
        let captured = requests.clone();
        tokio::spawn(async move {
            for (response, delay) in responses {
                let (mut socket, _) = listener.accept().await.unwrap();
                let mut request = [0_u8; 4096];
                let bytes = socket.read(&mut request).await.unwrap();
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&request[..bytes]).into_owned());
                tokio::time::sleep(delay).await;
                let _ = socket.write_all(&response).await;
            }
        });
        (format!("http://{address}"), requests)
    }

    fn ok_response(body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[tokio::test]
    async fn reqwest_adapter_fetches_cursor_pages_in_gateway_order() {
        let (url, requests) = scripted_http_server(vec![
            (
                ok_response(
                    r#"{"data":[{"id":"alias-first"}],"has_more":true,"last_id":"cursor-1"}"#,
                ),
                Duration::ZERO,
            ),
            (
                ok_response(r#"{"data":[{"id":"remote-second"}],"has_more":false}"#),
                Duration::ZERO,
            ),
        ])
        .await;
        let models = ReqwestGatewayFetcher::new(Duration::from_secs(1))
            .fetch(gateway(&url))
            .await
            .unwrap();
        assert_eq!(
            models
                .iter()
                .map(|candidate| candidate.model.id.as_str())
                .collect::<Vec<_>>(),
            ["alias-first", "remote-second"]
        );
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[0].contains("limit=1000"));
        assert!(requests[1].contains("after=cursor-1"));
        assert!(!requests[1].contains("after_id="));
    }

    #[tokio::test]
    async fn reqwest_adapter_uses_after_id_for_anthropic_model_envelopes() {
        let (url, requests) = scripted_http_server(vec![
            (
                ok_response(
                    r#"{"data":[{"id":"claude-opus","type":"model","display_name":"Opus"}],"has_more":true,"last_id":"cursor-1"}"#,
                ),
                Duration::ZERO,
            ),
            (
                ok_response(r#"{"data":[],"has_more":false}"#),
                Duration::ZERO,
            ),
        ])
        .await;

        ReqwestGatewayFetcher::new(Duration::from_secs(1))
            .fetch(gateway(&url))
            .await
            .unwrap();
        let requests = requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert!(requests[1].contains("after_id=cursor-1"));
        assert!(!requests[1].contains("after=cursor-1"));
    }

    #[tokio::test]
    async fn reqwest_adapter_keeps_pagination_across_timeout_windows_without_replaying_pages() {
        let delayed = Duration::from_millis(20);
        let (url, requests) = scripted_http_server(vec![
            (
                ok_response(r#"{"data":[],"has_more":true,"last_id":"cursor-1"}"#),
                delayed,
            ),
            (ok_response(r#"{"data":[],"has_more":false}"#), delayed),
        ])
        .await;
        let models = ReqwestGatewayFetcher::new(Duration::from_millis(30))
            .fetch(gateway(&url))
            .await
            .unwrap();
        assert!(models.is_empty());
        assert_eq!(requests.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn reqwest_adapter_rejects_redirect_and_sanitizes_http_failures() {
        let redirect_url = one_shot_server(
            b"HTTP/1.1 302 Found\r\nLocation: https://secret.invalid/private\r\nContent-Length: 0\r\n\r\n",
            false,
        )
        .await;
        let redirect = ReqwestGatewayFetcher::new(Duration::from_secs(1))
            .fetch(gateway(&redirect_url))
            .await
            .unwrap_err();
        assert_eq!(
            redirect.safe_message(),
            "Claude gateway model discovery does not permit redirects."
        );

        for (status, expected) in [
            (
                "401 Unauthorized",
                "Claude gateway model discovery was not authorized.",
            ),
            (
                "404 Not Found",
                "Claude gateway model discovery endpoint is unavailable.",
            ),
            (
                "429 Too Many Requests",
                "Claude gateway model discovery was rate limited.",
            ),
            (
                "503 Service Unavailable",
                "Claude gateway model discovery is temporarily unavailable.",
            ),
        ] {
            let response =
                format!("HTTP/1.1 {status}\r\nContent-Length: 17\r\n\r\nsecret-body-value");
            let leaked: &'static [u8] = Box::leak(response.into_bytes().into_boxed_slice());
            let url = one_shot_server(leaked, false).await;
            let failure = ReqwestGatewayFetcher::new(Duration::from_secs(1))
                .fetch(gateway(&url))
                .await
                .unwrap_err();
            assert_eq!(failure.safe_message(), expected);
            assert!(!failure.safe_message().contains("secret-body-value"));
        }
    }

    #[tokio::test]
    async fn reqwest_adapter_bounds_timeout_response_size_models_and_pages() {
        let timeout_url = one_shot_server(b"", true).await;
        let started = tokio::time::Instant::now();
        let timeout = ReqwestGatewayFetcher::new(Duration::from_millis(25))
            .fetch(gateway(&timeout_url))
            .await
            .unwrap_err();
        assert!(started.elapsed() >= Duration::from_millis(75));
        assert_eq!(
            timeout.safe_message(),
            "Claude gateway model discovery timed out."
        );

        let oversized = vec![b'x'; MAX_GATEWAY_RESPONSE_BYTES + 1];
        let body: &'static [u8] = Box::leak(oversized.into_boxed_slice());
        let response =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", body.len()).into_bytes();
        let mut response = response;
        response.extend_from_slice(body);
        let leaked: &'static [u8] = Box::leak(response.into_boxed_slice());
        let url = one_shot_server(leaked, false).await;
        let too_large = ReqwestGatewayFetcher::new(Duration::from_secs(1))
            .fetch(gateway(&url))
            .await
            .unwrap_err();
        assert!(matches!(too_large, GatewayFailure::ResponseTooLarge));

        let models = (0..=MAX_GATEWAY_MODELS)
            .map(|index| format!(r#"{{"id":"model-{index}"}}"#))
            .collect::<Vec<_>>()
            .join(",");
        let page = format!(r#"{{"data":[{models}]}}"#);
        assert!(matches!(
            parse_gateway_page(page.as_bytes(), MAX_GATEWAY_MODELS),
            Err(GatewayFailure::TooManyModels)
        ));
        assert!(matches!(
            parse_gateway_page(br#"{"data":["one","two"]}"#, 1),
            Err(GatewayFailure::TooManyModels)
        ));

        let page =
            parse_gateway_page(br#"{"data":[],"has_more":true}"#, MAX_GATEWAY_MODELS).unwrap();
        assert!(page.next_cursor.is_none());

        let page_responses = (0..MAX_GATEWAY_PAGES)
            .map(|index| {
                (
                    ok_response(&format!(
                        r#"{{"data":[],"has_more":true,"last_id":"cursor-{index}"}}"#
                    )),
                    Duration::ZERO,
                )
            })
            .collect();
        let (url, _) = scripted_http_server(page_responses).await;
        let too_many_pages = ReqwestGatewayFetcher::new(Duration::from_secs(1))
            .fetch(gateway(&url))
            .await
            .unwrap_err();
        assert!(matches!(too_many_pages, GatewayFailure::TooManyPages));
    }

    #[test]
    fn cache_fingerprint_changes_without_being_printable() {
        let first = gateway("https://gateway.invalid");
        let mut second = gateway("https://gateway.invalid");
        second.credential = ClaudeGatewayCredential::ApiKey("other-secret".to_string());
        assert!(first.cache_key() != second.cache_key());
    }
}
