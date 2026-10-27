//! The single reconciled revision lifecycle of ADR 0025 §4 and its transition table.
//!
//! | From | To |
//! | --- | --- |
//! | `discovered` | `quarantined` |
//! | `quarantined` | `inspecting` |
//! | `inspecting` | `inspected`, `review_required`, `quarantined` (scanner unavailable, failed or incomplete) |
//! | `inspected` | `validated`, `quarantined` |
//! | `review_required` | `validated` (human review accepted), `quarantined` |
//! | `validated` | `evaluating`, `quarantined` |
//! | `evaluating` | `evaluated`, `quarantined` |
//! | `evaluated` | `awaiting_approval`, `auto_eligible`, `quarantined` |
//! | `awaiting_approval` | `approved`, `quarantined` |
//! | `auto_eligible` | `approved`, `awaiting_approval`, `quarantined` |
//! | `approved` | `active`, `quarantined` |
//! | `active` | `superseded` (another revision activated), `deprecated`, `approved` (deactivated), `quarantined` |
//! | `superseded` | `active` (rollback), `quarantined` |
//! | `deprecated` | `superseded`, `approved`, `quarantined` |
//! | any non-terminal | `blocked`, `revoked` |
//! | `blocked`, `revoked` | none (terminal) |
//!
//! `→ quarantined` from `inspected` or later is the stale-attestation edge (same bytes,
//! scanner pin or policy version changed; re-inspection needed). There is no edge into
//! `active` except from `approved` and `superseded`, and those are only reachable through
//! an inspection pass (`inspected` or `review_required`), a policy decision
//! (`awaiting_approval` or `auto_eligible`) and an approval (`approved`); the tests walk
//! the graph to prove it. The activation pointer (`skill_activations`) is the authority
//! for what is active; the revision's `active` state is kept equal in the same transaction.

macro_rules! states {
    ($($variant:ident = $text:literal,)+) => {
        /// A revision state (`skill_revisions.state`).
        #[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
        pub enum RevisionState { $($variant,)+ }

        impl RevisionState {
            pub const ALL: &'static [RevisionState] = &[$(RevisionState::$variant,)+];

            pub fn as_str(self) -> &'static str {
                match self { $(RevisionState::$variant => $text,)+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some(RevisionState::$variant),)+ _ => None }
            }
        }
    };
}

states!(
    Discovered = "discovered",
    Quarantined = "quarantined",
    Inspecting = "inspecting",
    Inspected = "inspected",
    ReviewRequired = "review_required",
    Blocked = "blocked",
    Validated = "validated",
    Evaluating = "evaluating",
    Evaluated = "evaluated",
    AwaitingApproval = "awaiting_approval",
    AutoEligible = "auto_eligible",
    Approved = "approved",
    Active = "active",
    Superseded = "superseded",
    Deprecated = "deprecated",
    Revoked = "revoked",
);

use RevisionState as S;

/// Forward edges; `blocked` and `revoked` are added for every non-terminal state.
const EDGES: &[(RevisionState, &[RevisionState])] = &[
    (S::Discovered, &[S::Quarantined]),
    (S::Quarantined, &[S::Inspecting]),
    (
        S::Inspecting,
        &[S::Inspected, S::ReviewRequired, S::Quarantined],
    ),
    (S::Inspected, &[S::Validated, S::Quarantined]),
    (S::ReviewRequired, &[S::Validated, S::Quarantined]),
    (S::Validated, &[S::Evaluating, S::Quarantined]),
    (S::Evaluating, &[S::Evaluated, S::Quarantined]),
    (
        S::Evaluated,
        &[S::AwaitingApproval, S::AutoEligible, S::Quarantined],
    ),
    (S::AwaitingApproval, &[S::Approved, S::Quarantined]),
    (
        S::AutoEligible,
        &[S::Approved, S::AwaitingApproval, S::Quarantined],
    ),
    (S::Approved, &[S::Active, S::Quarantined]),
    (
        S::Active,
        &[S::Superseded, S::Deprecated, S::Approved, S::Quarantined],
    ),
    (S::Superseded, &[S::Active, S::Quarantined]),
    (S::Deprecated, &[S::Superseded, S::Approved, S::Quarantined]),
];

