use crate::config::CONFIG_TOML_FILE;
use crate::config::load_config_as_toml;
use codex_protocol::config_types::ReasoningEffort;
use std::path::Path;
use tempfile::NamedTempFile;
use toml_edit::DocumentMut;

/// Persist the default `model` and `model_reasoning_effort` to
/// `CODEX_HOME/config.toml` so the selection is used across sessions.
///
/// If a `profile` is set in `config.toml`, this updates the corresponding
/// `[profiles.<name>]` table; otherwise it updates the top-level keys.
pub fn set_default_model_and_effort(
    codex_home: &Path,
    model: &str,
    effort: ReasoningEffort,
) -> anyhow::Result<()> {
    set_default_model_and_effort_for_profile(codex_home, None, model, effort)
}

/// Persist defaults under the specified profile if provided; otherwise, if a
/// `profile` is set in `config.toml`, use it; if neither is present, update
/// the top-level keys.
pub fn set_default_model_and_effort_for_profile(
    codex_home: &Path,
    profile_override: Option<&str>,
    model: &str,
    effort: ReasoningEffort,
) -> anyhow::Result<()> {
    let effort_str = effort.to_string();
    let overrides: [(&[&str], &str); 2] = [
        (&["model"], model),
        (&["model_reasoning_effort"], effort_str.as_str()),
    ];
    persist_overrides(codex_home, profile_override, &overrides)
}

/// Persist overrides into `config.toml` using explicit key segments per
/// override. This avoids ambiguity with keys that contain dots or spaces.
fn persist_overrides(
    codex_home: &Path,
    profile: Option<&str>,
    overrides: &[(&[&str], &str)],
) -> anyhow::Result<()> {
    let config_path = codex_home.join(CONFIG_TOML_FILE);

    let mut doc = match std::fs::read_to_string(&config_path) {
        Ok(s) => s.parse::<DocumentMut>()?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => DocumentMut::new(),
        Err(e) => return Err(e.into()),
    };

    let effective_profile: Option<String> = match profile {
        Some(name) => Some(name.to_string()),
        None => load_config_as_toml(codex_home).ok().and_then(|v| {
            v.get("profile")
                .and_then(|i| i.as_str())
                .map(|s| s.to_string())
        }),
    };

    for (segments, val) in overrides.iter().copied() {
        let value = toml_edit::value(val);
        if let Some(ref name) = effective_profile {
            if segments.first().copied() == Some("profiles") {
                apply_toml_edit_override_segments(&mut doc, segments, value);
            } else {
                let mut seg_buf: Vec<&str> = Vec::with_capacity(2 + segments.len());
                seg_buf.push("profiles");
                seg_buf.push(name.as_str());
                seg_buf.extend_from_slice(segments);
                apply_toml_edit_override_segments(&mut doc, &seg_buf, value);
            }
        } else {
            apply_toml_edit_override_segments(&mut doc, segments, value);
        }
    }

    std::fs::create_dir_all(codex_home)?;
    let tmp_file = NamedTempFile::new_in(codex_home)?;
    std::fs::write(tmp_file.path(), doc.to_string())?;
    tmp_file.persist(config_path)?;

    Ok(())
}

