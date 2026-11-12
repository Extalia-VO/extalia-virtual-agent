//! Extalia sidecar daemon (ADR 0020): the daemon wire contract v1 over stdio.

pub mod knowledge;
pub mod missions;
#[cfg(feature = "provider-experiments")]
pub mod provider_complete;
pub mod provider_models;
pub mod session;
pub mod skill_market;
pub mod skills;
pub mod wire;
pub mod worker_bundle;
pub mod worker_exchange;
pub mod worker_probe;
pub mod worker_protocol;
#[cfg(test)]
mod worker_protocol_tests;

pub mod learning;

pub mod skill_scanner;
