//! `RasterBand`. Holds only a dataset handle plus this band's index, so it never
//! owns GDAL memory and cannot outlive the dataset behind its back.
//!
//! Pixel reads go through [`DatasetRef::with`], which is the one access path that
//! runs in parallel for a thread-safe dataset. Everything else uses
//! [`DatasetRef::with_exclusive`] (or `with_mut` when it writes).

use std::collections::HashMap;
use std::ffi::{CString, c_char, c_int};

use gdal::Dataset as GdalDataset;
use gdal::Metadata;
use gdal::raster::RasterBand;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::dataset::{DatasetRef, with_two};
use crate::dtype::DataType;
use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, into_status_error, split};
use crate::raster_io::{
    ReadOptions, read_window, read_window_into, resample_alg, resolve_window, write_window,
};
use crate::raster_tools::{
    ContourGenerateOptions, ContourGenerateRequest, FillNoDataOptions, FillNoDataRequest,
    PolygonizeOptions, PolygonizeRequest, SieveFilterOptions, SieveFilterRequest, checksum_options,
    contour_generate, contour_generate_request, cpl_result, fill_no_data, fill_nodata_request,
    polygonize, polygonize_request, sieve_filter, sieve_filter_request,
};
use crate::runtime::ensure_initialized;
use crate::vector::JsLayer;

/// Re-derive this band's `RasterBand` and hand it to `f`.
///
/// `RasterBand::write` takes `&mut self` but only needs a mutable *local*, so a
/// single helper serves both reading and writing even though the dataset itself
/// is only borrowed immutably.
fn with_band<T>(
    dataset: &GdalDataset,
    index: usize,
    f: impl FnOnce(&mut RasterBand<'_>) -> Result<T>,
) -> Result<T> {
    let mut band = dataset.rasterband(index + 1).gdal()?;
    f(&mut band)
}

/// GDAL spells "no value" as an empty string in several places; JS gets `null`
/// for those rather than a string that carries no information.
fn non_empty(text: String) -> Option<String> {
    if text.is_empty() { None } else { Some(text) }
}

/// GDAL's `pbSuccess` out-parameter, turned into an `Option`.
fn cached(value: f64, success: c_int) -> Option<f64> {
    (success != 0).then_some(value)
}

/// Walk the null-terminated `char **` GDAL returns for category names.
///
/// It is a CPL string list, so a null entry is the terminator rather than a gap:
/// the array ends where GDAL ended it, and `categoryNames[i]` lines up with pixel
/// value `i`.
fn category_names(list: *mut *mut c_char) -> Vec<String> {
    if list.is_null() {
        return Vec::new();
    }
    let mut names = Vec::new();
    let mut index = 0;
    loop {
        let entry = unsafe { *list.add(index) };
        if entry.is_null() {
            break;
        }
        names.push(crate::runtime::c_string(entry));
        index += 1;
    }
    names
}

/// Build a CPL string list from a JS array. GDAL copies what it is given, so the
/// caller destroys this after the call; an empty array becomes a null list, which
/// is how GDAL spells "none".
fn string_list(items: &[String]) -> Result<*mut *mut c_char> {
    if items.is_empty() {
        return Ok(std::ptr::null_mut());
    }
    let mut list: *mut *mut c_char = std::ptr::null_mut();
    for item in items {
        let text = CString::new(item.as_str())
            .map_err(|_| bad_argument("a category name cannot contain a NUL byte"))?;
        list = unsafe { gdal_sys::CSLAddString(list, text.as_ptr()) };
    }
    Ok(list)
}

/// A JS string as a C string, or `None` for "unset" — which GDAL spells as a
/// null pointer in the setters that accept one.
fn optional_c_string(text: Option<String>, what: &str) -> Result<Option<CString>> {
    match text {
        Some(text) => CString::new(text)
            .map(Some)
            .map_err(|_| bad_argument(format!("{what} cannot contain a NUL byte"))),
        None => Ok(None),
    }
}

/// GDAL's bucket counts are 64-bit; JS gets 32-bit numbers, and a bucket that
/// does not fit is reported rather than truncated.
fn counts_as_u32(counts: &[u64]) -> Result<Vec<u32>> {
    counts
        .iter()
        .map(|count| {
            u32::try_from(*count).map_err(|_| {
                bad_argument(format!(
                    "a histogram bucket counted {count} samples, which does not fit in a \
                     32-bit integer"
                ))
            })
        })
        .collect()
}

/// A histogram range has to be finite and increasing before GDAL is handed it.
///
/// Written as a positive test because NaN fails every comparison: `min < max`
/// alone would let a NaN through, and so would any negated form of it.
fn check_range(min: f64, max: f64) -> Result<()> {
    let increasing = min.is_finite() && max.is_finite() && min < max;
    if !increasing {
        return Err(bad_argument(format!(
            "a histogram range must be finite and increasing, but min={min} and max={max}"
        )));
    }
    Ok(())
}

/// Statistics for a band, as GDAL computes them.
///
/// There is no valid-pixel count: `GDALGetRasterStatistics` does not report one,
/// and inventing a field that is always absent would be worse than leaving it out.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct BandStatistics {
    pub min: f64,
    pub max: f64,
    pub mean: f64,
    pub std_dev: f64,
}

