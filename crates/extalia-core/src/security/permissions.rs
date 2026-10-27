//! Tool permission decision (ADR 0026, audit PR 7): a port of `decide()` in
//! `packages/runtime/src/policy.ts`. Pure: no IO, clock or state. The shared matrix
//! `packages/runtime/test/fixtures/permission/decide-matrix.json`, generated from the
//! TypeScript function, is the parity oracle; `cargo test` runs every case.
//!
//! Path containment and credential-file refusal stay in the tools themselves; this
//! decision only covers actions inside the workspace boundary.

macro_rules! names {
    ($(#[$meta:meta])* $name:ident { $($variant:ident = $text:literal,)+ }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant,)+ }

        impl $name {
            /// Every value, in the order of the TypeScript list.
            pub const ALL: &'static [$name] = &[$($name::$variant,)+];

            /// The wire name.
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text,)+ }
            }

            pub fn parse(text: &str) -> Option<Self> {
                match text { $($text => Some($name::$variant),)+ _ => None }
            }
        }
    };
}

names!(
    /// What a tool does (`ToolAccess` in `runtime/src/tools.ts`).
    ToolAccess {
        Read = "read",
        Write = "write",
        Execute = "execute",
        Memory = "memory",
        Meta = "meta",
    }
);

names!(
    /// A session's permission mode (`SessionPermissionMode` in `core/src/models.ts`).
    SessionPermissionMode {
        Workspace = "workspace",
        Ask = "ask",
        AcceptEdits = "accept-edits",
        Plan = "plan",
    }
);

names!(
    /// One workspace permission (`PermissionMode` in `core/src/models.ts`).
    PermissionMode {
        Ask = "ask",
        Allow = "allow",
    }
);

names!(
    /// The outcome (`PolicyDecision` in `runtime/src/policy.ts`).
    Decision {
        Allow = "allow",
        Ask = "ask",
        Deny = "deny",
    }
);

/// What agents may do in a workspace without asking.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WorkspacePermissions {
    pub file_write: PermissionMode,
    pub commands: PermissionMode,
}

/// Decide whether a tool call may run without asking.
///
/// - `read`, `memory` and `meta` are always allowed;
/// - `plan` denies edits and commands, whatever the workspace or the grants allow;
/// - a session grant ("allow for this session") allows its access level in every other mode;
/// - edits: `accept-edits` allows them, `workspace` follows the workspace, `ask` asks;
/// - commands: `ask` asks, `workspace` and `accept-edits` follow the workspace.
pub fn decide(
    access: ToolAccess,
    workspace: WorkspacePermissions,
    session_grants: &[ToolAccess],
    mode: SessionPermissionMode,
) -> Decision {
    use SessionPermissionMode as Mode;
    match access {
        ToolAccess::Read | ToolAccess::Memory | ToolAccess::Meta => Decision::Allow,
        _ if mode == Mode::Plan => Decision::Deny,
        _ if session_grants.contains(&access) => Decision::Allow,
        ToolAccess::Write
            if mode == Mode::AcceptEdits
                || (mode == Mode::Workspace && workspace.file_write == PermissionMode::Allow) =>
        {
            Decision::Allow
        }
        ToolAccess::Execute if mode != Mode::Ask && workspace.commands == PermissionMode::Allow => {
            Decision::Allow
        }
        ToolAccess::Write | ToolAccess::Execute => Decision::Ask,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ASK: WorkspacePermissions = WorkspacePermissions {
        file_write: PermissionMode::Ask,
        commands: PermissionMode::Ask,
    };
    const ALLOW: WorkspacePermissions = WorkspacePermissions {
        file_write: PermissionMode::Allow,
        commands: PermissionMode::Allow,
    };

    #[test]
    fn reads_memory_and_meta_are_always_allowed() {
        for access in [ToolAccess::Read, ToolAccess::Memory, ToolAccess::Meta] {
            for &mode in SessionPermissionMode::ALL {
                assert_eq!(decide(access, ASK, &[], mode), Decision::Allow);
            }
        }
    }

    #[test]
    fn plan_denies_even_with_grants_and_an_allowing_workspace() {
        let all = ToolAccess::ALL;
        for access in [ToolAccess::Write, ToolAccess::Execute] {
            assert_eq!(
                decide(access, ALLOW, all, SessionPermissionMode::Plan),
                Decision::Deny
            );
        }
    }

    #[test]
    fn session_grants_and_modes() {
        use SessionPermissionMode::*;
        assert_eq!(
            decide(ToolAccess::Write, ASK, &[], Workspace),
            Decision::Ask
        );
        assert_eq!(
            decide(ToolAccess::Write, ASK, &[ToolAccess::Write], Ask),
            Decision::Allow
        );
        assert_eq!(decide(ToolAccess::Write, ALLOW, &[], Ask), Decision::Ask);
        assert_eq!(
            decide(ToolAccess::Write, ASK, &[], AcceptEdits),
            Decision::Allow
        );
        assert_eq!(
            decide(ToolAccess::Execute, ASK, &[], AcceptEdits),
            Decision::Ask
        );
        assert_eq!(
            decide(ToolAccess::Execute, ALLOW, &[], AcceptEdits),
            Decision::Allow
        );
        assert_eq!(decide(ToolAccess::Execute, ALLOW, &[], Ask), Decision::Ask);
        assert_eq!(
            decide(ToolAccess::Execute, ASK, &[ToolAccess::Write], Workspace),
            Decision::Ask
        );
    }

    #[test]
    fn names_round_trip() {
        for &access in ToolAccess::ALL {
            assert_eq!(ToolAccess::parse(access.as_str()), Some(access));
        }
        for &mode in SessionPermissionMode::ALL {
            assert_eq!(SessionPermissionMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(ToolAccess::parse("admin"), None);
        assert_eq!(SessionPermissionMode::parse("Plan"), None);
    }
}
