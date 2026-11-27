use anyhow::{Context, Result};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{path::PathBuf, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::Command,
    sync::{mpsc, watch},
    time::Instant,
};
use uuid::Uuid;

const OUTPUT_LIMIT: usize = 64 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Run {
    pub job_id: Uuid,
    language: Language,
    source: String,
    #[serde(default)]
    stdin: String,
    cases: Option<Vec<Case>>,
    compile_timeout_ms: Option<u64>,
    run_timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Deserialize, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Rust,
    C,
    Cpp,
    Python,
    Java,
}

pub const LANGUAGES: [Language; 5] = [
    Language::Rust,
    Language::C,
    Language::Cpp,
    Language::Python,
    Language::Java,
];

impl Language {
    fn tools(self) -> Option<(PathBuf, Option<PathBuf>)> {
        let (programs, runtime): (&[&str], Option<PathBuf>) = match self {
            Self::Rust => (&["rustc"], None),
            Self::C => (&["gcc-11", "gcc", "clang"], None),
            Self::Cpp => (&["g++-11", "g++", "clang++"], None),
            Self::Python => (&["python3.13", "python3"], None),
            Self::Java => {
                let compiler = executable("javac")?;
                let runtime =
                    compiler.with_file_name(if cfg!(windows) { "java.exe" } else { "java" });
                return runtime.is_file().then_some((compiler, Some(runtime)));
            }
        };
        Some((programs.iter().find_map(|name| executable(name))?, runtime))
    }

    fn filename(self) -> &'static str {
        match self {
            Self::Rust => "main.rs",
            Self::C => "Main.c",
            Self::Cpp => "Main.cc",
            Self::Python => "Main.py",
            Self::Java => "Main.java",
        }
    }

    fn compiler_arguments(self, binary: &std::path::Path) -> Vec<std::ffi::OsString> {
        let mut arguments: Vec<_> = match self {
            Self::Rust => vec!["--edition=2021", "-O", self.filename(), "-o"],
            Self::C | Self::Cpp => vec![
                self.filename(),
                "-O2",
                "-Wall",
                if matches!(self, Self::C) {
                    "-std=gnu11"
                } else {
                    "-std=gnu++17"
                },
                "-DONLINE_JUDGE",
                "-DBOJ",
                "-lm",
                "-o",
            ],
            Self::Python => vec!["-W", "ignore", "-m", "py_compile", self.filename()],
            Self::Java => vec!["--release", "11", "-encoding", "UTF-8", self.filename()],
        }
        .into_iter()
        .map(std::ffi::OsString::from)
        .collect();
        if self.native_binary() {
            arguments.push(binary.into());
        }
        arguments
    }

    fn native_binary(self) -> bool {
        matches!(self, Self::Rust | Self::C | Self::Cpp)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Case {
    input: String,
    expected_output: Option<String>,
}

impl Run {
    pub fn valid(&self, multiple: bool) -> bool {
        self.source.len() <= 256 * 1024
            && self.stdin.len() <= 64 * 1024
            && self
                .compile_timeout_ms
                .is_none_or(|ms| (1..=30_000).contains(&ms))
            && self
                .run_timeout_ms
                .is_none_or(|ms| (1..=3_000).contains(&ms))
            && self.cases.is_some() == multiple
            && self.cases.as_ref().is_none_or(|cases| {
                (1..=20).contains(&cases.len())
                    && cases.iter().all(|case| {
                        case.input.len() <= 64 * 1024
                            && case
                                .expected_output
                                .as_ref()
                                .is_none_or(|s| s.len() <= 64 * 1024)
                    })
            })
    }
}

fn executable(program: &str) -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        format!("{program}.exe")
    } else {
        program.to_owned()
    };
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    let java = (program == "javac")
        .then(|| std::env::var_os("JAVA_HOME"))
        .flatten()
        .map(|path| PathBuf::from(path).join("bin"));
    java.into_iter()
        .chain(
            std::env::var_os("PATH")
                .iter()
                .flat_map(std::env::split_paths),
        )
        .chain(home.map(|path| PathBuf::from(path).join(".cargo/bin")))
        .chain(
            [
                "/opt/homebrew/opt/rustup/bin",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                "/usr/bin",
            ]
            .map(PathBuf::from),
        )
        .filter(|path| path.is_absolute())
        .map(|dir| dir.join(&executable))
        .find(|file| file.is_file())
}

