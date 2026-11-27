use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::Path,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
};
use uuid::Uuid;

struct Host {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
}

impl Host {
    fn start(data_dir: &Path) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_super-boj-core"))
            .env("SUPER_BOJ_DATA_DIR", data_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        Self {
            input: child.stdin.take(),
            output: child.stdout.take().unwrap(),
            child,
        }
    }

    fn request(&mut self, kind: &str, payload: Value) -> Value {
        let id = Uuid::new_v4();
        let request = serde_json::to_vec(&json!({
            "protocolVersion": 1, "requestId": id, "type": kind, "payload": payload,
        }))
        .unwrap();
        let input = self.input.as_mut().unwrap();
        input
            .write_all(&(request.len() as u32).to_ne_bytes())
            .unwrap();
        input.write_all(&request).unwrap();
        let mut header = [0; 4];
        self.output.read_exact(&mut header).unwrap();
        let mut frame = vec![0; u32::from_ne_bytes(header) as usize];
        self.output.read_exact(&mut frame).unwrap();
        let response: Value = serde_json::from_slice(&frame).unwrap();
        assert_eq!(response["requestId"], id.to_string());
        response
    }

    fn ok(&mut self, kind: &str, payload: Value) -> Value {
        let response = self.request(kind, payload);
        assert_eq!(response["ok"], true, "{response}");
        response["payload"].clone()
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        drop(self.input.take());
        assert!(self.child.wait().unwrap().success());
    }
}

#[test]
fn preserves_each_confirmed_attempt_and_rejects_mismatched_source() {
    let dir = tempfile::tempdir().unwrap();
    let source = "fn main() {}\n";
    let mut host = Host::start(dir.path());
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    for id in [first, second] {
        let prepared = host.ok(
            "CREATE_SUBMISSION_INTENT",
            json!({
                "intentId": id, "accountContext": "alice", "problemId": 1000,
                "problemTitle": "A+B", "source": source,
            }),
        );
        assert_eq!(prepared["intentId"], id.to_string());
        assert!(prepared["sourceHash"]
            .as_str()
            .unwrap()
            .starts_with("sha256:"));
    }
    let mut confirmation = json!({
        "intentId": first, "submissionId": "123", "accountContext": "alice",
        "problemId": 1000, "source": "fn main() { panic!(); }",
        "rawVerdict": "런타임 에러 (NZEC)",
    });
    assert_eq!(
        host.request("CONFIRM_SUBMISSION", confirmation.clone())["error"]["code"],
        "SUBMISSION_MISMATCH"
    );
    confirmation["source"] = json!(source);
    assert_eq!(
        host.ok("CONFIRM_SUBMISSION", confirmation.clone())["duplicate"],
        false
    );
    assert_eq!(
        host.ok("CONFIRM_SUBMISSION", confirmation.clone())["duplicate"],
        true
    );
    confirmation["intentId"] = json!(second);
    confirmation["submissionId"] = json!("124");
    confirmation["rawVerdict"] = json!("맞았습니다!!");
    host.ok("CONFIRM_SUBMISSION", confirmation);
    drop(host);

    let mut host = Host::start(dir.path());
    let history = host.ok(
        "GET_HISTORY",
        json!({"accountContext":"alice","problemId":1000}),
    );
    let attempts = history["attempts"].as_array().unwrap();
    assert_eq!(attempts.len(), 2);
    assert_eq!(attempts[0]["submissionId"], "124");
    assert_eq!(attempts[0]["verdict"], "ACCEPTED");
    assert_eq!(attempts[1]["verdict"], "RUNTIME_ERROR");
    assert_eq!(attempts[0]["sourceHash"], attempts[1]["sourceHash"]);
    assert!(attempts[1].get("source").is_none());
    let attempt = host.ok(
        "GET_ATTEMPT",
        json!({"accountContext":"alice","submissionId":"123"}),
    );
    assert_eq!(attempt["source"], source);

    let changed = host.ok(
        "UPDATE_VERDICT",
        json!({
            "accountContext":"alice","submissionId":"123","rawVerdict":"새로운 결과",
        }),
    );
    assert_eq!(changed["updated"], true);
    let updated = host.ok(
        "GET_ATTEMPT",
        json!({"accountContext":"alice","submissionId":"123"}),
    );
    assert_eq!(updated["verdict"], "UNKNOWN");
    assert_eq!(updated["rawVerdict"], "새로운 결과");
    assert_eq!(updated["source"], source);
}

