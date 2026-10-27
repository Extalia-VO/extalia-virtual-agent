//! Profile-scoped reads (ADR 0024 §3–4). Every query takes a [`ProfileScope`] built by
//! the core from the session, never from tool, model or note input. A scope of another
//! profile sees nothing; within the profile only `profile`-visible nodes and edges are
//! returned, an edge only with a visible source, and a resolved target only when it is
//! visible (otherwise the edge reads as missing). A link to a note of another profile was
//! never resolvable, so it reads exactly like a link to a note that does not exist.
//!
//! Returned titles, paths, aliases and link text are untrusted note data (ADR 0027).

use std::collections::{BTreeMap, BTreeSet, VecDeque};

use rusqlite::{OptionalExtension, Row, params};

use super::links::EdgeType;
use super::resolve::Resolution;
use super::{KnowledgeError, KnowledgeStore};
use crate::skills::ProfileId;

pub const MAX_SEARCH_RESULTS: usize = 100;
pub const MAX_GRAPH_DEPTH: usize = 3;
pub const MAX_GRAPH_NODES: usize = 500;
pub const MAX_OVERVIEW_NODES: usize = 2_000;
pub const MAX_OVERVIEW_EDGES: usize = 8_000;
const MAX_SEARCH_TERMS: usize = 16;

/// The profile (and later workspace) a query runs for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProfileScope {
    profile: ProfileId,
}

impl ProfileScope {
    pub fn new(profile: ProfileId) -> Self {
        Self { profile }
    }

    pub fn profile(&self) -> &ProfileId {
        &self.profile
    }
}

/// A note node with its provenance (ADR 0027): authored vault Markdown, untrusted;
/// `declared_*` mirror the front matter and are never authority.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeView {
    pub node_id: String,
    pub id_from_front_matter: bool,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub aliases: Vec<String>,
    pub tags: Vec<String>,
    pub origin: String,
    pub trust_status: String,
    pub source_sha256: String,
    pub source_mtime_ns: i64,
    pub observed_at: String,
    pub declared_verification: Option<String>,
    pub declared_revision: Option<u32>,
    pub declared_source_task_ids: Vec<String>,
}

/// Where a link points.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkTarget {
    Resolved {
        node_id: String,
        via: Resolution,
    },
    /// No visible note matches (missing, or not visible to the scope).
    Missing,
    /// Several notes match; candidates sorted by path.
    Ambiguous {
        candidates: Vec<String>,
    },
}

/// One edge (one link occurrence).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeView {
    pub source_node_id: String,
    pub ordinal: u32,
    pub edge_type: EdgeType,
    pub embed: bool,
    pub line: u32,
    pub target_text: String,
    pub heading: Option<String>,
    pub display: Option<String>,
    pub target: LinkTarget,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchHit {
    pub node_id: String,
    pub path: String,
    pub title: String,
}

/// A bounded neighbourhood: nodes (id → title) and resolved edges among them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LocalGraph {
    pub nodes: BTreeMap<String, String>,
    pub edges: Vec<(String, EdgeType, String)>,
    /// The node cap was reached before the depth was exhausted.
    pub truncated: bool,
}

/// A note of the whole-vault overview with its degrees over [`OVERVIEW_GRAPH`] edges.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewNode {
    pub node_id: String,
    pub path: String,
    pub kind: String,
    pub title: String,
    pub tags: Vec<String>,
    pub source_mtime_ns: i64,
    pub in_degree: u64,
    pub out_degree: u64,
}

impl OverviewNode {
    pub fn degree(&self) -> u64 {
        self.in_degree + self.out_degree
    }
}

/// One overview edge: a distinct resolved link between two different visible notes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OverviewEdge {
    pub source: String,
    pub target: String,
    pub edge_type: EdgeType,
}

/// The most connected notes of the scope and the size of the whole overview graph.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OverviewNodes {
    pub total_nodes: u64,
    pub total_edges: u64,
    /// By degree descending, then node id.
    pub nodes: Vec<OverviewNode>,
}