fn command(path: PathBuf, directory: &std::path::Path) -> Command {
    let mut cmd = Command::new(path);
    cmd.current_dir(directory).env_clear().kill_on_drop(true);
    for key in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "SystemRoot",
        "TMPDIR",
        "TEMP",
        "TMP",
        "RUSTUP_HOME",
        "CARGO_HOME",
        "SDKROOT",
        // rustc locates the MSVC linker through these Windows folders. Without them it
        // falls back to the first `link.exe` on PATH, which may be an unrelated tool.
        "SystemDrive",
        "ProgramData",
        "ProgramFiles",
        "ProgramFiles(x86)",
        "ProgramW6432",
    ] {
        if let Some(value) = std::env::var_os(key) {
            cmd.env(key, value);
        }
    }
    cmd
}

pub async fn toolchain() -> Value {
    probe(Language::Rust).await
}

pub async fn toolchains() -> Vec<Value> {
    let mut results = Vec::with_capacity(LANGUAGES.len());
    for language in LANGUAGES {
        results.push(probe(language).await);
    }
    results
}

async fn probe(language: Language) -> Value {
    let Some((path, _)) = language.tools() else {
        return json!({"language":language,"available":false});
    };
    let Ok(cwd) = tempfile::tempdir() else {
        return json!({"language":language,"available":false,"path":path});
    };
    let mut cmd = command(path.clone(), cwd.path());
    cmd.arg(if matches!(language, Language::Java) {
        "-version"
    } else {
        "--version"
    });
    let (_cancel, receiver) = watch::channel(false);
    match execute(cmd, String::new(), 3000, receiver).await {
        Ok(result) if result.success => {
            let version = if result.stdout.is_empty() {
                &result.stderr
            } else {
                &result.stdout
            };
            json!({"language":language,"available":true,"path":path,"version":version.lines().next()})
        }
        _ => json!({"language":language,"available":false,"path":path}),
    }
}

struct Execution {
    reason: Option<&'static str>,
    stdout: String,
    stderr: String,
    exit_code: Option<i32>,
    success: bool,
    duration: u128,
}

async fn capture(
    mut reader: impl AsyncRead + Unpin,
    limit: mpsc::Sender<()>,
) -> std::io::Result<String> {
    let mut bytes = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = OUTPUT_LIMIT - bytes.len();
        bytes.extend_from_slice(&buffer[..count.min(remaining)]);
        if count > remaining {
            let _ = limit.try_send(());
            break;
        }
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(unix)]
struct ProcessGroup(i32);

#[cfg(unix)]
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        // The child is registered as leader of its own process group at spawn.
        unsafe {
            libc::kill(-self.0, libc::SIGKILL);
        }
    }
}

