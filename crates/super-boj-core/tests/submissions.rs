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
