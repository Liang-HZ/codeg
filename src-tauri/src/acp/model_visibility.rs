//! WHICH of the model rows an agent advertises codeg shows the user.
//!
//! An ACP agent's `model` config option lists everything its adapter can NAME,
//! not what the machine's credentials can actually RUN. OpenCode 2.x is the
//! measured case (2026-10-15, v2.0.28): `session/new` advertises the whole
//! models.dev catalog — 467 rows across ten providers — while the user's
//! `auth.json` holds two, so 89 rows belong to providers whose first prompt
//! would fail with "no credentials", and the agent's own default `currentValue`
//! (`nvidia/…`) is one of them. pi-acp is the second: 335 rows advertised
//! against two credentialed providers.
//!
//! This module is the per-agent display-side policy:
//!
//! - The availability snapshot is taken ONCE per launch (`compute`, stored on
//!   `SessionState::model_availability` at spawn). A fresh connect re-reads the
//!   fact sources, so `opencode auth login` reaches the NEXT session without a
//!   codeg restart.
//! - Filtering is applied at the single emit choke point
//!   (`connection::emit_session_config_options_values`), so the composer, the
//!   `/`-grouped model picker and the delegation "default model" probe all read
//!   one list — while every DECISION path (the wire `set`, preference replay,
//!   retirement healing) keeps reading the agent's raw list.
//! - Only the model option is ever touched (`is_model_config_option`'s dual
//!   signal, same as the connection's); `thought_level`/`mode`/`fast`/… travel
//!   byte-for-byte.
//! - The row whose value equals `currentValue` is always kept — the session IS
//!   on that model, and hiding it would make the composer show something the
//!   conversation is not running. No fallback, no silent `set`.
//!
//! Fact sources per agent:
//!
//! - **OpenCode**: `auth.json` keys under `<XDG data>/opencode/` (only keys
//!   whose value is a JSON object — the credential cascade also writes a
//!   top-level `api_key` STRING, which is not a provider), union the `provider`
//!   object's keys of every config file OpenCode reads — `opencode.json` (2.x),
//!   `opencode.jsonc` (the scaffold OpenCode 1.x creates AND parses; verified
//!   against 1.19.1 that a provider planted there reaches session/new), legacy
//!   `config.json` — the user explicitly configured those models, they must
//!   stay), plus the Zen
//!   (`opencode`) provider's free subset from the bundled models.dev snapshot
//!   when Zen itself is not logged in.
//! - **OpenCode desktop (same agent, third source)**: the model page's
//!   per-model toggles, persisted in the desktop app's `drafts.sqlite` row
//!   `opencode.global.dat`/`model`. These materialize near the whole catalog,
//!   so a provider the desktop has opinions about becomes opt-in: only its
//!   `show` rows survive, and a `show` outranks the credential and Zen-pricing
//!   inferences (the desktop reaches Zen/Console-account models `auth.json`
//!   never sees — measured 2026-10-16: 9 of 15 shows on unauthenticated
//!   providers). Fail-SOFT, unlike the file tiers: every read failure leaves
//!   the policy computed so far untouched.
//! - **Pi**: `~/.pi/agent/auth.json` keys union `models.json` `providers` keys
//!   union `settings.json` `defaultProvider` (the provider the session's
//!   current value comes from).
//!
//! Fail-open semantics, in three tiers:
//!
//! 1. The fact-source location cannot be resolved (XDG/home both unresolvable,
//!    the pi agent dir does not exist) → [`ModelAvailability::Unfiltered`],
//!    logged — hiding rows off a location we could not even find would be a
//!    guess.
//! 2. The location is known and the auth file is MISSING → authoritative
//!    emptiness: keep filtering with the remaining sources (custom providers ∪
//!    Zen free for OpenCode; models.json ∪ defaultProvider for pi). A
//!    never-logged-in machine is exactly the case this feature exists for, so
//!    reading "empty" and giving up would re-open the original bug.
//! 3. A file that EXISTS cannot be read or parsed → [`ModelAvailability::
//!    Unfiltered`], logged — a parse failure is not evidence.
//!
//! And the selector-level guard: if filtering would leave the model select with
//! zero rows, the WHOLE original list is put back. An empty selector means the
//! policy misread the shape, never that the user has nothing to select.
//!
//! Deliberately out of scope for now: joining the launch `runtime_env` against
//! the models.dev `env` names (marked as the extension point inside
//! `opencode_availability`), and any pi env join (pi's provider-id space
//! diverges from every other catalog — `vercel-ai-gateway` vs `vercel`). Custom
//! agents are never filtered: their bridges (zcode) filter upstream, and
//! codebuddy-cn/intl share the built-in judgment (no action).

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};

use agent_client_protocol::schema::v1::{
    SessionConfigKind, SessionConfigOption, SessionConfigOptionCategory, SessionConfigSelect,
    SessionConfigSelectGroup, SessionConfigSelectOption, SessionConfigSelectOptions,
};

use crate::models::agent::AgentType;

/// The conventional id of a model selector. ACP reserves none — `category:
/// "model"` is the spec-level signal — but every agent codeg drives spells the
/// id this way, and the frontend accepts either. Mirror of connection.rs's
/// `MODEL_CONFIG_OPTION_ID`.
const MODEL_CONFIG_OPTION_ID: &str = "model";

/// OpenCode's own aggregated provider (the Zen gateway) in the models.dev
/// catalog and in `auth.json`.
const ZEN_PROVIDER_ID: &str = "opencode";

/// Per-launch model visibility for one connection.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub enum ModelAvailability {
    /// No policy for this agent (or the policy failed open): every advertised
    /// row travels as-is.
    #[default]
    Unfiltered,
    /// A restricted view. Computed against the launch's fact sources; applied
    /// only at the emit path.
    Restricted(RestrictedAvailability),
}

/// The keep-rules behind [`ModelAvailability::Restricted`].
///
/// A row's provider is the first `/`-separated segment of its value
/// (`vercel/anthropic/claude-x` → `vercel`; same meaning as the frontend's
/// group prefix). A row is kept when:
///
/// - its value equals the select's `currentValue` (constant rule, not a field —
///   it needs the option, not the policy), or
/// - its exact value is in [`Self::shown_models`] — the OpenCode desktop's
///   per-row `show` is the user's most explicit word and outranks every
///   inference below, or
/// - its provider is in [`Self::providers`], or
/// - its provider is in [`Self::hidden_models`] and the model is NOT in that
///   provider's hidden set — notably a model id the provider's catalog has
///   never heard of stays (per-row fail-open), or
/// - its value has no `/` at all, so it cannot be attributed to any provider
///   (fail-open).
///
/// Otherwise it is dropped — in particular every non-shown row of a provider
/// with desktop opinions ([`Self::shown_models_providers`]): the desktop's
/// per-model toggles materialize near the whole catalog, so an opinionated
/// provider is opt-in. A provider is never in both [`Self::providers`] and
/// [`Self::hidden_models`].
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RestrictedAvailability {
    /// Provider prefixes whose rows are kept whole (authenticated providers,
    /// explicitly configured providers, pi's default provider).
    pub providers: HashSet<String>,
    /// Providers with a PARTIAL availability: the set lists the model ids
    /// positively known unavailable, all others (including unknown ids) pass.
    ///
    /// This is a hide-list rather than a keep-list on purpose: Zen's free
    /// subset is what we can name cheaply, but the ACP row set and the bundled
    /// snapshot are known to disagree (measured: 41 Zen rows against 118–122
    /// snapshot entries), and an ACP-only model the snapshot does not carry
    /// yet must not be hidden just because it is newer than our snapshot —
    /// so the computable direction is "these are known to cost money", and
    /// the rest fails open per row.
    pub hidden_models: HashMap<String, HashSet<String>>,
    /// Providers the OpenCode desktop app's model page has toggle entries for
    /// (`drafts.sqlite` → `opencode.global.dat`/`model`): for these, visibility
    /// is opt-in — only [`Self::shown_models`] rows survive. Empty when the
    /// desktop has no state (CLI-only machines) or it could not be read
    /// (fail-soft: this source never breaks the file-derived policy).
    pub shown_models_providers: HashSet<String>,
    /// Exact row values (`providerID/modelID`) the desktop marks `show`. A hit
    /// here keeps the row outright — it outranks the credential and Zen-pricing
    /// inferences (measured 2026-10-16: 9 of this machine's 15 shows sit on
    /// providers `auth.json` does not carry, because the desktop reaches them
    /// through its Console account), and it can only ever ADD rows the user
    /// explicitly enabled.
    pub shown_models: HashSet<String>,
}

