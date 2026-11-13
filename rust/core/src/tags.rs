//! Embedded-tag reading.
//!
//! `scan::parse_name` guesses artist and title from the file name, which is only
//! as good as whatever the downloader decided to call the file. The tags inside
//! the file are what the artist actually shipped, so they are read first and the
//! filename parser is a fallback for the fields the tags leave blank.
//!
//! Reading is header-only: lofty seeks through the container's metadata blocks,
//! audio properties and cover art are switched off, and no audio is decoded. A
//! library scan therefore stays cheap even for multi-gigabyte files, and an
//! embedded picture is never loaded just to name a track. Formats lofty cannot
//! parse (WebM/Matroska, TTA, AC-3, …) yield `None` and keep their filename names.

use std::borrow::Cow;
use std::path::Path;

use lofty::config::ParseOptions;
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::Accessor;

/// The tag fields the scanner can use, as the file declares them.
///
/// `album`, `track` and `disc` are read because the tag set is already open —
/// they are not in the `Track` schema yet, so only title and artist reach it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub track: Option<u32>,
    pub disc: Option<u32>,
}

impl Tags {
    /// Read the primary tag set, falling back to the first tag set present.
    ///
    /// `None` means the file has no readable or usable tag set: an unsupported
    /// container, a corrupt header, or a tag set whose fields are all blank.
    /// Callers treat that exactly like "no tags" and keep the filename metadata.
    pub fn read(path: &Path) -> Option<Self> {
        // Properties (duration/bitrate) and cover art are the two parts of a
        // read that would touch large regions of the file, and neither names a
        // track, so both are off. Tag reading itself only walks metadata blocks.
        let options = ParseOptions::new()
            .read_properties(false)
            .read_cover_art(false);
        let tagged = Probe::open(path).ok()?.options(options).read().ok()?;
        // The primary tag set is the one the format designates. Some files only
        // carry the other flavour (a WAV with RIFF INFO but no ID3v2), so fall
        // back to whatever tag set exists instead of reporting "no tags".
        let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
        let tags = Self {
            title: clean(tag.title()),
            artist: clean(tag.artist()),
            album: clean(tag.album()),
            track: tag.track(),
            disc: tag.disk(),
        };
        if tags.title.is_none()
            && tags.artist.is_none()
            && tags.album.is_none()
            && tags.track.is_none()
            && tags.disc.is_none()
        {
            None
        } else {
            Some(tags)
        }
    }
}

/// A tag value that is empty or only whitespace carries no information, so it
/// must count as absent rather than as an intentionally blank name.
fn clean(value: Option<Cow<'_, str>>) -> Option<String> {
    let value = value?;
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Tag value when it carries text, filename-derived value otherwise.
///
/// Merging happens per field, never per file: a track that tags its title but
/// not its artist keeps the tag title and the parsed artist. A blank tag must
/// not erase a usable fallback, which is why blank counts as absent here too.
pub fn merge_field(tag: Option<&str>, fallback: Option<&str>) -> Option<String> {
    tag.map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| fallback.map(str::trim).filter(|s| !s.is_empty()))
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_empty_tag_wins_over_the_filename() {
        assert_eq!(
            merge_field(Some("Tag Artist"), Some("Filename Artist")).as_deref(),
            Some("Tag Artist")
        );
        assert_eq!(
            merge_field(Some("  Padded  "), Some("Filename")).as_deref(),
            Some("Padded")
        );
    }

    #[test]
    fn empty_or_absent_tag_falls_back_to_the_filename() {
        assert_eq!(
            merge_field(None, Some("Filename Artist")).as_deref(),
            Some("Filename Artist")
        );
        assert_eq!(
            merge_field(Some(""), Some("Filename Artist")).as_deref(),
            Some("Filename Artist")
        );
        assert_eq!(
            merge_field(Some("   \t "), Some("Filename Artist")).as_deref(),
            Some("Filename Artist")
        );
    }

    #[test]
    fn both_sides_absent_means_no_value() {
        assert_eq!(merge_field(None, None), None);
        assert_eq!(merge_field(Some(""), Some("  ")), None);
    }
}
