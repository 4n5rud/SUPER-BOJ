use crate::runner::Language;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, Row, TransactionBehavior};
use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::path::PathBuf;
use std::time::Duration;
use uuid::Uuid;

#[derive(Debug)]
pub struct StoreError {
    pub code: &'static str,
    pub message: &'static str,
    pub retryable: bool,
}

impl StoreError {
    pub fn new(code: &'static str, message: &'static str, retryable: bool) -> Self {
        Self {
            code,
            message,
            retryable,
        }
    }
}

impl From<rusqlite::Error> for StoreError {
    fn from(error: rusqlite::Error) -> Self {
        let retryable = matches!(
            error.sqlite_error_code(),
            Some(rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked)
        );
        Self::new(
            "DATABASE_ERROR",
            "Unable to access the local submission database.",
            retryable,
        )
    }
}

pub fn data_dir() -> Result<PathBuf, StoreError> {
    if let Some(path) = std::env::var_os("SUPER_BOJ_DATA_DIR").map(PathBuf::from) {
        return if path.is_absolute() {
            Ok(path)
        } else {
            Err(data_dir_error())
        };
    }
    let env_path = |key| {
        std::env::var_os(key)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
    };
    let home = || env_path("HOME");
    let base = if cfg!(target_os = "macos") {
        home().map(|p| p.join("Library/Application Support"))
    } else if cfg!(windows) {
        env_path("LOCALAPPDATA")
    } else {
        env_path("XDG_DATA_HOME").or_else(|| home().map(|p| p.join(".local/share")))
    };
    Ok(base.ok_or_else(data_dir_error)?.join("SUPER_BOJ"))
}

fn data_dir_error() -> StoreError {
    StoreError::new(
        "FILE_SYSTEM_ERROR",
        "Unable to determine or create the application data directory.",
        false,
    )
}

pub fn open() -> Result<Connection, StoreError> {
    let root = data_dir()?;
    let directory = root.join("database");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&directory).map_err(|_| data_dir_error())?;
    for path in [&root, &directory] {
        let metadata = std::fs::symlink_metadata(path).map_err(|_| data_dir_error())?;
        if !metadata.is_dir() {
            return Err(data_dir_error());
        }
    }
    // Resolve system-provided aliases such as macOS /var before SQLite applies NOFOLLOW.
    let directory = directory.canonicalize().map_err(|_| data_dir_error())?;
    let mut conn = Connection::open_with_flags(
        directory.join("super-boj.db"),
        (OpenFlags::default() - OpenFlags::SQLITE_OPEN_URI) | OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )?;
    conn.busy_timeout(Duration::from_secs(3))?;
    conn.pragma_update(None, "foreign_keys", true)?;
    let version = conn.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))?;
    if version as usize > MIGRATIONS.len() {
        return Err(StoreError::new(
            "DATABASE_ERROR",
            "The database was created by a newer SUPER_BOJ version.",
            false,
        ));
    }
    if (version as usize) < MIGRATIONS.len() {
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let version = tx.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))?;
        for (index, migration) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            tx.execute_batch(migration)?;
            tx.pragma_update(None, "user_version", index as u32 + 1)?;
        }
        tx.commit()?;
    }
    Ok(conn)
}