/// A histogram over a value range.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct BandHistogram {
    pub min: f64,
    pub max: f64,
    /// One count per bucket — exactly `buckets` of them, in range order.
    pub counts: Vec<u32>,
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct StatisticsOptions {
    /// Compute them when GDAL has nothing cached. Default true. With `false` this
    /// only reads the cache and returns `null` when there is nothing, which costs
    /// nothing — that is the difference worth knowing about.
    pub force: Option<bool>,
    /// Let GDAL use overviews or a subset of the data: much faster on a large
    /// raster, and approximate. Default false.
    pub approx: Option<bool>,
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct HistogramOptions {
    /// Lower bound of the range. Required, as it is in GDAL — `statistics()`
    /// returns the usual pair to pass here.
    pub min: f64,
    /// Upper bound of the range. Required.
    pub max: f64,
    pub buckets: u32,
    /// Fold values outside the range into the first and last bucket instead of
    /// dropping them. Default false, which is GDAL's own default.
    pub include_out_of_range: Option<bool>,
    /// Default false.
    pub approx: Option<bool>,
}

/// `StatisticsOptions` with the defaults applied.
#[derive(Debug, Clone, Copy)]
pub struct StatisticsRequest {
    force: bool,
    approx: bool,
}

/// `HistogramOptions` resolved and checked, so a bad request fails on the JS
/// thread and the worker only ever sees numbers that make sense.
#[derive(Debug, Clone, Copy)]
pub struct HistogramRequest {
    min: f64,
    max: f64,
    buckets: usize,
    include_out_of_range: bool,
    approx: bool,
}

pub fn statistics_request(options: Option<StatisticsOptions>) -> StatisticsRequest {
    let options = options.unwrap_or_default();
    StatisticsRequest {
        force: options.force.unwrap_or(true),
        approx: options.approx.unwrap_or(false),
    }
}

pub fn histogram_request(options: HistogramOptions) -> Result<HistogramRequest> {
    if options.buckets == 0 {
        return Err(bad_argument("a histogram needs at least one bucket"));
    }
    check_range(options.min, options.max)?;
    Ok(HistogramRequest {
        min: options.min,
        max: options.max,
        buckets: options.buckets as usize,
        include_out_of_range: options.include_out_of_range.unwrap_or(false),
        approx: options.approx.unwrap_or(false),
    })
}

#[napi(js_name = "RasterBand")]
pub struct JsRasterBand {
    dataset: DatasetRef,
    index: usize,
    /// Cached so the getter does not have to reach into GDAL.
    data_type: DataType,
}

impl JsRasterBand {
    pub fn new(dataset: DatasetRef, index: usize, data_type: DataType) -> Self {
        Self {
            dataset,
            index,
            data_type,
        }
    }

    /// Fetch or compute this band's statistics.
    ///
    /// `get_statistics` takes `(force, approx)` — the **opposite** order from the
    /// C API's `GDALGetRasterStatistics(bApproxOK, bForce)`. Destructuring the
    /// request here keeps the two from being swapped by eye.
    fn compute_statistics(&self, request: StatisticsRequest) -> Result<Option<BandStatistics>> {
        ensure_initialized();
        let StatisticsRequest { force, approx } = request;
        // A read, but GDAL caches what it computes (and may write a `.aux.xml`
        // beside the raster), so it takes the exclusive side of the lock.
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                Ok(band
                    .get_statistics(force, approx)
                    .gdal()?
                    .map(|statistics| BandStatistics {
                        min: statistics.min,
                        max: statistics.max,
                        mean: statistics.mean,
                        std_dev: statistics.std_dev,
                    }))
            })
        })
    }

    fn compute_histogram(&self, request: HistogramRequest) -> Result<BandHistogram> {
        ensure_initialized();
        let HistogramRequest {
            min,
            max,
            buckets,
            include_out_of_range,
            approx,
        } = request;
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let histogram = band
                    .histogram(min, max, buckets, include_out_of_range, approx)
                    .gdal()?;

                Ok(BandHistogram {
                    min: histogram.min(),
                    max: histogram.max(),
                    counts: counts_as_u32(histogram.counts())?,
                })
            })
        })
    }

    /// A checksum is of the samples as they are, so it takes the same window
    /// resolution as a read and never the resampling path.
    fn compute_checksum(&self, options: &ReadOptions) -> Result<u32> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                let window = resolve_window(options, width, height)?;
                let checksum = band
                    .checksum(
                        (window.x as isize, window.y as isize),
                        (window.width, window.height),
                    )
                    .gdal()?;
                Ok(u32::from(checksum))
            })
        })
    }

    fn apply_fill_no_data(&self, request: FillNoDataRequest) -> Result<()> {
        ensure_initialized();
        // `with_mut`, so writing is the caller's to make: a read-only thread-safe
        // dataset refuses it, and a closed one says so.
        self.dataset
            .with_mut(|dataset| with_band(dataset, self.index, |band| fill_no_data(band, request)))
    }

    fn apply_sieve_filter(&self, request: SieveFilterRequest) -> Result<()> {
        ensure_initialized();
        self.dataset
            .with_mut(|dataset| with_band(dataset, self.index, |band| sieve_filter(band, request)))
    }

    fn read_sync(&self, target: Option<DataType>, options: &ReadOptions) -> Result<Vec<u8>> {
        ensure_initialized();
        // A pixel read is the one thing that runs concurrently on a thread-safe
        // dataset, so it is the only path that takes the shared lock.
        self.dataset.with(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                let window = resolve_window(options, width, height)?;
                let resampling = resample_alg(options)?;
                read_window(band, target, window, resampling)
            })
        })
    }

    /// The same read into memory the caller owns: GDAL writes through it, so there is
    /// no allocation and no copy. See `raster_io::read_window_into`.
    fn read_into_sync(
        &self,
        target: Option<DataType>,
        options: &ReadOptions,
        into: &mut [u8],
    ) -> Result<()> {
        ensure_initialized();
        self.dataset.with(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                let window = resolve_window(options, width, height)?;
                let resampling = resample_alg(options)?;
                read_window_into(band, target, window, resampling, into)
            })
        })
    }

    fn write_sync(&self, data: &[u8], options: &ReadOptions) -> Result<()> {
        ensure_initialized();
        // A write takes its data as an argument; `into` belongs to reads. Saying so
        // beats ignoring it and letting a caller wonder where their buffer went.
        if options.into.is_some() {
            return Err(bad_argument(
                "`into` is for reads — writePixels takes the data as its first argument",
            ));
        }
        // `with_mut` rather than `with_exclusive`: writing must be refused on a
        // read-only thread-safe dataset, and taking `&mut` is how we say so.
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                let window = resolve_window(options, width, height)?;
                write_window(band, self.data_type, window, data)
            })
        })
    }
}

#[napi]
impl JsRasterBand {
    /// **0-based**, unlike GDAL's own 1-based band numbering.
    #[napi(getter)]
    pub fn index(&self) -> u32 {
        self.index as u32
    }

    #[napi(getter)]
    pub fn data_type(&self) -> DataType {
        self.data_type
    }