#[cfg(unix)]
#[test]
fn database_symlink_is_rejected_without_breaking_ping() {
    use std::os::unix::fs::symlink;

    let dir = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let database = dir.path().join("database");
    std::fs::create_dir(&database).unwrap();
    symlink(outside.path(), database.join("super-boj.db")).unwrap();

    let mut host = Host::start(dir.path());
    assert_eq!(
        host.request("GET_SETTINGS", json!({}))["error"]["code"],
        "DATABASE_ERROR"
    );
    assert_eq!(host.ok("PING", json!({}))["status"], "PONG");
    assert_eq!(outside.as_file().metadata().unwrap().len(), 0);
}

#[test]
fn records_each_language_and_rejects_cross_language_linking() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::start(dir.path());
    for (index, language) in ["rust", "c", "cpp", "python", "java"]
        .into_iter()
        .enumerate()
    {
        let id = Uuid::new_v4();
        let submission = (100 + index).to_string();
        let mut preparation = json!({
            "intentId": id, "accountContext": "alice", "problemId": 1000,
            "problemTitle": "A+B", "source": "same bytes", "language": language,
        });
        host.ok("CREATE_SUBMISSION_INTENT", preparation.clone());
        assert_eq!(
            host.ok("CREATE_SUBMISSION_INTENT", preparation.clone())["intentId"],
            id.to_string()
        );
        let other = if language == "rust" { "c" } else { "rust" };
        preparation["language"] = json!(other);
        assert_eq!(
            host.request("CREATE_SUBMISSION_INTENT", preparation)["error"]["code"],
            "SUBMISSION_MISMATCH"
        );
        let pending = json!({"accountContext": "alice", "problemId": 1000, "language": other});
        assert_eq!(
            host.ok("GET_PENDING_INTENTS", pending)["intents"],
            json!([])
        );
        let pending = json!({"accountContext": "alice", "problemId": 1000, "language": language});
        assert_eq!(
            host.ok("GET_PENDING_INTENTS", pending)["intents"][0]["intentId"],
            id.to_string()
        );

        let mut confirmation = json!({
            "intentId": id, "accountContext": "alice", "problemId": 1000,
            "submissionId": submission, "source": "same bytes", "language": other,
        });
        assert_eq!(
            host.request("CONFIRM_SUBMISSION", confirmation.clone())["error"]["code"],
            "SUBMISSION_MISMATCH"
        );
        confirmation["language"] = json!(language);
        assert_eq!(
            host.ok("CONFIRM_SUBMISSION", confirmation)["duplicate"],
            false
        );
        let attempt = host.ok(
            "GET_ATTEMPT",
            json!({"accountContext": "alice", "submissionId": submission}),
        );
        assert_eq!(attempt["language"], language);
        assert_eq!(attempt["source"], "same bytes");
    }
}

fn connect_repository(host: &mut Host, dir: &Path, auto_sync: bool) {
    host.ok("GET_SETTINGS", json!({}));
    let db = rusqlite::Connection::open(dir.join("database/super-boj.db")).unwrap();
    db.execute(
        "INSERT INTO repositories(id, remote_url, branch, local_path, auto_sync)
         VALUES ('repo', 'https://github.com/alice/solutions', 'main', ?1, ?2)",
        rusqlite::params![dir.join("clone").to_str().unwrap(), auto_sync],
    )
    .unwrap();
}

