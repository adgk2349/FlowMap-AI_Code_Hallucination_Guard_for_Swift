use std::io::{self, BufRead, Write};

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
                let _ = writeln!(
                    out,
                    "{}",
                    serde_json::json!({
                        "protocolVersion": "0.1",
                        "requestId": "unknown",
                        "ok": false,
                        "error": {
                            "code": "PARSE_ERROR",
                            "message": format!("Failed to parse request: {e}")
                        }
                    })
                );
                continue;
            }
        };

        let response = engine::handle_request(request);
        match serde_json::to_string(&response) {
            Ok(json) => {
                let _ = writeln!(out, "{json}");
                let _ = out.flush();
            }
            Err(e) => eprintln!("Error serializing response: {e}"),
        }
    }
}
