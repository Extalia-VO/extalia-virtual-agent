use super::*;
use std::fs::File;
#[cfg(unix)]
use std::io::{Read, Seek, Write};
use std::sync::Arc;
#[cfg(unix)]
mod platform {
    use super::*;
    use rustix::fs::{AtFlags, Mode, OFlags, linkat, mkdirat, open, openat, unlinkat};
    use std::os::unix::fs::MetadataExt;
    fn flags() -> OFlags {
        OFlags::RDONLY | OFlags::CLOEXEC | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::NOCTTY
    }
    pub fn root(path: &Path) -> Result<File> {
        open(path, flags() | OFlags::DIRECTORY, Mode::empty())
            .map(File::from)
            .map_err(|_| refuse("not_regular_directory"))
    }
    pub fn same(a: &File, b: &File) -> bool {
        match (a.metadata(), b.metadata()) {
            (Ok(a), Ok(b)) => a.dev() == b.dev() && a.ino() == b.ino(),
            _ => false,
        }
    }
    pub fn child(parent: &File, name: &str, create: bool) -> Result<File> {
        if create {
            match mkdirat(parent, name, Mode::from_raw_mode(0o700)) {
                Ok(()) => parent.sync_all().map_err(io_fail)?,
                Err(e) if e == rustix::io::Errno::EXIST => {}
                Err(e) => return Err(io_fail(e)),
            }
        }
        openat(parent, name, flags() | OFlags::DIRECTORY, Mode::empty())
            .map(File::from)
            .map_err(|_| refuse("not_regular_directory"))
    }
    pub fn new_child(parent: &File, name: &str) -> Result<File> {
        mkdirat(parent, name, Mode::from_raw_mode(0o700)).map_err(|e| {
            if e == rustix::io::Errno::EXIST {
                refuse("stage_conflict")
            } else {
                io_fail(e)
            }
        })?;
        parent.sync_all().map_err(io_fail)?;
        child(parent, name, false)
    }
    pub fn create(parent: &File, name: &str, content: &[u8]) -> Result<Option<File>> {
        let opened = openat(
            parent,
            name,
            OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::from_raw_mode(0o600),
        );
        let mut file = match opened {
            Ok(f) => File::from(f),
            Err(e) if e == rustix::io::Errno::EXIST => return Ok(None),
            Err(e) => return Err(io_fail(e)),
        };
        // On failure leave the exclusive admission in place: uncertain writes block retry.
        file.write_all(content).map_err(io_fail)?;
        file.sync_all().map_err(io_fail)?;
        parent.sync_all().map_err(io_fail)?;
        Ok(Some(file))
    }
    pub fn publish(
        parent: &File,
        temp: &str,
        draft_file: &File,
        target: &str,
        content: &[u8],
    ) -> Result<()> {
        let mut df = draft_file.try_clone().map_err(io_fail)?;
        let m = df.metadata().map_err(io_fail)?;
        if !m.is_file() || m.len() != content.len() as u64 {
            return Err(refuse("draft_changed"));
        }
        df.seek(std::io::SeekFrom::Start(0)).map_err(io_fail)?;
        let mut draft_bytes = Vec::with_capacity(content.len());
        (&mut df)
            .take(content.len() as u64 + 1)
            .read_to_end(&mut draft_bytes)
            .map_err(io_fail)?;
        if draft_bytes != content {
            return Err(refuse("draft_changed"));
        }

        let temp_handle = openat(parent, temp, flags(), Mode::empty())
            .map(File::from)
            .map_err(|_| refuse("draft_changed"))?;
        if !same(&temp_handle, draft_file) {
            return Err(refuse("draft_changed"));
        }

        match linkat(parent, temp, parent, target, AtFlags::empty()) {
            Ok(()) => {
                let target_handle = openat(parent, target, flags(), Mode::empty())
                    .map(File::from)
                    .map_err(|_| {
                        remove(parent, target, false);
                        refuse("draft_changed")
                    })?;
                if !same(&target_handle, draft_file) {
                    remove(parent, target, false);
                    return Err(refuse("draft_changed"));
                }
            }
            Err(e) if e == rustix::io::Errno::EXIST => {
                let mut f = File::from(
                    openat(parent, target, flags(), Mode::empty())
                        .map_err(|_| refuse("not_overwritten"))?,
                );
                let m = f.metadata().map_err(io_fail)?;
                if !m.is_file() || m.len() != content.len() as u64 {
                    return Err(refuse("not_overwritten"));
                }
                let mut bytes = Vec::with_capacity(content.len());
                (&mut f)
                    .take(content.len() as u64 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_fail)?;
                if bytes != content {
                    return Err(refuse("not_overwritten"));
                }
            }
            Err(e) => return Err(io_fail(e)),
        }
        parent.sync_all().map_err(io_fail)
    }
    pub fn remove(parent: &File, name: &str, directory: bool) {
        let _ = unlinkat(
            parent,
            name,
            if directory {
                AtFlags::REMOVEDIR
            } else {
                AtFlags::empty()
            },
        );
        let _ = parent.sync_all();
    }
}
#[cfg(not(unix))]
mod platform {
    use super::*;
    // Windows refuses until directory-handle/reparse-point publication is implemented.
    pub fn root(_: &Path) -> Result<File> {
        Err(refuse("platform_unavailable"))
    }
    pub fn same(_: &File, _: &File) -> bool {
        false
    }
    pub fn child(_: &File, _: &str, _: bool) -> Result<File> {
        Err(refuse("platform_unavailable"))
    }
    pub fn new_child(_: &File, _: &str) -> Result<File> {
        Err(refuse("platform_unavailable"))
    }
    pub fn create(_: &File, _: &str, _: &[u8]) -> Result<Option<File>> {
        Err(refuse("platform_unavailable"))
    }
    pub fn publish(_: &File, _: &str, _: &File, _: &str, _: &[u8]) -> Result<()> {
        Err(refuse("platform_unavailable"))
    }
    pub fn remove(_: &File, _: &str, _: bool) {}
}
use platform::*;
pub(super) fn pin_data(path: &Path) -> Option<(File, PathBuf)> {
    let file = root(path).ok()?;
    let canonical = std::fs::canonicalize(path).ok()?;
    if !same(&file, &root(&canonical).ok()?) {
        return None;
    }
    Some((file, canonical))
}
impl Learning {
    pub(super) fn data_handle(&self) -> Result<File> {
        let (file, canonical) = self
            .data_identity
            .as_ref()
            .ok_or(refuse("data_unavailable"))?;
        if std::fs::canonicalize(&self.data).map_err(io_fail)? != *canonical
            || !same(file, &root(&self.data)?)
        {
            return Err(refuse("data_changed"));
        }
        file.try_clone().map_err(io_fail)
    }
}