    /// Band size in pixels: `[width, height]`.
    #[napi(getter)]
    pub fn size(&self) -> Result<Vec<u32>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                Ok(vec![width as u32, height as u32])
            })
        })
    }

    /// Native block size: `[width, height]`.
    #[napi(getter)]
    pub fn block_size(&self) -> Result<Vec<u32>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.block_size();
                Ok(vec![width as u32, height as u32])
            })
        })
    }

    #[napi(getter)]
    pub fn no_data_value(&self) -> Result<Option<f64>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| Ok(band.no_data_value()))
        })
    }

    #[napi]
    pub fn set_no_data_value(&self, value: Option<f64>) -> Result<()> {
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                band.set_no_data_value(value).gdal()
            })
        })
    }

    /// GDAL's colour interpretation for this band, e.g. `Red`, `GrayIndex`.
    /// Debug-formatted rather than mapped, so it stays correct as GDAL grows
    /// interpretation values.
    #[napi(getter)]
    pub fn color_interpretation(&self) -> Result<String> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                Ok(format!("{:?}", band.color_interpretation()))
            })
        })
    }

    /// GDAL's own band number, **1-based**: `band.id` is 1 for the first band.
    /// It is GDAL's numbering, where `index` is this API's 0-based convention,
    /// and the two differ by exactly one. Zero for a band that is not in the
    /// dataset's band list, such as a mask band.
    #[napi(getter)]
    pub fn id(&self) -> Result<u32> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                Ok(unsafe { gdal_sys::GDALGetBandNumber(band.c_rasterband()) } as u32)
            })
        })
    }

    /// Free-text description the format carries for this band, or `null` when it
    /// has none.
    #[napi(getter)]
    pub fn description(&self) -> Result<Option<String>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let text = crate::runtime::c_string(unsafe {
                    gdal_sys::GDALGetDescription(band.c_rasterband())
                });
                Ok(non_empty(text))
            })
        })
    }

    /// Write the band's description — the free-text label the format carries.
    /// Pass `null` to clear it.
    ///
    /// This is GDAL's `GDALSetDescription`, the same call `gdal_translate -mo
    /// DESCRIPTION=...` goes through, so the value reads back from the
    /// `description` getter and from any other GDAL tool. It is not the same
    /// thing as `setMetadataItem('DESCRIPTION', ...)`: GDAL keeps the two in
    /// different places, and `metadata()` does not show this one.
    #[napi]
    pub fn set_description(&self, value: Option<String>) -> Result<()> {
        let text = optional_c_string(value, "a description")?;
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                unsafe {
                    gdal_sys::GDALSetDescription(
                        band.c_rasterband() as gdal_sys::GDALMajorObjectH,
                        text.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()),
                    );
                }
                Ok(())
            })
        })
    }

    /// Whether this band cannot be written.
    ///
    /// A band has no access mode of its own, so this follows how its dataset was
    /// opened: `open()` is read-only, `{ update: true }` and `create` are not.
    #[napi(getter)]
    pub fn read_only(&self) -> Result<bool> {
        self.dataset.with_exclusive(|dataset| {
            let access = unsafe { gdal_sys::GDALGetAccess(dataset.c_dataset()) } as u32;
            Ok(access == gdal_sys::GDALAccess::GA_ReadOnly)
        })
    }

    /// Scale, or `null` when the band has none. The value a sample stands for is
    /// `raw * scale + offset`, which is what makes a reflectance or DEM raster
    /// mean anything beyond its raw integers.
    #[napi(getter)]
    pub fn scale(&self) -> Result<Option<f64>> {
        self.dataset
            .with_exclusive(|dataset| with_band(dataset, self.index, |band| Ok(band.scale())))
    }

    /// Offset, or `null` when the band has none — the other half of
    /// `raw * scale + offset`.
    #[napi(getter)]
    pub fn offset(&self) -> Result<Option<f64>> {
        self.dataset
            .with_exclusive(|dataset| with_band(dataset, self.index, |band| Ok(band.offset())))
    }

    /// Write the band's scale: the multiplier in `raw * scale + offset`.
    ///
    /// This is GDAL's `GDALSetRasterScale`. A driver that keeps no band metadata
    /// at all — the call fails with `SetScale() not supported on this raster
    /// band` — is reported rather than silently accepted, so a format that cannot
    /// store it says so here instead of at the next read.
    ///
    /// There is no "clear": GDAL's setter takes a number, and `0` is a scale
    /// like any other rather than a way back to `null`. `setNoDataValue(null)`
    /// and `setUnitType(null)` are the two setters that can unset anything.
    #[napi]
    pub fn set_scale(&self, scale: f64) -> Result<()> {
        self.dataset
            .with_mut(|dataset| with_band(dataset, self.index, |band| band.set_scale(scale).gdal()))
    }

    /// Write the band's offset — the other half of `raw * scale + offset`. The
    /// same rules as `setScale` apply, and there is likewise no way to unset it.
    #[napi]
    pub fn set_offset(&self, offset: f64) -> Result<()> {
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| band.set_offset(offset).gdal())
        })
    }

    /// The band's unit, e.g. `metre` or `DN`, or `null` when it has none.
    #[napi(getter)]
    pub fn unit_type(&self) -> Result<Option<String>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| Ok(non_empty(band.unit())))
        })
    }

    /// Write the band's unit — `metre`, `DN`, anything the format will carry.
    ///
    /// Pass `null` to clear it, which unlike `setScale` really does go back to
    /// `unitType === null`: GDAL's `GDALSetRasterUnitType` reads a null pointer as
    /// "remove", and the getter then reports an empty string that this binding
    /// maps to `null`.
    #[napi]
    pub fn set_unit_type(&self, value: Option<String>) -> Result<()> {
        let unit = optional_c_string(value, "a unit type")?;
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                cpl_result(unsafe {
                    gdal_sys::GDALSetRasterUnitType(
                        band.c_rasterband(),
                        unit.as_ref()
                            .map_or(std::ptr::null(), |value| value.as_ptr()),
                    )
                })
            })
        })
    }

    /// GDAL's cached minimum, or `null` when it has none.
    ///
    /// This is a cache, not a computation: `statistics()` fills it in, and a
    /// format that stores band statistics reads straight from the file, but a
    /// raster nobody has asked about reports `null` here. Use `statistics()` when
    /// you need the number itself.
    #[napi(getter)]
    pub fn minimum(&self) -> Result<Option<f64>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let mut success = 0;
                let value =
                    unsafe { gdal_sys::GDALGetRasterMinimum(band.c_rasterband(), &mut success) };
                Ok(cached(value, success))
            })
        })
    }

    /// GDAL's cached maximum — the counterpart of `minimum`, with the same
    /// "cache, not a computation" rule. `statistics({ force: false })` is the way
    /// to read it without a full pass.
    #[napi(getter)]
    pub fn maximum(&self) -> Result<Option<f64>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let mut success = 0;
                let value =
                    unsafe { gdal_sys::GDALGetRasterMaximum(band.c_rasterband(), &mut success) };
                Ok(cached(value, success))
            })
        })
    }

    /// Category names, indexed by pixel value: in a paletted raster
    /// `categoryNames[3]` is the label for value 3. Empty when the band has none.
    #[napi(getter)]
    pub fn category_names(&self) -> Result<Vec<String>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                Ok(category_names(unsafe {
                    gdal_sys::GDALGetRasterCategoryNames(band.c_rasterband())
                }))
            })
        })
    }

    /// Write the category names — the label per pixel value that a paletted
    /// raster or a classified one carries. Pass `[]` to clear them.
    ///
    /// The list is positional: `setCategoryNames(['water', 'land'])` labels value
    /// 0 `water` and value 1 `land`, which is the order `categoryNames` reads
    /// back. Names are copied into GDAL's own store, so the array is not retained.
    #[napi]
    pub fn set_category_names(&self, names: Vec<String>) -> Result<()> {
        let list = string_list(&names)?;
        let result = self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                cpl_result(unsafe {
                    gdal_sys::GDALSetRasterCategoryNames(band.c_rasterband(), list)
                })
            })
        });
        // The list is ours, not GDAL's: the call duplicated what it keeps.
        unsafe { gdal_sys::CSLDestroy(list) };
        result
    }

    #[napi]
    pub fn metadata(&self, domain: Option<String>) -> Result<HashMap<String, String>> {
        let domain = domain.unwrap_or_default();
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let mut out = HashMap::new();
                for entry in band.metadata() {
                    if entry.domain == domain {
                        out.insert(entry.key, entry.value);
                    }
                }
                Ok(out)
            })
        })
    }

    #[napi]
    pub fn metadata_domains(&self) -> Result<Vec<String>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| Ok(band.metadata_domains()))
        })
    }

    /// How many overview levels this band already has. Cheap: a query, not a
    /// computation. Zero is the common answer for a raster nobody ran `gdaladdo`
    /// over, and it is what `buildOverviews` is for.
    #[napi(getter)]
    pub fn overview_count(&self) -> Result<i32> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| band.overview_count().gdal())
        })
    }

    /// Min, max, mean and standard deviation.
    ///
    /// By default GDAL computes them on the spot if it has nothing cached, which
    /// on a large raster means reading the band once — use the async form for
    /// that. `approx: true` lets GDAL lean on overviews instead.
    ///
    /// Returns `null` only when `force: false` and there was no cached value to
    /// give back.
    #[napi]
    pub fn statistics_sync(
        &self,
        options: Option<StatisticsOptions>,
    ) -> Result<Option<BandStatistics>> {
        self.compute_statistics(statistics_request(options))
    }

    #[napi(ts_return_type = "Promise<BandStatistics | null>")]
    pub fn statistics(&self, options: Option<StatisticsOptions>) -> AsyncTask<StatisticsTask> {
        AsyncTask::new(StatisticsTask {
            dataset: self.dataset.clone(),
            index: self.index,
            request: statistics_request(options),
        })
    }

    /// Count samples per bucket across `[min, max)`.
    ///
    /// `min`, `max` and `buckets` are all required, because GDAL requires them —
    /// `statistics()` hands back the pair to use. Values outside the range are
    /// dropped unless `includeOutOfRange` folds them into the end buckets, so
    /// `counts` does not necessarily sum to the pixel count.
    #[napi]
    pub fn histogram_sync(&self, options: HistogramOptions) -> Result<BandHistogram> {
        self.compute_histogram(histogram_request(options)?)
    }

    #[napi(ts_return_type = "Promise<BandHistogram>")]
    pub fn histogram(&self, options: HistogramOptions) -> Result<AsyncTask<HistogramTask>> {
        // Resolved here rather than in `compute`, so a bad range or bucket count
        // is thrown by the call instead of surfacing as a rejected promise.
        let request = histogram_request(options)?;
        Ok(AsyncTask::new(HistogramTask {
            dataset: self.dataset.clone(),
            index: self.index,
            request,
        }))
    }

    /// The default histogram GDAL has stored for this band, or `null` when there
    /// is none.
    ///
    /// This is the *stored* histogram, not one computed now: `histogram()`
    /// computes, `defaultHistogram()` reads what an earlier `setDefaultHistogram`
    /// — or the format itself — left behind. `force: true` lets GDAL compute one
    /// if nothing is stored, which reads the whole band, hence the default of
    /// `false`.
    #[napi]
    pub fn default_histogram(&self, force: Option<bool>) -> Result<Option<BandHistogram>> {
        ensure_initialized();
        let force = force.unwrap_or(false);
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let Some(histogram) = band.default_histogram(force).gdal()? else {
                    return Ok(None);
                };
                Ok(Some(BandHistogram {
                    min: histogram.min(),
                    max: histogram.max(),
                    counts: counts_as_u32(histogram.counts())?,
                }))
            })
        })
    }

    /// Write a histogram into the dataset, so a later reader does not have to
    /// compute one — the counterpart of `setStatistics`.
    ///
    /// `counts` is one count per bucket, in range order, and `min`/`max` are the
    /// range those buckets span — exactly the shape `histogram()` and
    /// `defaultHistogram()` return. The same caveat as `setStatistics` applies: a
    /// read-only handle does not fail, because GDAL's PAM layer writes to a
    /// `<file>.aux.xml` sidecar instead.
    #[napi]
    pub fn set_default_histogram(&self, histogram: BandHistogram) -> Result<()> {
        ensure_initialized();
        if histogram.counts.is_empty() {
            return Err(bad_argument("a histogram needs at least one bucket"));
        }
        check_range(histogram.min, histogram.max)?;

        // GDAL reads this as a mutable slice but does not write to it.
        let mut counts = histogram
            .counts
            .iter()
            .map(|count| u64::from(*count))
            .collect::<Vec<u64>>();

        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                band.set_default_histogram(histogram.min, histogram.max, &mut counts)
                    .gdal()
            })
        })
    }

    /// Write statistics into the dataset, so a later reader does not have to
    /// compute them: `statistics({ force: false })` then hands back exactly these
    /// numbers, and other GDAL tools see them too.
    ///
    /// A dataset open for update stores them in the file when the driver keeps
    /// band metadata there (GTiff, COG, GPKG, MEM). A read-only handle does not
    /// fail: GDAL's PAM layer writes them to a `<file>.aux.xml` sidecar next to
    /// the raster instead, which is worth knowing before pointing this at a
    /// directory you thought was read-only.
    #[napi]
    pub fn set_statistics(&self, statistics: BandStatistics) -> Result<()> {
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| {
                unsafe {
                    gdal_sys::GDALSetRasterStatistics(
                        band.c_rasterband(),
                        statistics.min,
                        statistics.max,
                        statistics.mean,
                        statistics.std_dev,
                    );
                }

                // GDALSetRasterStatistics returns nothing, so a driver that keeps
                // nothing reports nothing. Reading the value back is the only
                // reliable check — with `force` off that is a metadata lookup
                // rather than a pass over the pixels.
                if band.get_statistics(false, false).gdal()?.is_none() {
                    return Err(bad_argument(
                        "the driver did not keep the statistics — not every format stores band metadata",
                    ));
                }

                Ok(())
            })
        })
    }

    /// GDAL's checksum of a window of this band: a 16-bit fingerprint of the
    /// samples, the same number `gdalinfo` prints. Two rasters that agree here hold
    /// the same samples there.
    ///
    /// The window defaults to the whole band. `resampling`, `outWidth` and
    /// `outHeight` are refused rather than ignored, because a checksum is of the
    /// samples as they are and silently resampling into it would change the number
    /// for no reason anyone asked for.
    #[napi]
    pub fn checksum_sync(&self, options: Option<ReadOptions>) -> Result<u32> {
        self.compute_checksum(&checksum_options(options)?)
    }

    /// The same, on the thread pool: a checksum of a large raster reads all of it,
    /// so it costs what a read costs.
    #[napi(ts_return_type = "Promise<number>")]
    pub fn checksum(&self, options: Option<ReadOptions>) -> Result<AsyncTask<ChecksumTask>> {
        let options = checksum_options(options)?;
        Ok(AsyncTask::new(ChecksumTask {
            dataset: self.dataset.clone(),
            index: self.index,
            options,
        }))
    }

    /// Fill this band's no-data pixels from their neighbours — GDAL's
    /// `GDALFillNodata`, the algorithm behind `gdal_fillnodata.py`.
    ///
    /// It works in place, so the dataset has to be writable, and the band needs a
    /// no-data value: without one there is no telling a hole from data, and that is
    /// reported rather than guessed at.
    #[napi]
    pub fn fill_no_data_sync(&self, options: Option<FillNoDataOptions>) -> Result<()> {
        self.apply_fill_no_data(fill_nodata_request(options)?)
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn fill_no_data(
        &self,
        options: Option<FillNoDataOptions>,
    ) -> Result<AsyncTask<FillNoDataTask>> {
        // Resolved here, so a bad distance is thrown by the call rather than
        // surfacing on the worker.
        let request = fill_nodata_request(options)?;
        Ok(AsyncTask::new(FillNoDataTask {
            dataset: self.dataset.clone(),
            index: self.index,
            request,
        }))
    }

    /// Remove connected regions smaller than `threshold` pixels — GDAL's
    /// `GDALSieveFilter`, the algorithm behind `gdal_sieve.py`. A region that is
    /// too small takes the value of its largest neighbour.
    ///
    /// It runs in place: this band is both source and destination, so the dataset
    /// has to be writable.
    ///
    /// ```js
    /// band.sieveFilterSync({ threshold: 10 })                        // 4-connected
    /// band.sieveFilterSync({ threshold: 10, connectedness: 8 })
    /// ```
    #[napi]
    pub fn sieve_filter_sync(&self, options: SieveFilterOptions) -> Result<()> {
        self.apply_sieve_filter(sieve_filter_request(options)?)
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn sieve_filter(&self, options: SieveFilterOptions) -> Result<AsyncTask<SieveFilterTask>> {
        let request = sieve_filter_request(options)?;
        Ok(AsyncTask::new(SieveFilterTask {
            dataset: self.dataset.clone(),
            index: self.index,
            request,
        }))
    }

    /// Turn this band's values into polygons in `layer` — GDAL's `GDALPolygonize`,
    /// the algorithm behind `gdal_polygonize.py`. A float band goes through
    /// `GDALFPolygonize` and a `Real` field instead, which is the pair GDAL's own
    /// tool chooses between.
    ///
    /// The values land in a field called `fieldName` (default `DN`), created when
    /// the layer does not have one. `layer` will usually belong to a *different*
    /// dataset from this band, and that dataset has to be writable.
    ///
    /// ```js
    /// raster.band(0).polygonizeSync(layer)     // 4-connected, into the field `DN`
    /// await raster.band(0).polygonize(layer, { connectedness: 8, fieldName: 'value' })
    /// ```
    #[napi]
    pub fn polygonize_sync(
        &self,
        layer: &JsLayer,
        options: Option<PolygonizeOptions>,
    ) -> Result<()> {
        let request = polygonize_request(options)?;
        // Both datasets at once: the process-wide lock is not reentrant, so the band
        // and the layer cannot each be reached through their own lock.
        with_two(&self.dataset, layer.dataset(), |raster, vector| {
            let band = raster.rasterband(self.index + 1).gdal()?;
            let mut target = vector.layer(layer.index() as usize).gdal()?;
            polygonize(&band, &mut target, &request)
        })
    }

    /// The same, on the thread pool: polygonizing reads the whole band and writes
    /// features.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn polygonize(
        &self,
        layer: &JsLayer,
        options: Option<PolygonizeOptions>,
    ) -> Result<AsyncTask<PolygonizeTask>> {
        let request = polygonize_request(options)?;
        Ok(AsyncTask::new(PolygonizeTask {
            dataset: self.dataset.clone(),
            // The layer's dataset travels along, because the layer will usually live
            // in a dataset other than this band's.
            layer: layer.dataset().clone(),
            layer_index: layer.index() as usize,
            index: self.index,
            request,
        }))
    }

    /// Draw contour lines for this band into `layer` — GDAL's
    /// `GDALContourGenerateEx`, the call behind `gdal_contour`.
    ///
    /// Give `levels` (`[0, 100, 200]`) or an `interval` (with an optional `base`),
    /// not both. The elevations land in `elevField` (default `ELEV`), and `idField`
    /// names a field to put a per-line id in if you want one — both are created when
    /// the layer does not have them.
    ///
    /// The band wants a geotransform, and the **layer** is what carries the CRS, so
    /// the lines come out in the layer's coordinate system. It will usually be a
    /// LineString layer in a different dataset from this band, and it has to be
    /// writable.
    ///
    /// ```js
    /// band.contourGenerateSync(layer, { levels: [0, 100, 200, 300] })
    /// await band.contourGenerate(layer, { interval: 50, base: 0, idField: 'id' })
    /// ```
    #[napi]
    pub fn contour_generate_sync(
        &self,
        layer: &JsLayer,
        options: Option<ContourGenerateOptions>,
    ) -> Result<()> {
        let request = contour_generate_request(options)?;
        with_two(&self.dataset, layer.dataset(), |raster, vector| {
            let band = raster.rasterband(self.index + 1).gdal()?;
            let mut target = vector.layer(layer.index() as usize).gdal()?;
            contour_generate(&band, &mut target, &request)
        })
    }

    /// The same, on the thread pool: contouring reads the whole band and writes a
    /// feature per line.
    #[napi(ts_return_type = "Promise<void>")]
    pub fn contour_generate(
        &self,
        layer: &JsLayer,
        options: Option<ContourGenerateOptions>,
    ) -> Result<AsyncTask<ContourGenerateTask>> {
        let request = contour_generate_request(options)?;
        Ok(AsyncTask::new(ContourGenerateTask {
            dataset: self.dataset.clone(),
            layer: layer.dataset().clone(),
            layer_index: layer.index() as usize,
            index: self.index,
            request,
        }))
    }

    /// Both sync reads, with or without a destination — `options.into` chooses. A
    /// destination is returned as it came in, which is the same object.
    fn read_sync_any(&self, target: Option<DataType>, mut options: ReadOptions) -> Result<Buffer> {
        match options.into.take() {
            Some(mut into) => {
                self.read_into_sync(target, &options, into.as_mut())?;
                Ok(into)
            }
            None => Ok(self.read_sync(target, &options)?.into()),
        }
    }

    /// Read in the band's own sample type, with no conversion. The returned
    /// buffer is the raw little-endian bytes of `width * height` samples; use
    /// `bytesPerSample(band.dataType)` to view it as a typed array.
    ///
    /// With `options.into` the read writes through that buffer instead of allocating
    /// one, and hands it straight back.
    #[napi]
    pub fn read_pixels_sync(&self, options: Option<ReadOptions>) -> Result<Buffer> {
        self.read_sync_any(None, options.unwrap_or_default())
    }

    /// Read, asking GDAL to convert to `data_type`.
    #[napi]
    pub fn read_as_sync(
        &self,
        data_type: DataType,
        options: Option<ReadOptions>,
    ) -> Result<Buffer> {
        self.read_sync_any(Some(data_type), options.unwrap_or_default())
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn read_pixels(&self, options: Option<ReadOptions>) -> AsyncTask<ReadBandTask> {
        ReadBandTask::new(self.dataset.clone(), self.index, None, options)
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn read_as(
        &self,
        data_type: DataType,
        options: Option<ReadOptions>,
    ) -> AsyncTask<ReadBandTask> {
        ReadBandTask::new(self.dataset.clone(), self.index, Some(data_type), options)
    }

    /// Write raw sample bytes into a window. `data` must hold at least
    /// `width * height` samples of this band's sample type (`outWidth` /
    /// `outHeight` are ignored: GDAL does not resample on write).
    #[napi]
    pub fn write_pixels_sync(&self, data: Buffer, options: Option<ReadOptions>) -> Result<()> {
        let options = options.unwrap_or_default();
        self.write_sync(data.as_ref(), &options)
    }

    /// Fill the whole band with a constant value — GDAL's `GDALFillRaster`, the
    /// cheap way to initialise or reset a raster without building a buffer for
    /// every sample.
    ///
    /// There is no imaginary component: this binding has no complex sample type,
    /// so GDAL is always asked for a real fill.
    #[napi]
    pub fn fill(&self, value: f64) -> Result<()> {
        self.dataset.with_mut(|dataset| {
            with_band(dataset, self.index, |band| band.fill(value, None).gdal())
        })
    }

    #[napi(ts_return_type = "Promise<void>")]
    pub fn write_pixels(
        &self,
        data: Buffer,
        options: Option<ReadOptions>,
    ) -> AsyncTask<WriteBandTask> {
        AsyncTask::new(WriteBandTask {
            dataset: self.dataset.clone(),
            index: self.index,
            data_type: self.data_type,
            options: options.unwrap_or_default(),
            data: data.to_vec(),
        })
    }

    /// One sample, as a JS number, read in the band's own type.
    ///
    /// The two 64-bit integers are not exact here — a JS number is a double — so this
    /// is for the types JS has always held. `readValues` is the one that gives
    /// `BigInt` for those, rather than rounding them.
    ///
    /// A window outside the band is an error, not zeroes: the window is checked
    /// against the band before GDAL is asked, and what does not fit is reported.
    #[napi]
    pub fn get_pixel(&self, x: u32, y: u32) -> Result<f64> {
        let bytes = self.read_sync(None, &window(x, y, 1, 1))?;
        sample_as_number(&bytes, self.data_type)
    }

    /// Write one sample from a JS number. The value is converted to the band's type,
    /// so out-of-range integers wrap as GDAL wraps them.
    #[napi]
    pub fn set_pixel(&self, x: u32, y: u32, value: f64) -> Result<()> {
        let bytes = number_as_sample(value, self.data_type)?;
        self.write_sync(&bytes, &window(x, y, 1, 1))
    }

    /// Read a window of samples in the band's own type, as bytes — `readPixelsSync`
    /// with the window given as four numbers instead of an options object.
    ///
    /// Bytes rather than the typed array this was meant to return. napi's typed
    /// arrays are worth reading about twice before trying: the ones its prelude
    /// exports are owned and have no constructor from Rust data, while the ones that
    /// do have `from_data(&env, values)` borrow the environment — which does not
    /// survive this binding's generated return types. `BigInt64Array` is not even in
    /// the prelude. So the view stays where this binding has always put it, one line
    /// on the JS side: `new Float32Array(bytes.buffer, bytes.byteOffset,
    /// bytes.byteLength / 4)`.
    #[napi]
    pub fn read_values(&self, x: u32, y: u32, width: u32, height: u32) -> Result<Buffer> {
        let bytes = self.read_sync(None, &window(x, y, width, height))?;
        Ok(bytes.into())
    }

    /// Write a window from raw sample bytes — `width * height` samples of this band's
    /// own type, the layout `readPixelsSync` returns.
    ///
    /// Bytes rather than a typed array, because every typed array is one line away
    /// from its bytes (`Buffer.from(values.buffer, values.byteOffset, values.byteLength)`)
    /// and one method that takes all ten of them would be ten signatures to read.
    #[napi]
    pub fn write_values(
        &self,
        x: u32,
        y: u32,
        width: u32,
        height: u32,
        data: Buffer,
    ) -> Result<()> {
        self.write_sync(data.as_ref(), &window(x, y, width, height))
    }

    /// Read the block of samples holding `(x, y)` — GDAL's own unit of I/O, and the
    /// read that has to happen anyway.
    ///
    /// The window is the block's rectangle *clipped to the band*, so along the right
    /// and bottom edges it is smaller than `blockSize`. GDAL's own block read pads
    /// those with whatever it likes; a value that was never in the file is not worth
    /// handing to JS, so it is left out instead.
    #[napi]
    pub fn read_block(&self, x: u32, y: u32) -> Result<Buffer> {
        let options = self.block_window(x, y)?;
        let bytes = self.read_sync(None, &options)?;
        Ok(bytes.into())
    }

    /// Write into the block holding `(x, y)`, clipped to the band the same way
    /// `readBlock` reads. `data` has to hold the whole clipped block: no resampling
    /// and no partial writes.
    #[napi]
    pub fn write_block(&self, x: u32, y: u32, data: Buffer) -> Result<()> {
        let options = self.block_window(x, y)?;
        self.write_sync(data.as_ref(), &options)
    }

    /// Walk the band in horizontal strips, handing each one to `onChunk` and reading
    /// the next only once that call has come back.
    ///
    /// The answer *is* the backpressure: return `false` and the walk stops, the same
    /// contract `onProgress` has. The strips are the band's own samples in its own
    /// type, so a raster larger than memory can be processed a strip at a time, with
    /// every strip whole — never a partial one. `rows` defaults to the band's block
    /// height, the strip GDAL reads anyway. The return value is how many strips were
    /// handed out.
    ///
    /// This one is synchronous: the callback runs on this thread, between reads, so
    /// the walk holds the event loop for its duration. That is the price of not using
    /// napi's async-iterator support, which is behind an experimental feature and
    /// cannot be named from here at all — for a long walk, run it in a worker.
    #[napi]
    pub fn read_chunks_sync(
        &self,
        options: Option<ChunkOptions>,
        on_chunk: napi::bindgen_prelude::Function<Chunk, bool>,
    ) -> Result<u32> {
        let plan = self.chunk_plan(&options.unwrap_or_default())?;

        let mut handed_out = 0;
        let mut next_row = plan.top;
        while next_row < plan.bottom {
            let rows = plan.rows.min(plan.bottom - next_row);
            let bytes = self.read_sync(None, &window(plan.left, next_row, plan.width, rows))?;
            handed_out += 1;
            let keep_going = on_chunk
                .call(Chunk {
                    data: bytes.into(),
                    x: plan.left,
                    y: next_row,
                    width: plan.width,
                    height: rows,
                })
                // A callback that throws ends the walk, and there is no `CPLErr`
                // behind a JS exception to report — its own message is the whole
                // story, so it is carried over rather than swallowed.
                .map_err(|error| bad_argument(format!("the chunk callback threw: {error}")))?;
            if !keep_going {
                break;
            }
            next_row += rows;
        }
        Ok(handed_out)
    }

    /// This band's overview levels, as they were built — `[]` when there are none.
    ///
    /// Indexing the array is the `overviews.get(i)` of the GDAL API. A level is not a
    /// view of this band: it is the decimation that was recorded, at its own size,
    /// and reading it gives the pixels that were stored rather than a fresh
    /// resampling — `readPixels({ outWidth, outHeight })` makes GDAL *pick* a level
    /// and resample through it instead.
    #[napi(getter)]
    pub fn overviews(&self) -> Result<Vec<JsBandOverview>> {
        self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let count = band.overview_count().gdal()?;
                (0..count as usize)
                    .map(|level| overview_level(band, &self.dataset, self.index, level))
                    .collect()
            })
        })
    }
}