/// The overview graph `g(s, t, k)`: resolved edges whose source and target are visible and
/// different, one row per (source, target, type); and `d(id, inn, outn)`, the degrees of every
/// node with at least one such edge. Ambiguous and missing links have no target and are out.
const OVERVIEW_GRAPH: &str = "WITH g(s, t, k) AS ( \
      SELECT DISTINCT e.source_node_id, e.target_node_id, e.edge_type FROM knowledge_edges e \
      JOIN knowledge_nodes sn ON sn.profile_id = e.profile_id \
        AND sn.node_id = e.source_node_id AND sn.visibility = 'profile' \
      JOIN knowledge_nodes tn ON tn.profile_id = e.profile_id \
        AND tn.node_id = e.target_node_id AND tn.visibility = 'profile' \
      WHERE e.profile_id = ?1 AND e.visibility = 'profile' AND e.target_node_id IS NOT NULL \
        AND e.source_node_id <> e.target_node_id), \
    d(id, inn, outn) AS ( \
      SELECT id, sum(i), sum(o) FROM ( \
        SELECT s AS id, 0 AS i, 1 AS o FROM g UNION ALL SELECT t, 1, 0 FROM g) \
      GROUP BY id)";

const NODE_COLUMNS: &str = "node_id, id_source, path, kind, title, tags_json, origin, \
    trust_status, source_sha256, source_mtime_ns, observed_at, declared_verification, \
    declared_revision, declared_source_task_ids";

const EDGE_COLUMNS: &str = "e.source_node_id, e.ordinal, e.edge_type, e.embed, e.line, \
    e.target_text, e.heading, e.display, e.resolution, t.node_id";

/// Edges with a visible source; `t` is the target only when visible.
const EDGE_FROM: &str = "FROM knowledge_edges e \
    JOIN knowledge_nodes s ON s.profile_id = e.profile_id AND s.node_id = e.source_node_id \
      AND s.visibility = 'profile' \
    LEFT JOIN knowledge_nodes t ON t.profile_id = e.profile_id AND t.node_id = e.target_node_id \
      AND t.visibility = 'profile' \
    WHERE e.profile_id = ?1 AND e.visibility = 'profile'";

fn json_list(text: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(text).unwrap_or_default()
}

impl KnowledgeStore {
    fn visible(&self, scope: &ProfileScope) -> bool {
        scope.profile == self.profile
    }

    /// A node by id.
    pub fn node(
        &self,
        scope: &ProfileScope,
        node_id: &str,
    ) -> Result<Option<NodeView>, KnowledgeError> {
        self.node_where(scope, "node_id", node_id)
    }

    /// A node by vault-relative path (exact).
    pub fn node_by_path(
        &self,
        scope: &ProfileScope,
        path: &str,
    ) -> Result<Option<NodeView>, KnowledgeError> {
        self.node_where(scope, "path", path)
    }

    fn node_where(
        &self,
        scope: &ProfileScope,
        column: &str,
        value: &str,
    ) -> Result<Option<NodeView>, KnowledgeError> {
        if !self.visible(scope) {
            return Ok(None);
        }
        let sql = format!(
            "SELECT {NODE_COLUMNS} FROM knowledge_nodes \
             WHERE profile_id = ?1 AND {column} = ?2 AND visibility = 'profile'"
        );
        let node = self
            .conn
            .query_row(&sql, params![self.profile.as_str(), value], node_row)
            .optional()?;
        let Some(mut node) = node else {
            return Ok(None);
        };
        node.aliases = self
            .conn
            .prepare(
                "SELECT alias FROM knowledge_aliases WHERE profile_id = ?1 AND node_id = ?2 \
                 ORDER BY alias",
            )?
            .query_map(params![self.profile.as_str(), node.node_id], |row| {
                row.get(0)
            })?
            .collect::<Result<_, _>>()?;
        Ok(Some(node))
    }

    /// Links written in a note, in order, including unresolved ones.
    pub fn outgoing(
        &self,
        scope: &ProfileScope,
        node_id: &str,
    ) -> Result<Vec<EdgeView>, KnowledgeError> {
        if !self.visible(scope) {
            return Ok(Vec::new());
        }
        self.edges(
            &format!(
                "SELECT {EDGE_COLUMNS} {EDGE_FROM} AND e.source_node_id = ?2 ORDER BY e.ordinal"
            ),
            node_id,
        )
    }

