//! Cover art: social-media style square crops and the average colour used for
//! the fallback sleeve gradient. Replaces the ffmpeg scale/crop subprocess.

use std::fs::File;
use std::io::BufWriter;
use std::path::Path;

use anyhow::{Context, Result};
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ImageFormat, Rgb, RgbImage};

/// Square cover crop, centre anchored, written as a progressive-friendly JPEG.
pub fn make_thumb(src: &Path, out: &Path, size: u32) -> Result<()> {
    let img = image::open(src).with_context(|| format!("open {}", src.display()))?;
    let square = cover_square(&img, size);
    write_jpeg(&square, out, 82)
}

/// Resize preserving aspect ratio and centre-crop to a square of `size`.
pub fn cover_square(img: &DynamicImage, size: u32) -> RgbImage {
    let (w, h) = (img.width(), img.height());
    let side = w.min(h).max(1);
    let x = (w - side) / 2;
    let y = (h - side) / 2;
    let cropped = img.crop_imm(x, y, side, side);
    cropped
        .resize_exact(size, size, image::imageops::FilterType::Lanczos3)
        .to_rgb8()
}

pub fn write_jpeg(rgb: &RgbImage, out: &Path, quality: u8) -> Result<()> {
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let tmp = out.with_extension("part");
    {
        let f = File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?;
        let mut w = BufWriter::new(f);
        let mut enc = JpegEncoder::new_with_quality(&mut w, quality);
        enc.encode_image(rgb)?;
    }
    std::fs::rename(&tmp, out).with_context(|| format!("rename into {}", out.display()))?;
    Ok(())
}

/// The single colour a sleeve falls back to (mean of the image).
pub fn avg_color(img: &DynamicImage) -> [u8; 3] {
    let one: RgbImage = img
        .resize_exact(1, 1, image::imageops::FilterType::Triangle)
        .to_rgb8();
    let Rgb([r, g, b]) = one.get_pixel(0, 0).to_owned();
    [r, g, b]
}

pub fn avg_color_path(src: &Path) -> Result<[u8; 3]> {
    let img = image::open(src).with_context(|| format!("open {}", src.display()))?;
    Ok(avg_color(&img))
}

/// Detect whether a byte blob is an image at all — used before writing a cover.
pub fn sniff(src: &Path) -> Option<ImageFormat> {
    image::ImageReader::open(src).ok()?.with_guessed_format().ok()?.format()
}
