use crate::storage::{data_dir, open, StoreError};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use uuid::Uuid;

const MAX_RETRIES: i64 = 4;
static STOP: AtomicBool = AtomicBool::new(false);
static GITHUB_AUTH: Mutex<Option<GithubAuth>> = Mutex::new(None);

pub fn stop_background() {
    STOP.store(true, Ordering::Relaxed);
}

pub fn enqueue(tx: &Transaction<'_>, submission_id: i64) -> rusqlite::Result<usize> {
    tx.execute(
        "INSERT INTO sync_jobs(submission_id, repository_id)
         SELECT ?1, id FROM repositories WHERE active = 1
         ON CONFLICT(submission_id, repository_id) DO UPDATE SET status = 'PENDING',
           retry_count = 0, last_error = NULL, next_retry_at = 0, updated_at = unixepoch()
         WHERE sync_jobs.status = 'PUSHED' AND sync_jobs.synced_revision <
           (SELECT revision FROM submissions WHERE id = ?1)",
        [submission_id],
    )
}

type Result<T> = std::result::Result<T, StoreError>;

fn failure(code: &'static str, message: &'static str) -> StoreError {
    StoreError::new(code, message, false)
}

fn invalid() -> StoreError {
    failure(
        "GIT_REPOSITORY_INVALID",
        "Enter a GitHub repository URL and an existing branch.",
    )
}

fn conflict() -> StoreError {
    failure(
        "GIT_SYNC_CONFLICT",
        "Managed repository content differs from the saved submission.",
    )
}