/// Apply a single override onto a `toml_edit` document while preserving
/// existing formatting/comments.
/// The key is expressed as explicit segments to correctly handle keys that
/// contain dots or spaces.
fn apply_toml_edit_override_segments(
    doc: &mut DocumentMut,
    segments: &[&str],
    value: toml_edit::Item,
) {
    use toml_edit::Item;

    if segments.is_empty() {
        return;
    }

    let mut current = doc.as_table_mut();
    for seg in &segments[..segments.len() - 1] {
        if !current.contains_key(seg) {
            current[*seg] = Item::Table(toml_edit::Table::new());
            if let Some(t) = current[*seg].as_table_mut() {
                t.set_implicit(true);
            }
        }

        let maybe_item = current.get_mut(seg);
        let Some(item) = maybe_item else { return };

        if !item.is_table() {
            *item = Item::Table(toml_edit::Table::new());
            if let Some(t) = item.as_table_mut() {
                t.set_implicit(true);
            }
        }

        let Some(tbl) = item.as_table_mut() else {
            return;
        };
        current = tbl;
    }

    let last = segments[segments.len() - 1];
    current[last] = value;
}

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::fs;
    use tempfile::tempdir;

    fn read_config(codex_home: &Path) -> String {
        let p = codex_home.join(CONFIG_TOML_FILE);
        fs::read_to_string(p).unwrap_or_default()
    }

    #[test]
    fn set_default_model_top_level_when_no_profile() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();

        set_default_model_and_effort(codex_home, "gpt-5", ReasoningEffort::High).expect("persist");

        let contents = read_config(codex_home);
        let val: toml::Value = toml::from_str(&contents).expect("parse");
        assert_eq!(val.get("model").and_then(|v| v.as_str()), Some("gpt-5"));
        assert_eq!(
            val.get("model_reasoning_effort").and_then(|v| v.as_str()),
            Some("high")
        );
    }

    #[test]
    fn set_default_model_updates_profile_when_profile_set() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();

        // Seed config with a profile selection but without profiles table
        let seed = "profile = \"o3\"\n";
        fs::write(codex_home.join(CONFIG_TOML_FILE), seed).expect("seed write");

        set_default_model_and_effort(codex_home, "o3", ReasoningEffort::Minimal).expect("persist");

        let contents = read_config(codex_home);
        let val: toml::Value = toml::from_str(&contents).expect("parse");

        // Top-level model keys should not be present because a profile is set.
        assert!(val.get("model").is_none());
        assert!(val.get("model_reasoning_effort").is_none());

        let profiles = val
            .get("profiles")
            .and_then(|v| v.as_table())
            .expect("profiles table");
        let o3 = profiles
            .get("o3")
            .and_then(|v| v.as_table())
            .expect("o3 tbl");
        assert_eq!(o3.get("model").and_then(|v| v.as_str()), Some("o3"));
        assert_eq!(
            o3.get("model_reasoning_effort").and_then(|v| v.as_str()),
            Some("minimal")
        );
    }

    #[test]
    fn set_default_model_updates_profile_with_dot_and_space() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();

        // Seed config with a profile name that contains a dot and a space
        let seed = "profile = \"my.team name\"\n";
        fs::write(codex_home.join(CONFIG_TOML_FILE), seed).expect("seed write");

        set_default_model_and_effort(codex_home, "o3", ReasoningEffort::Minimal).expect("persist");

        let contents = read_config(codex_home);
        let val: toml::Value = toml::from_str(&contents).expect("parse");

        // Top-level model keys should not be present because a profile is set.
        assert!(val.get("model").is_none());
        assert!(val.get("model_reasoning_effort").is_none());

        let profiles = val
            .get("profiles")
            .and_then(|v| v.as_table())
            .expect("profiles table");
        let prof = profiles
            .get("my.team name")
            .and_then(|v| v.as_table())
            .expect("profile tbl");
        assert_eq!(prof.get("model").and_then(|v| v.as_str()), Some("o3"));
        assert_eq!(
            prof.get("model_reasoning_effort").and_then(|v| v.as_str()),
            Some("minimal")
        );
    }

    #[test]
    fn set_default_model_updates_when_profile_override_supplied() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();

        // No profile key in config.toml
        fs::write(codex_home.join(CONFIG_TOML_FILE), "").expect("seed write");

        // Persist with an explicit profile override
        set_default_model_and_effort_for_profile(
            codex_home,
            Some("o3"),
            "o3",
            ReasoningEffort::High,
        )
        .expect("persist");

        let contents = read_config(codex_home);
        let val: toml::Value = toml::from_str(&contents).expect("parse");

        // Should not touch top-level keys
        assert!(val.get("model").is_none());
        assert!(val.get("model_reasoning_effort").is_none());

        // Should create the appropriate profile subtable
        let profiles = val
            .get("profiles")
            .and_then(|v| v.as_table())
            .expect("profiles table");
        let tbl = profiles
            .get("o3")
            .and_then(|v| v.as_table())
            .expect("o3 profile table");
        assert_eq!(tbl.get("model").and_then(|v| v.as_str()), Some("o3"));
        assert_eq!(
            tbl.get("model_reasoning_effort").and_then(|v| v.as_str()),
            Some("high")
        );
    }

    #[test]
    fn persist_overrides_creates_nested_tables() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();

        persist_overrides(
            codex_home,
            None,
            &[
                (&["a", "b", "c"], "v"),
                (&["x"], "y"),
                (&["profiles", "p1", "model"], "gpt-5"),
            ],
        )
        .expect("persist");

        let contents = read_config(codex_home);
        let val: toml::Value = toml::from_str(&contents).expect("parse");
        assert_eq!(
            val.get("a")
                .and_then(|v| v.get("b"))
                .and_then(|v| v.get("c"))
                .and_then(|v| v.as_str()),
            Some("v")
        );
        assert_eq!(val.get("x").and_then(|v| v.as_str()), Some("y"));
        assert_eq!(
            val.get("profiles")
                .and_then(|v| v.get("p1"))
                .and_then(|v| v.get("model"))
                .and_then(|v| v.as_str()),
            Some("gpt-5")
        );
    }

    #[test]
    fn persist_overrides_replaces_scalar_with_table() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();
        let seed = "foo = \"bar\"\n";
        fs::write(codex_home.join(CONFIG_TOML_FILE), seed).expect("seed write");

        persist_overrides(codex_home, None, &[(&["foo", "bar", "baz"], "ok")]).expect("persist");

        let contents = read_config(codex_home);
        let val: toml::Value = toml::from_str(&contents).expect("parse");
        assert_eq!(
            val.get("foo")
                .and_then(|v| v.get("bar"))
                .and_then(|v| v.get("baz"))
                .and_then(|v| v.as_str()),
            Some("ok")
        );
    }

    #[test]
    fn persist_overrides_errors_on_parse_failure() {
        let tmpdir = tempdir().expect("tmp");
        let codex_home = tmpdir.path();

        // Write an intentionally invalid TOML file
        let invalid = "invalid = [unclosed";
        fs::write(codex_home.join(CONFIG_TOML_FILE), invalid).expect("seed write");

        // Attempting to persist should return an error and must not clobber the file.
        let res = persist_overrides(codex_home, None, &[(&["x"], "y")]);
        assert!(res.is_err(), "expected parse error to propagate");

        // File should be unchanged
        let contents = read_config(codex_home);
        assert_eq!(contents, invalid);
    }
}
