use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};
use uuid::Uuid;

struct Host {
    child: Child,
    input: Option<ChildStdin>,
    output: ChildStdout,
    data_dir: tempfile::TempDir,
}

impl Host {
    fn start() -> Self {
        let data_dir = tempfile::tempdir().unwrap();
        let mut host = Command::new(env!("CARGO_BIN_EXE_super-boj-core"))
            .env("SUPER_BOJ_DATA_DIR", data_dir.path().join("sandbox"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        Self {
            input: host.stdin.take(),
            output: host.stdout.take().unwrap(),
            child: host,
            data_dir,
        }
    }

    fn send_version(&mut self, version: u32, kind: &str, payload: Value) -> Uuid {
        let id = Uuid::new_v4();
        let bytes = serde_json::to_vec(&json!({
            "protocolVersion": version, "requestId": id, "type": kind, "payload": payload
        }))
        .unwrap();
        let input = self.input.as_mut().unwrap();
        input
            .write_all(&(bytes.len() as u32).to_ne_bytes())
            .unwrap();
        input.write_all(&bytes).unwrap();
        id
    }

    fn send(&mut self, kind: &str, payload: Value) -> Uuid {
        self.send_version(1, kind, payload)
    }

    fn receive(&mut self) -> Value {
        let mut header = [0; 4];
        self.output.read_exact(&mut header).unwrap();
        let mut response = vec![0; u32::from_ne_bytes(header) as usize];
        self.output.read_exact(&mut response).unwrap();
        serde_json::from_slice(&response).unwrap()
    }

    fn request(&mut self, kind: &str, payload: Value) -> Value {
        let id = self.send(kind, payload);
        let response = self.receive();
        assert_eq!(response["requestId"], id.to_string());
        assert_eq!(response["ok"], true, "{response}");
        response["payload"].clone()
    }

    fn finish(&mut self) -> std::process::ExitStatus {
        drop(self.input.take());
        let expires = Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < expires, "Native Host did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn ping_and_compile_over_native_messaging() {
    let mut host = Host::start();
    assert_eq!(host.request("PING", json!({}))["status"], "PONG");
    let result = host.request("RUN", json!({
        "jobId": Uuid::new_v4(),
        "language": "rust",
        "source": "fn main(){let mut s=String::new(); std::io::stdin().read_line(&mut s).unwrap(); println!(\"{}\",s.split_whitespace().map(|x|x.parse::<i32>().unwrap()).sum::<i32>());}",
        "stdin": "1 2\n"
    }));
    assert_eq!(result["status"], "COMPLETED", "{result}");
    assert_eq!(result["stdout"], "3\n");
    assert!(host.finish().success());
}

#[test]
fn core_language_profiles_execute_when_their_tools_are_installed() {
    let mut host = Host::start();
    let tools = host.request("GET_TOOLCHAINS", json!({}));
    for (language, source) in [
        ("c", "#include <stdio.h>\nint main(void) { int a,b; if (scanf(\"%d%d\",&a,&b)!=2) return 1; printf(\"%d\\n\",a+b); }"),
        ("cpp", "#include <iostream>\nint main() { int a,b; std::cin>>a>>b; std::cout<<a+b<<'\\n'; }"),
        ("python", "a,b=map(int,input().split())\nprint(a+b)"),
        ("java", "import java.util.Scanner; public class Main { public static void main(String[] args) { Scanner s=new Scanner(System.in); System.out.println(s.nextInt()+s.nextInt()); } }"),
    ] {
        let profile = tools["toolchains"].as_array().unwrap().iter()
            .find(|item| item["language"] == language).expect(language);
        let result = host.request("RUN", json!({
            "jobId": Uuid::new_v4(), "language": language, "source": source, "stdin": "1 2\n"
        }));
        if profile["available"] == true {
            assert_eq!(result["status"], "COMPLETED", "{language}: {result}");
            assert_eq!(result["stdout"], "3\n", "{language}");
        } else {
            assert_eq!(result["status"], "TOOLCHAIN_NOT_FOUND", "{language}: {result}");
        }
    }
}

#[test]
fn rejects_invalid_frame_sizes_and_partial_frames() {
    for frame in [
        0_u32.to_ne_bytes().to_vec(),
        (512 * 1024 + 1_u32).to_ne_bytes().to_vec(),
        vec![1, 2],
        [5_u32.to_ne_bytes().as_slice(), b"{}"].concat(),
    ] {
        let mut host = Host::start();
        host.input.as_mut().unwrap().write_all(&frame).unwrap();
        assert!(!host.finish().success(), "{frame:?}");
    }
}

#[test]
fn invalid_protocol_version_and_payload_leave_host_available() {
    let mut host = Host::start();
    let id = host.send_version(2, "PING", json!({}));
    let response = host.receive();
    assert_eq!(response["requestId"], id.to_string());
    assert_eq!(response["error"]["code"], "PROTOCOL_VERSION_MISMATCH");
    host.send("RUN", json!({"language": "sh", "command": "ls"}));
    assert_eq!(host.receive()["error"]["code"], "INVALID_MESSAGE");
    assert_eq!(host.request("PING", json!({}))["status"], "PONG");
}

#[test]
fn enforces_local_time_and_output_limits() {
    let mut host = Host::start();
    for (source, status, timeout_ms) in [
        (
            "fn main() { loop { std::hint::spin_loop(); } }",
            "TIME_LIMIT_EXCEEDED",
            1000,
        ),
        (
            "fn main() { print!(\"{}\", \"x\".repeat(100_000)); }",
            "OUTPUT_LIMIT_EXCEEDED",
            3000,
        ),
        ("fn main() { malformed!{} }", "COMPILE_ERROR", 3000),
    ] {
        let result = host.request(
            "RUN",
            json!({
                "jobId": Uuid::new_v4(), "language": "rust", "source": source, "runTimeoutMs": timeout_ms,
            }),
        );
        assert_eq!(result["status"], status, "{result}");
        if status == "OUTPUT_LIMIT_EXCEEDED" {
            assert_eq!(result["outputTruncated"], true);
            assert!(result["stdout"].as_str().unwrap().len() <= 64 * 1024);
        }
    }
    assert_eq!(host.request("PING", json!({}))["status"], "PONG");
}

#[test]
fn compares_cases_without_trimming_internal_whitespace() {
    let mut host = Host::start();
    let result = host.request(
        "RUN_TESTS",
        json!({
            "jobId": Uuid::new_v4(), "language": "rust",
            "source": "fn main() { print!(\"a  b\\n\"); }",
            "cases": [
                {"input":"", "expectedOutput":"a  b\r\n"},
                {"input":"", "expectedOutput":"a b"},
                {"input":"", "expectedOutput":null},
            ],
        }),
    );
    assert_eq!(result["results"][0]["passed"], true);
    assert_eq!(result["results"][1]["passed"], false);
    assert_eq!(result["results"][2]["passed"], Value::Null);
    assert_eq!(result["results"][0]["status"], "COMPLETED");
}

#[test]
fn running_job_can_be_cancelled_after_solution_starts() {
    let mut host = Host::start();
    let marker = host.data_dir.path().join("running");
    let job = Uuid::new_v4();
    let run_request = host.send("RUN", json!({
        "jobId":job,"language":"rust",
        "source":format!("fn main() {{ std::fs::write({:?}, b\"running\").unwrap(); loop {{ std::hint::spin_loop(); }} }}", marker.to_str().unwrap()),
    }));
    let expires = Instant::now() + Duration::from_secs(15);
    while !marker.is_file() {
        assert!(Instant::now() < expires, "solution did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    let cancel_request = host.send("CANCEL", json!({"jobId":job}));
    let mut frames = [host.receive(), host.receive()];
    frames.sort_by_key(|frame| frame["requestId"] != cancel_request.to_string());
    assert_eq!(frames[0]["payload"]["cancelled"], true);
    assert_eq!(frames[1]["requestId"], run_request.to_string());
    assert_eq!(frames[1]["payload"]["status"], "CANCELLED");
    assert!(host.finish().success());
}

#[test]
fn closing_output_does_not_wait_for_input_eof() {
    let mut host = Command::new(env!("CARGO_BIN_EXE_super-boj-core"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    drop(host.stdout.take());
    let mut input = host.stdin.take().unwrap();
    let request = serde_json::to_vec(&json!({
        "protocolVersion":1,"requestId":Uuid::new_v4(),"type":"PING","payload":{},
    }))
    .unwrap();
    input
        .write_all(&(request.len() as u32).to_ne_bytes())
        .unwrap();
    input.write_all(&request).unwrap();
    let expires = Instant::now() + Duration::from_secs(3);
    loop {
        if host.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= expires {
            let _ = host.kill();
            let _ = host.wait();
            panic!("host hung after output closed");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(input);
}

#[cfg(unix)]
#[test]
fn host_input_eof_stops_the_running_process_group() {
    let mut host = Host::start();
    let child_started = host.data_dir.path().join("descendant-ready");
    let child_survived = host.data_dir.path().join("descendant-survived");
    host.send(
        "RUN",
        json!({
            "jobId": Uuid::new_v4(), "language": "rust",
            "source": format!(r#"
fn main() {{
    if std::env::args_os().len() > 1 {{
        std::fs::write({:?}, "running").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(1));
        std::fs::write({:?}, "survived").unwrap();
    }} else {{
        let mut child = std::process::Command::new(std::env::current_exe().unwrap())
            .arg("descendant").spawn().unwrap();
        child.wait().unwrap();
    }}
}}
"#, child_started.to_str().unwrap(), child_survived.to_str().unwrap()),
        }),
    );
    let expires = Instant::now() + Duration::from_secs(15);
    while !child_started.is_file() {
        assert!(Instant::now() < expires, "descendant did not start");
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(host.finish().success());
    std::thread::sleep(Duration::from_millis(1100));
    assert!(
        !child_survived.exists(),
        "descendant survived host disconnect"
    );
}

#[test]
fn shared_request_fixtures_match_native_host() {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/fixtures/v1-requests.json"
    ))
    .unwrap();
    let mut host = Host::start();
    for fixture in fixtures.as_array().unwrap() {
        let request = &fixture["request"];
        let bytes = serde_json::to_vec(&request).unwrap();
        let input = host.input.as_mut().unwrap();
        input
            .write_all(&(bytes.len() as u32).to_ne_bytes())
            .unwrap();
        input.write_all(&bytes).unwrap();
        let actual = host.receive();
        assert_eq!(actual["requestId"], request["requestId"]);
        assert_eq!(actual["ok"], fixture["accepted"], "{request}: {actual}");
        assert_eq!(actual["error"]["code"], fixture["errorCode"], "{request}");
    }
    assert!(host.finish().success());
}