    /// Resolved links pointing at a note, by source then position.
    pub fn backlinks(
        &self,
        scope: &ProfileScope,
        node_id: &str,
    ) -> Result<Vec<EdgeView>, KnowledgeError> {
        if !self.visible(scope) {
            return Ok(Vec::new());
        }
        self.edges(
            &format!(
                "SELECT {EDGE_COLUMNS} {EDGE_FROM} AND e.target_node_id = ?2 \
                 AND t.node_id IS NOT NULL ORDER BY e.source_node_id, e.ordinal"
            ),
            node_id,
        )
    }

    fn edges(&self, sql: &str, node_id: &str) -> Result<Vec<EdgeView>, KnowledgeError> {
        let p = self.profile.as_str();
        let mut edges = self
            .conn
            .prepare(sql)?
            .query_map(params![p, node_id], edge_row)?
            .collect::<Result<Vec<_>, _>>()?;
        for edge in &mut edges {
            if matches!(edge.target, LinkTarget::Ambiguous { .. }) {
                let candidates: Vec<String> = self
                    .conn
                    .prepare(
                        "SELECT c.candidate_node_id FROM knowledge_edge_candidates c \
                         JOIN knowledge_nodes n ON n.profile_id = c.profile_id \
                           AND n.node_id = c.candidate_node_id AND n.visibility = 'profile' \
                         WHERE c.profile_id = ?1 AND c.source_node_id = ?2 AND c.ordinal = ?3 \
                         ORDER BY n.path",
                    )?
                    .query_map(params![p, edge.source_node_id, edge.ordinal], |row| {
                        row.get(0)
                    })?
                    .collect::<Result<_, _>>()?;
                edge.target = if candidates.is_empty() {
                    LinkTarget::Missing
                } else {
                    LinkTarget::Ambiguous { candidates }
                };
            }
        }
        Ok(edges)
    }

    /// Full-text search over titles, aliases and bodies. Each whitespace-separated term is
    /// matched as a quoted token (no query syntax from the caller reaches FTS5); all terms
    /// must match. Ordered by rank, then path.
    pub fn search(
        &self,
        scope: &ProfileScope,
        text: &str,
        limit: usize,
    ) -> Result<Vec<SearchHit>, KnowledgeError> {
        if !self.visible(scope) {
            return Ok(Vec::new());
        }
        let terms: Vec<String> = text
            .split_whitespace()
            .take(MAX_SEARCH_TERMS)
            .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
            .collect();
        if terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let limit = i64::try_from(limit.min(MAX_SEARCH_RESULTS)).unwrap_or(1);
        let hits = self
            .conn
            .prepare(
                "SELECT n.node_id, n.path, n.title FROM knowledge_fts f \
                 JOIN knowledge_nodes n ON n.node_seq = f.rowid \
                 WHERE knowledge_fts MATCH ?2 AND n.profile_id = ?1 AND n.visibility = 'profile' \
                 ORDER BY f.rank, n.path LIMIT ?3",
            )?
            .query_map(
                params![self.profile.as_str(), terms.join(" "), limit],
                |row| {
                    Ok(SearchHit {
                        node_id: row.get(0)?,
                        path: row.get(1)?,
                        title: row.get(2)?,
                    })
                },
            )?
            .collect::<Result<_, _>>()?;
        Ok(hits)
    }

