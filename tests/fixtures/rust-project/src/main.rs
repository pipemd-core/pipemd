mod handler;
mod config;

use crate::handler;
use crate::config::Config;
use anyhow::Result;
use serde::Deserialize;

fn main() {
    // TODO: implement main logic
    println!("Hello, world!");
}

// FIXME: error handling needed
fn process(input: &str) -> Result<String> {
    let cfg = Config::new("app", "1.0");
    let result = handler::process();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_process() {
        assert_eq!(process("hello").unwrap(), "HELLO");
    }
}