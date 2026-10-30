//! Terminal index setup, with independent selection positions for both model tabs.

mod credential;
pub use credential::prompt_setup_credential;

use std::{
    io::{self, Write},
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use crossterm::{
    cursor::{Hide, MoveToColumn, MoveUp, Show},
    event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    queue,
    terminal::{self, Clear, ClearType},
};
use tokio_util::sync::CancellationToken;
use zg_engine::{
    api::index::setup::{EmbeddingChoice, IndexSetup},
    authorization::IndexAuthorization,
};

use crate::{
    ColorMode,
    theme::{StatusTheme, clean, display_path},
};

const NO_INDEX_PREFIX: &str = "The directory ";
const NO_INDEX_SUFFIX: &str = " has not been indexed yet.";
const COMPACT_NO_INDEX_PREFIX: &str = "Not indexed: ";
const LOCAL_MODEL_TABS: &str = "  [ Local models ]    Remote models";
const REMOTE_MODEL_TABS: &str = "    Local models    [ Remote models ]";

struct TerminalSession {
    was_raw: bool,
}

impl TerminalSession {
    fn new() -> io::Result<Self> {
        let was_raw = terminal::is_raw_mode_enabled()?;
        terminal::enable_raw_mode()?;
        let session = Self { was_raw };
        crossterm::execute!(io::stderr(), Hide)?;
        Ok(session)
    }
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        let _ = crossterm::execute!(io::stderr(), Show);
        if !self.was_raw {
            let _ = terminal::disable_raw_mode();
        }
    }
}

fn cancelled(key: KeyEvent) -> bool {
    key.code == KeyCode::Esc
        || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
}

fn color_model_tabs(line: &str, theme: StatusTheme) -> String {
    let Some(start) = line.find('[') else {
        return theme.muted(line);
    };
    let end = line[start..]
        .find(']')
        .map_or(line.len(), |offset| start + offset + 1);
    format!(
        "{}{}{}",
        theme.muted(&line[..start]),
        theme.selected_tab(&line[start..end]),
        theme.muted(&line[end..])
    )
}

fn color_model_row(line: &str, theme: StatusTheme) -> String {
    if line.trim_start().starts_with('›') {
        theme.success(line)
    } else {
        line.to_owned()
    }
}

fn directory_title(root: &Path) -> String {
    format!(
        "{NO_INDEX_PREFIX}{}{NO_INDEX_SUFFIX}",
        clean(&display_path(root))
    )
}

fn character_columns(character: char) -> usize {
    unicode_width::UnicodeWidthChar::width(character).unwrap_or(0)
}

fn title_ranges(title: &str, columns: u16) -> Vec<std::ops::Range<usize>> {
    let width = usize::from(columns).max(1);
    let mut ranges = Vec::new();
    let mut start = 0;
    while start < title.len() {
        let mut used_columns = 0;
        let mut end = start;
        for character in title[start..].chars() {
            let next_columns = used_columns + character_columns(character);
            if end > start && next_columns > width {
                break;
            }
            used_columns = next_columns;
            end += character.len_utf8();
        }
        if end < title.len()
            && let Some(space) = title[start..end].rfind(' ')
            && title[start..start + space]
                .chars()
                .map(character_columns)
                .sum::<usize>()
                >= width / 2
        {
            end = start + space + 1;
        }
        ranges.push(start..end);
        start = end;
    }
    ranges
}

fn color_directory_title(title: &str, columns: u16, theme: StatusTheme) -> Vec<String> {
    let (path_start, path_end) = if title.starts_with(NO_INDEX_PREFIX) {
        (NO_INDEX_PREFIX.len(), title.len() - NO_INDEX_SUFFIX.len())
    } else {
        (COMPACT_NO_INDEX_PREFIX.len().min(title.len()), title.len())
    };
    title_ranges(title, columns)
        .into_iter()
        .map(|row| {
            let start = path_start.clamp(row.start, row.end);
            let end = path_end.clamp(row.start, row.end);
            format!(
                "{}{}{}",
                theme.warning(&title[row.start..start]),
                theme.path(&title[start..end]),
                theme.warning(&title[end..row.end])
            )
        })
        .collect()
}