/// The availability policy for a launch with `agent_type` and the merged
/// `runtime_env` its process is spawned with. Called once per spawn; file IO is
/// a few small reads. `runtime_env` is unused by the OpenCode policy today (the
/// env join is a later step) but is what the pi policy resolves its agent dir
/// against.
pub fn compute(agent_type: AgentType, runtime_env: &BTreeMap<String, String>) -> ModelAvailability {
    match agent_type {
        AgentType::OpenCode => attach_desktop_visibility(
            opencode_availability(
                &crate::commands::acp::opencode_auth_json_path(),
                &crate::commands::acp::opencode_config_candidates(),
            ),
            read_desktop_visibility(),
        ),
        AgentType::Pi => pi_availability(&crate::commands::acp::pi_agent_dir_for_env(runtime_env)),
        // The thirteen other built-ins need no policy: Claude/Gemini/Grok/
        // Qoder/CodeBuddy-family/Antigravity/DeepSeek/OpenClaw/Hermes read
        // their list off the same account the credentials open (or off the
        // user's own gateway config); Codex/Kimi/Cursor/Cline either fail
        // closed before listing anything unauthenticated, or are already
        // mediated by codeg (catalog injection, provider pin). Custom agents:
        // the bridge filters upstream; never second-guess it here.
        _ => ModelAvailability::Unfiltered,
    }
}

/// Apply the policy to an advertised config-option list. `Unfiltered` returns
/// the list untouched; a `Restricted` policy rewrites only the model SELECT —
/// every other option, and every non-select model option, passes through
/// exactly.
pub fn filter_model_options(
    availability: &ModelAvailability,
    config_options: Vec<SessionConfigOption>,
) -> Vec<SessionConfigOption> {
    let ModelAvailability::Restricted(policy) = availability else {
        return config_options;
    };

    let original = config_options.clone();
    let mut emptied_model_select = false;
    let filtered: Vec<SessionConfigOption> = config_options
        .into_iter()
        .map(|option| filter_config_option(policy, option, &mut emptied_model_select))
        .collect();

    // The zero-row guard: a model selector with nothing left in it means the
    // policy misread this agent's shape (not that the user has no choices), so
    // the whole original list goes back — all options, unfiltered.
    if emptied_model_select {
        return original;
    }
    filtered
}

/// Rewrite one option. Non-model options and non-select model options return
/// unchanged. Sets `emptied` when a model select lost every row (the caller
/// reverts the whole list then).
fn filter_config_option(
    policy: &RestrictedAvailability,
    mut option: SessionConfigOption,
    emptied: &mut bool,
) -> SessionConfigOption {
    if !is_model_config_option(&option) {
        return option;
    }
    // Build the replacement first (shared borrow), so the fall-out paths can
    // move `option` back out untouched.
    let replacement = match &option.kind {
        SessionConfigKind::Select(select) => Some((
            select.current_value.clone(),
            filter_select_options(policy, select),
        )),
        _ => None,
    };
    let Some((current_value, filtered_options)) = replacement else {
        return option;
    };
    if select_row_count(&filtered_options) == 0 {
        *emptied = true;
        return option;
    }
    option.kind =
        SessionConfigKind::Select(agent_client_protocol::schema::v1::SessionConfigSelect::new(
            current_value,
            filtered_options,
        ));
    option
}

/// Whether an advertised option IS the agent's model selector — the
/// `category` signal or the conventional `model` id, the same pair
/// connection.rs's `is_model_config_option` checks (kept as the module's own
/// twin so the policy is self-contained).
fn is_model_config_option(option: &SessionConfigOption) -> bool {
    matches!(option.category, Some(SessionConfigOptionCategory::Model))
        || option.id.to_string() == MODEL_CONFIG_OPTION_ID
}

/// Filter a select's option set: flat rows one by one, grouped rows per group
/// with emptied groups dropped (a bare group header with no rows under it
/// renders as a broken control).
fn filter_select_options(
    policy: &RestrictedAvailability,
    select: &SessionConfigSelect,
) -> SessionConfigSelectOptions {
    let current_value = select.current_value.to_string();
    match &select.options {
        SessionConfigSelectOptions::Ungrouped(rows) => {
            SessionConfigSelectOptions::Ungrouped(filter_rows(policy, &current_value, rows))
        }
        SessionConfigSelectOptions::Grouped(groups) => SessionConfigSelectOptions::Grouped(
            groups
                .iter()
                .filter_map(|group| {
                    let rows = filter_rows(policy, &current_value, &group.options);
                    if rows.is_empty() {
                        return None;
                    }
                    Some(
                        SessionConfigSelectGroup::new(
                            group.group.clone(),
                            group.name.clone(),
                            rows,
                        )
                        .meta(group.meta.clone()),
                    )
                })
                .collect(),
        ),
        // non_exhaustive: a future select shape is passed through unchanged
        // (fail-open — we cannot judge rows we do not understand).
        other => other.clone(),
    }
}

fn filter_rows(
    policy: &RestrictedAvailability,
    current_value: &str,
    rows: &[SessionConfigSelectOption],
) -> Vec<SessionConfigSelectOption> {
    rows.iter()
        .filter(|row| row_is_kept(policy, current_value, &row.value.to_string()))
        .cloned()
        .collect()
}

/// The keep decision for ONE row value. See [`RestrictedAvailability`] for the
/// contract and each fail-open case.
fn row_is_kept(policy: &RestrictedAvailability, current_value: &str, value: &str) -> bool {
    if value == current_value {
        return true;
    }
    // The desktop's per-row `show` outranks everything below: it can rescue a
    // row the credential or Zen-pricing inferences would drop, but it can only
    // ever add rows the user explicitly enabled.
    if policy.shown_models.contains(value) {
        return true;
    }
    let Some((provider, model)) = value.split_once('/') else {
        // No provider segment: nothing to judge it against. Fail open rather
        // than hide a row whose shape we do not recognize.
        return true;
    };
    // A provider with desktop opinions is opt-in: everything but its `show`
    // rows (handled above) is dropped, whatever the rules below would say.
    if policy.shown_models_providers.contains(provider) {
        return false;
    }
    if policy.providers.contains(provider) {
        return true;
    }
    match policy.hidden_models.get(provider) {
        // Unknown model id under a partially-available provider → kept.
        Some(hidden) => !hidden.contains(model),
        None => false,
    }
}