    /// Breadth-first neighbourhood over resolved edges in both directions, at most
    /// `depth` hops (≤ [`MAX_GRAPH_DEPTH`]) and `max_nodes` nodes (≤ [`MAX_GRAPH_NODES`]).
    /// Cycles are visited once.
    pub fn local_graph(
        &self,
        scope: &ProfileScope,
        node_id: &str,
        depth: usize,
        max_nodes: usize,
    ) -> Result<LocalGraph, KnowledgeError> {
        let mut graph = LocalGraph::default();
        let Some(start) = self.node(scope, node_id)? else {
            return Ok(graph);
        };
        let depth = depth.min(MAX_GRAPH_DEPTH);
        let max_nodes = max_nodes.clamp(1, MAX_GRAPH_NODES);
        let p = self.profile.as_str();
        graph.nodes.insert(start.node_id.clone(), start.title);
        let mut queue = VecDeque::from([(start.node_id, 0usize)]);
        let mut edges: BTreeSet<(String, EdgeType, String)> = BTreeSet::new();
        let mut statement = self.conn.prepare(
            "SELECT e.source_node_id, e.edge_type, e.target_node_id, \
               CASE WHEN e.source_node_id = ?2 THEN t.title ELSE s.title END \
             FROM knowledge_edges e \
             JOIN knowledge_nodes s ON s.profile_id = e.profile_id \
               AND s.node_id = e.source_node_id AND s.visibility = 'profile' \
             JOIN knowledge_nodes t ON t.profile_id = e.profile_id \
               AND t.node_id = e.target_node_id AND t.visibility = 'profile' \
             WHERE e.profile_id = ?1 AND e.visibility = 'profile' \
               AND (e.source_node_id = ?2 OR e.target_node_id = ?2) \
             ORDER BY e.source_node_id, e.ordinal",
        )?;
        while let Some((current, distance)) = queue.pop_front() {
            if distance >= depth {
                continue;
            }
            let rows = statement
                .query_map(params![p, current], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            for (source, kind, target, other_title) in rows {
                let other = if source == current {
                    target.clone()
                } else {
                    source.clone()
                };
                if !graph.nodes.contains_key(&other) {
                    if graph.nodes.len() >= max_nodes {
                        graph.truncated = true;
                        continue;
                    }
                    graph.nodes.insert(other.clone(), other_title);
                    queue.push_back((other, distance + 1));
                }
                let kind = EdgeType::parse(&kind).ok_or(KnowledgeError::Integrity)?;
                edges.insert((source, kind, target));
            }
        }
        graph.edges = edges.into_iter().collect();
        Ok(graph)
    }

    /// The whole-vault overview: totals, and at most `limit` (≤ [`MAX_OVERVIEW_NODES`]) notes
    /// by degree descending, then node id. One aggregate query; no per-node reads.
    pub fn overview_nodes(
        &self,
        scope: &ProfileScope,
        limit: usize,
    ) -> Result<OverviewNodes, KnowledgeError> {
        if !self.visible(scope) {
            return Ok(OverviewNodes::default());
        }
        let p = self.profile.as_str();
        let (total_nodes, total_edges): (i64, i64) = self.conn.query_row(
            &format!(
                "{OVERVIEW_GRAPH} SELECT (SELECT count(*) FROM knowledge_nodes \
                   WHERE profile_id = ?1 AND visibility = 'profile'), (SELECT count(*) FROM g)"
            ),
            params![p],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let limit = i64::try_from(limit.min(MAX_OVERVIEW_NODES)).unwrap_or(0);
        let nodes = self
            .conn
            .prepare(&format!(
                "{OVERVIEW_GRAPH} SELECT n.node_id, n.path, n.kind, n.title, n.tags_json, \
                   n.source_mtime_ns, coalesce(d.inn, 0), coalesce(d.outn, 0) \
                 FROM knowledge_nodes n LEFT JOIN d ON d.id = n.node_id \
                 WHERE n.profile_id = ?1 AND n.visibility = 'profile' \
                 ORDER BY coalesce(d.inn, 0) + coalesce(d.outn, 0) DESC, n.node_id LIMIT ?2"
            ))?
            .query_map(params![p, limit], |row| {
                let tags: String = row.get(4)?;
                Ok(OverviewNode {
                    node_id: row.get(0)?,
                    path: row.get(1)?,
                    kind: row.get(2)?,
                    title: row.get(3)?,
                    tags: json_list(&tags),
                    source_mtime_ns: row.get(5)?,
                    in_degree: u64::try_from(row.get::<_, i64>(6)?).unwrap_or(0),
                    out_degree: u64::try_from(row.get::<_, i64>(7)?).unwrap_or(0),
                })
            })?
            .collect::<Result<_, _>>()?;
        Ok(OverviewNodes {
            total_nodes: u64::try_from(total_nodes).unwrap_or(0),
            total_edges: u64::try_from(total_edges).unwrap_or(0),
            nodes,
        })
    }

    /// At most `limit` (≤ [`MAX_OVERVIEW_EDGES`]) overview edges whose both ends are in
    /// `node_ids`, by the summed degree of their ends descending, then source, target, type.
    /// The set is passed as one JSON array parameter; no per-node reads.
    pub fn overview_edges(
        &self,
        scope: &ProfileScope,
        node_ids: &[&str],
        limit: usize,
    ) -> Result<Vec<OverviewEdge>, KnowledgeError> {
        if !self.visible(scope) || node_ids.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let ids = serde_json::to_string(node_ids).map_err(|_| KnowledgeError::Integrity)?;
        let limit = i64::try_from(limit.min(MAX_OVERVIEW_EDGES)).unwrap_or(0);
        let rows = self
            .conn
            .prepare(&format!(
                "{OVERVIEW_GRAPH}, sel(id) AS (SELECT DISTINCT value FROM json_each(?2)) \
                 SELECT g.s, g.t, g.k FROM g \
                 JOIN sel a ON a.id = g.s JOIN sel b ON b.id = g.t \
                 JOIN d ds ON ds.id = g.s JOIN d dt ON dt.id = g.t \
                 ORDER BY ds.inn + ds.outn + dt.inn + dt.outn DESC, g.s, g.t, g.k LIMIT ?3"
            ))?
            .query_map(params![self.profile.as_str(), ids, limit], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?
            .collect::<Result<Vec<_>, _>>()?;
        rows.into_iter()
            .map(|(source, target, kind)| {
                Ok(OverviewEdge {
                    source,
                    target,
                    edge_type: EdgeType::parse(&kind).ok_or(KnowledgeError::Integrity)?,
                })
            })
            .collect()
    }
}

fn node_row(row: &Row<'_>) -> rusqlite::Result<NodeView> {
    let id_source: String = row.get(1)?;
    let tags: String = row.get(5)?;
    let tasks: String = row.get(13)?;
    let revision: Option<i64> = row.get(12)?;
    Ok(NodeView {
        node_id: row.get(0)?,
        id_from_front_matter: id_source == "front_matter",
        path: row.get(2)?,
        kind: row.get(3)?,
        title: row.get(4)?,
        aliases: Vec::new(),
        tags: json_list(&tags),
        origin: row.get(6)?,
        trust_status: row.get(7)?,
        source_sha256: row.get(8)?,
        source_mtime_ns: row.get(9)?,
        observed_at: row.get(10)?,
        declared_verification: row.get(11)?,
        declared_revision: revision.and_then(|value| u32::try_from(value).ok()),
        declared_source_task_ids: json_list(&tasks),
    })
}

fn edge_row(row: &Row<'_>) -> rusqlite::Result<EdgeView> {
    let kind: String = row.get(2)?;
    let resolution: String = row.get(8)?;
    let visible_target: Option<String> = row.get(9)?;
    let resolution = Resolution::parse(&resolution).unwrap_or(Resolution::Missing);
    let target = match (resolution, visible_target) {
        (Resolution::Ambiguous, _) => LinkTarget::Ambiguous {
            candidates: Vec::new(),
        },
        (Resolution::Missing, _) | (_, None) => LinkTarget::Missing,
        (via, Some(node_id)) => LinkTarget::Resolved { node_id, via },
    };
    Ok(EdgeView {
        source_node_id: row.get(0)?,
        ordinal: u32::try_from(row.get::<_, i64>(1)?).unwrap_or(u32::MAX),
        edge_type: EdgeType::parse(&kind).unwrap_or(EdgeType::LinksTo),
        embed: row.get(3)?,
        line: u32::try_from(row.get::<_, i64>(4)?).unwrap_or(u32::MAX),
        target_text: row.get(5)?,
        heading: row.get(6)?,
        display: row.get(7)?,
        target,
    })
}
