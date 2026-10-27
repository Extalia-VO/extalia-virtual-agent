-- Core store schema 3: running journal totals per mission (ADR 0014 caps, ADR 0019 store).
-- Applied in one transaction by the migrator; no transaction control or PRAGMA statements.
-- Released migrations are immutable: change the schema with a new numbered file.
--
-- `event.commit`, `task.transition` and `mission.create` assign the next sequence and check
-- the per-mission caps from this row instead of scanning the mission's journal, so a commit
-- costs the same at 8,000 events as at 10. The triggers below keep every row equal to the
-- aggregates of its mission's events (`count(*)`, `max(sequence)`,
-- `sum(length(CAST(payload AS BLOB)))`) in the same transaction as any write to `events`,
-- whoever writes: a rolled-back write rolls its totals back with it. Exactly one row exists
-- per mission; it is created with the mission and cascades with it.

CREATE TABLE mission_totals (
  profile_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  event_count INTEGER NOT NULL CHECK (event_count >= 0),
  last_sequence INTEGER NOT NULL CHECK (last_sequence >= 0),
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes >= 0),
  PRIMARY KEY (profile_id, mission_id),
  FOREIGN KEY (profile_id, mission_id) REFERENCES missions (profile_id, mission_id) ON DELETE CASCADE
) STRICT;

-- Backfill the missions stored before this migration.
INSERT INTO mission_totals (profile_id, mission_id, event_count, last_sequence, payload_bytes)
SELECT m.profile_id, m.mission_id, count(e.event_id), coalesce(max(e.sequence), 0),
       coalesce(sum(length(CAST(e.payload AS BLOB))), 0)
FROM missions AS m
LEFT JOIN events AS e ON e.profile_id = m.profile_id AND e.mission_id = m.mission_id
GROUP BY m.profile_id, m.mission_id;

CREATE TRIGGER mission_totals_on_mission_insert AFTER INSERT ON missions
BEGIN
  INSERT INTO mission_totals (profile_id, mission_id, event_count, last_sequence, payload_bytes)
  VALUES (NEW.profile_id, NEW.mission_id, 0, 0, 0);
END;

CREATE TRIGGER mission_totals_on_event_insert AFTER INSERT ON events
BEGIN
  UPDATE mission_totals
  SET event_count = event_count + 1,
      last_sequence = max(last_sequence, NEW.sequence),
      payload_bytes = payload_bytes + length(CAST(NEW.payload AS BLOB))
  WHERE profile_id = NEW.profile_id AND mission_id = NEW.mission_id;
END;

-- The journal is append-only in the store code; these keep the totals exact for any other
-- writer too (the mission cascade, maintenance, tests). `max(sequence)` uses the unique
-- (profile_id, mission_id, sequence) index.
CREATE TRIGGER mission_totals_on_event_delete AFTER DELETE ON events
BEGIN
  UPDATE mission_totals
  SET event_count = event_count - 1,
      last_sequence = (SELECT coalesce(max(sequence), 0) FROM events
                       WHERE profile_id = OLD.profile_id AND mission_id = OLD.mission_id),
      payload_bytes = payload_bytes - length(CAST(OLD.payload AS BLOB))
  WHERE profile_id = OLD.profile_id AND mission_id = OLD.mission_id;
END;

CREATE TRIGGER mission_totals_on_event_update AFTER UPDATE OF profile_id, mission_id, sequence, payload ON events
BEGIN
  UPDATE mission_totals
  SET event_count = event_count - 1,
      last_sequence = (SELECT coalesce(max(sequence), 0) FROM events
                       WHERE profile_id = OLD.profile_id AND mission_id = OLD.mission_id),
      payload_bytes = payload_bytes - length(CAST(OLD.payload AS BLOB))
  WHERE profile_id = OLD.profile_id AND mission_id = OLD.mission_id;
  UPDATE mission_totals
  SET event_count = event_count + 1,
      last_sequence = (SELECT coalesce(max(sequence), 0) FROM events
                       WHERE profile_id = NEW.profile_id AND mission_id = NEW.mission_id),
      payload_bytes = payload_bytes + length(CAST(NEW.payload AS BLOB))
  WHERE profile_id = NEW.profile_id AND mission_id = NEW.mission_id;
END;