/// How many rows a filtered select would show. A future (unknown) select shape
/// is passed through by [`filter_select_options`], so it can never be the
/// empty-selector case.
fn select_row_count(options: &SessionConfigSelectOptions) -> usize {
    match options {
        SessionConfigSelectOptions::Ungrouped(rows) => rows.len(),
        SessionConfigSelectOptions::Grouped(groups) => groups.iter().map(|g| g.options.len()).sum(),
        _ => 1,
    }
}

/// What `read_json_object_file` found.
enum JsonObjectFile {
    /// The file does not exist (or is a dangling symlink).
    Missing,
    /// The file exists but cannot be read, is not JSON, or is not a JSON
    /// object.
    Unparsable,
    Parsed(serde_json::Map<String, serde_json::Value>),
}

/// Tri-state JSON-object read: "missing" and "exists but is garbage" are
/// different FACTS and the policy must treat them differently (see the module
/// docs), so this cannot collapse them the way the settings panels'
/// `read_json_object_or_empty` deliberately does.
fn read_json_object_file(path: &Path) -> JsonObjectFile {
    match std::fs::read_to_string(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => JsonObjectFile::Missing,
        Err(_) => JsonObjectFile::Unparsable,
        Ok(raw) => {
            // `opencode.jsonc` is JSON-with-comments — OpenCode 1.x's default
            // scaffold format (verified against 1.19.1). Comments and trailing
            // commas are stripped before the strict parse; a file that is not
            // valid JSONC still lands in Unparsable and the caller fails open.
            let text = if is_jsonc(path) { strip_jsonc(&raw) } else { raw };
            match serde_json::from_str::<serde_json::Value>(&text) {
                Ok(serde_json::Value::Object(map)) => JsonObjectFile::Parsed(map),
                _ => JsonObjectFile::Unparsable,
            }
        }
    }
}

fn is_jsonc(path: &Path) -> bool {
    path.extension().and_then(|e| e.to_str()) == Some("jsonc")
}

/// Remove what JSONC adds on top of JSON — `//` and `/*…*/` comments and
/// trailing commas — without touching string literals (a `"https://…"` URL
/// must survive byte-for-byte). Two linear string-aware passes; whitespace is
/// insignificant to JSON, so dropping what surrounds a dropped comma is safe.
fn strip_jsonc(raw: &str) -> String {
    strip_trailing_commas(&strip_comments(raw))
}

fn strip_comments(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut chars = raw.chars().peekable();
    let mut in_string = false;
    let mut escaped = false;
    while let Some(c) = chars.next() {
        if in_string {
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                in_string = true;
                out.push(c);
            }
            '/' => match chars.peek() {
                Some('/') => {
                    for n in chars.by_ref() {
                        if n == '\n' {
                            out.push('\n');
                            break;
                        }
                    }
                }
                Some('*') => {
                    chars.next();
                    while let Some(n) = chars.next() {
                        if n == '*' && chars.peek() == Some(&'/') {
                            chars.next();
                            break;
                        }
                    }
                }
                _ => out.push('/'),
            },
            _ => out.push(c),
        }
    }
    out
}

fn strip_trailing_commas(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut in_string = false;
    let mut escaped = false;
    let mut pending_comma = false;
    for c in raw.chars() {
        if in_string {
            if pending_comma {
                out.push(',');
                pending_comma = false;
            }
            out.push(c);
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => {
                if pending_comma {
                    out.push(',');
                    pending_comma = false;
                }
                in_string = true;
                out.push(c);
            }
            ',' => pending_comma = true,
            '}' | ']' => {
                pending_comma = false;
                out.push(c);
            }
            c if c.is_whitespace() => {
                if !pending_comma {
                    out.push(c);
                }
            }
            _ => {
                if pending_comma {
                    out.push(',');
                    pending_comma = false;
                }
                out.push(c);
            }
        }
    }
    out
}

/// OpenCode's policy over its config files. `auth_path` and the
/// `config_candidates` are injected so tests can drive real files in a temp
/// dir; `compute` passes the same resolvers the launch and the credential
/// cascade use (`resolve_opencode_base_dir()` for the data side,
/// `opencode_config_candidates()` for the config side).
fn opencode_availability(auth_path: &Path, config_candidates: &[PathBuf]) -> ModelAvailability {
    // Tier 1: the fact-source locations themselves. `resolve_opencode_base_dir`
    // falls back to the RELATIVE path "opencode" when neither XDG_DATA_HOME nor
    // the account home resolves; a relative path means we cannot say which
    // machine state this launch reads, so nothing is filtered.
    if !auth_path.is_absolute() || config_candidates.iter().any(|path| !path.is_absolute()) {
        tracing::warn!(
            "[ACP] opencode config/data dir could not be located ({}, {:?}); \
             showing the unfiltered model list",
            auth_path.display(),
            config_candidates
        );
        return ModelAvailability::Unfiltered;
    }

    // Tier 2/3: missing auth.json = authoritative emptiness (a never-logged-in
    // machine is the case this feature exists for); an unreadable/unparsable
    // one = not evidence.
    let authed: HashSet<String> = match read_json_object_file(auth_path) {
        JsonObjectFile::Missing => HashSet::new(),
        JsonObjectFile::Unparsable => {
            tracing::warn!(
                "[ACP] opencode auth.json exists but could not be parsed ({}); \
                 showing the unfiltered model list",
                auth_path.display()
            );
            return ModelAvailability::Unfiltered;
        }
        JsonObjectFile::Parsed(map) => map
            .iter()
            // Keys whose value is a JSON OBJECT are credentials. The cascade
            // also writes a top-level `api_key` STRING into this file; string
            // values are not providers (and would keep nothing anyway).
            .filter(|(_, value)| value.is_object())
            .map(|(provider, _)| provider.clone())
            .collect(),
    };

    // Every config file OpenCode may carry `provider` entries in: the primary
    // `opencode.json`, the `opencode.jsonc` scaffold OpenCode 1.x creates AND
    // reads (verified against 1.19.1: a provider planted there shows up in
    // session/new), and the legacy `config.json`. Union their provider ids —
    // OpenCode merges these files, so a provider in any one of them is the
    // user's explicit word. Missing → skip; exists but unparsable → fail open,
    // the user's hand-edited providers must never be hidden off a file we
    // failed to read.
    let mut explicit: HashSet<String> = HashSet::new();
    for candidate in config_candidates {
        match read_json_object_file(candidate) {
            JsonObjectFile::Missing => continue,
            JsonObjectFile::Unparsable => {
                tracing::warn!(
                    "[ACP] opencode config exists but could not be parsed ({}); \
                     showing the unfiltered model list",
                    candidate.display()
                );
                return ModelAvailability::Unfiltered;
            }
            JsonObjectFile::Parsed(map) => {
                if let Some(providers) =
                    map.get("provider").and_then(serde_json::Value::as_object)
                {
                    explicit.extend(providers.keys().cloned());
                }
            }
        }
    }

    let providers: HashSet<String> = authed.union(&explicit).cloned().collect();

    // C3 extension point: join the launch's merged `runtime_env` against the
    // models.dev `env` names (`opencode_catalog::CatalogProvider.env`) and add
    // every provider whose variable is set — deliberately not implemented yet
    // (this change ships file facts only).

    let mut hidden_models = HashMap::new();
    // Zen: with `opencode` authenticated, everything is kept (it is already in
    // `providers`). Without it, the free subset still works — keep it by hiding
    // the models the snapshot prices above zero.
    if !providers.contains(ZEN_PROVIDER_ID) {
        hidden_models.insert(ZEN_PROVIDER_ID.to_string(), zen_hidden_models());
    }

    ModelAvailability::Restricted(RestrictedAvailability {
        providers,
        hidden_models,
        ..Default::default()
    })
}

