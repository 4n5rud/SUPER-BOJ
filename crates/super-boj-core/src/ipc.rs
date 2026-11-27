use crate::{
    git,
    runner::{self, Run},
    storage,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{io, time::Duration};
use tokio::{
    io::{AsyncWrite, AsyncWriteExt},
    sync::watch,
    task::JoinSet,
};
use uuid::Uuid;

const MAX_FRAME: usize = 512 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    protocol_version: u32,
    request_id: Uuid,
    #[serde(rename = "type")]
    kind: String,
    payload: Value,
}

fn read_frame(input: &mut impl io::Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0; 4];
    if input.read(&mut header[..1])? == 0 {
        return Ok(None);
    }
    input.read_exact(&mut header[1..])?;
    let length = u32::from_ne_bytes(header) as usize;
    if !(1..=MAX_FRAME).contains(&length) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid native message length",
        ));
    }
    let mut frame = vec![0; length];
    input.read_exact(&mut frame)?;
    Ok(Some(frame))
}

fn error(id: Option<Uuid>, code: &str, message: &str, retryable: bool) -> Value {
    json!({"protocolVersion":1,"requestId":id,"type":"RESPONSE","ok":false,
        "error":{"code":code,"message":message,"retryable":retryable}})
}

fn success(id: Uuid, payload: Value) -> Value {
    json!({"protocolVersion":1,"requestId":id,"type":"RESPONSE","ok":true,"payload":payload})
}

async fn send(out: &mut (impl AsyncWrite + Unpin), response: Value) -> anyhow::Result<()> {
    let mut frame = serde_json::to_vec(&response)?;
    if frame.len() > MAX_FRAME {
        let id = serde_json::from_value(response["requestId"].clone())?;
        frame = serde_json::to_vec(&error(
            id,
            "PAYLOAD_TOO_LARGE",
            "The response exceeds the native message limit.",
            false,
        ))?;
    }
    out.write_all(&(frame.len() as u32).to_ne_bytes()).await?;
    out.write_all(&frame).await?;
    out.flush().await?;
    Ok(())
}

