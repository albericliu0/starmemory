pub mod engine;
pub mod vector;

// The napi layer links against Node's symbols, which are not available to a
// `cargo test` binary -- so it is compiled out of the test build. `engine.rs`
// stays pure Rust and is what the unit tests exercise.
#[cfg(not(test))]
mod bindings;
