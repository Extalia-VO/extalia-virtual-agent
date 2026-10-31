//! Strict core-shared planning lifetime contract, with no authority-bearing fields.
use super::{Check, Op, RequestParams, ResponseResult};
use extalia_core::planning::{
    self, PlanningAdmission, PlanningBegin, PlanningInspection, PlanningObservation,
    PlanningObservationRecord,
};
use serde_json::Value;

pub(super) fn request(check: &mut Check, op: Op, value: &Value) -> Option<RequestParams> {
    let result = match op {
        Op::PlanningBegin => PlanningBegin::from_value(value).map(RequestParams::PlanningBegin),
        Op::PlanningObserve => {
            PlanningObservation::from_value(value).map(RequestParams::PlanningObserve)
        }
        Op::PlanningInspect => planning::inspect_invocation(value)
            .map(|invocation_id| RequestParams::PlanningInspect { invocation_id }),
        _ => unreachable!("planning operation"),
    };
    result
        .map_err(|_| check.fail("frame.params", "invalid planning lifetime parameters"))
        .ok()
}
pub(super) fn response(check: &mut Check, op: Op, value: &Value) -> Option<ResponseResult> {
    let result = match op {
        Op::PlanningBegin => {
            PlanningAdmission::from_value(value).map(ResponseResult::PlanningBegin)
        }
        Op::PlanningObserve => {
            PlanningObservationRecord::from_value(value).map(ResponseResult::PlanningObserve)
        }
        Op::PlanningInspect => {
            PlanningInspection::from_value(value).map(ResponseResult::PlanningInspect)
        }
        _ => unreachable!("planning operation"),
    };
    result
        .map_err(|_| check.fail("frame.result", "invalid planning lifetime result"))
        .ok()
}