#[derive(Default)]
struct Screen {
    lines: u16,
    body: Vec<u8>,
}

impl Screen {
    fn rewind(&self, output: &mut impl Write) -> io::Result<()> {
        queue!(output, MoveToColumn(0))?;
        if self.lines > 0 {
            queue!(output, MoveUp(self.lines))?;
        }
        queue!(output, Clear(ClearType::FromCursorDown))
    }

    fn clear(&mut self) -> io::Result<()> {
        let mut frame = Vec::new();
        self.rewind(&mut frame)?;
        let mut output = io::stderr().lock();
        output.write_all(&frame)?;
        output.flush()?;
        self.lines = 0;
        self.body.clear();
        Ok(())
    }

    fn draw(&mut self, lines: &[String], color: ColorMode) -> io::Result<()> {
        self.draw_with_model_styles(lines, color, false)
    }

    fn draw_with_model_styles(
        &mut self,
        lines: &[String],
        color: ColorMode,
        model_selection: bool,
    ) -> io::Result<()> {
        let columns = terminal::size()
            .map_or(80, |(columns, _)| columns)
            .saturating_sub(1);
        let theme = StatusTheme::new(color, crate::stderr_supports_ansi());
        let body = render_screen(lines, usize::from(columns), theme, model_selection);
        if body == self.body {
            return Ok(());
        }
        let mut frame = Vec::with_capacity(body.len() + 24);
        self.rewind(&mut frame)?;
        frame.extend_from_slice(&body);
        let mut output = io::stderr().lock();
        output.write_all(&frame)?;
        output.flush()?;
        self.lines = u16::try_from(
            std::str::from_utf8(&body)
                .expect("rendered UTF-8 screen")
                .lines()
                .count(),
        )
        .unwrap_or(u16::MAX);
        self.body = body;
        Ok(())
    }
}

fn render_screen(
    lines: &[String],
    columns: usize,
    theme: StatusTheme,
    model_selection: bool,
) -> Vec<u8> {
    let mut body = String::new();
    for (index, line) in lines.iter().enumerate() {
        if model_selection && index == 0 {
            for row in
                color_directory_title(line, u16::try_from(columns).unwrap_or(u16::MAX), theme)
            {
                body.push_str(&row);
                body.push_str("\r\n");
            }
            continue;
        }
        let model_tabs =
            model_selection && matches!(line.as_str(), LOCAL_MODEL_TABS | REMOTE_MODEL_TABS);
        let line = crate::theme::truncate(line, columns);
        let styled = if model_tabs {
            color_model_tabs(&line, theme)
        } else if model_selection && (line.starts_with("  › ") || line.starts_with("    ")) {
            color_model_row(&line, theme)
        } else if let Some(selected) = line.strip_prefix("  ✓ ") {
            format!("  {} {selected}", theme.success("✓"))
        } else if let Some(error) = line.strip_prefix("  × ") {
            format!("  {} {error}", theme.danger("×"))
        } else if let Some(warning) = line.strip_prefix("  ! ") {
            format!("  {} {warning}", theme.warning("!"))
        } else if line.starts_with("  ↑/↓")
            || line.starts_with("  Enter ")
            || line.starts_with("  Workspace  ")
            || line.starts_with("  Endpoint   ")
            || line.starts_with("  ~/")
            || line.starts_with("  /")
            || line.starts_with("  Type or paste ")
        {
            theme.muted(&line)
        } else {
            line
        };
        body.push_str(&styled);
        body.push_str("\r\n");
    }
    body.into_bytes()
}

pub struct ModelSelection {
    setup: IndexSetup,
    tab: usize,
    positions: [usize; 2],
}