pub async fn serve() -> anyhow::Result<()> {
    let mut output = tokio::io::stdout();
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    // An OS read on stdin may remain pending after a broken output pipe.
    // A dedicated thread keeps that read outside Tokio's runtime shutdown.
    std::thread::Builder::new()
        .name("native-input".into())
        .spawn(move || {
            let mut input = io::stdin().lock();
            loop {
                match read_frame(&mut input) {
                    Ok(Some(frame)) => {
                        if tx.blocking_send(Ok(frame)).is_err() {
                            return;
                        }
                    }
                    Ok(None) => return,
                    Err(error) => {
                        let _ = tx.blocking_send(Err(error));
                        return;
                    }
                }
            }
        })?;
    let mut tasks = JoinSet::new();
    let mut sync_tasks = JoinSet::new();
    let mut sync_tick = tokio::time::interval(Duration::from_secs(15));
    sync_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut connected = false;
    let mut active: Option<(Uuid, watch::Sender<bool>)> = None;
    let result = async {
        loop {
            let frame = tokio::select! {
                frame = rx.recv() => match frame {Some(frame) => frame?, None => break},
                _ = sync_tick.tick(), if connected && sync_tasks.is_empty() => {
                    sync_tasks.spawn_blocking(git::sync_background);
                    continue;
                }
                _ = sync_tasks.join_next(), if !sync_tasks.is_empty() => continue,
                Some(result) = tasks.join_next(), if !tasks.is_empty() => {
                    let (is_run, response) = result?;
                    if is_run { active = None; }
                    send(&mut output, response).await?;
                    continue;
                }
            };
            let response = match serde_json::from_slice::<Request>(&frame) {
                Err(_) => {
                    let id = serde_json::from_slice::<Value>(&frame).ok()
                        .and_then(|v| serde_json::from_value(v["requestId"].clone()).ok());
                    error(id,"INVALID_MESSAGE","Invalid request envelope.",false)
                }
                Ok(request) => {
                    let id = request.request_id;
                    if request.protocol_version != 1 {
                        error(Some(id),"PROTOCOL_VERSION_MISMATCH","Expected protocol version 1.",false)
                    } else {
                        match request.kind.as_str() {
                            "PING" if request.payload == json!({}) => success(id,json!({"status":"PONG"})),
                            "HELLO" if request.payload == json!({}) => {
                                connected = true;
                                success(id,json!({"version":env!("CARGO_PKG_VERSION"),"maxFrameBytes":MAX_FRAME,"languages":runner::LANGUAGES}))
                            }
                            "GET_TOOLCHAINS" if request.payload == json!({}) && tasks.len() < 4 => {
                                tasks.spawn(async move { (false, success(id,json!({"toolchains":runner::toolchains().await}))) });
                                continue;
                            }
                            "RUN" | "RUN_TESTS" if active.is_some() => error(Some(id),"RUN_BUSY","Another job is running.",true),
                            "RUN" | "RUN_TESTS" => match serde_json::from_value::<Run>(request.payload) {
                                Ok(run) if run.valid(request.kind == "RUN_TESTS") => {
                                    let (cancel, receiver) = watch::channel(false);
                                    active = Some((run.job_id,cancel));
                                    tasks.spawn(async move {
                                        let response = match runner::run(run,receiver).await {
                                            Ok(result) => success(id,result),
                                            Err(_) => error(Some(id),"INTERNAL_ERROR","Could not start or manage the local process.",false),
                                        };
                                        (true,response)
                                    });
                                    continue;
                                }
                                _ => error(Some(id),"INVALID_MESSAGE","Invalid execution payload or limits.",false),
                            },
                            "CANCEL" => {
                                let job = serde_json::from_value::<Uuid>(request.payload["jobId"].clone());
                                match job {
                                    Ok(job) if request.payload.as_object().is_some_and(|value| value.len() == 1) => {
                                        let cancelled = active.as_ref().filter(|(id,_)| *id == job)
                                            .is_some_and(|(_,cancel)| cancel.send(true).is_ok());
                                        success(id,json!({"cancelled":cancelled}))
                                    }
                                    _ => error(Some(id),"INVALID_MESSAGE","Expected a job ID.",false),
                                }
                            }
                            kind if local_request(kind) && tasks.len() < 8 => {
                                let trigger_sync = matches!(kind, "CONFIRM_SUBMISSION" | "IMPORT_ACCEPTED_SUBMISSION" | "UPDATE_VERDICT" | "CONFIGURE_REPOSITORY" | "UPDATE_SETTINGS");
                                if trigger_sync && connected {
                                    sync_tick.reset_after(Duration::from_millis(250));
                                }
                                tasks.spawn_blocking(move || {
                                    let result = if storage::handles(&request.kind) {
                                        storage::handle(&request.kind, request.payload)
                                    } else {
                                        git::handle(&request.kind, request.payload).unwrap_or_else(|| Err(
                                            storage::StoreError::new("INVALID_MESSAGE", "Unsupported local request.", false)
                                        ))
                                    };
                                    let response = match result {
                                        Ok(payload) => success(id, payload),
                                        Err(e) => error(Some(id), e.code, e.message, e.retryable),
                                    };
                                    (false, response)
                                });
                                continue;
                            }
                            kind if local_request(kind) => error(Some(id), "REQUEST_BUSY", "Too many pending requests.", true),
                            _ => error(Some(id),"INVALID_MESSAGE","Unsupported request or invalid payload.",false),
                        }
                    }
                }
            };
            send(&mut output,response).await?;
        }
        Ok::<(),anyhow::Error>(())
    }.await;
    git::stop_background();
    if let Some((_, cancel)) = active {
        let _ = cancel.send(true);
    }
    while tasks.join_next().await.is_some() {}
    while sync_tasks.join_next().await.is_some() {}
    result
}

fn local_request(kind: &str) -> bool {
    storage::handles(kind)
        || matches!(
            kind,
            "CONFIGURE_REPOSITORY" | "GET_GIT_STATUS" | "RETRY_SYNC" | "SET_GITHUB_AUTH"
        )
}