/// The rectangle of the block that holds `(x, y)`, clipped to the band.
impl JsRasterBand {
    fn block_window(&self, x: u32, y: u32) -> Result<ReadOptions> {
        let (block_width, block_height) = self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.block_size();
                Ok((width as u32, height as u32))
            })
        })?;
        let (band_width, band_height) = self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                Ok((width as u32, height as u32))
            })
        })?;

        // GDAL's blocks are laid out from the band's origin, so the one holding a
        // sample starts at the largest multiple of the block size at or below it.
        let left = x - x % block_width;
        let top = y - y % block_height;
        Ok(window(
            left,
            top,
            block_width.min(band_width.saturating_sub(left)),
            block_height.min(band_height.saturating_sub(top)),
        ))
    }
}

/// A `ReadOptions` for one window, which is all the accessors above need.
fn window(x: u32, y: u32, width: u32, height: u32) -> ReadOptions {
    ReadOptions {
        x: Some(x),
        y: Some(y),
        width: Some(width),
        height: Some(height),
        ..ReadOptions::default()
    }
}

/// One overview level of a band — see `band.overviews`.
///
/// Reading one is raw `GDALRasterIO`, in the glue below. The `gdal` crate's readers
/// start from a dataset and a band number, and an overview has neither: it hangs off
/// a band rather than off the dataset, and no band number reaches it.
#[napi(js_name = "BandOverview")]
pub struct JsBandOverview {
    dataset: DatasetRef,
    index: usize,
    level: usize,
    width: u32,
    height: u32,
    data_type: DataType,
}