#[derive(Debug, Eq, PartialEq)]
enum SelectionResult {
    Selected(EmbeddingChoice),
    Cancelled,
}

impl ModelSelection {
    #[must_use]
    pub fn new(setup: &IndexSetup) -> Self {
        let mut selection = Self {
            setup: setup.clone(),
            tab: 0,
            positions: [0, 0],
        };
        if let Some(default) = setup.models.iter().find(|model| {
            Some(&model.reference) == setup.default_model.as_ref() && model.available()
        }) {
            selection.tab = usize::from(!default.local);
            selection.positions[selection.tab] = selection
                .choices()
                .iter()
                .position(|model| model.reference == default.reference)
                .unwrap_or(0);
        }
        selection
    }

    /// Refreshes a provider's credential status without resetting either tab.
    pub fn set_provider_credential_available(&mut self, provider: &str) {
        for model in &mut self.setup.models {
            if !model.local && model.reference.split('/').next() == Some(provider) {
                model.credential_available = true;
            }
        }
    }

    fn choices(&self) -> Vec<&EmbeddingChoice> {
        self.setup
            .models
            .iter()
            .filter(|model| model.local == (self.tab == 0))
            .collect()
    }

    fn key(&mut self, key: KeyEvent) -> Option<SelectionResult> {
        if key.kind == KeyEventKind::Release {
            return None;
        }
        if cancelled(key) {
            return Some(SelectionResult::Cancelled);
        }
        let count = self.choices().len();
        match key.code {
            KeyCode::Left | KeyCode::Right | KeyCode::Tab | KeyCode::BackTab => {
                self.tab = 1 - self.tab;
            }
            KeyCode::Up if count > 0 => {
                self.positions[self.tab] = (self.positions[self.tab] + count - 1) % count;
            }
            KeyCode::Down if count > 0 => {
                self.positions[self.tab] = (self.positions[self.tab] + 1) % count;
            }
            KeyCode::Enter => {
                if let Some(model) = self.choices().get(self.positions[self.tab]) {
                    return Some(SelectionResult::Selected((*model).clone()));
                }
            }
            _ => {}
        }
        None
    }

    fn lines(&self, root: &Path, columns: u16, height: u16) -> Vec<String> {
        let mut title = directory_title(root);
        let title_budget = usize::from(height.saturating_sub(10).max(1));
        if title_ranges(&title, columns.saturating_sub(1)).len() > title_budget {
            // Preserve space for the active model and controls on a short terminal.
            let width = usize::from(columns.saturating_sub(1));
            let compact = format!("{COMPACT_NO_INDEX_PREFIX}{}", clean(&display_path(root)));
            title = format!(
                "{}{}",
                crate::theme::truncate(&compact, width.saturating_sub(3)),
                ".".repeat(width.min(3))
            );
        }
        let title_rows = u16::try_from(title_ranges(&title, columns.saturating_sub(1)).len())
            .unwrap_or(u16::MAX);
        let mut lines = vec![
            title,
            String::new(),
            "Choose a model to build the index and continue this search.".into(),
            String::new(),
            if self.tab == 0 {
                LOCAL_MODEL_TABS
            } else {
                REMOTE_MODEL_TABS
            }
            .into(),
            String::new(),
        ];
        let choices = self.choices();
        let visible =
            usize::from(height.saturating_sub(10_u16.saturating_add(title_rows))).clamp(1, 12);
        let active = self.positions[self.tab];
        let start = active.saturating_sub(visible - 1);
        let width = choices
            .iter()
            .map(|model| model.reference.chars().count())
            .max()
            .unwrap_or(0);
        for (index, model) in choices.iter().enumerate().skip(start).take(visible) {
            let status = if model.local {
                if model.downloaded {
                    "Downloaded".to_owned()
                } else {
                    model.download_bytes.map_or_else(
                        || "Download needed".to_owned(),
                        |bytes| format!("Download {} MiB", bytes.div_ceil(1024 * 1024)),
                    )
                }
            } else {
                if model.credential_available {
                    "Credential available"
                } else {
                    "Missing API credential"
                }
                .to_owned()
            };
            lines.push(format!(
                "  {} {:width$}  {status}",
                if index == active { "›" } else { " " },
                model.reference
            ));
        }
        if choices.is_empty() {
            lines.push("    No supported models".into());
        }
        if choices.len() > visible {
            lines.push(format!("  {}/{} models", active + 1, choices.len()));
        }
        lines.push(String::new());
        lines.push(format!(
            "  ↑/↓ Select · ←/→ or Tab Switch · Enter {} · Esc Cancel",
            if self.tab == 0 {
                "Build & search"
            } else {
                "Continue"
            }
        ));
        if choices.get(active).is_some_and(|model| !model.available()) {
            lines.push("  ! An API Key is required before building.".into());
        }
        lines
    }