/// The Zen models the bundled models.dev snapshot prices above zero — i.e. the
/// ones a logged-out user cannot run. A model the snapshot does not carry at
/// all is NOT in this set, so it stays on screen: the snapshot and the ACP row
/// set are known to disagree (measured 2026-10-15: 41 Zen rows against 118
/// snapshot entries — the ACP set rolls forward faster than the shipped
/// snapshot), and every such disagreement must fail open per row.
fn zen_hidden_models() -> HashSet<String> {
    crate::acp::opencode_catalog::bundled_catalog()
        .into_iter()
        .find(|provider| provider.id == ZEN_PROVIDER_ID)
        .map(|provider| {
            provider
                .models
                .into_iter()
                .filter(|model| !(model.cost_in == Some(0.0) && model.cost_out == Some(0.0)))
                .map(|model| model.id)
                .collect()
        })
        .unwrap_or_default()
}

/// Layer the OpenCode desktop app's per-model visibility onto a computed
/// policy. The desktop state is an independent USER-authored fact source: it
/// narrows (never widens) what the credential/config rules keep, and it must
/// never break them — a failed read leaves the base policy standing. Applied
/// only to a `Restricted` base: an `Unfiltered` base means the file facts
/// already failed open, and expressing the gate there would need a second
/// policy shape (bare `Restricted` would wrongly drop the providers we know
/// nothing about) for a branch that is rare and already logged.
fn attach_desktop_visibility(
    base: ModelAvailability,
    visibility: Option<DesktopVisibility>,
) -> ModelAvailability {
    let Some(visibility) = visibility else {
        return base;
    };
    let ModelAvailability::Restricted(mut policy) = base else {
        return base;
    };
    policy.shown_models_providers = visibility.providers_with_opinions;
    policy.shown_models = visibility.shown;
    ModelAvailability::Restricted(policy)
}

/// The OpenCode desktop app's per-model visibility state, as its model page
/// persists it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
struct DesktopVisibility {
    /// Providers with at least one toggle entry (show or hide).
    providers_with_opinions: HashSet<String>,
    /// Exact `providerID/modelID` row values marked `show`.
    shown: HashSet<String>,
}

/// Where the desktop app keeps its UI state — Electron's userData dir
/// (`~/Library/Application Support/ai.opencode.desktop` on macOS, `%APPDATA%`
/// on Windows, `~/.config` on Linux; `dirs::data_dir()` covers the first two
/// and `dirs::config_dir()` the third).
fn opencode_desktop_drafts_db() -> Option<PathBuf> {
    dirs::data_dir()
        .or_else(dirs::config_dir)
        .map(|dir| dir.join("ai.opencode.desktop").join("drafts.sqlite"))
}

/// Read the desktop visibility. EVERY failure mode — no desktop app, unreadable
/// or locked db, absent row, unexpected JSON — collapses into `None` and the
/// base policy stands unchanged: this is one opinion among several, never an
/// authority whose absence invalidates the rest.
fn read_desktop_visibility() -> Option<DesktopVisibility> {
    read_desktop_visibility_at(&opencode_desktop_drafts_db()?)
}

fn read_desktop_visibility_at(path: &Path) -> Option<DesktopVisibility> {
    let connection =
        rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .ok()?;
    let raw: String = connection
        .query_row(
            "SELECT value FROM state WHERE name = 'opencode.global.dat' AND key = 'model'",
            [],
            |row| row.get(0),
        )
        .ok()?;
    parse_desktop_model_state(&raw)
}

/// Pure parse of the `opencode.global.dat`/`model` payload — measured shape:
/// `{"user":[{"providerID","modelID","visibility":"show"|"hide"},...],
/// "recent":[...],"variant":{...}}`. Only the `user` toggles count: each
/// parseable entry makes its provider opinionated, and exactly `"show"` marks
/// the row visible (`hide`, a future value, or a missing visibility does not).
/// Entries without both ids are skipped; `recent` and `variant` are usage
/// metadata, not the user's word. An empty opinion set means the desktop holds
/// no state worth honoring → `None`.
fn parse_desktop_model_state(raw: &str) -> Option<DesktopVisibility> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let entries = value.get("user")?.as_array()?;
    let mut visibility = DesktopVisibility::default();
    for entry in entries {
        let (Some(provider), Some(model)) = (
            entry.get("providerID").and_then(serde_json::Value::as_str),
            entry.get("modelID").and_then(serde_json::Value::as_str),
        ) else {
            continue;
        };
        visibility
            .providers_with_opinions
            .insert(provider.to_string());
        if entry.get("visibility").and_then(serde_json::Value::as_str) == Some("show") {
            visibility.shown.insert(format!("{provider}/{model}"));
        }
    }
    if visibility.providers_with_opinions.is_empty() {
        return None;
    }
    Some(visibility)
}

