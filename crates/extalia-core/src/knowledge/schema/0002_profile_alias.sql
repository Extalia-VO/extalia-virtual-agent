-- Trusted host-default semantic identity; physical index ownership stays canonical.
-- Changing this value requires rebuilding all document ACL decisions, including skips.
ALTER TABLE knowledge_index_state ADD COLUMN accepted_profile_alias TEXT
  CHECK (accepted_profile_alias IS NULL OR length(accepted_profile_alias) BETWEEN 1 AND 64);