fn fs_error(_: std::io::Error) -> StoreError {
    failure(
        "FILE_SYSTEM_ERROR",
        "Could not access the managed repository files.",
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Configure {
    remote_url: String,
    branch: String,
    auto_sync: bool,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Retry {
    #[serde(default)]
    allow_push: bool,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GithubAuth {
    remote_url: String,
    basic: String,
    expires_at: u64,
}

fn now_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn set_github_auth(auth: Option<GithubAuth>) -> Result<Value> {
    let auth = auth
        .map(|mut auth| {
            let (remote, _) = github_remote(&auth.remote_url).ok_or_else(invalid)?;
            let now = now_seconds();
            if !remote.starts_with("https://")
                || !(now + 1..=now + 86_400).contains(&auth.expires_at)
                || !(20..=512).contains(&auth.basic.len())
                || !auth
                    .basic
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
            {
                return Err(failure("INVALID_MESSAGE", "Invalid GitHub authorization."));
            }
            auth.remote_url = remote;
            Ok(auth)
        })
        .transpose()?;
    *GITHUB_AUTH
        .lock()
        .map_err(|_| failure("INTERNAL_ERROR", "Could not update GitHub authorization."))? = auth;
    Ok(json!({"updated":true}))
}

struct Repository {
    id: String,
    remote: String,
    branch: String,
    path: PathBuf,
    auto_sync: bool,
    head: String,
}

pub(crate) fn github_remote(input: &str) -> Option<(String, String)> {
    let (scheme, path) = input
        .strip_prefix("https://github.com/")
        .map(|s| ("https://github.com/", s))
        .or_else(|| {
            input
                .strip_prefix("git@github.com:")
                .map(|s| ("git@github.com:", s))
        })
        .or_else(|| {
            input
                .strip_prefix("ssh://git@github.com/")
                .map(|s| ("git@github.com:", s))
        })?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    let allowed = |part: &str| {
        !part.is_empty()
            && part.len() <= 100
            && part != "."
            && part != ".."
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    if !allowed(owner) || !allowed(repo) {
        return None;
    }
    let path = path.to_ascii_lowercase();
    Some((
        format!("{scheme}{path}.git"),
        format!("https://github.com/{path}"),
    ))
}

fn git_executable() -> Option<PathBuf> {
    let name = if cfg!(windows) { "git.exe" } else { "git" };
    let program_files =
        std::env::var_os("ProgramFiles").map(|path| PathBuf::from(path).join("Git/cmd"));
    std::env::var_os("PATH")
        .iter()
        .flat_map(std::env::split_paths)
        .chain(program_files)
        .chain(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].map(PathBuf::from))
        .filter(|dir| dir.is_absolute())
        .map(|dir| dir.join(name))
        .find(|candidate| candidate.is_file())
}

struct Git {
    executable: PathBuf,
    hooks: PathBuf,
    auth: Option<GithubAuth>,
}

struct GitOutput {
    ok: bool,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

impl GitOutput {
    fn text(&self) -> &str {
        std::str::from_utf8(&self.stdout).unwrap_or("").trim()
    }
}

impl Git {
    fn new(root: &Path) -> Result<Self> {
        let executable = git_executable()
            .ok_or_else(|| failure("GIT_NOT_FOUND", "Install Git to connect a repository."))?;
        let hooks = root.join("disabled-hooks");
        fs::create_dir_all(&hooks).map_err(fs_error)?;
        if fs::symlink_metadata(&hooks)
            .map_err(fs_error)?
            .file_type()
            .is_symlink()
            || fs::read_dir(&hooks).map_err(fs_error)?.next().is_some()
        {
            return Err(conflict());
        }
        Ok(Self {
            executable,
            hooks,
            auth: None,
        })
    }

    fn for_remote(mut self, remote: &str) -> Self {
        self.auth = GITHUB_AUTH.lock().ok().and_then(|stored| {
            stored
                .as_ref()
                .filter(|auth| auth.remote_url == remote && auth.expires_at > now_seconds())
                .cloned()
        });
        self
    }

    fn run(&self, cwd: &Path, args: &[&str]) -> Result<GitOutput> {
        if STOP.load(Ordering::Relaxed) {
            return Err(StoreError::new(
                "GIT_TIMEOUT",
                "The native connection ended.",
                true,
            ));
        }
        let mut command = Command::new(&self.executable);
        for (key, _) in std::env::vars_os() {
            if key
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("GIT_")
            {
                command.env_remove(key);
            }
        }
        command
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_NO_REPLACE_OBJECTS", "1")
            .env("GCM_INTERACTIVE", "never")
            .env("LC_ALL", "C")
            .args([
                "-c",
                "protocol.allow=never",
                "-c",
                "protocol.https.allow=always",
                "-c",
                "protocol.ssh.allow=always",
            ])
            .args([
                "-c",
                "core.fsmonitor=false",
                "-c",
                "core.sshCommand=ssh -o BatchMode=yes",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.autocrlf=false",
                "-c",
                "gc.auto=0",
                "-c",
                "http.followRedirects=false",
            ])
            .arg("-c")
            .arg(format!("core.hooksPath={}", self.hooks.display()))
            .args([
                "-c",
                "submodule.recurse=false",
                "-c",
                "push.followTags=false",
            ])
            .stdin(Stdio::null());
        if cfg!(test) {
            command.env("GIT_CONFIG_NOSYSTEM", "1");
            command.env(
                "GIT_CONFIG_GLOBAL",
                if cfg!(windows) { "NUL" } else { "/dev/null" },
            );
            command.args([
                "-c",
                "protocol.file.allow=always",
                "-c",
                "user.name=SUPER_BOJ",
                "-c",
                "user.email=test@example.invalid",
            ]);
        }
        if let Some(auth) = self.auth.as_ref().filter(|_| {
            matches!(
                args.first().copied(),
                Some("clone" | "push" | "fetch" | "ls-remote")
            ) && !args.contains(&"--get-url")
        }) {
            command
                .env("GIT_CONFIG_COUNT", "2")
                .env(
                    "GIT_CONFIG_KEY_0",
                    format!("http.{}.extraHeader", auth.remote_url),
                )
                .env(
                    "GIT_CONFIG_VALUE_0",
                    format!("Authorization: Basic {}", auth.basic),
                )
                .env("GIT_CONFIG_KEY_1", "credential.helper")
                .env("GIT_CONFIG_VALUE_1", "");
        }
        command.args(args);
        let stdout = tempfile::tempfile().map_err(fs_error)?;
        let stderr = tempfile::tempfile().map_err(fs_error)?;
        command
            .stdout(stdout.try_clone().map_err(fs_error)?)
            .stderr(stderr.try_clone().map_err(fs_error)?);
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
        }
        #[cfg(windows)]
        let job = crate::windows_job::WindowsJob::prepare(&mut command).map_err(fs_error)?;
        let mut child = command
            .spawn()
            .map_err(|_| failure("GIT_NOT_FOUND", "Could not launch Git."))?;
        #[cfg(windows)]
        {
            use std::os::windows::io::AsRawHandle;
            if let Err(error) = job.attach_and_resume(child.id(), child.as_raw_handle()) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(fs_error(error));
            }
        }
        let deadline = Instant::now() + Duration::from_secs(25);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(fs_error)? {
                break status;
            }
            let too_much_output = [&stdout, &stderr]
                .iter()
                .any(|file| file.metadata().is_ok_and(|m| m.len() > 1024 * 1024));
            if STOP.load(Ordering::Relaxed) || Instant::now() >= deadline || too_much_output {
                #[cfg(unix)]
                unsafe {
                    libc::kill(-(child.id() as i32), libc::SIGKILL);
                }
                let _ = child.kill();
                let _ = child.wait();
                return Err(StoreError::new(
                    "GIT_TIMEOUT",
                    "Git did not finish before the operation ended.",
                    true,
                ));
            }
            thread::sleep(Duration::from_millis(20));
        };
        use std::io::{Seek, SeekFrom};
        let read = |mut file: File| -> std::io::Result<Vec<u8>> {
            file.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::new();
            file.take(1024 * 1024).read_to_end(&mut bytes)?;
            Ok(bytes)
        };
        Ok(GitOutput {
            ok: status.success(),
            stdout: read(stdout).map_err(fs_error)?,
            stderr: read(stderr).map_err(fs_error)?,
        })
    }

    fn checked(&self, cwd: &Path, args: &[&str]) -> Result<GitOutput> {
        let output = self.run(cwd, args)?;
        if output.ok {
            Ok(output)
        } else {
            Err(conflict())
        }
    }
}

fn read_repository(db: &Connection) -> Result<Option<Repository>> {
    Ok(db
        .query_row(
            "SELECT id, remote_url, branch, local_path, auto_sync, managed_head
         FROM repositories WHERE active = 1",
            [],
            |row| {
                Ok(Repository {
                    id: row.get(0)?,
                    remote: row.get(1)?,
                    branch: row.get(2)?,
                    path: PathBuf::from(row.get::<_, String>(3)?),
                    auto_sync: row.get(4)?,
                    head: row.get(5)?,
                })
            },
        )
        .optional()?)
}

struct RepositoryLease(File);

impl Drop for RepositoryLease {
    fn drop(&mut self) {
        // A concurrent fork can briefly hold a duplicate descriptor until exec.
        let _ = self.0.unlock();
    }
}

fn lock(root: &Path) -> Result<RepositoryLease> {
    fs::create_dir_all(root).map_err(fs_error)?;
    if !fs::symlink_metadata(root)
        .map_err(fs_error)?
        .file_type()
        .is_dir()
    {
        return Err(conflict());
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("sync.lock"))
        .map_err(fs_error)?;
    match file.try_lock() {
        Ok(()) => Ok(RepositoryLease(file)),
        Err(std::fs::TryLockError::WouldBlock) => Err(StoreError::new(
            "GIT_SYNC_BUSY",
            "A repository operation is already running.",
            true,
        )),
        Err(std::fs::TryLockError::Error(error)) => Err(fs_error(error)),
    }
}

fn clone_repository(
    git: &Git,
    root: &Path,
    remote: &str,
    branch: &str,
    path: &Path,
) -> Result<String> {
    if !git
        .run(root, &["check-ref-format", &format!("refs/heads/{branch}")])?
        .ok
    {
        return Err(invalid());
    }
    if git
        .checked(root, &["ls-remote", "--get-url", "--", remote])?
        .text()
        != remote
    {
        return Err(invalid());
    }
    let target = path.to_str().ok_or_else(invalid)?;
    let result = git.run(
        root,
        &[
            "clone",
            "--no-local",
            "--single-branch",
            "--no-tags",
            "--branch",
            branch,
            "--",
            remote,
            target,
        ],
    )?;
    if !result.ok {
        let stderr = String::from_utf8_lossy(&result.stderr).to_ascii_lowercase();
        if stderr.contains("authentication")
            || stderr.contains("permission denied")
            || stderr.contains("could not read username")
            || stderr.contains("repository not found")
        {
            return Err(failure(
                "GIT_AUTH_FAILED",
                "GitHub access failed. Check the repository and your Git credentials.",
            ));
        }
        return Err(failure(
            "GIT_REPOSITORY_INVALID",
            "Git could not clone the selected GitHub branch.",
        ));
    }
    Ok(git
        .checked(path, &["rev-parse", "--verify", "HEAD"])?
        .text()
        .to_owned())
}

fn configure(db: &mut Connection, root: &Path, input: Configure) -> Result<Value> {
    let (remote, _) = github_remote(&input.remote_url).ok_or_else(invalid)?;
    if input.branch.is_empty() || input.branch.len() > 200 || input.branch.starts_with('-') {
        return Err(invalid());
    }
    let _lease = lock(root)?;
    let existing: Option<String> = db
        .query_row(
            "SELECT id FROM repositories WHERE remote_url = ?1 AND branch = ?2",
            params![remote, input.branch],
            |row| row.get(0),
        )
        .optional()?;
    let tx = if let Some(id) = existing {
        let tx = db.transaction()?;
        tx.execute(
            "UPDATE repositories SET active = 0 WHERE active = 1 AND id <> ?1",
            [&id],
        )?;
        tx.execute("UPDATE repositories SET active = 1, auto_sync = ?2, updated_at = unixepoch() WHERE id = ?1", params![id, input.auto_sync])?;
        tx
    } else {
        let git = Git::new(root)?.for_remote(&remote);
        let id = Uuid::new_v4().to_string();
        let path = root.join(&id);
        let head = clone_repository(&git, root, &remote, &input.branch, &path)?;
        let tx = db.transaction()?;
        tx.execute("UPDATE repositories SET active = 0 WHERE active = 1", [])?;
        tx.execute(
            "INSERT INTO repositories(id, remote_url, branch, local_path, auto_sync, managed_head)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                id,
                remote,
                input.branch,
                path.to_str().ok_or_else(invalid)?,
                input.auto_sync,
                head
            ],
        )?;
        tx
    };
    tx.commit()?;
    status(db)
}

fn status(db: &Connection) -> Result<Value> {
    let available = git_executable().is_some();
    let Some(repo) = read_repository(db)? else {
        return Ok(
            json!({"available":available,"repository":null,"pendingCount":0,"failedCount":0,
            "lastCommit":null,"lastSyncAt":null,"lastError":null,"authentication":"UNVERIFIED"}),
        );
    };
    let (pending,failed) = db.query_row(
        "SELECT count(*) FILTER (WHERE status NOT IN ('PUSHED','FAILED','CONFLICT')),
                count(*) FILTER (WHERE status IN ('FAILED','CONFLICT')) FROM sync_jobs WHERE repository_id=?1",
        [&repo.id],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let (commit, synced_at): (Option<String>, Option<String>) = db
        .query_row(
            "SELECT pushed_sha, strftime('%Y-%m-%dT%H:%M:%SZ',pushed_at,'unixepoch') FROM sync_jobs
         WHERE repository_id=?1 AND pushed_at IS NOT NULL
         ORDER BY pushed_at DESC,id DESC LIMIT 1",
            [&repo.id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?
        .unwrap_or_default();
    let last_error: Option<String> = db
        .query_row(
            "SELECT last_error FROM sync_jobs WHERE repository_id=?1 AND last_error IS NOT NULL
         ORDER BY updated_at DESC,id DESC LIMIT 1",
            [&repo.id],
            |row| row.get(0),
        )
        .optional()?;
    let web_url = github_remote(&repo.remote).map(|(_, url)| url);
    Ok(
        json!({"available":available,"repository":{"remoteUrl":repo.remote,"branch":repo.branch,
            "autoSync":repo.auto_sync,"webUrl":web_url},"pendingCount":pending,"failedCount":failed,
            "lastCommit":commit,"lastSyncAt":synced_at,"lastError":last_error,
            "authentication":if last_error.as_deref() == Some("GIT_AUTH_FAILED") {"FAILED"}
            else if synced_at.is_some() {"WRITE_VERIFIED"} else {"READ_VERIFIED"}}),
    )
}

struct Job {
    id: i64,
    problem_id: i64,
    submission: String,
    source: String,
    revision: i64,
    metadata: String,
    synced_revision: i64,
    working_revision: Option<i64>,
    working_metadata: Option<String>,
    commit: Option<String>,
    pushed_sha: Option<String>,
    retries: i64,
}

fn next_job(db: &Connection, repo: &Repository) -> Result<Option<Job>> {
    Ok(db.query_row(
        "SELECT j.id, s.problem_id, s.boj_submission_id, s.source_code, s.revision,
                json_object('schemaVersion',1,'problemId',s.problem_id,'problemTitle',p.title,
                  'problemUrl',p.url,'submissionId',s.boj_submission_id,'language',s.language,
                  'attemptNumber',(SELECT count(*) FROM submissions a WHERE a.problem_id=s.problem_id
                      AND a.account_context=s.account_context AND a.id <= s.id),
                  'verdict',CASE WHEN s.verdict IN ('WAITING','JUDGING') THEN 'UNKNOWN' ELSE s.verdict END,
                  'rawVerdict',s.raw_verdict,'executionTimeMs',s.execution_time_ms,'memoryKb',s.memory_kb,
                  'submittedAt',s.submitted_at,'sourceFile','main.rs','sourceHash',s.source_hash),
                j.synced_revision,j.working_revision,j.working_metadata,j.commit_sha,j.pushed_sha,j.retry_count
         FROM sync_jobs j JOIN submissions s ON s.id=j.submission_id JOIN problems p ON p.id=s.problem_id
         WHERE j.repository_id=?1 AND (
             j.working_revision IS NOT NULL OR (
               j.status IN ('PENDING','RETRY_WAIT') AND j.next_retry_at <= unixepoch()
               AND (s.verdict NOT IN ('WAITING','JUDGING') OR s.created_at + coalesce(
                   (SELECT CAST(value AS INTEGER) FROM settings WHERE key='verdict_wait_seconds'),300
                 ) <= unixepoch())
             ))
         ORDER BY j.working_revision IS NULL, j.id LIMIT 1",
        [&repo.id],
        |row| Ok(Job {
            id:row.get(0)?,problem_id:row.get(1)?,submission:row.get(2)?,source:row.get(3)?,
            revision:row.get(4)?,metadata:row.get(5)?,synced_revision:row.get(6)?,
            working_revision:row.get(7)?,working_metadata:row.get(8)?,commit:row.get(9)?,
            pushed_sha:row.get(10)?,retries:row.get(11)?,
        }),
    ).optional()?)
}

fn verify_repository(git: &Git, root: &Path, repo: &Repository) -> Result<String> {
    if Uuid::parse_str(&repo.id).is_err() || repo.path != root.join(&repo.id) {
        return Err(conflict());
    }
    #[cfg(not(test))]
    if github_remote(&repo.remote).is_none() {
        return Err(conflict());
    }
    for directory in [&repo.path, &repo.path.join(".git")] {
        if !fs::symlink_metadata(directory)
            .map_err(fs_error)?
            .file_type()
            .is_dir()
        {
            return Err(conflict());
        }
    }
    if git.checked(&repo.path, &["symbolic-ref", "HEAD"])?.text()
        != format!("refs/heads/{}", repo.branch)
    {
        return Err(conflict());
    }
    for args in [
        &["remote", "get-url", "origin"][..],
        &["remote", "get-url", "--push", "origin"][..],
    ] {
        if git.checked(&repo.path, args)?.text() != repo.remote {
            return Err(conflict());
        }
    }
    // Git accepts multiple push URLs for one remote. Reject all configurations except exactly one.
    let urls = git.checked(
        &repo.path,
        &["remote", "get-url", "--push", "--all", "origin"],
    )?;
    if urls.text() != repo.remote {
        return Err(conflict());
    }
    Ok(git
        .checked(&repo.path, &["rev-parse", "--verify", "HEAD"])?
        .text()
        .to_owned())
}

fn check_worktree(git: &Git, repo: &Repository, allowed: &[&str]) -> Result<()> {
    let status = git.checked(
        &repo.path,
        &[
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
            "--ignored=matching",
        ],
    )?;
    for entry in status
        .stdout
        .split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
    {
        let path = entry.get(3..).ok_or_else(conflict)?;
        if !allowed.iter().any(|name| name.as_bytes() == path) {
            return Err(failure(
                "GIT_REPOSITORY_DIRTY",
                "Managed repository has unexpected local changes.",
            ));
        }
    }
    Ok(())
}

fn job_paths(repo: &Repository, job: &Job) -> Result<(String, String)> {
    if job.problem_id <= 0
        || job.submission.is_empty()
        || job.submission.len() > 20
        || !job.submission.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(conflict());
    }
    let directory = format!("BOJ/{}/attempts/{}", job.problem_id, job.submission);
    let mut path = repo.path.clone();
    for component in directory.split('/') {
        path.push(component);
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Err(conflict()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(fs_error(error)),
        }
    }
    Ok((
        format!("{directory}/main.rs"),
        format!("{directory}/metadata.json"),
    ))
}

fn read_regular_file(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() && metadata.len() <= 512 * 1024 => {
            Ok(Some(fs::read(path).map_err(fs_error)?))
        }
        Ok(_) => Err(conflict()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(fs_error(error)),
    }
}

fn atomic_file(root: &Path, path: &Path, content: &[u8], overwrite: bool) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(fs_error)?;
    }
    let mut temp = tempfile::NamedTempFile::new_in(root).map_err(fs_error)?;
    temp.write_all(content).map_err(fs_error)?;
    temp.as_file().sync_all().map_err(fs_error)?;
    if overwrite {
        temp.persist(path).map_err(|e| fs_error(e.error))?;
    } else {
        temp.persist_noclobber(path)
            .map_err(|e| fs_error(e.error))?;
    }
    Ok(())
}

fn tree_file(git: &Git, repo: &Repository, revision: &str, path: &str) -> Result<Option<Vec<u8>>> {
    let result = git.run(
        &repo.path,
        &["show", "--no-textconv", &format!("{revision}:{path}")],
    )?;
    Ok(result.ok.then_some(result.stdout))
}

fn verify_commit(
    git: &Git,
    repo: &Repository,
    head: &str,
    source: (&str, &[u8]),
    metadata: (&str, &[u8]),
    trailer: &str,
) -> Result<()> {
    let parent = git.checked(&repo.path, &["show", "-s", "--format=%P", head])?;
    let message = git.checked(&repo.path, &["show", "-s", "--format=%B", head])?;
    let changed = git.checked(
        &repo.path,
        &[
            "diff-tree",
            "--no-commit-id",
            "--name-only",
            "-r",
            "-z",
            head,
        ],
    )?;
    let valid_paths = changed
        .stdout
        .split(|b| *b == 0)
        .filter(|entry| !entry.is_empty())
        .all(|entry| entry == source.0.as_bytes() || entry == metadata.0.as_bytes());
    if parent.text() != repo.head
        || !message.text().lines().any(|line| line == trailer)
        || !valid_paths
        || tree_file(git, repo, head, source.0)?.as_deref() != Some(source.1)
        || tree_file(git, repo, head, metadata.0)?.as_deref() != Some(metadata.1)
    {
        return Err(conflict());
    }
    Ok(())
}

fn stage_file(git: &Git, repo: &Repository, path: &str) -> Result<()> {
    // Hash exact bytes and stage only this path, independent of clean filters and attributes.
    let oid = git.checked(
        &repo.path,
        &["hash-object", "-w", "--no-filters", "--", path],
    )?;
    git.checked(
        &repo.path,
        &[
            "update-index",
            "--add",
            "--cacheinfo",
            "100644",
            oid.text(),
            path,
        ],
    )?;
    Ok(())
}

fn commit_attempt(
    git: &Git,
    repo: &Repository,
    root: &Path,
    job: &Job,
    revision: i64,
    metadata: &str,
) -> Result<String> {
    let head = verify_repository(git, root, repo)?;
    let (source_path, metadata_path) = job_paths(repo, job)?;
    let metadata_json: Value = serde_json::from_str(metadata).map_err(|_| conflict())?;
    let metadata_bytes = format!(
        "{}\n",
        serde_json::to_string_pretty(&metadata_json).map_err(|_| conflict())?
    )
    .into_bytes();
    let trailer = format!("SUPER-BOJ-Attempt: {}@{}", job.submission, revision);
    let source = job.source.as_bytes();
    if metadata_json["sourceHash"].as_str() != Some(crate::storage::hash(&job.source).as_str()) {
        return Err(conflict());
    }

    if head != repo.head {
        check_worktree(git, repo, &[])?;
        verify_commit(
            git,
            repo,
            &head,
            (&source_path, source),
            (&metadata_path, &metadata_bytes),
            &trailer,
        )?;
        return Ok(head);
    }
    let initial = job.synced_revision == 0;
    let allowed = if initial {
        vec![source_path.as_str(), metadata_path.as_str()]
    } else {
        vec![metadata_path.as_str()]
    };
    check_worktree(git, repo, &allowed)?;
    let old_source = tree_file(git, repo, &head, &source_path)?;
    let old_metadata = tree_file(git, repo, &head, &metadata_path)?;
    if initial {
        if old_source.is_some() || old_metadata.is_some() {
            return Err(conflict());
        }
    } else {
        let previous = job.pushed_sha.as_deref().ok_or_else(conflict)?;
        if old_source.as_deref() != Some(source)
            || old_metadata.is_none()
            || tree_file(git, repo, previous, &metadata_path)? != old_metadata
        {
            return Err(conflict());
        }
    }

    for (path, new, previous, replace) in [
        (&source_path, source, old_source.as_deref(), false),
        (
            &metadata_path,
            metadata_bytes.as_slice(),
            old_metadata.as_deref(),
            !initial,
        ),
    ] {
        let absolute = repo.path.join(path);
        let current = read_regular_file(&absolute)?;
        let staged = tree_file(git, repo, "", path)?;
        if staged
            .as_deref()
            .is_some_and(|contents| Some(contents) != previous && contents != new)
        {
            return Err(conflict());
        }
        match current.as_deref() {
            Some(bytes) if bytes == new => {}
            Some(bytes) if replace && Some(bytes) == previous => {
                atomic_file(root, &absolute, new, true)?
            }
            None if initial => atomic_file(root, &absolute, new, false)?,
            _ => return Err(conflict()),
        }
        if initial || replace {
            stage_file(git, repo, path)?;
        }
    }
    let verdict = metadata_json["verdict"].as_str().ok_or_else(conflict)?;
    let summary = match verdict {
        "ACCEPTED" => "Accepted",
        "WRONG_ANSWER" => "Wrong Answer",
        "COMPILE_ERROR" => "Compile Error",
        "RUNTIME_ERROR" => "Runtime Error",
        "TIME_LIMIT_EXCEEDED" => "Time Limit Exceeded",
        "MEMORY_LIMIT_EXCEEDED" => "Memory Limit Exceeded",
        "OUTPUT_LIMIT_EXCEEDED" => "Output Limit Exceeded",
        "PRESENTATION_ERROR" => "Presentation Error",
        _ => "Unknown",
    };
    let action = if initial { "" } else { "Verdict update: " };
    let subject = format!(
        "[BOJ-{}] #{} {action}{summary}",
        job.problem_id, job.submission
    );
    let tree = git.checked(&repo.path, &["write-tree"])?;
    let changed = git.checked(
        &repo.path,
        &["diff-tree", "--name-only", "-r", "-z", &head, tree.text()],
    )?;
    if changed
        .stdout
        .split(|b| *b == 0)
        .filter(|path| !path.is_empty())
        .any(|path| {
            !allowed
                .iter()
                .any(|allowed_path| allowed_path.as_bytes() == path)
        })
    {
        return Err(conflict());
    }
    let output = git.run(
        &repo.path,
        &[
            "commit-tree",
            tree.text(),
            "-p",
            &head,
            "-m",
            &subject,
            "-m",
            &trailer,
        ],
    )?;
    if !output.ok {
        return Err(failure(
            "GIT_COMMIT_FAILED",
            "Git could not commit. Check the managed repository and Git author settings.",
        ));
    }
    let committed = output.text().to_owned();
    verify_commit(
        git,
        repo,
        &committed,
        (&source_path, source),
        (&metadata_path, &metadata_bytes),
        &trailer,
    )?;
    git.checked(
        &repo.path,
        &[
            "update-ref",
            &format!("refs/heads/{}", repo.branch),
            &committed,
            &head,
        ],
    )?;
    Ok(committed)
}

fn push(git: &Git, repo: &Repository, commit: &str) -> Result<()> {
    let refspec = format!("{commit}:refs/heads/{}", repo.branch);
    let output = git.run(
        &repo.path,
        &[
            "push",
            "--porcelain",
            "--no-follow-tags",
            "--recurse-submodules=no",
            "origin",
            &refspec,
        ],
    )?;
    if output.ok {
        return Ok(());
    }
    let details = format!(
        "{}\n{}",
        output.text(),
        String::from_utf8_lossy(&output.stderr)
    )
    .to_ascii_lowercase();
    if details.contains("non-fast-forward") || details.contains("fetch first") {
        let branch = format!("refs/heads/{}", repo.branch);
        let remote = git.run(&repo.path, &["ls-remote", "--refs", "origin", &branch])?;
        let remote_id = remote
            .text()
            .split_once('\t')
            .map(|(oid, _)| oid)
            .filter(|oid| oid.len() == 40 && oid.bytes().all(|b| b.is_ascii_hexdigit()));
        if remote.ok {
            if let Some(oid) = remote_id {
                // Fetch only into FETCH_HEAD when the new remote commit is absent locally.
                if !git.run(&repo.path, &["cat-file", "-e", oid])?.ok {
                    git.run(
                        &repo.path,
                        &[
                            "fetch",
                            "--no-tags",
                            "--no-recurse-submodules",
                            "origin",
                            &branch,
                        ],
                    )?;
                }
                if git
                    .run(&repo.path, &["merge-base", "--is-ancestor", commit, oid])?
                    .ok
                {
                    return Ok(());
                }
            }
        }
        return Err(failure(
            "GIT_NON_FAST_FORWARD",
            "The remote branch changed. Resolve branch divergence before retrying.",
        ));
    }
    if details.contains("authentication")
        || details.contains("permission denied")
        || details.contains("could not read username")
    {
        return Err(failure(
            "GIT_AUTH_FAILED",
            "GitHub rejected the credentials. Check your Git credential helper or SSH agent.",
        ));
    }
    Err(StoreError::new(
        "GIT_PUSH_FAILED",
        "Git could not push. The commit is preserved for retry.",
        true,
    ))
}

fn record_failure(db: &Connection, job: &Job, error: &StoreError) -> Result<()> {
    let retries = job.retries + 1;
    let status = match error.code {
        "GIT_SYNC_CONFLICT" | "GIT_NON_FAST_FORWARD" | "GIT_REPOSITORY_DIRTY" => "CONFLICT",
        _ if error.retryable && retries < MAX_RETRIES => "RETRY_WAIT",
        _ => "FAILED",
    };
    let delay = 15 * 2_i64.pow(retries.clamp(1, MAX_RETRIES) as u32 - 1);
    db.execute(
        "UPDATE sync_jobs SET status=?2, retry_count=?3, last_error=?4,
          next_retry_at=unixepoch()+?5, updated_at=unixepoch() WHERE id=?1",
        params![job.id, status, retries, error.code, delay],
    )?;
    Ok(())
}

fn sync_one(
    db: &mut Connection,
    root: &Path,
    git: &Git,
    repo: &Repository,
    job: &Job,
) -> Result<()> {
    let revision = job.working_revision.unwrap_or(job.revision);
    let metadata = job.working_metadata.as_deref().unwrap_or(&job.metadata);
    if job.working_revision.is_none() {
        if verify_repository(git, root, repo)? != repo.head {
            return Err(conflict());
        }
        check_worktree(git, repo, &[])?;
        db.execute(
            "UPDATE sync_jobs SET status='WRITING_FILES',working_revision=?2,working_metadata=?3,commit_sha=NULL,
             updated_at=unixepoch() WHERE id=?1",
            params![job.id,revision,metadata],
        )?;
    }
    let sha = if job.working_revision.is_some() && job.commit.is_some() {
        let sha = job.commit.as_deref().ok_or_else(conflict)?;
        let head = verify_repository(git, root, repo)?;
        if head != repo.head || head != sha {
            return Err(conflict());
        }
        check_worktree(git, repo, &[])?;
        sha.to_owned()
    } else {
        db.execute(
            "UPDATE sync_jobs SET status='COMMITTING',updated_at=unixepoch() WHERE id=?1",
            [job.id],
        )?;
        let sha = commit_attempt(git, repo, root, job, revision, metadata)?;
        let tx = db.transaction()?;
        tx.execute(
            "UPDATE repositories SET managed_head=?2 WHERE id=?1",
            params![repo.id, sha],
        )?;
        tx.execute("UPDATE sync_jobs SET status='COMMITTED',commit_sha=?2,updated_at=unixepoch() WHERE id=?1",params![job.id,sha])?;
        tx.commit()?;
        sha
    };
    db.execute(
        "UPDATE sync_jobs SET status='PUSHING',updated_at=unixepoch() WHERE id=?1",
        [job.id],
    )?;
    push(git, repo, &sha)?;
    db.execute(
        "UPDATE sync_jobs SET
            status=CASE WHEN ?2 = (SELECT revision FROM submissions WHERE id=submission_id)
                        THEN 'PUSHED' ELSE 'PENDING' END,
            synced_revision=?2,pushed_sha=?3,pushed_at=unixepoch(),working_revision=NULL,working_metadata=NULL,retry_count=0,last_error=NULL,
            next_retry_at=0,updated_at=unixepoch() WHERE id=?1",
        params![job.id,revision,sha],
    )?;
    Ok(())
}

fn sync_next(db: &mut Connection, root: &Path, manual: Option<Retry>) -> Result<()> {
    let _lease = lock(root)?;
    let Some(repo) = read_repository(db)? else {
        return Ok(());
    };
    if !repo.auto_sync && !manual.as_ref().is_some_and(|request| request.allow_push) {
        if manual.is_some() {
            return Err(failure(
                "GIT_PUSH_CONSENT_REQUIRED",
                "Enable automatic sync or confirm this push.",
            ));
        }
        return Ok(());
    }
    if manual.is_some() {
        db.execute(
            "UPDATE sync_jobs SET status='PENDING',retry_count=0,next_retry_at=0
             WHERE repository_id=?1 AND status IN ('FAILED','CONFLICT','RETRY_WAIT')",
            [&repo.id],
        )?;
    }
    let Some(job) = next_job(db, &repo)? else {
        return Ok(());
    };
    let ready: bool = db.query_row(
        "SELECT status NOT IN ('FAILED','CONFLICT') AND next_retry_at <= unixepoch() FROM sync_jobs WHERE id=?1",
        [job.id], |row|row.get(0),
    )?;
    if !ready || STOP.load(Ordering::Relaxed) {
        return Ok(());
    }
    let result = Git::new(root).and_then(|git| {
        let git = git.for_remote(&repo.remote);
        sync_one(db, root, &git, &repo, &job)
    });
    if let Err(error) = result {
        if STOP.load(Ordering::Relaxed) {
            return Ok(());
        }
        record_failure(db, &job, &error)?;
    }
    Ok(())
}

pub fn sync_background() -> Result<()> {
    let mut db = open()?;
    if !read_repository(&db)?.is_some_and(|repo| repo.auto_sync) {
        return Ok(());
    }
    sync_next(&mut db, &data_dir()?.join("repositories"), None)
}

pub fn handle(kind: &str, payload: Value) -> Option<Result<Value>> {
    fn request<T: for<'de> Deserialize<'de>>(payload: Value) -> Result<T> {
        serde_json::from_value(payload)
            .map_err(|_| failure("INVALID_MESSAGE", "Invalid Git request payload."))
    }
    Some(match kind {
        "SET_GITHUB_AUTH" => (|| {
            #[derive(Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Update {
                auth: Option<GithubAuth>,
            }
            let update: Update = request(payload)?;
            set_github_auth(update.auth)
        })(),
        "CONFIGURE_REPOSITORY" => (|| {
            configure(
                &mut open()?,
                &data_dir()?.join("repositories"),
                request(payload)?,
            )
        })(),
        "GET_GIT_STATUS" if payload == json!({}) => (|| status(&open()?))(),
        "GET_GIT_STATUS" => Err(failure(
            "INVALID_MESSAGE",
            "Expected an empty Git status request.",
        )),
        "RETRY_SYNC" => (|| {
            let mut db = open()?;
            sync_next(
                &mut db,
                &data_dir()?.join("repositories"),
                Some(request(payload)?),
            )?;
            status(&db)
        })(),
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture {
        root: tempfile::TempDir,
        git: Git,
        repo: PathBuf,
        remote: PathBuf,
        db: Connection,
    }

    #[cfg(unix)]
    #[test]
    fn repository_lease_unlocks_while_a_duplicate_descriptor_is_open() {
        let root = tempfile::tempdir().unwrap();
        let lease = lock(root.path()).unwrap();
        let inherited = lease.0.try_clone().unwrap();
        assert!(lock(root.path()).is_err());
        drop(lease);
        let _next = lock(root.path()).unwrap();
        drop(inherited);
    }

    impl Fixture {
        fn new() -> Self {
            let root = tempfile::tempdir().unwrap();
            let git = Git::new(root.path()).unwrap();
            let remote = root.path().join("remote.git");
            let seed = root.path().join("seed");
            git.checked(
                root.path(),
                &[
                    "init",
                    "--bare",
                    "--initial-branch=main",
                    remote.to_str().unwrap(),
                ],
            )
            .unwrap();
            git.checked(
                root.path(),
                &["init", "--initial-branch=main", seed.to_str().unwrap()],
            )
            .unwrap();
            git.checked(&seed, &["commit", "--allow-empty", "-m", "Initial"])
                .unwrap();
            git.checked(&seed, &["push", remote.to_str().unwrap(), "main"])
                .unwrap();
            let id = Uuid::new_v4().to_string();
            let repo = root.path().join(&id);
            let head = clone_repository(&git, root.path(), remote.to_str().unwrap(), "main", &repo)
                .unwrap();
            let db = Connection::open(root.path().join("fixture.sqlite3")).unwrap();
            db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
            db.execute_batch(include_str!("../migrations/001_submissions.sql"))
                .unwrap();
            db.execute_batch(include_str!("../migrations/002_git.sql"))
                .unwrap();
            db.execute(
                "INSERT INTO repositories(id,remote_url,branch,local_path,auto_sync,managed_head)
                        VALUES (?1,?2,'main',?3,1,?4)",
                params![id, remote.to_str().unwrap(), repo.to_str().unwrap(), head],
            )
            .unwrap();
            db.execute("INSERT INTO problems(id,title,url) VALUES (1000,'A+B','https://acmicpc.net/problem/1000')",[]).unwrap();
            Self {
                root,
                git,
                repo,
                remote,
                db,
            }
        }

        fn attempt(&mut self, id: i64, verdict: &str) {
            let tx = self.db.transaction().unwrap();
            let intent = format!("intent-{id}");
            let hash = crate::storage::hash("fn main() {}");
            tx.execute("INSERT INTO submission_intents(id,account_context,problem_id,language,source_code,source_hash,status)
                        VALUES (?1,'user',1000,'rust','fn main() {}',?2,'CONFIRMED')", params![intent,hash]).unwrap();
            tx.execute("INSERT INTO submissions(id,intent_id,account_context,problem_id,boj_submission_id,language,source_code,
                        source_hash,verdict,state) VALUES (?1,?2,'user',1000,?3,'rust','fn main() {}',?4,?5,'JUDGED')",
                params![id,intent,id.to_string(),hash,verdict]).unwrap();
            enqueue(&tx, id).unwrap();
            tx.commit().unwrap();
        }

        fn sync(&mut self) {
            sync_next(&mut self.db, self.root.path(), None).unwrap();
        }

        fn staged(&self, id: i64) -> (String, Option<String>) {
            self.db
                .query_row(
                    "SELECT status,commit_sha FROM sync_jobs WHERE submission_id=?1",
                    [id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .unwrap()
        }

        fn count_commits(&self, path: &Path) -> usize {
            self.git
                .checked(path, &["rev-list", "--count", "main"])
                .unwrap()
                .text()
                .parse()
                .unwrap()
        }
    }

    #[test]
    fn separate_attempts_duplicate_notification_and_metadata_update() {
        let mut fixture = Fixture::new();
        for (index, verdict) in ["COMPILE_ERROR", "WRONG_ANSWER", "RUNTIME_ERROR", "ACCEPTED"]
            .iter()
            .enumerate()
        {
            let id = 10001 + index as i64;
            fixture.attempt(id, verdict);
            fixture.sync();
            assert_eq!(
                fixture.staged(id).0,
                "PUSHED",
                "{}",
                status(&fixture.db).unwrap()
            );
            assert_eq!(
                fs::read_to_string(fixture.repo.join(format!("BOJ/1000/attempts/{id}/main.rs")))
                    .unwrap(),
                "fn main() {}"
            );
        }
        let tx = fixture.db.transaction().unwrap();
        enqueue(&tx, 10001).unwrap();
        tx.commit().unwrap();
        fixture.sync();
        assert_eq!(fixture.count_commits(&fixture.remote), 5);
        let tx = fixture.db.transaction().unwrap();
        tx.execute(
            "UPDATE submissions SET verdict='ACCEPTED',revision=2 WHERE id=10001",
            [],
        )
        .unwrap();
        enqueue(&tx, 10001).unwrap();
        tx.commit().unwrap();
        fixture.sync();
        assert_eq!(
            fixture.staged(10001).0,
            "PUSHED",
            "{}",
            status(&fixture.db).unwrap()
        );
        assert_eq!(fixture.count_commits(&fixture.remote), 6);
        let files = fixture
            .git
            .checked(
                &fixture.repo,
                &["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
            )
            .unwrap();
        assert_eq!(files.text(), "BOJ/1000/attempts/10001/metadata.json");
    }

    #[test]
    fn failed_push_retries_the_existing_commit() {
        let mut fixture = Fixture::new();
        let relocated = fixture.root.path().join("offline");
        fs::rename(&fixture.remote, &relocated).unwrap();
        fixture.attempt(10001, "WRONG_ANSWER");
        fixture.sync();
        let (state, sha) = fixture.staged(10001);
        assert_eq!(state, "RETRY_WAIT", "{}", status(&fixture.db).unwrap());
        assert!(sha.is_some());
        fs::rename(relocated, &fixture.remote).unwrap();
        sync_next(&mut fixture.db, fixture.root.path(), Some(Retry::default())).unwrap();
        assert_eq!(fixture.staged(10001), ("PUSHED".to_owned(), sha));
        assert_eq!(fixture.count_commits(&fixture.remote), 2);
    }

    #[test]
    fn commit_before_db_write_is_recovered() {
        let mut fixture = Fixture::new();
        fixture.attempt(10001, "ACCEPTED");
        let repo = read_repository(&fixture.db).unwrap().unwrap();
        let job = next_job(&fixture.db, &repo).unwrap().unwrap();
        fixture.db.execute(
            "UPDATE sync_jobs SET working_revision=?2,working_metadata=?3,status='COMMITTING' WHERE id=?1",
            params![job.id,job.revision,job.metadata]).unwrap();
        let sha = commit_attempt(
            &fixture.git,
            &repo,
            fixture.root.path(),
            &job,
            job.revision,
            &job.metadata,
        )
        .unwrap();
        assert_eq!(fixture.count_commits(&fixture.remote), 1);
        fixture.db = Connection::open(fixture.root.path().join("fixture.sqlite3")).unwrap();
        fixture.sync();
        assert_eq!(fixture.staged(10001), ("PUSHED".to_owned(), Some(sha)));
        assert_eq!(fixture.count_commits(&fixture.remote), 2);
    }
    #[test]
    fn unrelated_worktree_files_stop_sync_without_creating_commit() {
        let mut fixture = Fixture::new();
        let unexpected = fixture.repo.join("work-in-progress");
        fs::write(&unexpected, "work in progress").unwrap();
        fixture.attempt(10001, "ACCEPTED");
        fixture.sync();
        assert_eq!(fixture.staged(10001), ("CONFLICT".to_owned(), None));
        assert_eq!(fs::read_to_string(&unexpected).unwrap(), "work in progress");
        assert_eq!(fixture.count_commits(&fixture.remote), 1);
        assert!(!fixture.repo.join("BOJ").exists());
    }

    #[test]
    fn previously_pushed_commit_is_detected_after_db_acknowledgement_is_lost() {
        let mut fixture = Fixture::new();
        fixture.attempt(10001, "ACCEPTED");
        fixture.sync();
        let (_, sha) = fixture.staged(10001);
        let repo = read_repository(&fixture.db).unwrap().unwrap();
        fixture.db.execute(
            "UPDATE sync_jobs SET status='PUSHING',working_revision=1,working_metadata='{}' WHERE repository_id=?1",
            [&repo.id],
        ).unwrap();
        fixture.db = Connection::open(fixture.root.path().join("fixture.sqlite3")).unwrap();
        fixture.sync();
        assert_eq!(fixture.staged(10001), ("PUSHED".to_owned(), sha));
        assert_eq!(fixture.count_commits(&fixture.remote), 2);
    }

    #[test]
    fn github_remote_accepts_only_explicit_credential_free_github_locations() {
        assert_eq!(
            github_remote("ssh://git@github.com/Octo/Repo.git"),
            Some((
                "git@github.com:octo/repo.git".into(),
                "https://github.com/octo/repo".into()
            ))
        );
        for invalid in [
            "https://username@github.com/owner/repo",
            "https://github.com.example.com/owner/repo",
            "https://github.com/owner/repo?token=secret",
            "https://github.com/owner/../repo",
            "git@github.com:/owner/repo",
            "ext::git server",
            "file:///tmp/test.git",
        ] {
            assert!(github_remote(invalid).is_none());
        }
    }
}