/// pi's policy: the union of its three native files, read through the same
/// projection the settings panel shows (`load_pi_config_at`), after a health
/// check the projection itself deliberately swallows (it projects "absent" and
/// "malformed" into the same empty shape — fine for a settings form, not fine
/// for a filter that would hide rows off a parse failure).
fn pi_availability(dir: &Path) -> ModelAvailability {
    // Tier 1: no agent dir = pi has never run here; the fact sources do not
    // exist as a location at all.
    if !dir.is_dir() {
        tracing::warn!(
            "[ACP] pi agent dir {} does not exist; showing the unfiltered model list",
            dir.display()
        );
        return ModelAvailability::Unfiltered;
    }

    // Tier 3: any fact-source file that exists must actually parse.
    for name in ["auth.json", "models.json", "settings.json"] {
        if matches!(
            read_json_object_file(&dir.join(name)),
            JsonObjectFile::Unparsable
        ) {
            tracing::warn!(
                "[ACP] pi {} exists but could not be parsed; \
                 showing the unfiltered model list",
                dir.join(name).display()
            );
            return ModelAvailability::Unfiltered;
        }
    }

    // Tier 2: whatever the files hold is authoritative — a missing auth.json
    // contributes nothing and filtering continues on the remaining sources.
    let projection = crate::commands::acp::load_pi_config_at(dir);
    let mut providers: HashSet<String> = projection.auth_providers.into_iter().collect();
    providers.extend(projection.custom_providers.into_iter().map(|p| p.id));
    providers.extend(projection.default_provider);

    ModelAvailability::Restricted(RestrictedAvailability {
        providers,
        hidden_models: HashMap::new(),
        ..Default::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use agent_client_protocol::schema::v1::{SessionConfigId, SessionConfigValueId};

    fn restricted(providers: &[&str], hidden: &[(&str, &[&str])]) -> ModelAvailability {
        ModelAvailability::Restricted(RestrictedAvailability {
            providers: providers.iter().map(|p| p.to_string()).collect(),
            hidden_models: hidden
                .iter()
                .map(|(provider, models)| {
                    (
                        provider.to_string(),
                        models.iter().map(|m| m.to_string()).collect(),
                    )
                })
                .collect(),
            ..Default::default()
        })
    }

    /// A policy with the OpenCode desktop's visibility layered on.
    fn restricted_desktop(
        providers: &[&str],
        hidden: &[(&str, &[&str])],
        desktop_providers: &[&str],
        shown: &[&str],
    ) -> ModelAvailability {
        let ModelAvailability::Restricted(mut policy) = restricted(providers, hidden) else {
            unreachable!()
        };
        policy.shown_models_providers = desktop_providers.iter().map(|p| p.to_string()).collect();
        policy.shown_models = shown.iter().map(|s| s.to_string()).collect();
        ModelAvailability::Restricted(policy)
    }

    fn rows(values: &[&str]) -> Vec<SessionConfigSelectOption> {
        values
            .iter()
            .map(|value| {
                SessionConfigSelectOption::new(
                    SessionConfigValueId::new(*value),
                    format!("label of {value}"),
                )
            })
            .collect()
    }

    fn model_select(current: &str, values: &[&str]) -> SessionConfigOption {
        SessionConfigOption::select(
            SessionConfigId::new(MODEL_CONFIG_OPTION_ID),
            "Model",
            SessionConfigValueId::new(current),
            rows(values),
        )
        .category(SessionConfigOptionCategory::Model)
    }

    fn plain_select(
        id: &str,
        category: Option<SessionConfigOptionCategory>,
        current: &str,
        values: &[&str],
    ) -> SessionConfigOption {
        let mut option = SessionConfigOption::select(
            SessionConfigId::new(id),
            format!("{id} label"),
            SessionConfigValueId::new(current),
            rows(values),
        );
        if let Some(category) = category {
            option = option.category(category);
        }
        option
    }

    /// Every row value across all options, in order.
    fn values(options: &[SessionConfigOption]) -> Vec<String> {
        options
            .iter()
            .flat_map(|option| match &option.kind {
                SessionConfigKind::Select(select) => match &select.options {
                    SessionConfigSelectOptions::Ungrouped(rows) => {
                        rows.iter().map(|r| r.value.to_string()).collect::<Vec<_>>()
                    }
                    SessionConfigSelectOptions::Grouped(groups) => groups
                        .iter()
                        .flat_map(|g| {
                            g.options
                                .iter()
                                .map(|r| r.value.to_string())
                                .collect::<Vec<_>>()
                        })
                        .collect(),
                    _ => Vec::new(),
                },
                _ => Vec::new(),
            })
            .collect()
    }

    /// The Zen snapshot ids a fresh machine can and cannot run, taken from the
    /// bundled snapshot itself so these tests survive a snapshot refresh.
    fn zen_snapshot_split() -> (String, String) {
        let zen = crate::acp::opencode_catalog::bundled_catalog()
            .into_iter()
            .find(|p| p.id == ZEN_PROVIDER_ID)
            .expect("the bundled snapshot carries the zen (opencode) provider");
        let free = zen
            .models
            .iter()
            .find(|m| m.cost_in == Some(0.0) && m.cost_out == Some(0.0))
            .expect("zen has free models in the snapshot")
            .id
            .clone();
        let paid = zen
            .models
            .iter()
            .find(|m| !(m.cost_in == Some(0.0) && m.cost_out == Some(0.0)))
            .expect("zen has paid models in the snapshot")
            .id
            .clone();
        (free, paid)
    }

    fn write(dir: &Path, name: &str, content: &str) {
        std::fs::write(dir.join(name), content).unwrap();
    }

    #[test]
    fn opencode_fact_sources_keep_authed_and_explicit_providers() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            "auth.json",
            r#"{
                "opencode-go": { "type": "api_key", "key": "k" },
                "vercel": { "type": "api_key", "key": "k" },
                "api_key": "the cascade writes this string"
            }"#,
        );
        write(
            dir.path(),
            "opencode.json",
            r#"{ "provider": { "my-llm": { "npm": "@ai-sdk/openai-compatible" } } }"#,
        );

        let availability = opencode_availability(
            &dir.path().join("auth.json"),
            &[dir.path().join("opencode.json")],
        );
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("a parsed pair of fact files must restrict, got {availability:?}");
        };
        assert_eq!(
            policy.providers,
            HashSet::from([
                "opencode-go".to_string(),
                "vercel".to_string(),
                "my-llm".to_string(),
            ]),
            "object-valued auth keys and explicit providers must be kept; the \
             cascade's string api_key must not become a provider"
        );
        assert!(
            policy.hidden_models.contains_key(ZEN_PROVIDER_ID),
            "no zen credential → zen is judged per model"
        );
    }

    #[test]
    fn opencode_main_path_keeps_its_rows_and_the_current_value() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            "auth.json",
            r#"{ "opencode-go": {}, "vercel": {} }"#,
        );
        write(
            dir.path(),
            "opencode.json",
            r#"{ "mcp": {}, "provider": { "my-llm": {} } }"#,
        );
        let availability = opencode_availability(
            &dir.path().join("auth.json"),
            &[dir.path().join("opencode.json")],
        );

        let (free, paid) = zen_snapshot_split();
        let free_row = format!("opencode/{free}");
        let paid_row = format!("opencode/{paid}");
        let current = "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b";
        let options = vec![model_select(
            current,
            &[
                "opencode-go/glm-5",
                "vercel/anthropic/claude-x",
                "my-llm/local-1",
                "nvidia/nvidia/some-other",
                &free_row,
                &paid_row,
                "opencode/brand-new-model-not-in-snapshot",
                current,
            ],
        )];

        let filtered = filter_model_options(&availability, options);
        assert_eq!(
            values(&filtered),
            vec![
                "opencode-go/glm-5".to_string(),
                // Nested prefix: judged on the first segment (`vercel`).
                "vercel/anthropic/claude-x".to_string(),
                // Explicit providers are not authenticated fact sources but
                // user-configured ones — kept on the user's word.
                "my-llm/local-1".to_string(),
                // A zen model the snapshot proves free.
                free_row.clone(),
                // Unknown under a partial provider (not in the snapshot) → kept.
                "opencode/brand-new-model-not-in-snapshot".to_string(),
                // The session runs on this one; kept even though nvidia has no
                // credential (the honest current value).
                current.to_string(),
            ],
            "dropped: the other nvidia row and the PAID zen row; kept: \
             credentialed, explicit, free zen, snapshot-unknown zen, current"
        );
        assert!(
            !values(&filtered).contains(&paid_row),
            "a zen model the snapshot prices above zero must be hidden"
        );
    }

    #[test]
    fn opencode_missing_auth_is_an_authoritative_empty_set() {
        let dir = tempfile::tempdir().expect("tempdir");
        let availability = opencode_availability(
            &dir.path().join("auth.json"),
            &[dir.path().join("opencode.json")],
        );
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("a missing auth.json must still restrict");
        };
        assert!(policy.providers.is_empty());

        let (free, paid) = zen_snapshot_split();
        let free_row = format!("opencode/{free}");
        let paid_row = format!("opencode/{paid}");
        let options = vec![model_select(
            "nvidia/keeper",
            &[
                "opencode-go/nothing",
                "nvidia/keeper",
                &free_row,
                &paid_row,
                "opencode/never-heard-of-it",
            ],
        )];
        let filtered = filter_model_options(&availability, options);
        assert_eq!(
            values(&filtered),
            vec![
                "nvidia/keeper".to_string(),
                free_row,
                "opencode/never-heard-of-it".to_string(),
            ],
            "the never-logged-in machine sees exactly the free zen subset plus \
             whatever the agent's current value points at"
        );
    }

    #[test]
    fn opencode_fails_open_when_a_fact_source_is_unlocatable_or_corrupt() {
        let dir = tempfile::tempdir().expect("tempdir");

        // Tier 1: a relative path means the XDG/home resolution fell through.
        assert_eq!(
            opencode_availability(
                Path::new("opencode/auth.json"),
                &[Path::new("opencode/opencode.json").to_path_buf()],
            ),
            ModelAvailability::Unfiltered
        );

        // Tier 3: auth.json exists but is not parseable JSON…
        let auth = dir.path().join("auth.json");
        write(dir.path(), "auth.json", "{ not json");
        assert_eq!(
            opencode_availability(&auth, &[dir.path().join("opencode.json")]),
            ModelAvailability::Unfiltered
        );
        // …or parses to something other than an object.
        write(dir.path(), "auth.json", "[]");
        assert_eq!(
            opencode_availability(&auth, &[dir.path().join("opencode.json")]),
            ModelAvailability::Unfiltered
        );

        // The same for the config file, with a healthy auth.json beside it.
        write(dir.path(), "auth.json", r#"{ "vercel": {} }"#);
        write(dir.path(), "opencode.json", "{ oops");
        assert_eq!(
            opencode_availability(&auth, &[dir.path().join("opencode.json")]),
            ModelAvailability::Unfiltered
        );
    }

    #[test]
    fn opencode_jsonc_scaffold_providers_are_kept() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "auth.json", r#"{ "vercel": {} }"#);
        write(
            dir.path(),
            "opencode.jsonc",
            r#"{
    // opencode 1.x scaffold
    "$schema": "https://opencode.ai/config.json", // trailing comment
    "provider": {
        /* block comment */
        "jsonc-only": {
            "npm": "@ai-sdk/openai-compatible",
            "options": { "baseURL": "https://example.invalid/v1" },
        },
    },
}"#,
        );

        let availability = opencode_availability(
            &dir.path().join("auth.json"),
            &[dir.path().join("opencode.jsonc")],
        );
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("a valid jsonc config must restrict, got {availability:?}");
        };
        assert!(
            policy.providers.contains("jsonc-only"),
            "providers configured in the 1.x jsonc scaffold must be kept, got {:?}",
            policy.providers
        );
    }

    #[test]
    fn opencode_unions_json_and_jsonc_providers() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "auth.json", "{}");
        write(
            dir.path(),
            "opencode.json",
            r#"{ "provider": { "from-json": {} } }"#,
        );
        write(
            dir.path(),
            "opencode.jsonc",
            r#"{ "provider": { "from-jsonc": {} } }"#,
        );

        let availability = opencode_availability(
            &dir.path().join("auth.json"),
            &[
                dir.path().join("opencode.json"),
                dir.path().join("opencode.jsonc"),
            ],
        );
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("a configured pair of files must restrict, got {availability:?}");
        };
        assert_eq!(
            policy.providers,
            HashSet::from(["from-json".to_string(), "from-jsonc".to_string()]),
            "providers from both config files must be unioned"
        );
    }

    #[test]
    fn opencode_fails_open_off_an_unparsable_jsonc() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(dir.path(), "auth.json", r#"{ "vercel": {} }"#);
        write(dir.path(), "opencode.json", r#"{ "provider": { "ok": {} } }"#);
        write(dir.path(), "opencode.jsonc", "{ not jsonc either");

        assert_eq!(
            opencode_availability(
                &dir.path().join("auth.json"),
                &[
                    dir.path().join("opencode.json"),
                    dir.path().join("opencode.jsonc")
                ],
            ),
            ModelAvailability::Unfiltered,
            "an unparsable candidate config must disable filtering entirely, \
             the same as an unparsable opencode.json"
        );
    }

    #[test]
    fn strip_jsonc_preserves_strings_and_shapes() {
        // URLs with comment-like or comma/brace characters inside strings
        // must survive byte-for-byte.
        assert_eq!(
            strip_jsonc(r#"{"u": "https://a.invalid/v1//x"}"#),
            r#"{"u": "https://a.invalid/v1//x"}"#,
        );
        // Comments of both flavors disappear, including after values.
        assert_eq!(strip_jsonc("{ /* c */ }"), "{  }");
        assert_eq!(
            strip_jsonc("{\n  // line\n  \"a\": 1,\n}"),
            // The trailing comma is dropped along with the whitespace it
            // held before the closer — semantically identical JSON.
            "{\n  \n  \"a\": 1}",
        );
        // Trailing commas are dropped before `}` and `]`, at any nesting.
        assert_eq!(
            strip_jsonc(r#"{"a":{"b":1,},"arr":[1,2,],"esc":"x,}"}"#),
            r#"{"a":{"b":1},"arr":[1,2],"esc":"x,}"}"#,
        );
        // An escaped quote must not flip the string state machine.
        assert_eq!(
            strip_jsonc(r#""e":"a\"//b""#),
            r#""e":"a\"//b""#,
        );
    }

    #[test]
    fn desktop_gate_narrows_an_opinionated_provider_to_its_shows() {
        let policy = restricted_desktop(&["go", "authed"], &[], &["go"], &["go/m1"]);
        let options = filter_model_options(
            &policy,
            vec![model_select(
                "go/m2",
                &["go/m1", "go/m2", "go/m3", "authed/a", "authed/b"],
            )],
        );
        // `go` has desktop opinions: only its show row and the session's
        // current row survive it; the authed provider without opinions keeps
        // its credential rule.
        assert_eq!(
            values(&options),
            vec!["go/m1".to_string(), "go/m2".to_string(), "authed/a".to_string(), "authed/b".to_string()],
        );
    }

    #[test]
    fn desktop_show_outranks_zen_pricing_and_the_per_row_fail_open() {
        let (free, paid) = zen_snapshot_split();
        // Zen unauthenticated, so the deny-list hides `paid`; the desktop
        // marks `paid` shown anyway (Console-account reachability), and has
        // opinions about the provider at all.
        let policy = restricted_desktop(
            &[],
            &[("opencode", &[&paid])],
            &["opencode"],
            &[&format!("opencode/{paid}"), &format!("opencode/{free}")],
        );
        let options = filter_model_options(
            &policy,
            vec![model_select(
                &format!("opencode/{paid}"),
                &[
                    &format!("opencode/{paid}"),
                    &format!("opencode/{free}"),
                    "opencode/never-heard-of-it",
                    "opencode/other-priced",
                ],
            )],
        );
        assert_eq!(
            values(&options),
            vec![
                format!("opencode/{paid}"),
                format!("opencode/{free}"),
                // `never-heard-of-it` would fail open under the bare Zen
                // deny-list, but the desktop's opinion narrows first; the
                // show rows above (and the current value, which is also the
                // show) are all that survive.
            ]
        );
    }

    #[test]
    fn desktop_show_rescues_an_uncredentialed_provider_row() {
        // The measured 2026-10-16 case: `deepseek` is toggled on in the
        // desktop but absent from auth.json (Console-account credential).
        let policy = restricted_desktop(&[], &[], &["deepseek"], &["deepseek/flash"]);
        let options = filter_model_options(
            &policy,
            vec![model_select("deepseek/flash", &["deepseek/flash"])],
        );
        assert_eq!(values(&options), vec!["deepseek/flash".to_string()]);
    }

    #[test]
    fn unopinionated_providers_keep_their_existing_rules() {
        let policy = restricted_desktop(&["authed"], &[], &["go"], &[]);
        let options = filter_model_options(
            &policy,
            vec![model_select(
                "authed/a",
                &["authed/a", "authed/b", "go/x", "random/y"],
            )],
        );
        // `go/x`: opinionated but not shown → dropped. `random/y`: no
        // opinions, not credentialed → dropped exactly as before this source
        // existed.
        assert_eq!(
            values(&options),
            vec!["authed/a".to_string(), "authed/b".to_string()]
        );
    }

    #[test]
    fn parse_desktop_model_state_reads_toggles_and_skips_noise() {
        let payload = serde_json::json!({
            "user": [
                {"providerID": "go", "modelID": "m1", "visibility": "show"},
                {"providerID": "go", "modelID": "m2", "visibility": "hide"},
                {"providerID": "go", "modelID": "m3", "visibility": "some-future-value"},
                {"providerID": "vercel", "modelID": "a/b", "visibility": "hide"},
                {"modelID": "orphan", "visibility": "show"},
                {"providerID": "orphan2"},
                "not-an-object",
            ],
            "recent": [{"providerID": "go", "modelID": "m1"}],
        });
        let visibility = parse_desktop_model_state(&payload.to_string()).expect("parseable");
        assert_eq!(
            visibility.providers_with_opinions,
            HashSet::from(["go".to_string(), "vercel".to_string()]),
        );
        assert_eq!(
            visibility.shown,
            HashSet::from(["go/m1".to_string()]),
        );

        // Only-shows-when-there-is-something-to-honor.
        assert_eq!(
            parse_desktop_model_state(r#"{"user": [], "recent": []}"#),
            None,
        );
        assert_eq!(parse_desktop_model_state(r#"{"recent": []}"#), None);
        assert_eq!(parse_desktop_model_state("not json"), None);
    }

    #[test]
    fn read_desktop_visibility_at_reads_the_state_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("drafts.sqlite");
        let connection = rusqlite::Connection::open(&db).expect("create db");
        connection
            .execute_batch(
                "CREATE TABLE state (
                    name TEXT NOT NULL,
                    key TEXT NOT NULL,
                    value TEXT NOT NULL,
                    updated_at INTEGER,
                    PRIMARY KEY (name, key)
                );",
            )
            .expect("create table");
        let payload = serde_json::json!({
            "user": [
                {"providerID": "go", "modelID": "m1", "visibility": "show"},
                {"providerID": "go", "modelID": "m2", "visibility": "hide"},
                {"providerID": "zen", "modelID": "free", "visibility": "show"},
            ],
            "recent": [],
        });
        connection
            .execute(
                "INSERT INTO state (name, key, value) VALUES ('opencode.global.dat', 'model', ?1)",
                [payload.to_string()],
            )
            .expect("insert row");
        drop(connection);

        let visibility = read_desktop_visibility_at(&db).expect("readable");
        assert_eq!(
            visibility.providers_with_opinions,
            HashSet::from(["go".to_string(), "zen".to_string()]),
        );
        assert_eq!(
            visibility.shown,
            HashSet::from(["go/m1".to_string(), "zen/free".to_string()]),
        );
    }

    #[test]
    fn read_desktop_visibility_at_fails_soft_on_a_corrupt_db() {
        let dir = tempfile::tempdir().expect("tempdir");
        let db = dir.path().join("drafts.sqlite");
        std::fs::write(&db, b"not a database at all").expect("write garbage");
        assert_eq!(read_desktop_visibility_at(&db), None);
    }

    #[test]
    fn attach_desktop_visibility_extends_restricted_and_leaves_unfiltered_alone() {
        let base = restricted(&["authed"], &[]);
        let visibility = Some(DesktopVisibility {
            providers_with_opinions: HashSet::from(["go".to_string()]),
            shown: HashSet::from(["go/m1".to_string()]),
        });
        let ModelAvailability::Restricted(policy) =
            attach_desktop_visibility(base.clone(), visibility.clone())
        else {
            panic!("a restricted base must stay restricted");
        };
        assert_eq!(
            policy.shown_models_providers,
            HashSet::from(["go".to_string()]),
        );
        assert_eq!(policy.shown_models, HashSet::from(["go/m1".to_string()]));
        assert_eq!(policy.providers, HashSet::from(["authed".to_string()]));

        // A failed read leaves the base untouched.
        assert_eq!(
            attach_desktop_visibility(base.clone(), None),
            ModelAvailability::Restricted(RestrictedAvailability {
                providers: HashSet::from(["authed".to_string()]),
                ..Default::default()
            }),
        );
        // An Unfiltered base stays Unfiltered: the gate cannot express
        // "narrow only the opinionated providers" there without a second
        // policy shape.
        assert_eq!(
            attach_desktop_visibility(ModelAvailability::Unfiltered, visibility),
            ModelAvailability::Unfiltered,
        );
    }

    #[test]
    fn pi_unions_its_three_fact_sources() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            "auth.json",
            r#"{ "deepseek": { "type": "api_key" } }"#,
        );
        write(
            dir.path(),
            "models.json",
            r#"{ "providers": { "my-custom": {}, "ark": {} } }"#,
        );
        write(
            dir.path(),
            "settings.json",
            r#"{ "defaultProvider": "vercel-ai-gateway", "defaultModel": "x" }"#,
        );

        let availability = pi_availability(dir.path());
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("a configured pi must restrict, got {availability:?}");
        };
        assert_eq!(
            policy.providers,
            HashSet::from([
                "deepseek".to_string(),
                "my-custom".to_string(),
                "ark".to_string(),
                "vercel-ai-gateway".to_string(),
            ])
        );
        assert!(
            policy.hidden_models.is_empty(),
            "pi has no partial providers"
        );

        let options = vec![model_select(
            "my-custom/glm-5-nt",
            &[
                "vercel-ai-gateway/anthropic/claude-fable-5-1",
                "nvidia/nemotron",
                "deepseek/deepseek-v4-pro",
            ],
        )];
        let filtered = filter_model_options(&availability, options);
        assert_eq!(
            values(&filtered),
            vec![
                "vercel-ai-gateway/anthropic/claude-fable-5-1".to_string(),
                "deepseek/deepseek-v4-pro".to_string(),
            ]
        );
    }

    #[test]
    fn pi_missing_auth_continues_with_the_remaining_sources() {
        let dir = tempfile::tempdir().expect("tempdir");
        write(
            dir.path(),
            "models.json",
            r#"{ "providers": { "my-custom": {} } }"#,
        );
        write(
            dir.path(),
            "settings.json",
            r#"{ "defaultProvider": "my-custom" }"#,
        );

        let availability = pi_availability(dir.path());
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("a missing auth.json must still restrict");
        };
        assert_eq!(
            policy.providers,
            HashSet::from(["my-custom".to_string()]),
            "auth emptiness is authoritative; models.json/defaultProvider still apply"
        );
    }

    #[test]
    fn pi_fails_open_without_a_dir_or_off_a_corrupt_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(
            pi_availability(&dir.path().join("no-such-agent-dir")),
            ModelAvailability::Unfiltered
        );

        write(dir.path(), "settings.json", "{ not json");
        assert_eq!(pi_availability(dir.path()), ModelAvailability::Unfiltered);
    }

    #[test]
    fn an_empty_pi_directory_keeps_only_the_current_row() {
        let dir = tempfile::tempdir().expect("tempdir");
        let availability = pi_availability(dir.path());
        let ModelAvailability::Restricted(policy) = &availability else {
            panic!("an existing but empty agent dir must still restrict");
        };
        assert!(policy.providers.is_empty() && policy.hidden_models.is_empty());

        let options = vec![model_select(
            "my-custom/glm-5-nt",
            &[
                "nvidia/nemotron",
                "deepseek/deepseek-v4-pro",
                "my-custom/glm-5-nt",
            ],
        )];
        let filtered = filter_model_options(&availability, options);
        assert_eq!(values(&filtered), vec!["my-custom/glm-5-nt".to_string()]);
    }

    #[test]
    fn custom_and_unpolicied_agents_are_unfiltered() {
        let env = BTreeMap::new();
        assert_eq!(
            compute(AgentType::custom("zcode").expect("valid slug"), &env),
            ModelAvailability::Unfiltered
        );
        for agent_type in [
            AgentType::ClaudeCode,
            AgentType::Codex,
            AgentType::Cline,
            AgentType::KimiCode,
            AgentType::Grok,
        ] {
            assert_eq!(compute(agent_type, &env), ModelAvailability::Unfiltered);
        }
    }

    #[test]
    fn non_model_options_are_untouched_byte_for_byte() {
        let availability = restricted(&["kept"], &[]);
        let effort = plain_select(
            "effort",
            Some(SessionConfigOptionCategory::ThoughtLevel),
            "default",
            &["nvidia/only", "hidden/only"],
        );
        let mode = plain_select(
            "mode",
            Some(SessionConfigOptionCategory::Mode),
            "build",
            &["a/b"],
        );
        let toggle = SessionConfigOption::boolean(SessionConfigId::new("fast"), "Fast", false);
        let options = vec![
            model_select("kept/current", &["kept/a", "hidden/b"]),
            effort.clone(),
            mode.clone(),
            toggle.clone(),
        ];

        let filtered = filter_model_options(&availability, options);

        // Serialized equality: not merely PartialEq — the JSON the wire would
        // carry is identical.
        assert_eq!(
            serde_json::to_value(&filtered[1]).unwrap(),
            serde_json::to_value(&effort).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&filtered[2]).unwrap(),
            serde_json::to_value(&mode).unwrap()
        );
        assert_eq!(
            serde_json::to_value(&filtered[3]).unwrap(),
            serde_json::to_value(&toggle).unwrap()
        );
        assert_eq!(
            values(&filtered[0..1]),
            vec!["kept/a".to_string()],
            "only the model select is filtered"
        );
    }

    #[test]
    fn zero_row_guard_puts_the_original_list_back() {
        // The policy knows only `kept`; the selector has nothing from it, and
        // its current value is not among the rows at all. That is a shape we
        // misread (or a policy from another machine) — revert everything.
        let availability = restricted(&["kept"], &[]);
        let options = vec![model_select("gone/model", &["hidden/a", "other/b"])];

        let filtered = filter_model_options(&availability, options.clone());
        assert_eq!(
            serde_json::to_value(&filtered).unwrap(),
            serde_json::to_value(&options).unwrap(),
            "an emptied model select reverts the whole list"
        );
    }

    #[test]
    fn grouped_selects_lose_empty_groups_and_keep_current_rows() {
        let availability = restricted(&["kept"], &[]);
        let grouped = SessionConfigSelectOptions::Grouped(vec![
            SessionConfigSelectGroup::new(
                agent_client_protocol::schema::v1::SessionConfigGroupId::new("g1"),
                "Only hidden",
                rows(&["hidden/a"]),
            ),
            SessionConfigSelectGroup::new(
                agent_client_protocol::schema::v1::SessionConfigGroupId::new("g2"),
                "Keeps",
                rows(&["kept/b", "hidden/c"]),
            ),
        ]);
        let options = vec![SessionConfigOption::select(
            SessionConfigId::new(MODEL_CONFIG_OPTION_ID),
            "Model",
            SessionConfigValueId::new("kept/b"),
            grouped,
        )
        .category(SessionConfigOptionCategory::Model)];

        let filtered = filter_model_options(&availability, options);
        let SessionConfigKind::Select(select) = &filtered[0].kind else {
            panic!("still a select");
        };
        let SessionConfigSelectOptions::Grouped(groups) = &select.options else {
            panic!("still grouped");
        };
        assert_eq!(groups.len(), 1, "the emptied group is dropped");
        assert_eq!(groups[0].group.to_string(), "g2");
        assert_eq!(
            groups[0]
                .options
                .iter()
                .map(|r| r.value.to_string())
                .collect::<Vec<_>>(),
            vec!["kept/b".to_string()]
        );

        // Every group emptied and the current value absent → the guard puts
        // the original (both groups) back.
        let all_hidden = vec![model_select_with_groups(
            "gone/model",
            &[&["hidden/a"], &["hidden/b"]],
        )];
        let filtered = filter_model_options(&availability, all_hidden.clone());
        assert_eq!(
            serde_json::to_value(&filtered).unwrap(),
            serde_json::to_value(&all_hidden).unwrap()
        );
    }

    fn model_select_with_groups(current: &str, groups: &[&[&str]]) -> SessionConfigOption {
        SessionConfigOption::select(
            SessionConfigId::new(MODEL_CONFIG_OPTION_ID),
            "Model",
            SessionConfigValueId::new(current),
            SessionConfigSelectOptions::Grouped(
                groups
                    .iter()
                    .enumerate()
                    .map(|(index, values)| {
                        SessionConfigSelectGroup::new(
                            agent_client_protocol::schema::v1::SessionConfigGroupId::new(format!(
                                "g{index}"
                            )),
                            format!("Group {index}"),
                            rows(values),
                        )
                    })
                    .collect(),
            ),
        )
        .category(SessionConfigOptionCategory::Model)
    }

    #[test]
    fn partial_providers_hide_known_models_and_fail_open_on_unknown_ones() {
        let availability = restricted(&["kept"], &[("zen", &["paid-1"])]);
        let options = vec![model_select(
            "zen/paid-1",
            &[
                "zen/paid-1",
                "zen/never-heard-of-it",
                "kept/x",
                "elsewhere/y",
                "bare-model-without-provider",
            ],
        )];

        let filtered = filter_model_options(&availability, options);
        assert_eq!(
            values(&filtered),
            vec![
                "zen/paid-1".to_string(),
                "zen/never-heard-of-it".to_string(),
                "kept/x".to_string(),
                "bare-model-without-provider".to_string(),
            ],
            "known-unavailable hidden; unknown under the partial provider kept; \
             unattributable values kept; other providers dropped"
        );
    }

    #[test]
    fn zen_hidden_models_is_exactly_the_snapshot_complement_of_free() {
        let zen = crate::acp::opencode_catalog::bundled_catalog()
            .into_iter()
            .find(|p| p.id == ZEN_PROVIDER_ID)
            .expect("zen provider");
        let hidden = zen_hidden_models();
        assert!(!hidden.is_empty());
        for model in &zen.models {
            let free = model.cost_in == Some(0.0) && model.cost_out == Some(0.0);
            assert_eq!(
                hidden.contains(&model.id),
                !free,
                "model {} must be {} in the hidden set",
                model.id,
                if free { "absent" } else { "present" }
            );
        }
    }
}