#[napi]
impl JsBandOverview {
    /// **0-based**, as GDAL counts a band's overviews.
    #[napi(getter)]
    pub fn index(&self) -> u32 {
        self.level as u32
    }

    /// Size of the level in pixels: `[width, height]`.
    #[napi(getter)]
    pub fn size(&self) -> Vec<u32> {
        vec![self.width, self.height]
    }

    /// The level's sample type, which is the band's.
    #[napi(getter)]
    pub fn data_type(&self) -> DataType {
        self.data_type
    }

    /// Read the whole level, in its own sample type, as raw bytes.
    #[napi]
    pub fn read_sync(&self) -> Result<Buffer> {
        let bytes = self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                read_overview_bytes(band, self.level)
            })
        })?;
        Ok(bytes.into())
    }

    /// The same read on the thread pool. A level is small next to its band, but it is
    /// still every pixel in it.
    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn read(&self) -> AsyncTask<ReadOverviewTask> {
        AsyncTask::new(ReadOverviewTask {
            dataset: self.dataset.clone(),
            index: self.index,
            level: self.level,
        })
    }
}

pub struct ReadOverviewTask {
    dataset: DatasetRef,
    index: usize,
    level: usize,
}

impl Task for ReadOverviewTask {
    type Output = OpResult<Vec<u8>>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let ReadOverviewTask {
            dataset,
            index,
            level,
        } = self;
        Ok(op(dataset.with_exclusive(|dataset| {
            with_band(dataset, *index, |band| read_overview_bytes(band, *level))
        })))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(Buffer::from)
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Describe one overview level of `band`.
fn overview_level(
    band: &mut RasterBand<'_>,
    dataset: &DatasetRef,
    index: usize,
    level: usize,
) -> Result<JsBandOverview> {
    let overview = overview_band(band, level)?;
    let (width, height) = unsafe {
        (
            gdal_sys::GDALGetRasterBandXSize(overview) as u32,
            gdal_sys::GDALGetRasterBandYSize(overview) as u32,
        )
    };
    Ok(JsBandOverview {
        dataset: dataset.clone(),
        index,
        level,
        width,
        height,
        // A level is built with its band's sample type — GDAL has no way to make one
        // with a different type — so the band's own is the level's, and it is already
        // the binding's `DataType` rather than a raw GDAL enum value.
        data_type: DataType::from_gdal(band.band_type()),
    })
}

/// The level's band handle. GDAL owns it, so it is looked up per call rather than
/// held — which also means nothing here has to outlive the dataset that owns it.
fn overview_band(band: &mut RasterBand<'_>, level: usize) -> Result<gdal_sys::GDALRasterBandH> {
    let overview = unsafe { gdal_sys::GDALGetOverview(band.c_rasterband(), level as i32) };
    if overview.is_null() {
        return Err(bad_argument(format!(
            "this band has no overview level {level}"
        )));
    }
    Ok(overview)
}

/// Read one level whole, in the level's own sample type.
fn read_overview_bytes(band: &mut RasterBand<'_>, level: usize) -> Result<Vec<u8>> {
    let overview = overview_band(band, level)?;
    let (width, height) = unsafe {
        (
            gdal_sys::GDALGetRasterBandXSize(overview),
            gdal_sys::GDALGetRasterBandYSize(overview),
        )
    };
    let data_type = unsafe { gdal_sys::GDALGetRasterDataType(overview) };
    let sample_bytes =
        crate::dtype::bytes_per_sample(DataType::from_gdal(band.band_type())) as usize;

    let mut bytes = vec![0u8; width as usize * height as usize * sample_bytes];
    let class = unsafe {
        gdal_sys::GDALRasterIO(
            overview,
            gdal_sys::GDALRWFlag::GF_Read,
            0,
            0,
            width,
            height,
            bytes.as_mut_ptr().cast(),
            width,
            height,
            data_type,
            0,
            0,
        )
    };
    crate::raster_tools::cpl_result(class)?;
    Ok(bytes)
}

/// One strip of a band, as `readChunksSync` hands it over.
#[napi(object)]
pub struct Chunk {
    /// The band's samples, in its own type: `width * height` of them.
    pub data: Buffer,
    /// Where that strip sits in the band.
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// What `readChunksSync` takes for its window and its strips.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ChunkOptions {
    /// Left edge of the window, in pixels. Default 0.
    pub x: Option<u32>,
    /// Top edge of the window, in pixels. Default 0.
    pub y: Option<u32>,
    /// Width of the window. Default: to the right edge of the band.
    pub width: Option<u32>,
    /// Height of the window. Default: to the bottom edge of the band.
    pub height: Option<u32>,
    /// Rows in each strip. Default: the band's own block height.
    pub rows: Option<u32>,
}

/// A `readChunksSync` walk, worked out and checked before the first strip is read.
struct ChunkPlan {
    left: u32,
    width: u32,
    top: u32,
    bottom: u32,
    rows: u32,
}

impl JsRasterBand {
    fn chunk_plan(&self, options: &ChunkOptions) -> Result<ChunkPlan> {
        let (band_width, band_height, block_rows) = self.dataset.with_exclusive(|dataset| {
            with_band(dataset, self.index, |band| {
                let (width, height) = band.size();
                Ok((width, height, band.block_size().1))
            })
        })?;

        let left = options.x.unwrap_or(0) as usize;
        let top = options.y.unwrap_or(0) as usize;
        let width = options
            .width
            .map_or(band_width.saturating_sub(left), |value| value as usize);
        let height = options
            .height
            .map_or(band_height.saturating_sub(top), |value| value as usize);
        let rows = options.rows.map_or(block_rows, |value| value as usize);

        // The whole window is checked once, here, so a bad one fails on the call; the
        // strips the walk reads are then parts of a window that fits.
        crate::raster_io::resolve_window(
            &window(left as u32, top as u32, width as u32, height as u32),
            band_width,
            band_height,
        )?;

        Ok(ChunkPlan {
            left: left as u32,
            width: width as u32,
            top: top as u32,
            bottom: (top + height) as u32,
            rows: rows.max(1) as u32,
        })
    }
}

/// The ten sample types a band can have, and the two conversions a single sample
/// needs: a number out of one, and one out of a number.
///
/// A macro because the alternative is the same ten arms written twice, and because
/// the list is the one `DataType` carries — which is what keeps the two from drifting
/// apart without anyone noticing.
macro_rules! sample_types {
    ($($variant:ident => $rust:ty,)*) => {
        /// A sample read out of a raw window as a number, in the band's own type.
        fn sample_as_number(bytes: &[u8], data_type: DataType) -> Result<f64> {
            match data_type {
                $(DataType::$variant => {
                    let sample = <$rust>::from_ne_bytes(
                        bytes
                            .try_into()
                            .map_err(|_| bad_argument("exactly one sample"))?,
                    );
                    Ok(sample as f64)
                })*
                DataType::Unknown => Err(bad_argument("an unknown sample type")),
            }
        }

        /// A sample written from a number, in the band's own type. The cast is what
        /// GDAL does with the same value: a float truncates towards zero, and an
        /// integer wraps in two's complement.
        fn number_as_sample(value: f64, data_type: DataType) -> Result<Vec<u8>> {
            Ok(match data_type {
                $(DataType::$variant => (value as $rust).to_ne_bytes().to_vec(),)*
                DataType::Unknown => return Err(bad_argument("an unknown sample type")),
            })
        }
    };
}

sample_types!(
    Uint8 => u8,
    Int8 => i8,
    Uint16 => u16,
    Int16 => i16,
    Uint32 => u32,
    Int32 => i32,
    Uint64 => u64,
    Int64 => i64,
    Float32 => f32,
    Float64 => f64,
);

type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

pub struct ReadBandTask {
    dataset: DatasetRef,
    index: usize,
    target: Option<DataType>,
    options: ReadOptions,
    /// The caller's buffer, when the read was asked to fill one instead of allocating.
    /// GDAL writes through it on the worker, and it goes home as the object it came in
    /// as.
    into: Option<Buffer>,
}

/// What a read produced. `Reused` carries nothing, because the buffer is already on the
/// task — and has to stay there until `resolve` runs.
pub enum ReadOutput {
    Allocated(Vec<u8>),
    Reused,
}

impl ReadBandTask {
    fn new(
        dataset: DatasetRef,
        index: usize,
        target: Option<DataType>,
        options: Option<ReadOptions>,
    ) -> AsyncTask<Self> {
        // Taken out of the options here rather than on the worker: the buffer travels
        // with the task, not inside the description of the read.
        let mut options = options.unwrap_or_default();
        let into = options.into.take();
        AsyncTask::new(Self {
            dataset,
            index,
            target,
            options,
            into,
        })
    }
}

impl Task for ReadBandTask {
    type Output = OpResult<ReadOutput>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // `data_type` is only used when writing, so `Unknown` is fine here.
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(match self.into.as_mut() {
            Some(into) => band
                .read_into_sync(self.target, &self.options, into.as_mut())
                .map(|()| ReadOutput::Reused),
            None => band
                .read_sync(self.target, &self.options)
                .map(ReadOutput::Allocated),
        }))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        match output.map_err(|(code, reason)| into_status_error(code, reason))? {
            ReadOutput::Allocated(bytes) => Ok(bytes.into()),
            // A buffer that came from JS resolves back to that same object, so this is
            // the caller's own memory going home rather than a fresh view of it.
            ReadOutput::Reused => Ok(self
                .into
                .take()
                .expect("a read asked to fill a buffer keeps it until resolve")),
        }
    }
}