#[derive(Debug)]
pub(super) struct Pin {
    pub created: Instant,
    binding: Value,
    path: PathBuf,
    canonical: PathBuf,
    root: File,
}
impl Pin {
    fn check(&self) -> Result<()> {
        if self.created.elapsed() >= RETAIN
            || std::fs::canonicalize(&self.path).map_err(|_| refuse("root_changed"))?
                != self.canonical
            || !same(
                &self.root,
                &root(&self.path).map_err(|_| refuse("root_changed"))?,
            )
        {
            return Err(refuse("root_changed"));
        }
        Ok(())
    }
}
#[derive(Debug)]
pub(super) struct Draft {
    pub created: Instant,
    pub pin_id: String,
    folder: File,
    file: File,
    category: String,
    workspace: String,
    temp: String,
    target: String,
    relative: String,
    content: String,
}
impl Drop for Draft {
    fn drop(&mut self) {
        remove(&self.folder, &self.temp, false);
    }
}
#[derive(Debug)]
pub(super) struct Stage {
    pub created: Instant,
    parent: File,
    folder: File,
    name: String,
    entries: Vec<(Arc<File>, String, bool)>,
}
impl Drop for Stage {
    fn drop(&mut self) {
        // Remove only the two files this staging owner created, never recursively follow a path.
        for (parent, name, is_dir) in self.entries.iter().rev() {
            remove(parent, name, *is_dir);
        }
        if child(&self.parent, &self.name, false).is_ok_and(|f| same(&f, &self.folder)) {
            remove(&self.parent, &self.name, true);
        }
    }
}
impl Learning {
    pub(super) fn ensure_vault(&mut self, input: &Value) -> Result<Value> {
        let profile = s(input, "profileId");
        if profile != "default" && (!profile.starts_with("vp-") || !id(profile)) {
            return Err(refuse("invalid_profile"));
        }
        let data = self.data_handle()?;
        let vaults = child(&data, "vaults", true)?;
        child(&vaults, profile, true)?;
        Ok(json!({"root":self.data.join("vaults").join(profile).to_string_lossy()}))
    }
    pub(super) fn pin(&mut self, input: &Value) -> Result<Value> {
        ids(input, &["profileId", "workspaceId", "sessionId"])?;
        if self.pins.len() >= MAX_HANDLES {
            return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
        }
        let path = PathBuf::from(s(input, "root"));
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
            || path.parent().is_none()
        {
            return Err(refuse("invalid_root"));
        }
        let opened = root(&path)?;
        let canonical = std::fs::canonicalize(&path).map_err(io_fail)?;
        let data = std::fs::canonicalize(&self.data).map_err(io_fail)?;
        let allowed_vault = data.join("vaults").join(s(input, "profileId"));
        if canonical == data
            || data.starts_with(&canonical)
            || canonical.starts_with(&data)
                && canonical != allowed_vault
                && canonical != data.join("vaults/default")
            || std::env::var_os("HOME").is_some_and(|home| home == canonical)
        {
            return Err(refuse("invalid_root"));
        }
        if !same(&opened, &root(&canonical)?) {
            return Err(refuse("root_changed"));
        }
        let pin = Pin {
            created: Instant::now(),
            binding: input.clone(),
            path,
            canonical,
            root: opened,
        };
        pin.check()?;
        let pin_id = uid();
        self.pins.insert(pin_id.clone(), pin);
        Ok(json!({"pinId":pin_id}))
    }
    pub(super) fn prepare(&mut self, input: &Value) -> Result<Value> {
        if self.drafts.len() >= MAX_HANDLES {
            return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
        }
        let pin_id = s(input, "pinId");
        let pin = self.pins.get(pin_id).ok_or(refuse("invalid_handle"))?;
        pin.check()?;
        let record = &input["record"];
        let (category, name, content) = if s(&pin.binding, "purpose") == "learning" {
            if ["profileId", "revision", "workspaceId", "sessionId"]
                .iter()
                .any(|k| record[k] != pin.binding[k])
            {
                return Err(refuse("destination_changed"));
            }
            (
                "Learning",
                s(record, "runId"),
                text::learning_markdown(record)?,
            )
        } else {
            (
                "Meetings",
                s(record, "meetingId"),
                text::meeting_markdown(record, &pin.binding)?,
            )
        };
        if !id(name) {
            return Err(refuse("invalid_identity"));
        }
        let workspace = s(&pin.binding, "workspaceId");
        let top = child(&pin.root, category, true)?;
        let folder = child(&top, workspace, true)?;
        let draft_id = uid();
        let temp = format!(".learning-{draft_id}.tmp");
        let target = format!("{name}.md");
        let relative = format!("{category}/{workspace}/{target}");
        let draft_file =
            create(&folder, &temp, content.as_bytes())?.ok_or(refuse("draft_conflict"))?;
        let draft = Draft {
            created: Instant::now(),
            pin_id: pin_id.into(),
            folder,
            file: draft_file,
            category: category.into(),
            workspace: workspace.into(),
            temp,
            target,
            relative: relative.clone(),
            content,
        };
        pin.check()?;
        self.drafts.insert(draft_id.clone(), draft);
        Ok(json!({"draftId":draft_id,"path":relative}))
    }
    pub(super) fn commit(&mut self, input: &Value) -> Result<Value> {
        // Removing the draft first ensures any refusal also cleans up the prepared bytes.
        let draft = self
            .drafts
            .remove(s(input, "draftId"))
            .ok_or(refuse("invalid_handle"))?;
        let pin = self
            .pins
            .get(&draft.pin_id)
            .ok_or(refuse("invalid_handle"))?;
        pin.check()?;
        let top = child(&pin.root, &draft.category, false)?;
        let folder = child(&top, &draft.workspace, false)?;
        if !same(&folder, &draft.folder) {
            return Err(refuse("root_changed"));
        }
        publish(
            &draft.folder,
            &draft.temp,
            &draft.file,
            &draft.target,
            draft.content.as_bytes(),
        )?;
        Ok(json!({"path":draft.relative}))
    }
    pub(super) fn claim(&mut self, input: &Value) -> Result<bool> {
        ids(input, &["profileId", "runId"])?;
        let content = s(input, "contentSha256");
        if !digest(content) {
            return Err(refuse("invalid_receipt"));
        }
        let data = self.data_handle()?;
        let folder = child(&data, "automatic-learning", true)?;
        let profile = hash(s(input, "profileId"));
        let name = format!("{profile}-{content}.json");
        let receipt = json!({"schema":"extalia.learning-admission.v1","profileHash":profile,"contentSha256":content,"runSha256":hash(s(input,"runId")),"status":"attempted"});
        Ok(create(&folder, &name, receipt.to_string().as_bytes())?.is_some())
    }
    pub(super) fn stage(&mut self, input: &Value) -> Result<Value> {
        if self.stages.len() >= MAX_HANDLES {
            return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
        }
        let proposal = text::proposal(&input["proposal"])?;
        let provenance = text::provenance(&input["provenance"])?;
        let data = self.data_handle()?;
        let profiles = child(&data, "profiles", true)?;
        let profile = child(&profiles, &self.profile, true)?;
        let inbox = child(&profile, "skill-imports", true)?;
        let stage_id = uid();
        let name = format!("proposal-{}", &stage_id[..32]);
        let folder = new_child(&inbox, &name)?;
        let mut stage = Stage {
            created: Instant::now(),
            parent: inbox,
            folder,
            name: name.clone(),
            entries: Vec::new(),
        };
        let skill = format!(
            "---\nname: {}\ndescription: {}\n---\n{}\n",
            s(&proposal, "name"),
            s(&proposal, "description"),
            s(&proposal, "instructions")
        );
        let mut receipt = provenance;
        receipt["schema"] = "extalia.skill-proposal.v1".into();
        receipt["kind"] = "model-generated-draft".into();
        receipt["sourceVerified"] = false.into();
        receipt["claimedSourceUrls"] = proposal.get("sourceUrls").cloned().unwrap_or(json!([]));
        receipt["fidelity"] = "Generated instructions, not a verified copy of the source.".into();
        let provenance = format!(
            "# Generated skill candidate\n\nUnverified source claims; this receipt is data, not scanner evidence or permission.\n\n```json\n{}\n```\n",
            serde_json::to_string_pretty(&receipt).map_err(io_fail)?
        );
        stage.entries.push((
            Arc::new(stage.folder.try_clone().map_err(io_fail)?),
            "SKILL.md".into(),
            false,
        ));
        create(&stage.folder, "SKILL.md", skill.as_bytes())?.ok_or(refuse("stage_conflict"))?;
        stage.entries.push((
            Arc::new(stage.folder.try_clone().map_err(io_fail)?),
            "PROVENANCE.md".into(),
            false,
        ));
        create(&stage.folder, "PROVENANCE.md", provenance.as_bytes())?
            .ok_or(refuse("stage_conflict"))?;
        self.stages.insert(stage_id.clone(), stage);
        Ok(json!({"stageId":stage_id,"path":name}))
    }
}

