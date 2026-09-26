//! Blocking GDAL raster I/O, dispatched on the sample type.
//!
//! Everything here runs *without* taking the global GDAL lock — callers take it
//! first. Keeping the dispatch (and therefore the generics) in one place is what
//! lets the sync methods and the `AsyncTask` implementations share a code path.

use gdal::cpl::CslStringList;
use gdal::raster::{Buffer, RasterBand, ResampleAlg};
use napi_derive::napi;
use serde_json::Value;

use crate::dtype::DataType;
use crate::error::{IntoGdalResult, Result, bad_argument};
use crate::json::option_pairs;

/// Region to read or write, resolved against the band's own size.
#[derive(Debug, Clone, Copy)]
pub struct Window {
    pub x: usize,
    pub y: usize,
    pub width: usize,
    pub height: usize,
    pub out_width: usize,
    pub out_height: usize,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ReadOptions {
    /// Left edge of the source window, in pixels. Default 0.
    pub x: Option<u32>,
    /// Top edge of the source window, in pixels. Default 0.
    pub y: Option<u32>,
    /// Width of the source window. Default: to the right edge of the band.
    pub width: Option<u32>,
    /// Height of the source window. Default: to the bottom edge of the band.
    pub height: Option<u32>,
    /// Width of the result. Defaults to `width`; set it to resample.
    pub out_width: Option<u32>,
    /// Height of the result. Defaults to `height`; set it to resample.
    pub out_height: Option<u32>,
    /// Resampling kernel used when `outWidth`/`outHeight` differ. One of
    /// `nearest`, `bilinear`, `cubic`, `cubicspline`, `lanczos`, `average`,
    /// `mode`, `gauss`. Defaults to `nearest`.
    pub resampling: Option<String>,
}

pub fn resolve_window(
    options: &ReadOptions,
    band_width: usize,
    band_height: usize,
) -> Result<Window> {
    let x = options.x.unwrap_or(0) as usize;
    let y = options.y.unwrap_or(0) as usize;
    let width = options
        .width
        .map_or(band_width.saturating_sub(x), |v| v as usize);
    let height = options
        .height
        .map_or(band_height.saturating_sub(y), |v| v as usize);

    if width == 0 || height == 0 {
        return Err(bad_argument("read window is empty"));
    }
    if x + width > band_width || y + height > band_height {
        return Err(bad_argument(format!(
            "read window ({x},{y} {width}x{height}) falls outside the band ({band_width}x{band_height})"
        )));
    }

    Ok(Window {
        x,
        y,
        width,
        height,
        out_width: options.out_width.map_or(width, |v| v as usize),
        out_height: options.out_height.map_or(height, |v| v as usize),
    })
}

pub fn resample_alg(options: &ReadOptions) -> Result<Option<ResampleAlg>> {
    match &options.resampling {
        None => Ok(None),
        Some(name) => name
            .parse::<ResampleAlg>()
            .map(Some)
            .map_err(|err| bad_argument(format!("unknown resampling {name:?}: {err}"))),
    }
}

/// Reinterpret a slice of samples as raw little-endian bytes.
fn samples_to_bytes<T: Copy>(samples: &[T]) -> Vec<u8> {
    let len = std::mem::size_of_val(samples);
    let mut bytes = vec![0u8; len];
    if len > 0 {
        // SAFETY: `bytes` has exactly the size of `samples`, `u8` has alignment
        // 1, and the regions do not overlap.
        unsafe {
            std::ptr::copy_nonoverlapping(samples.as_ptr() as *const u8, bytes.as_mut_ptr(), len);
        }
    }
    bytes
}

/// Reinterpret raw bytes as a `Vec` of samples. `read_unaligned` keeps this
/// sound for a `Buffer` whose backing allocation makes no alignment promise.
fn bytes_to_samples<T: Copy>(bytes: &[u8]) -> Vec<T> {
    let size = std::mem::size_of::<T>();
    bytes
        .chunks_exact(size)
        .map(|chunk| unsafe { std::ptr::read_unaligned(chunk.as_ptr() as *const T) })
        .collect()
}

/// Read `window` from a band. `target` of `None` reads in the band's own sample
/// type; `Some(t)` asks GDAL to convert.
pub fn read_window(
    band: &RasterBand<'_>,
    target: Option<DataType>,
    window: Window,
    resampling: Option<ResampleAlg>,
) -> Result<Vec<u8>> {
    let native = DataType::from_gdal(band.band_type());
    let data_type = target.unwrap_or(native);
    if data_type == DataType::Unknown {
        return Err(bad_argument("cannot read an Unknown sample type"));
    }

    let source = (window.x as isize, window.y as isize);
    let source_size = (window.width, window.height);
    let shape = (window.out_width, window.out_height);

    macro_rules! read {
        ($ty:ty) => {{
            let buffer = band
                .read_as::<$ty>(source, source_size, shape, resampling)
                .gdal()?;
            Ok(samples_to_bytes(buffer.data()))
        }};
    }

    match data_type {
        DataType::Uint8 => read!(u8),
        DataType::Int8 => read!(i8),
        DataType::Uint16 => read!(u16),
        DataType::Int16 => read!(i16),
        DataType::Uint32 => read!(u32),
        DataType::Int32 => read!(i32),
        DataType::Uint64 => read!(u64),
        DataType::Int64 => read!(i64),
        DataType::Float32 => read!(f32),
        DataType::Float64 => read!(f64),
        DataType::Unknown => unreachable!(),
    }
}

/// Write raw bytes into `window`. `data_type` describes how to interpret them,
/// and must be large enough for `window.width * window.height` samples.
pub fn write_window(
    band: &mut RasterBand<'_>,
    data_type: DataType,
    window: Window,
    bytes: &[u8],
) -> Result<()> {
    if data_type == DataType::Unknown {
        return Err(bad_argument("cannot write an Unknown sample type"));
    }

    let expected = window.width * window.height;
    let available = bytes.len() / data_type.size();
    if available < expected {
        return Err(bad_argument(format!(
            "buffer holds {available} samples but the {}x{} window needs {expected}",
            window.width, window.height
        )));
    }

    let source = (window.x as isize, window.y as isize);
    let source_size = (window.width, window.height);

    macro_rules! write {
        ($ty:ty) => {{
            let mut buffer = Buffer::new(source_size, bytes_to_samples::<$ty>(bytes));
            band.write(source, source_size, &mut buffer).gdal()
        }};
    }

    match data_type {
        DataType::Uint8 => write!(u8),
        DataType::Int8 => write!(i8),
        DataType::Uint16 => write!(u16),
        DataType::Int16 => write!(i16),
        DataType::Uint32 => write!(u32),
        DataType::Int32 => write!(i32),
        DataType::Uint64 => write!(u64),
        DataType::Int64 => write!(i64),
        DataType::Float32 => write!(f32),
        DataType::Float64 => write!(f64),
        DataType::Unknown => unreachable!(),
    }
}

/// Driver creation options, e.g. `{ TILED: true, COMPRESS: 'DEFLATE' }`.
///
/// An empty list is what `create_with_band_type` passes anyway (it has a null
/// list pointer), so there is no separate no-options code path.
pub(crate) fn build_creation_options(options: Option<&Value>) -> Result<CslStringList> {
    let mut list = CslStringList::new();
    for (name, value) in option_pairs(options)? {
        list.add_name_value(&name, &value).gdal()?;
    }
    Ok(list)
}

/// `Driver::create_with_band_type_with_options` is generic over the sample type,
/// so creation needs the same dispatch as reading and writing.
pub fn create_dataset(
    driver: &gdal::Driver,
    path: &str,
    width: usize,
    height: usize,
    band_count: usize,
    data_type: DataType,
    options: Option<&Value>,
) -> Result<gdal::Dataset> {
    let data_type = if data_type == DataType::Unknown {
        DataType::Uint8
    } else {
        data_type
    };
    let options = build_creation_options(options)?;

    macro_rules! create {
        ($ty:ty) => {
            driver
                .create_with_band_type_with_options::<$ty, _>(
                    path, width, height, band_count, &options,
                )
                .gdal()
        };
    }

    match data_type {
        DataType::Uint8 => create!(u8),
        DataType::Int8 => create!(i8),
        DataType::Uint16 => create!(u16),
        DataType::Int16 => create!(i16),
        DataType::Uint32 => create!(u32),
        DataType::Int32 => create!(i32),
        DataType::Uint64 => create!(u64),
        DataType::Int64 => create!(i64),
        DataType::Float32 => create!(f32),
        DataType::Float64 => create!(f64),
        DataType::Unknown => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(x: u32, y: u32, width: u32, height: u32) -> ReadOptions {
        ReadOptions {
            x: Some(x),
            y: Some(y),
            width: Some(width),
            height: Some(height),
            ..Default::default()
        }
    }

    #[test]
    fn defaults_to_the_whole_band() {
        let window = resolve_window(&ReadOptions::default(), 8, 4).unwrap();
        assert_eq!(window.x, 0);
        assert_eq!(window.y, 0);
        assert_eq!((window.width, window.height), (8, 4));
        // With no explicit output size the result keeps the window's shape.
        assert_eq!((window.out_width, window.out_height), (8, 4));
    }

    #[test]
    fn an_explicit_window_keeps_its_size_and_can_resample() {
        let window = resolve_window(&options(2, 1, 3, 2), 8, 4).unwrap();
        assert_eq!((window.x, window.y), (2, 1));
        assert_eq!((window.width, window.height), (3, 2));
        assert_eq!((window.out_width, window.out_height), (3, 2));

        let resampled = resolve_window(
            &ReadOptions {
                out_width: Some(6),
                ..options(2, 1, 3, 2)
            },
            8,
            4,
        )
        .unwrap();
        assert_eq!((resampled.out_width, resampled.out_height), (6, 2));
    }

    #[test]
    fn rejects_a_window_that_leaves_the_band() {
        let err = resolve_window(&options(6, 0, 4, 1), 8, 4).unwrap_err();
        assert!(err.reason.contains("outside the band"), "{}", err.reason);

        let err = resolve_window(&options(0, 3, 1, 4), 8, 4).unwrap_err();
        assert!(err.reason.contains("outside the band"), "{}", err.reason);
    }

    #[test]
    fn rejects_an_empty_window() {
        assert!(resolve_window(&options(0, 0, 0, 1), 8, 4).is_err());
        assert!(resolve_window(&options(0, 0, 1, 0), 8, 4).is_err());
    }

    #[test]
    fn parses_resampling_names_through_gdal() {
        assert!(resample_alg(&ReadOptions::default()).unwrap().is_none());

        let named = ReadOptions {
            resampling: Some("bilinear".to_string()),
            ..Default::default()
        };
        assert!(resample_alg(&named).unwrap().is_some());

        let bogus = ReadOptions {
            resampling: Some("not-a-kernel".to_string()),
            ..Default::default()
        };
        let err = resample_alg(&bogus).unwrap_err();
        assert!(err.reason.contains("unknown resampling"), "{}", err.reason);
    }

    #[test]
    fn samples_and_bytes_round_trip() {
        let samples: Vec<f32> = vec![1.0, -2.5, 3.25];
        let bytes = samples_to_bytes(&samples);
        assert_eq!(bytes.len(), 3 * size_of::<f32>());
        assert_eq!(bytes_to_samples::<f32>(&bytes), samples);

        let ints: Vec<i16> = vec![-1, 0, 32767];
        assert_eq!(bytes_to_samples::<i16>(&samples_to_bytes(&ints)), ints);
    }

    #[test]
    fn short_byte_buffers_simply_yield_fewer_samples() {
        // `write_window` is what rejects a short buffer; the converter itself
        // just takes whatever whole samples are there.
        assert_eq!(bytes_to_samples::<u16>(&[1, 0, 2]), vec![1u16]);
    }
}
