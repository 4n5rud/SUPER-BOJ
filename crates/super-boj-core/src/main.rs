mod git;
mod ipc;
mod runner;
mod storage;
#[cfg(windows)]
mod windows_job;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.as_slice() {
        [] => ipc::serve().await,
        [arg, ..]
            if arg == "native-host"
                || arg
                    .to_str()
                    .is_some_and(|v| v.starts_with("chrome-extension://")) =>
        {
            ipc::serve().await
        }
        [arg] if arg == "doctor" => {
            println!(
                "{}",
                serde_json::to_string_pretty(&runner::toolchain().await)?
            );
            Ok(())
        }
        [arg, path] if arg == "run" => {
            let source = std::fs::read_to_string(path)?;
            let mut stdin = String::new();
            std::io::Read::read_to_string(&mut std::io::stdin(), &mut stdin)?;
            let request: runner::Run = serde_json::from_value(serde_json::json!({
                "jobId":uuid::Uuid::new_v4(),"language":"rust","source":source,"stdin":stdin
            }))?;
            anyhow::ensure!(
                request.valid(false),
                "Source or input exceeds the local execution limit."
            );
            let (_cancel, receiver) = tokio::sync::watch::channel(false);
            println!(
                "{}",
                serde_json::to_string_pretty(&runner::run(request, receiver).await?)?
            );
            Ok(())
        }
        _ => anyhow::bail!("usage: super-boj-core [native-host | doctor | run <main.rs>]"),
    }
}
