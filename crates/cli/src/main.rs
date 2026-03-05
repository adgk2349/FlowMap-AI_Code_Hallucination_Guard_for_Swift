use std::io::{self, BufRead, Write};
use std::process;

fn main() {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut out = stdout.lock();

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Error reading stdin: {e}");
                break;
            }
        };

        if line.trim().is_empty() {
            continue;
        }

        let request = match serde_json::from_str::<protocol::RequestEnvelope>(&line) {
            Ok(r) => r,
            Err(e) => {
                // Try to extract requestId from the raw JSON for better error reporting
                let request_id = serde_json::from_str::<serde_json::Value>(&line)
                    .ok()
                    .and_then(|v| v.get("requestId")?.as_str().map(String::from))
                    .unwrap_or_else(|| "unknown".to_string());

                let err_resp = serde_json::json!({
                    "protocolVersion": "0.1",
                    "requestId": request_id,
                    "ok": false,
                    "error": {
                        "code": "PARSE_ERROR",
                        "message": format!("Failed to parse request: {e}")
                    }
                });
                if writeln!(out, "{err_resp}").is_err() || out.flush().is_err() {
                    break; // Reader closed — exit gracefully
                }
                continue;
            }
        };

        let response = engine::handle_request(&request);

        // If shutdown was requested, send the response and exit
        let is_shutdown = request.cmd == "shutdown";

        match serde_json::to_string(&response) {
            Ok(json) => {
                if writeln!(out, "{json}").is_err() || out.flush().is_err() {
                    break; // Reader closed (SIGPIPE) — exit gracefully
                }
            }
            Err(e) => eprintln!("Error serializing response: {e}"),
        }

        if is_shutdown {
            process::exit(0);
        }
    }
}