    /// Preserves each tab's selection across switches and later prompts.
    /// # Errors
    /// Returns terminal setup or input/output failures.
    pub fn select(&mut self, root: &Path, color: ColorMode) -> io::Result<Option<EmbeddingChoice>> {
        let _terminal = TerminalSession::new()?;
        let mut screen = Screen::default();
        loop {
            let (columns, height) = terminal::size().unwrap_or((80, 24));
            screen.draw_with_model_styles(&self.lines(root, columns, height), color, true)?;
            if let Event::Key(key) = event::read()?
                && let Some(result) = self.key(key)
            {
                screen.clear()?;
                return Ok(match result {
                    SelectionResult::Selected(model) => Some(model),
                    SelectionResult::Cancelled => None,
                });
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetupAuthorizationDecision {
    Once,
    Workspace,
    Back,
    Cancel,
}

/// Requests consent before indexing sends any workspace content.
/// # Errors
/// Returns terminal setup or input/output failures.
pub fn prompt_setup_authorization(
    target: &IndexAuthorization,
    query_after: bool,
    color: ColorMode,
) -> io::Result<SetupAuthorizationDecision> {
    let _terminal = TerminalSession::new()?;
    let mut screen = Screen::default();
    let mut active = 0;
    loop {
        let mut lines = vec![
            "Remote embedding authorization".into(),
            String::new(),
            format!("  Workspace  {}", crate::theme::display_path(&target.root)),
            format!("  Model      {}", target.model),
            format!("  Endpoint   {}", target.endpoint),
            format!(
                "  Sends      {}",
                if query_after {
                    "selected workspace files and query text"
                } else {
                    "selected workspace files"
                }
            ),
            "  ! API charges may apply.".into(),
            String::new(),
            format!(
                "  Allow once covers {}.",
                if query_after {
                    "this build and the following query"
                } else {
                    "this background build only"
                }
            ),
            String::new(),
        ];
        for (index, choice) in [
            "Allow once",
            "Allow for this workspace",
            "Back to model selection",
        ]
        .iter()
        .enumerate()
        {
            lines.push(format!(
                "  {} {choice}",
                if index == active { "✓" } else { " " }
            ));
        }
        lines.extend([
            String::new(),
            "  ↑/↓ Select · Enter Confirm · Esc Cancel".into(),
        ]);
        screen.draw(&lines, color)?;
        if let Event::Key(key) = event::read()? {
            if key.kind == KeyEventKind::Release {
                continue;
            }
            if cancelled(key) {
                screen.clear()?;
                return Ok(SetupAuthorizationDecision::Cancel);
            }
            match key.code {
                KeyCode::Up => active = (active + 2) % 3,
                KeyCode::Down => active = (active + 1) % 3,
                KeyCode::Enter => {
                    screen.clear()?;
                    return Ok([
                        SetupAuthorizationDecision::Once,
                        SetupAuthorizationDecision::Workspace,
                        SetupAuthorizationDecision::Back,
                    ][active]);
                }
                _ => {}
            }
        }
    }
}

/// Owns the terminal event reader while an index is built in the foreground.
pub struct IndexCancellation {
    signal: CancellationToken,
    stopped: Arc<AtomicBool>,
    reader: Option<JoinHandle<()>>,
    _terminal: TerminalSession,
}

impl IndexCancellation {
    /// # Errors
    /// Returns a terminal setup error before any worker is started.
    pub fn new() -> io::Result<Self> {
        let terminal = TerminalSession::new()?;
        let signal = CancellationToken::new();
        let stopped = Arc::new(AtomicBool::new(false));
        let reader_signal = signal.clone();
        let reader_stopped = Arc::clone(&stopped);
        let reader = thread::spawn(move || {
            while !reader_stopped.load(Ordering::Acquire) {
                let Ok(ready) = event::poll(Duration::from_millis(100)) else {
                    reader_signal.cancel();
                    break;
                };
                if ready {
                    match event::read() {
                        Ok(Event::Key(key))
                            if key.kind != KeyEventKind::Release && cancelled(key) =>
                        {
                            reader_signal.cancel();
                            break;
                        }
                        Err(_) => {
                            reader_signal.cancel();
                            break;
                        }
                        _ => {}
                    }
                }
            }
        });
        Ok(Self {
            signal,
            stopped,
            reader: Some(reader),
            _terminal: terminal,
        })
    }

    #[must_use]
    pub fn signal(&self) -> CancellationToken {
        self.signal.clone()
    }
}

impl Drop for IndexCancellation {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> IndexSetup {
        IndexSetup {
            default_model: Some("remote/ready".into()),
            models: vec![
                EmbeddingChoice {
                    reference: "local/one".into(),
                    local: true,
                    downloaded: true,
                    configured: false,
                    credential_available: true,
                    download_bytes: None,
                },
                EmbeddingChoice {
                    reference: "local/two".into(),
                    local: true,
                    downloaded: false,
                    configured: false,
                    credential_available: true,
                    download_bytes: None,
                },
                EmbeddingChoice {
                    reference: "remote/missing".into(),
                    local: false,
                    downloaded: false,
                    configured: false,
                    credential_available: false,
                    download_bytes: None,
                },
                EmbeddingChoice {
                    reference: "remote/ready".into(),
                    local: false,
                    downloaded: false,
                    configured: true,
                    credential_available: true,
                    download_bytes: None,
                },
            ],
        }
    }

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn tab_positions_survive_switches_and_missing_credentials_can_confirm() {
        let setup = setup();
        let mut picker = ModelSelection::new(&setup);
        assert_eq!(picker.tab, 1);
        assert_eq!(picker.positions, [0, 1]);
        picker.key(key(KeyCode::Tab));
        picker.key(key(KeyCode::Down));
        picker.key(key(KeyCode::Right));
        assert_eq!(picker.positions, [1, 1]);
        picker.key(key(KeyCode::Up));
        let Some(SelectionResult::Selected(missing)) = picker.key(key(KeyCode::Enter)) else {
            panic!("select model to configure credentials");
        };
        assert_eq!(missing.reference, "remote/missing");
        assert!(!missing.credential_available);
        picker.set_provider_credential_available("remote");
        assert_eq!(picker.positions, [1, 0]);
        let lines = picker.lines(Path::new("/workspace"), 80, 24).join("\n");
        assert!(!lines.contains("Missing API credential"));
        assert!(lines.contains("Credential available"));
        picker.key(key(KeyCode::Left));
        let Some(SelectionResult::Selected(chosen)) = picker.key(key(KeyCode::Enter)) else {
            panic!("selected model");
        };
        assert_eq!(chosen.reference, "local/two");
        assert_eq!(
            picker.key(key(KeyCode::Esc)),
            Some(SelectionResult::Cancelled)
        );
    }

    #[test]
    fn invalid_default_opens_local_and_scrolling_keeps_selection_visible() {
        let mut setup = setup();
        setup.default_model = Some("remote/missing".into());
        let mut picker = ModelSelection::new(&setup);
        assert_eq!(picker.tab, 0);
        picker.key(key(KeyCode::Down));
        let lines = picker.lines(Path::new("/workspace"), 80, 11).join("\n");
        assert!(lines.contains("› local/two"));
        assert!(lines.contains("The directory /workspace has not been indexed yet."));
        assert!(lines.contains("Choose a model to build the index and continue this search."));
        assert!(!lines.contains("local/one"));
        assert!(lines.contains("Esc Cancel"));
    }

    #[test]
    fn setup_screen_colors_only_markers_and_secondary_text() {
        let lines = vec![
            "  ✓ local/model".into(),
            "  ! API charges may apply.".into(),
            "  × Enter an API Key.".into(),
            "  ↑/↓ Select · Enter Confirm · Esc Cancel".into(),
            "  /workspace\x1b[2J\npath".into(),
        ];
        let plain = String::from_utf8(render_screen(
            &lines,
            80,
            StatusTheme::new(ColorMode::Never, true),
            false,
        ))
        .expect("UTF-8 screen");
        assert!(!plain.contains('\x1b'));
        assert!(!plain.contains("\npath"));
        assert!(plain.contains("✓ local/model\r\n"));
        let colored = String::from_utf8(render_screen(
            &lines,
            80,
            StatusTheme::new(ColorMode::Always, true),
            false,
        ))
        .expect("UTF-8 screen");
        assert!(colored.contains("✓\x1b[0m local/model"));
        assert!(colored.contains("\x1b[2m  ↑/↓"));
        assert!(!colored.contains("\x1b[2J"));
    }

    #[test]
    fn setup_screen_clips_wide_workspace_names_to_terminal_columns() {
        let body = render_screen(
            &["  /工作目录/project".into()],
            8,
            StatusTheme::new(ColorMode::Never, true),
            false,
        );
        let text = String::from_utf8(body).expect("UTF-8 screen");
        assert!(unicode_width::UnicodeWidthStr::width(text.trim_end()) <= 8);
        assert!(!text.contains("project"));
    }

    #[test]
    fn model_screen_preserves_wrapped_paths_and_colors_tabs_and_selection() {
        let title = directory_title(Path::new("/工作目录/project/long-directory"));
        let rows = color_directory_title(&title, 24, StatusTheme::new(ColorMode::Never, true));
        assert_eq!(rows.concat(), title);
        assert!(
            rows.iter()
                .all(|row| unicode_width::UnicodeWidthStr::width(row.as_str()) <= 24)
        );

        let lines = vec![
            title,
            LOCAL_MODEL_TABS.to_owned(),
            "  › local/potion-code-16m-v2  Downloaded".to_owned(),
        ];
        let colored = String::from_utf8(render_screen(
            &lines,
            100,
            StatusTheme::new(ColorMode::Always, true),
            true,
        ))
        .expect("UTF-8 screen");
        assert!(colored.contains("\x1b[1;36m[ Local models ]\x1b[0m"));
        assert!(colored.contains("\x1b[32m  › local/potion-code-16m-v2 "));
        let plain = render_screen(&lines, 100, StatusTheme::new(ColorMode::Never, true), true);
        assert!(!plain.contains(&b'\x1b'));
    }

    #[test]
    fn long_model_directory_leaves_room_for_selection_and_controls() {
        let mut setup = setup();
        setup.default_model = Some("local/one".into());
        let picker = ModelSelection::new(&setup);
        let root = format!("/workspace/{}", "long-directory/".repeat(20));
        let lines = picker.lines(Path::new(&root), 40, 12);
        let screen = String::from_utf8(render_screen(
            &lines,
            39,
            StatusTheme::new(ColorMode::Never, true),
            true,
        ))
        .expect("UTF-8 screen");
        assert!(screen.lines().count() < 12);
        assert!(screen.contains("› local/one"));
        assert!(screen.contains("↑/↓ Select"));
        assert!(screen.starts_with("Not indexed: "));
    }
}