async fn execute(
    mut cmd: Command,
    input: String,
    timeout_ms: u64,
    mut cancel: watch::Receiver<bool>,
) -> Result<Execution> {
    if *cancel.borrow() {
        return Ok(Execution {
            reason: Some("CANCELLED"),
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            success: false,
            duration: 0,
        });
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    let job = crate::windows_job::WindowsJob::prepare(cmd.as_std_mut())?;
    let start = Instant::now();
    let mut child = cmd.spawn()?;
    #[cfg(windows)]
    job.attach_and_resume(
        child.id().context("missing child PID")?,
        child.raw_handle().context("missing child process handle")?,
    )?;
    #[cfg(unix)]
    let group = ProcessGroup(child.id().context("missing child PID")? as i32);
    let mut stdin = child.stdin.take().context("missing stdin")?;
    let (limit, mut over_limit) = mpsc::channel(1);
    let mut out = tokio::spawn(capture(
        child.stdout.take().context("missing stdout")?,
        limit.clone(),
    ));
    let mut err = tokio::spawn(capture(
        child.stderr.take().context("missing stderr")?,
        limit.clone(),
    ));
    let write = tokio::spawn(async move {
        let _ = stdin.write_all(input.as_bytes()).await;
    });
    let deadline = tokio::time::sleep(Duration::from_millis(timeout_ms));
    tokio::pin!(deadline);
    let (exit, mut reason) = tokio::select! {
        biased;
        _ = cancel.changed() => (None, Some("CANCELLED")),
        _ = over_limit.recv() => (None, Some("OUTPUT_LIMIT_EXCEEDED")),
        _ = &mut deadline => (None, Some("TIME_LIMIT_EXCEEDED")),
        result = child.wait() => (Some(result?), None),
    };
    #[cfg(unix)]
    drop(group);
    #[cfg(windows)]
    drop(job);
    if exit.is_none() {
        #[cfg(windows)]
        child.wait().await?;
        #[cfg(not(windows))]
        child.kill().await?;
    }
    write.abort();
    let output = tokio::select! {
        result = async { tokio::try_join!(&mut out, &mut err) } => Some(result?),
        _ = &mut deadline, if reason.is_none() => {
            reason = Some("TIME_LIMIT_EXCEEDED");
            None
        },
        _ = cancel.changed(), if reason.is_none() => {
            reason = Some("CANCELLED");
            None
        }
    };
    let (stdout, stderr) = match output {
        Some((stdout, stderr)) => (stdout?, stderr?),
        None => {
            out.abort();
            err.abort();
            (String::new(), String::new())
        }
    };
    if over_limit.try_recv().is_ok() && reason.is_none() {
        reason = Some("OUTPUT_LIMIT_EXCEEDED");
    }
    Ok(Execution {
        reason,
        stdout,
        stderr,
        exit_code: exit.and_then(|s| s.code()),
        success: reason.is_none() && exit.is_some_and(|s| s.success()),
        duration: start.elapsed().as_millis(),
    })
}

fn normalize(text: &str) -> String {
    let text = text.replace("\r\n", "\n");
    text.strip_suffix('\n').unwrap_or(&text).to_owned()
}

#[cfg(target_os = "macos")]
fn prepare_compiler_output(binary: &std::path::Path) -> Result<()> {
    use std::os::{
        fd::AsRawFd,
        unix::fs::{MetadataExt, OpenOptionsExt},
    };

    // Chrome's file quarantine can propagate to files that rustc creates locally.
    // Only handle the executable produced in this invocation's private temp directory.
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(binary)?;
    let metadata = file.metadata()?;
    anyhow::ensure!(
        metadata.is_file() && metadata.nlink() == 1,
        "invalid compiler output"
    );
    let result =
        unsafe { libc::fremovexattr(file.as_raw_fd(), c"com.apple.quarantine".as_ptr(), 0) };
    if result < 0 {
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() != Some(libc::ENOATTR) {
            return Err(error).context("prepare locally compiled macOS executable");
        }
    }
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod macos_tests {
    use super::prepare_compiler_output;
    use std::{fs, os::fd::AsRawFd, os::unix::fs::symlink};

    #[test]
    fn prepares_only_a_regular_compiler_output_with_one_link() {
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("solution");
        let file = fs::File::create(&binary).unwrap();
        let attribute = c"com.apple.quarantine";
        let value = b"0081;00000000;SUPER_BOJ test;";
        let fd = file.as_raw_fd();
        assert_eq!(
            unsafe {
                libc::fsetxattr(
                    fd,
                    attribute.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                    0,
                )
            },
            0
        );
        let alias = directory.path().join("alias");
        symlink(&binary, &alias).unwrap();
        assert!(prepare_compiler_output(&alias).is_err());
        fs::remove_file(&alias).unwrap();
        fs::hard_link(&binary, &alias).unwrap();
        assert!(prepare_compiler_output(&binary).is_err());
        fs::remove_file(&alias).unwrap();
        assert_eq!(
            unsafe { libc::fgetxattr(fd, attribute.as_ptr(), std::ptr::null_mut(), 0, 0, 0) },
            value.len() as isize
        );
        prepare_compiler_output(&binary).unwrap();
        assert_eq!(
            unsafe { libc::fgetxattr(fd, attribute.as_ptr(), std::ptr::null_mut(), 0, 0, 0) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ENOATTR)
        );
        prepare_compiler_output(&binary).unwrap();
    }
}

pub async fn run(request: Run, cancel: watch::Receiver<bool>) -> Result<Value> {
    let id = request.job_id;
    let Some((compiler, runtime)) = request.language.tools() else {
        return Ok(json!({"jobId":id,"status":"TOOLCHAIN_NOT_FOUND"}));
    };
    let directory = tempfile::Builder::new().prefix("super-boj-").tempdir()?;
    let filename = request.language.filename();
    std::fs::write(directory.path().join(filename), request.source)?;
    let binary = directory.path().join(if cfg!(windows) {
        "solution.exe"
    } else {
        "solution"
    });
    let mut compile = command(compiler.clone(), directory.path());
    compile.args(request.language.compiler_arguments(&binary));
    let compiled = execute(
        compile,
        String::new(),
        request.compile_timeout_ms.unwrap_or(30_000),
        cancel.clone(),
    )
    .await?;
    if !compiled.success {
        let status = match compiled.reason {
            Some("TIME_LIMIT_EXCEEDED") => "COMPILE_TIMEOUT",
            Some(reason) => reason,
            None => "COMPILE_ERROR",
        };
        return Ok(
            json!({"jobId":id,"status":status,"stdout":compiled.stdout,"stderr":compiled.stderr,
            "exitCode":compiled.exit_code,"compileDurationMs":compiled.duration,
            "outputTruncated":status == "OUTPUT_LIMIT_EXCEEDED"}),
        );
    }
    #[cfg(target_os = "macos")]
    if request.language.native_binary() {
        prepare_compiler_output(&binary)?;
    }
    let multiple = request.cases.is_some();
    let cases = request.cases.unwrap_or_else(|| {
        vec![Case {
            input: request.stdin,
            expected_output: None,
        }]
    });
    let mut results = Vec::new();
    for case in cases {
        let mut run = match request.language {
            Language::Python => {
                let mut cmd = command(compiler.clone(), directory.path());
                cmd.args(["-W", "ignore", filename]);
                cmd
            }
            Language::Java => {
                let mut cmd = command(
                    runtime.clone().context("missing Java runtime")?,
                    directory.path(),
                );
                cmd.args([
                    "-Dfile.encoding=UTF-8",
                    "-XX:+UseSerialGC",
                    "-DONLINE_JUDGE=1",
                    "-DBOJ=1",
                    "-cp",
                    ".",
                    "Main",
                ]);
                cmd
            }
            _ => command(binary.clone(), directory.path()),
        };
        run.env("NO_COLOR", "1");
        let outcome = execute(
            run,
            case.input,
            request.run_timeout_ms.unwrap_or(3000),
            cancel.clone(),
        )
        .await?;
        let status = outcome.reason.unwrap_or(if outcome.success {
            "COMPLETED"
        } else {
            "RUNTIME_ERROR"
        });
        let passed = case
            .expected_output
            .map(|expected| outcome.success && normalize(&expected) == normalize(&outcome.stdout));
        results.push(json!({"jobId":id,"status":status,"stdout":outcome.stdout,"stderr":outcome.stderr,
            "exitCode":outcome.exit_code,"compileDurationMs":compiled.duration,"executionDurationMs":outcome.duration,
            "outputTruncated":status == "OUTPUT_LIMIT_EXCEEDED","passed":passed}));
        if status == "CANCELLED" {
            break;
        }
    }
    Ok(if multiple {
        json!({"jobId":id,"results":results})
    } else {
        results.remove(0)
    })
}
