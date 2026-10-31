//! Extalia control-plane core (ADR 0021). It starts with the SQLite store adapter
//! (ADR 0019); domain types and ports are added with the operations that use them.

pub mod adapters;
pub mod control;
pub mod knowledge;
pub mod learning;
pub mod mission;
pub mod planning;
pub mod security;
mod sha256;
pub mod skills;
pub mod time;

pub use adapters::sqlite::{CoreStore, StoreError};
