# Agent operating profiles

Status: implemented and verified locally in v0.4.297. The owner confirmed
both team defaults and individual agent settings. Global skill storage remains separate.
See [ADR 0083](../adr/0083-team-and-individual-operating-profiles.md).

An operating profile describes how an agent team should work and what it is
trying to build. It is reusable across workspaces. The workspace continues to
own its project files, Knowledge visibility, memory recall and permissions.

## What a profile contains

| Setting | Meaning |
| --- | --- |
| Name and purpose | A recognizable preset and the outcome it is designed to support. |
| Personality | Communication style, working principles and decision preferences. |
| Lead agent | Role, supported runtime, saved connection and preferred model chain. |
| Subagents | Roles, individual personalities, model choices and delegation guidance. |
| Team rules | How members coordinate, review and hand work back. |

Store references to approved connections and models, never credentials. An
operating profile cannot grant file access, enable a skill, bypass review or
provide capabilities an observed external runtime does not support.

## Reuse and overrides

The precedence is profile defaults, workspace overrides, then explicit
session choices. New sessions receive a resolved snapshot so later profile
edits do not silently change running work. Missing connections or unavailable
models need a visible resolution before starting; do not substitute silently.

Existing workspace `AgentTeam` settings already provide goals, rules, member
roles, model chains and individual `soul` instructions. The profile manager
uses that model and its validation. Existing sessions and workspace team settings
remain valid. Empty custom lead personality clears shared style; a blank member
personality inherits it. Explicit `team: null` starts solo.

Profile purpose and personality are background instructions. They must not be
concatenated into the current worker task used for optional skill selection.
Each lead or subagent selects procedures against its own actual assignment;
an unrelated profile goal is insufficient relevance evidence.

## Storage and isolation

The shared skill library belongs at `<data>/skills`, with the default data root
being `~/.extalia-vo`. Both ordinary and isolated workspaces can use eligible
shared procedures. The profile selector must not select another skill registry
namespace. Knowledge and memory remain scoped by workspace and vault policy.

The current display/UI profile (`config/profile.json`) and Knowledge vault
profiles have different responsibilities. Keep their settings separate from
operating presets in both storage and the interface. The host owns atomic,
versioned `config/operating-profiles.json` persistence, revision-aware edits and
stable creation request IDs. It bounds the catalog to 32 profiles, 64 KiB per
profile and 512 KiB total. Referenced connections and effective routing retain
their existing validation; profile text grants no permissions.

The existing nondefault daemon `--profile` option is a legacy storage/security
namespace, not the proposed operating-profile selector. Do not merge its
revisions or approval grants into the default registry implicitly.

## Interface

Settings has one Agent profiles destination for Purpose and personality, Lead
agent and Team. Projects select a preset and can reset their overrides.
The profile's team editor saves an in-memory draft before the outer profile
save. Chat/Office team settings expose idle lead and individual member edits.
Catalog refresh preserves drafts and source-revision checks. Knowledge location
remains in Knowledge controls, and shared skill review remains in Grimoire.

Full execution is Native-only; Hermes and observed apps keep their actual
capabilities and external configuration. Verification covers restart
persistence, explicit overrides, unchanged running sessions, concurrent
creation, reviewed handover routing, isolated context and per-worker skill
relevance. See the [user workflow](../getting-started/agent-profiles.md).