impl RevisionState {
    /// `blocked` and `revoked` have no outgoing edge.
    pub fn terminal(self) -> bool {
        matches!(self, S::Blocked | S::Revoked)
    }

    /// States at or after `inspected` whose validity rests on an attestation.
    pub fn attested(self) -> bool {
        matches!(
            self,
            S::Inspected
                | S::ReviewRequired
                | S::Validated
                | S::Evaluating
                | S::Evaluated
                | S::AwaitingApproval
                | S::AutoEligible
                | S::Approved
                | S::Active
                | S::Superseded
                | S::Deprecated
        )
    }

    /// Whether the table allows `self → to`.
    pub fn can_transition_to(self, to: RevisionState) -> bool {
        if self.terminal() {
            return false;
        }
        if matches!(to, S::Blocked | S::Revoked) {
            return true;
        }
        EDGES
            .iter()
            .find(|(from, _)| *from == self)
            .is_some_and(|(_, targets)| targets.contains(&to))
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::RevisionState as S;

    fn reachable(from: S, removed: &[S]) -> BTreeSet<S> {
        let mut seen = BTreeSet::from([from]);
        let mut queue = vec![from];
        while let Some(state) = queue.pop() {
            for &next in S::ALL {
                if !removed.contains(&next) && state.can_transition_to(next) && seen.insert(next) {
                    queue.push(next);
                }
            }
        }
        seen
    }

    #[test]
    fn names_round_trip_and_match_the_schema_check() {
        let schema = include_str!("../../migrations/0002_skills.sql");
        for &state in S::ALL {
            assert_eq!(S::parse(state.as_str()), Some(state));
            assert!(
                schema.contains(&format!("'{}'", state.as_str())),
                "{state:?}"
            );
        }
        assert_eq!(S::ALL.len(), 16);
    }

    #[test]
    fn every_state_is_reachable_from_discovered() {
        assert_eq!(reachable(S::Discovered, &[]).len(), S::ALL.len());
    }

    #[test]
    fn terminal_states_have_no_exit() {
        for &from in &[S::Blocked, S::Revoked] {
            for &to in S::ALL {
                assert!(!from.can_transition_to(to), "{from:?} -> {to:?}");
            }
        }
    }

    #[test]
    fn active_needs_inspection_policy_decision_and_approval() {
        for start in [S::Discovered, S::Quarantined] {
            for gate in [
                &[S::Inspected, S::ReviewRequired][..],
                &[S::AwaitingApproval, S::AutoEligible][..],
                &[S::Approved][..],
                &[S::Validated][..],
                &[S::Evaluated][..],
            ] {
                assert!(
                    !reachable(start, gate).contains(&S::Active),
                    "{start:?} reaches active without {gate:?}"
                );
            }
        }
        // No direct shortcut either.
        for &from in S::ALL {
            if from.can_transition_to(S::Active) {
                assert!(matches!(from, S::Approved | S::Superseded), "{from:?}");
            }
        }
    }

    #[test]
    fn forbidden_shortcuts() {
        let forbidden = [
            (S::Discovered, S::Active),
            (S::Quarantined, S::Active),
            (S::Quarantined, S::Inspected),
            (S::Quarantined, S::Approved),
            (S::Inspected, S::Approved),
            (S::Evaluated, S::Active),
            (S::AwaitingApproval, S::Active),
            (S::AutoEligible, S::Active),
            (S::Inspecting, S::Validated),
            (S::Blocked, S::Quarantined),
            (S::Revoked, S::Quarantined),
            (S::Superseded, S::Approved),
        ];
        for (from, to) in forbidden {
            assert!(!from.can_transition_to(to), "{from:?} -> {to:?}");
        }
    }

    #[test]
    fn every_non_terminal_state_can_be_blocked_revoked_or_requarantined_when_attested() {
        for &state in S::ALL.iter().filter(|state| !state.terminal()) {
            assert!(state.can_transition_to(S::Blocked));
            assert!(state.can_transition_to(S::Revoked));
            if state.attested() {
                assert!(state.can_transition_to(S::Quarantined), "{state:?}");
            }
        }
    }
}