impl Learning {
    pub(super) fn stage_folder(&mut self, input: &Value) -> Result<Value> {
        if self.stages.len() >= MAX_HANDLES {
            return Err((ErrorCode::CapacityExceeded, Some("learning_capacity")));
        }
        let path = PathBuf::from(s(input, "root"));
        if !path.is_absolute()
            || path
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(refuse("invalid_root"));
        }
        let source = root(&path)?;
        let canonical = std::fs::canonicalize(&path).map_err(io_fail)?;
        let data = std::fs::canonicalize(&self.data).map_err(io_fail)?;
        if canonical.starts_with(&data) || data.starts_with(&canonical) {
            return Err(refuse("inside_store"));
        }
        let root_data = self.data_handle()?;
        let profiles = child(&root_data, "profiles", true)?;
        let profile = child(&profiles, &self.profile, true)?;
        let inbox = child(&profile, "skill-imports", true)?;
        let stage_id = uid();
        let name = format!("import-{}", &stage_id[..32]);
        let folder = new_child(&inbox, &name)?;
        let mut stage = Stage {
            created: Instant::now(),
            parent: inbox,
            folder,
            name: name.clone(),
            entries: Vec::new(),
        };
        copy_folder(&source, &mut stage)?;
        if std::fs::canonicalize(&path).map_err(io_fail)? != canonical
            || !same(&source, &root(&path)?)
        {
            return Err(refuse("changed"));
        }
        self.stages.insert(stage_id.clone(), stage);
        Ok(json!({"stageId":stage_id,"path":name}))
    }
}
#[cfg(not(unix))]
fn copy_folder(_: &File, _: &mut Stage) -> Result<()> {
    Err(refuse("platform_unavailable"))
}
#[cfg(unix)]
fn copy_folder(source: &File, stage: &mut Stage) -> Result<()> {
    use rustix::fs::{AtFlags, Dir, FileType, Mode, OFlags, openat, statat};
    use std::collections::HashSet;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    struct Copy {
        count: usize,
        bytes: u64,
        seen: HashSet<String>,
        skill: bool,
    }
    fn walk(
        source: &File,
        dest: &Arc<File>,
        prefix: &str,
        state: &mut Copy,
        tracked: &mut Vec<(Arc<File>, String, bool)>,
    ) -> Result<()> {
        let mut directory = Dir::read_from(source).map_err(io_fail)?;
        while let Some(entry) = directory.read() {
            let entry = entry.map_err(io_fail)?;
            let raw = entry.file_name();
            let name = raw.to_str().map_err(|_| refuse("invalid_name"))?;
            if [".", ".."].contains(&name) {
                continue;
            }
            if name == ".DS_Store" {
                let stat = statat(source, raw, AtFlags::SYMLINK_NOFOLLOW).map_err(io_fail)?;
                if FileType::from_raw_mode(stat.st_mode) == FileType::RegularFile {
                    continue;
                }
            }
            state.count += 1;
            if state.count > 256 {
                return Err(refuse("too_many_entries"));
            }
            let relative = if prefix.is_empty() {
                name.to_owned()
            } else {
                format!("{prefix}/{name}")
            };
            extalia_core::skills::tree::check_relative_path(&relative).map_err(|_| {
                refuse(if name.starts_with('.') {
                    "hidden_entry"
                } else {
                    "invalid_name"
                })
            })?;
            if relative.split('/').count() > 8 {
                return Err(refuse("too_deep"));
            }
            if !state.seen.insert(relative.to_ascii_lowercase()) {
                return Err(refuse("path_collision"));
            }
            let stat = statat(source, raw, AtFlags::SYMLINK_NOFOLLOW).map_err(io_fail)?;
            let kind = FileType::from_raw_mode(stat.st_mode);
            if kind == FileType::Symlink {
                return Err(refuse("symlink"));
            }
            if !matches!(kind, FileType::RegularFile | FileType::Directory) {
                return Err(refuse("special_file"));
            }
            let flags = OFlags::RDONLY
                | OFlags::CLOEXEC
                | OFlags::NOFOLLOW
                | OFlags::NONBLOCK
                | OFlags::NOCTTY
                | if kind == FileType::Directory {
                    OFlags::DIRECTORY
                } else {
                    OFlags::empty()
                };
            let mut file = File::from(
                openat(source, raw, flags, Mode::empty()).map_err(|_| refuse("changed"))?,
            );
            let before = file.metadata().map_err(io_fail)?;
            #[allow(clippy::unnecessary_cast)]
            let identity_matches =
                before.dev() == stat.st_dev as u64 && before.ino() == stat.st_ino as u64;
            if !identity_matches {
                return Err(refuse("changed"));
            }
            if kind == FileType::Directory {
                let folder = Arc::new(new_child(dest, name)?);
                tracked.push((Arc::clone(dest), name.into(), true));
                walk(&file, &folder, &relative, state, tracked)?;
            } else {
                if !before.is_file() {
                    return Err(refuse("special_file"));
                }
                if before.nlink() != 1 {
                    return Err(refuse("hard_link"));
                }
                if before.len() > 1024 * 1024 {
                    return Err(refuse("file_too_large"));
                }
                state.bytes = state
                    .bytes
                    .checked_add(before.len())
                    .ok_or(refuse("package_too_large"))?;
                if state.bytes > 8 * 1024 * 1024 {
                    return Err(refuse("package_too_large"));
                }
                let mut bytes = Vec::with_capacity(before.len() as usize);
                (&mut file)
                    .take(before.len() + 1)
                    .read_to_end(&mut bytes)
                    .map_err(io_fail)?;
                let after = file.metadata().map_err(io_fail)?;
                if bytes.len() as u64 != before.len()
                    || before.len() != after.len()
                    || before.mtime() != after.mtime()
                    || before.mtime_nsec() != after.mtime_nsec()
                    || before.ctime() != after.ctime()
                    || before.ctime_nsec() != after.ctime_nsec()
                {
                    return Err(refuse("changed"));
                }
                tracked.push((Arc::clone(dest), name.into(), false));
                let copied = create(dest, name, &bytes)?.ok_or(refuse("stage_conflict"))?;
                if before.mode() & 0o111 != 0 {
                    copied
                        .set_permissions(std::fs::Permissions::from_mode(0o700))
                        .map_err(io_fail)?;
                    copied.sync_all().map_err(io_fail)?;
                }
                if relative == "SKILL.md" {
                    state.skill = true;
                }
            }
        }
        Ok(())
    }
    let mut state = Copy {
        count: 0,
        bytes: 0,
        seen: HashSet::new(),
        skill: false,
    };
    let dest = Arc::new(stage.folder.try_clone().map_err(io_fail)?);
    walk(source, &dest, "", &mut state, &mut stage.entries)?;
    if !state.skill {
        return Err(refuse("missing_skill_md"));
    }
    Ok(())
}