fn submission_row(dir: &Path, id: &str) -> (String, Option<u32>, Option<u32>, i64) {
    let db = rusqlite::Connection::open(dir.join("database/super-boj.db")).unwrap();
    db.query_row(
        "SELECT verdict, execution_time_ms, memory_kb, revision FROM submissions WHERE boj_submission_id=?1",
        [id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

#[test]
fn import_requires_an_active_repository_with_auto_sync() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::start(dir.path());
    let import = json!({
        "accountContext": "alice", "problemId": 1330, "problemTitle": "두 수 비교하기",
        "submissionId": "300", "source": "print(1)\n", "language": "python", "rawVerdict": "맞았습니다!!",
    });
    assert_eq!(host.request("IMPORT_ACCEPTED_SUBMISSION", import.clone())["error"]["code"], "AUTO_SYNC_DISABLED");
    connect_repository(&mut host, dir.path(), false);
    assert_eq!(host.request("IMPORT_ACCEPTED_SUBMISSION", import)["error"]["code"], "AUTO_SYNC_DISABLED");
}

#[test]
fn import_finishes_a_submission_that_was_recorded_before_judging_ended() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::start(dir.path());
    connect_repository(&mut host, dir.path(), true);
    let intent = Uuid::new_v4();
    host.ok("CREATE_SUBMISSION_INTENT", json!({
        "intentId": intent, "accountContext": "alice", "problemId": 1330,
        "problemTitle": "두 수 비교하기", "source": "print(1)\n", "language": "python",
    }));
    host.ok("CONFIRM_SUBMISSION", json!({
        "intentId": intent, "submissionId": "301", "accountContext": "alice", "problemId": 1330,
        "source": "print(1)\n", "language": "python", "rawVerdict": "채점 중 (50%)",
    }));
    let before = submission_row(dir.path(), "301");
    assert_eq!(before.0, "JUDGING");
    let import = json!({
        "accountContext": "alice", "problemId": 1330, "problemTitle": "두 수 비교하기",
        "submissionId": "301", "source": "print(1)\n", "language": "python",
        "rawVerdict": "맞았습니다!!", "executionTimeMs": 40, "memoryKb": 31120,
    });
    let reply = host.ok("IMPORT_ACCEPTED_SUBMISSION", import.clone());
    assert_eq!((reply["duplicate"].as_bool(), reply["updated"].as_bool()), (Some(true), Some(true)));
    let after = submission_row(dir.path(), "301");
    assert_eq!((after.0.as_str(), after.1, after.2), ("ACCEPTED", Some(40), Some(31120)));
    assert_eq!(after.3, before.3 + 1);
    assert_eq!(host.ok("IMPORT_ACCEPTED_SUBMISSION", import)["updated"], false);
    assert_eq!(submission_row(dir.path(), "301").3, after.3);
}

#[test]
fn import_fills_missing_time_and_memory_of_an_accepted_submission() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::start(dir.path());
    connect_repository(&mut host, dir.path(), true);
    let mut import = json!({
        "accountContext": "alice", "problemId": 1330, "problemTitle": "두 수 비교하기",
        "submissionId": "302", "source": "print(1)\n", "language": "python", "rawVerdict": "맞았습니다!!",
    });
    assert_eq!(host.ok("IMPORT_ACCEPTED_SUBMISSION", import.clone())["duplicate"], false);
    let before = submission_row(dir.path(), "302");
    assert_eq!((before.1, before.2), (None, None));
    import["executionTimeMs"] = json!(12);
    import["memoryKb"] = json!(2048);
    assert_eq!(host.ok("IMPORT_ACCEPTED_SUBMISSION", import)["updated"], true);
    let after = submission_row(dir.path(), "302");
    assert_eq!((after.1, after.2, after.3), (Some(12), Some(2048), before.3 + 1));
}

#[test]
fn imports_accepted_submission_once_without_a_preparation_record() {
    let dir = tempfile::tempdir().unwrap();
    let mut host = Host::start(dir.path());
    connect_repository(&mut host, dir.path(), true);
    let mut import = json!({
        "accountContext": "alice", "problemId": 1330, "problemTitle": "두 수 비교하기",
        "submissionId": "200", "source": "print(1)\n", "language": "python",
        "rawVerdict": "맞았습니다!!", "executionTimeMs": 40, "memoryKb": 31120,
        "submittedAt": "2026-11-27T08:00:00.000Z",
    });
    assert_eq!(host.ok("IMPORT_ACCEPTED_SUBMISSION", import.clone())["duplicate"], false);
    assert_eq!(host.ok("IMPORT_ACCEPTED_SUBMISSION", import.clone())["duplicate"], true);
    let attempt = host.ok("GET_ATTEMPT", json!({"accountContext": "alice", "submissionId": "200"}));
    assert_eq!(attempt["verdict"], "ACCEPTED");
    assert_eq!(attempt["language"], "python");
    assert_eq!(attempt["source"], "print(1)\n");

    import["source"] = json!("print(2)\n");
    assert_eq!(
        host.request("IMPORT_ACCEPTED_SUBMISSION", import.clone())["error"]["code"],
        "SUBMISSION_MISMATCH"
    );
    import["submissionId"] = json!("201");
    import["rawVerdict"] = json!("틀렸습니다");
    assert_eq!(
        host.request("IMPORT_ACCEPTED_SUBMISSION", import)["error"]["code"],
        "INVALID_MESSAGE"
    );
}