pub struct WriteBandTask {
    dataset: DatasetRef,
    index: usize,
    data_type: DataType,
    options: ReadOptions,
    data: Vec<u8>,
}

impl Task for WriteBandTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let band = JsRasterBand::new(self.dataset.clone(), self.index, self.data_type);
        Ok(op(band.write_sync(&self.data, &self.options)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Computing statistics reads the whole band when nothing is cached, so it earns
/// the thread pool more than most things here.
pub struct StatisticsTask {
    dataset: DatasetRef,
    index: usize,
    request: StatisticsRequest,
}

impl Task for StatisticsTask {
    type Output = OpResult<Option<BandStatistics>>;
    type JsValue = Option<BandStatistics>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // `data_type` only matters when writing; this path never does.
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(band.compute_statistics(self.request)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

pub struct HistogramTask {
    dataset: DatasetRef,
    index: usize,
    request: HistogramRequest,
}

impl Task for HistogramTask {
    type Output = OpResult<BandHistogram>;
    type JsValue = BandHistogram;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(band.compute_histogram(self.request)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// A checksum reads the whole window, which on a large raster is what a read costs,
/// so it earns the thread pool.
pub struct ChecksumTask {
    dataset: DatasetRef,
    index: usize,
    options: ReadOptions,
}

impl Task for ChecksumTask {
    type Output = OpResult<u32>;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // `data_type` only matters when writing; this path never does.
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(band.compute_checksum(&self.options)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Filling reads the band and writes it back, the same cost as a checksum of that
/// size — so it goes on the pool for the same reason.
pub struct FillNoDataTask {
    dataset: DatasetRef,
    index: usize,
    request: FillNoDataRequest,
}

impl Task for FillNoDataTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(band.apply_fill_no_data(self.request)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// The sieve reads and rewrites the band, so it is on the pool for the same reason
/// `FillNoDataTask` is.
pub struct SieveFilterTask {
    dataset: DatasetRef,
    index: usize,
    request: SieveFilterRequest,
}

impl Task for SieveFilterTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(band.apply_sieve_filter(self.request)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Polygonizing reads the whole band and writes features into another dataset's
/// layer, so it belongs on the pool.
pub struct PolygonizeTask {
    dataset: DatasetRef,
    /// The layer's own dataset: it is usually not the one the band is in.
    layer: DatasetRef,
    layer_index: usize,
    index: usize,
    request: PolygonizeRequest,
}

impl Task for PolygonizeTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let PolygonizeTask {
            dataset,
            layer,
            layer_index,
            index,
            request,
        } = self;
        let (index, layer_index) = (*index, *layer_index);

        Ok(op(with_two(dataset, layer, |raster, vector| {
            let band = raster.rasterband(index + 1).gdal()?;
            let mut target = vector.layer(layer_index).gdal()?;
            polygonize(&band, &mut target, request)
        })))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Contouring reads the whole band and writes a feature per line, into whichever
/// dataset holds the layer.
pub struct ContourGenerateTask {
    dataset: DatasetRef,
    /// The layer's own dataset, as in `PolygonizeTask`.
    layer: DatasetRef,
    layer_index: usize,
    index: usize,
    request: ContourGenerateRequest,
}

impl Task for ContourGenerateTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let ContourGenerateTask {
            dataset,
            layer,
            layer_index,
            index,
            request,
        } = self;
        let (index, layer_index) = (*index, *layer_index);

        Ok(op(with_two(dataset, layer, |raster, vector| {
            let band = raster.rasterband(index + 1).gdal()?;
            let mut target = vector.layer(layer_index).gdal()?;
            contour_generate(&band, &mut target, request)
        })))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}