const MIGRATIONS: &[&str] = &[
    include_str!("../migrations/001_submissions.sql"),
    include_str!("../migrations/002_git.sql"),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Prepare {
    #[serde(default)]
    language: Language,
    intent_id: Uuid,
    account_context: Option<String>,
    problem_id: u32,
    problem_title: String,
    source: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Confirm {
    #[serde(default)]
    language: Language,
    intent_id: Uuid,
    account_context: String,
    problem_id: u32,
    submission_id: String,
    source: String,
    raw_verdict: Option<String>,
    execution_time_ms: Option<u32>,
    memory_kb: Option<u32>,
    submitted_at: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct VerdictUpdate {
    account_context: String,
    submission_id: String,
    raw_verdict: String,
    execution_time_ms: Option<u32>,
    memory_kb: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Problem {
    #[serde(default)]
    language: Language,
    account_context: Option<String>,
    problem_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct History {
    account_context: String,
    problem_id: Option<u32>,
    before: Option<i64>,
    limit: Option<u32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Attempt {
    account_context: String,
    submission_id: String,
}

fn parse<T: DeserializeOwned>(payload: Value) -> Result<T, StoreError> {
    serde_json::from_value(payload).map_err(|_| invalid())
}

fn invalid() -> StoreError {
    StoreError::new(
        "INVALID_MESSAGE",
        "Invalid submission or settings payload.",
        false,
    )
}

fn unverified() -> StoreError {
    StoreError::new(
        "SUBMISSION_UNVERIFIED",
        "The submission or preparation record could not be located.",
        false,
    )
}

fn mismatch() -> StoreError {
    StoreError::new(
        "SUBMISSION_MISMATCH",
        "The submitted source, language, account, or problem differs from the prepared snapshot.",
        false,
    )
}

fn valid_account(value: &str) -> bool {
    (1..=50).contains(&value.len())
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

fn valid_id(value: &str) -> bool {
    (1..=20).contains(&value.len())
        && !value.starts_with('0')
        && value.bytes().all(|c| c.is_ascii_digit())
}

pub(crate) fn hash(source: &str) -> String {
    let mut digest = String::with_capacity(71);
    digest.push_str("sha256:");
    for byte in Sha256::digest(source.as_bytes()) {
        write!(digest, "{byte:02x}").expect("writing to String cannot fail");
    }
    digest
}

fn prepare(conn: &mut Connection, request: Prepare) -> Result<Value, StoreError> {
    if request.problem_id == 0
        || request
            .account_context
            .as_deref()
            .is_some_and(|account| !valid_account(account))
        || request.problem_title.trim().is_empty()
        || request.problem_title.len() > 512
        || request.source.len() > 256 * 1024
    {
        return Err(invalid());
    }
    let id = request.intent_id.to_string();
    let digest = hash(&request.source);
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    tx.execute(
        "INSERT INTO problems(id, title, url) VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated_at=unixepoch()",
        params![
            request.problem_id,
            request.problem_title,
            format!("https://www.acmicpc.net/problem/{}", request.problem_id)
        ],
    )?;
    let inserted = tx.execute(
        "INSERT INTO submission_intents(id, account_context, problem_id, language, source_code, source_hash, status)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'PREPARED') ON CONFLICT(id) DO NOTHING",
        params![id, request.account_context, request.problem_id, request.language.as_str(), request.source, digest],
    )?;
    if inserted == 0 {
        let same: bool = tx.query_row(
            "SELECT account_context IS ?2 AND problem_id=?3 AND source_code=?4 AND language=?5 FROM submission_intents WHERE id=?1",
            params![id, request.account_context, request.problem_id, request.source, request.language.as_str()], |row| row.get(0),
        )?;
        if !same {
            return Err(mismatch());
        }
    }
    tx.commit()?;
    Ok(json!({"intentId":id,"sourceHash":digest}))
}

fn verdict(raw: Option<&str>) -> (&'static str, &'static str) {
    let text = raw.unwrap_or("").trim();
    match text {
        "채점 준비 중" | "채점 대기 중" | "WAITING" => ("WAITING", "SUBMITTED"),
        text if text.starts_with("채점 중")
            || text.starts_with("컴파일 중")
            || text == "JUDGING" =>
        {
            ("JUDGING", "JUDGING")
        }
        "맞았습니다!!" | "ACCEPTED" => ("ACCEPTED", "JUDGED"),
        "틀렸습니다" | "WRONG_ANSWER" => ("WRONG_ANSWER", "JUDGED"),
        "컴파일 에러" | "COMPILE_ERROR" => ("COMPILE_ERROR", "JUDGED"),
        text if text.starts_with("런타임 에러") || text == "RUNTIME_ERROR" => {
            ("RUNTIME_ERROR", "JUDGED")
        }
        "시간 초과" | "TIME_LIMIT_EXCEEDED" => ("TIME_LIMIT_EXCEEDED", "JUDGED"),
        "메모리 초과" | "MEMORY_LIMIT_EXCEEDED" => ("MEMORY_LIMIT_EXCEEDED", "JUDGED"),
        "출력 초과" | "OUTPUT_LIMIT_EXCEEDED" => ("OUTPUT_LIMIT_EXCEEDED", "JUDGED"),
        "출력 형식이 잘못되었습니다" | "PRESENTATION_ERROR" => {
            ("PRESENTATION_ERROR", "JUDGED")
        }
        _ => ("UNKNOWN", "UNKNOWN"),
    }
}

fn confirm(conn: &mut Connection, request: Confirm) -> Result<Value, StoreError> {
    if !valid_account(&request.account_context)
        || !valid_id(&request.submission_id)
        || request.problem_id == 0
        || request.source.len() > 256 * 1024
        || request.raw_verdict.as_ref().is_some_and(|s| s.len() > 256)
        || request
            .submitted_at
            .as_ref()
            .is_some_and(|s| s.len() > 40 || chrono::DateTime::parse_from_rfc3339(s).is_err())
    {
        return Err(invalid());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let id = request.intent_id.to_string();
    let matches = tx.query_row(
        "SELECT (account_context IS NULL OR account_context=?2) AND problem_id=?3 AND source_code=?4 AND language=?5 AND status!='CANCELLED'
         FROM submission_intents WHERE id=?1",
        params![id, request.account_context, request.problem_id, request.source, request.language.as_str()], |row| row.get::<_, bool>(0),
    ).optional()?.ok_or_else(unverified)?;
    if !matches {
        return Err(mismatch());
    }
    let existing = tx.query_row(
        "SELECT problem_id=?3 AND source_code=?4 AND language=?5 FROM submissions WHERE account_context=?1 AND boj_submission_id=?2",
        params![request.account_context, request.submission_id, request.problem_id, request.source, request.language.as_str()], |row| row.get::<_, bool>(0),
    ).optional()?;
    if let Some(same) = existing {
        if !same {
            return Err(mismatch());
        }
        return Ok(json!({"submissionId":request.submission_id,"duplicate":true}));
    }
    let already_confirmed: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM submissions WHERE intent_id=?1)",
        [&id],
        |row| row.get(0),
    )?;
    if already_confirmed {
        return Err(StoreError::new(
            "SUBMISSION_ALREADY_RECORDED",
            "This snapshot is already linked to a different submission.",
            false,
        ));
    }
    let (verdict, state) = verdict(request.raw_verdict.as_deref());
    tx.execute(
        "INSERT INTO submissions(intent_id, account_context, problem_id, boj_submission_id, language, source_code, source_hash,
                                  verdict, raw_verdict, execution_time_ms, memory_kb, submitted_at, state)
         SELECT id, ?2, problem_id, ?3, language, source_code, source_hash, ?4, ?5, ?6, ?7, ?8, ?9
         FROM submission_intents WHERE id=?1",
        params![id,request.account_context,request.submission_id,verdict,request.raw_verdict,request.execution_time_ms,
                request.memory_kb,request.submitted_at,state],
    )?;
    tx.execute(
        "UPDATE submission_intents SET status='CONFIRMED' WHERE id=?1",
        [&id],
    )?;
    crate::git::enqueue(&tx, tx.last_insert_rowid())?;
    tx.commit()?;
    Ok(json!({"submissionId":request.submission_id,"duplicate":false}))
}

fn update_verdict(conn: &mut Connection, request: VerdictUpdate) -> Result<Value, StoreError> {
    if !valid_account(&request.account_context)
        || !valid_id(&request.submission_id)
        || request.raw_verdict.len() > 256
    {
        return Err(invalid());
    }
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let id = tx
        .query_row(
            "SELECT id FROM submissions WHERE account_context=?1 AND boj_submission_id=?2",
            params![request.account_context, request.submission_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?
        .ok_or_else(unverified)?;
    let (verdict, state) = verdict(Some(&request.raw_verdict));
    let updated = tx.execute(
        "UPDATE submissions SET verdict=?2, raw_verdict=?3, execution_time_ms=?4, memory_kb=?5,
                state=?6, updated_at=unixepoch(), revision=revision+1
         WHERE id=?1 AND (verdict IS NOT ?2 OR raw_verdict IS NOT ?3 OR execution_time_ms IS NOT ?4 OR memory_kb IS NOT ?5)",
        params![id, verdict, request.raw_verdict, request.execution_time_ms, request.memory_kb, state],
    )?;
    if updated != 0 {
        crate::git::enqueue(&tx, id)?;
    }
    tx.commit()?;
    Ok(json!({"submissionId":request.submission_id,"updated":updated != 0}))
}

fn pending(conn: &Connection, request: Problem) -> Result<Value, StoreError> {
    if request.problem_id == 0
        || request
            .account_context
            .as_deref()
            .is_some_and(|account| !valid_account(account))
    {
        return Err(invalid());
    }
    let mut stmt = conn.prepare(
        "SELECT id, source_hash, created_at FROM submission_intents
         WHERE problem_id=?1 AND (account_context IS NULL OR account_context=?2)
           AND language=?3 AND status IN ('PREPARED','AWAITING_CONFIRMATION','UNVERIFIED') ORDER BY created_at DESC, rowid DESC LIMIT 50",
    )?;
    let intents = stmt.query_map(params![request.problem_id, request.account_context, request.language.as_str()], |row| {
        Ok(json!({"intentId":row.get::<_, String>(0)?,"sourceHash":row.get::<_, String>(1)?,"createdAt":row.get::<_, i64>(2)?}))
    })?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!({"intents":intents}))
}

const ATTEMPT_COLUMNS: &str = "s.id, s.account_context, p.id, p.title, p.url, s.boj_submission_id, s.language,
    s.source_hash, s.verdict, s.raw_verdict, s.execution_time_ms, s.memory_kb, s.submitted_at, s.created_at, s.updated_at,
    j.status, j.commit_sha, j.pushed_sha, r.remote_url";
const ATTEMPT_TABLES: &str = "FROM submissions s JOIN problems p ON p.id=s.problem_id
    LEFT JOIN repositories r ON r.active=1
    LEFT JOIN sync_jobs j ON j.submission_id=s.id AND j.repository_id=r.id";

fn attempt_metadata(row: &Row<'_>) -> rusqlite::Result<Value> {
    let pushed_sha: Option<String> = row.get(17)?;
    let remote: Option<String> = row.get(18)?;
    let commit_url = pushed_sha.zip(remote).and_then(|(sha, remote)| {
        let (_, web_url) = crate::git::github_remote(&remote)?;
        Some(format!("{web_url}/commit/{sha}"))
    });
    Ok(json!({
        "id":row.get::<_, i64>(0)?,
        "accountContext":row.get::<_, String>(1)?,
        "problemId":row.get::<_, u32>(2)?,
        "problemTitle":row.get::<_, String>(3)?,
        "problemUrl":row.get::<_, String>(4)?,
        "submissionId":row.get::<_, String>(5)?,
        "language":row.get::<_, String>(6)?,
        "sourceHash":row.get::<_, String>(7)?,
        "verdict":row.get::<_, String>(8)?,
        "rawVerdict":row.get::<_, Option<String>>(9)?,
        "executionTimeMs":row.get::<_, Option<u32>>(10)?,
        "memoryKb":row.get::<_, Option<u32>>(11)?,
        "submittedAt":row.get::<_, Option<String>>(12)?,
        "createdAt":row.get::<_, i64>(13)?,
        "updatedAt":row.get::<_, i64>(14)?,
        "gitStatus":row.get::<_, Option<String>>(15)?,
        "commitSha":row.get::<_, Option<String>>(16)?,
        "commitUrl":commit_url,
    }))
}

fn history(conn: &Connection, request: History) -> Result<Value, StoreError> {
    let limit = request.limit.unwrap_or(30);
    if !valid_account(&request.account_context)
        || request.problem_id == Some(0)
        || request.before.is_some_and(|value| value <= 0)
        || !(1..=100).contains(&limit)
    {
        return Err(invalid());
    }
    let mut stmt = conn.prepare(&format!(
        "SELECT {ATTEMPT_COLUMNS} {ATTEMPT_TABLES}
         WHERE s.account_context=?1 AND (?2 IS NULL OR s.problem_id=?2) AND (?3 IS NULL OR s.id<?3)
         ORDER BY s.id DESC LIMIT ?4"
    ))?;
    let mut attempts = stmt
        .query_map(
            params![
                request.account_context,
                request.problem_id,
                request.before,
                limit + 1
            ],
            attempt_metadata,
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let next = if attempts.len() > limit as usize {
        attempts.pop();
        attempts.last().map(|item| &item["id"])
    } else {
        None
    };
    Ok(json!({"attempts":attempts,"nextCursor":next}))
}

fn attempt(conn: &Connection, request: Attempt) -> Result<Value, StoreError> {
    if !valid_account(&request.account_context) || !valid_id(&request.submission_id) {
        return Err(invalid());
    }
    conn.query_row(
        &format!(
            "SELECT {ATTEMPT_COLUMNS}, s.source_code {ATTEMPT_TABLES}
                  WHERE s.account_context=?1 AND s.boj_submission_id=?2"
        ),
        params![request.account_context, request.submission_id],
        |row| {
            let mut data = attempt_metadata(row)?;
            data["source"] = json!(row.get::<_, String>(19)?);
            Ok(data)
        },
    )
    .optional()?
    .ok_or_else(unverified)
}

pub fn handles(kind: &str) -> bool {
    matches!(
        kind,
        "CREATE_SUBMISSION_INTENT"
            | "CONFIRM_SUBMISSION"
            | "GET_PENDING_INTENTS"
            | "UPDATE_VERDICT"
            | "GET_HISTORY"
            | "GET_ATTEMPT"
            | "GET_SETTINGS"
            | "UPDATE_SETTINGS"
    )
}

pub fn handle(kind: &str, payload: Value) -> Result<Value, StoreError> {
    let mut conn = open()?;
    match kind {
        "CREATE_SUBMISSION_INTENT" => prepare(&mut conn, parse(payload)?),
        "CONFIRM_SUBMISSION" => confirm(&mut conn, parse(payload)?),
        "GET_PENDING_INTENTS" => pending(&conn, parse(payload)?),
        "UPDATE_VERDICT" => update_verdict(&mut conn, parse(payload)?),
        "GET_HISTORY" => history(&conn, parse(payload)?),
        "GET_ATTEMPT" => attempt(&conn, parse(payload)?),
        "GET_SETTINGS" if payload == json!({}) => settings(&conn),
        "UPDATE_SETTINGS" => update_settings(&conn, parse(payload)?),
        _ => Err(invalid()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    verdict_wait_seconds: u32,
}

fn settings(conn: &Connection) -> Result<Value, StoreError> {
    let wait = conn
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM settings WHERE key='verdict_wait_seconds'",
            [],
            |row| row.get::<_, u32>(0),
        )
        .optional()?
        .unwrap_or(300);
    Ok(json!({"verdictWaitSeconds":wait}))
}

fn update_settings(conn: &Connection, request: Settings) -> Result<Value, StoreError> {
    if request.verdict_wait_seconds > 86_400 {
        return Err(invalid());
    }
    conn.execute(
        "INSERT INTO settings(key,value) VALUES ('verdict_wait_seconds', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=unixepoch()",
        [request.verdict_wait_seconds.to_string()],
    )?;
    settings(conn)
}
