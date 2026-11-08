//! Strict core-shared preparation lifetime contract, with no authority-bearing fields.
use super::{Check, Op, RequestParams, ResponseResult};
use extalia_core::preparation::{
    self, PreparationAdmission, PreparationBegin, PreparationInspection, PreparationObservation,
    PreparationObservationRecord,
};
use serde_json::Value;

pub(super) fn request(check: &mut Check, op: Op, value: &Value) -> Option<RequestParams> {
    let result = match op {
        Op::PreparationBegin => {
            PreparationBegin::from_value(value).map(RequestParams::PreparationBegin)
        }
        Op::PreparationObserve => {
            PreparationObservation::from_value(value).map(RequestParams::PreparationObserve)
        }
        Op::PreparationInspect => preparation::inspect_invocation(value)
            .map(|invocation_id| RequestParams::PreparationInspect { invocation_id }),
        _ => unreachable!("preparation operation"),
    };
    result
        .map_err(|_| check.fail("frame.params", "invalid preparation lifetime parameters"))
        .ok()
}
pub(super) fn response(check: &mut Check, op: Op, value: &Value) -> Option<ResponseResult> {
    let result = match op {
        Op::PreparationBegin => {
            PreparationAdmission::from_value(value).map(ResponseResult::PreparationBegin)
        }
        Op::PreparationObserve => {
            PreparationObservationRecord::from_value(value).map(ResponseResult::PreparationObserve)
        }
        Op::PreparationInspect => {
            PreparationInspection::from_value(value).map(ResponseResult::PreparationInspect)
        }
        _ => unreachable!("preparation operation"),
    };
    result
        .map_err(|_| check.fail("frame.result", "invalid preparation lifetime result"))
        .ok()
}
