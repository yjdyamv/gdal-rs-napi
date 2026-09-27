//! `RasterBand`. Holds only a dataset handle plus this band's index, so it never
//! owns GDAL memory and cannot outlive the dataset behind its back.
//!
//! Pixel reads go through [`DatasetRef::with`], which is the one access path that
//! runs in parallel for a thread-safe dataset. Everything else uses
//! [`DatasetRef::with_exclusive`] (or `with_mut` when it writes).

use std::collections::HashMap;

use gdal::Dataset as GdalDataset;
use gdal::Metadata;
use gdal::raster::RasterBand;
use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::dataset::DatasetRef;
use crate::dtype::DataType;
use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, into_status_error, split};
use crate::raster_io::{ReadOptions, read_window, resample_alg, resolve_window, write_window};
use crate::runtime::ensure_initialized;

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
    // Written as a positive test because NaN fails every comparison: `min < max`
    // alone would let a NaN through, and so would any negated form of it.
    let increasing =
        options.min.is_finite() && options.max.is_finite() && options.min < options.max;
    if !increasing {
        return Err(bad_argument(format!(
            "a histogram range must be finite and increasing, but min={} and max={}",
            options.min, options.max
        )));
    }
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

                // GDAL's own bucket counts are C `int`, so a u32 is lossless —
                // and a failure here would mean a bucket holding more than four
                // billion samples, which is worth reporting rather than truncating.
                let counts = histogram
                    .counts()
                    .iter()
                    .map(|count| {
                        u32::try_from(*count).map_err(|_| {
                            bad_argument(format!(
                                "a histogram bucket counted {count} samples, which does not fit in \
                                 a 32-bit integer"
                            ))
                        })
                    })
                    .collect::<Result<Vec<u32>>>()?;

                Ok(BandHistogram {
                    min: histogram.min(),
                    max: histogram.max(),
                    counts,
                })
            })
        })
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

    fn write_sync(&self, data: &[u8], options: &ReadOptions) -> Result<()> {
        ensure_initialized();
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

    /// Read in the band's own sample type, with no conversion. The returned
    /// buffer is the raw little-endian bytes of `width * height` samples; use
    /// `bytesPerSample(band.dataType)` to view it as a typed array.
    #[napi]
    pub fn read_pixels_sync(&self, options: Option<ReadOptions>) -> Result<Buffer> {
        let options = options.unwrap_or_default();
        let bytes = self.read_sync(None, &options)?;
        Ok(bytes.into())
    }

    /// Read, asking GDAL to convert to `data_type`.
    #[napi]
    pub fn read_as_sync(
        &self,
        data_type: DataType,
        options: Option<ReadOptions>,
    ) -> Result<Buffer> {
        let options = options.unwrap_or_default();
        let bytes = self.read_sync(Some(data_type), &options)?;
        Ok(bytes.into())
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn read_pixels(&self, options: Option<ReadOptions>) -> AsyncTask<ReadBandTask> {
        AsyncTask::new(ReadBandTask {
            dataset: self.dataset.clone(),
            index: self.index,
            target: None,
            options: options.unwrap_or_default(),
        })
    }

    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn read_as(
        &self,
        data_type: DataType,
        options: Option<ReadOptions>,
    ) -> AsyncTask<ReadBandTask> {
        AsyncTask::new(ReadBandTask {
            dataset: self.dataset.clone(),
            index: self.index,
            target: Some(data_type),
            options: options.unwrap_or_default(),
        })
    }

    /// Write raw sample bytes into a window. `data` must hold at least
    /// `width * height` samples of this band's sample type (`outWidth` /
    /// `outHeight` are ignored: GDAL does not resample on write).
    #[napi]
    pub fn write_pixels_sync(&self, data: Buffer, options: Option<ReadOptions>) -> Result<()> {
        let options = options.unwrap_or_default();
        self.write_sync(data.as_ref(), &options)
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
}

type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

pub struct ReadBandTask {
    dataset: DatasetRef,
    index: usize,
    target: Option<DataType>,
    options: ReadOptions,
}

impl Task for ReadBandTask {
    type Output = OpResult<Vec<u8>>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        // `data_type` is only used when writing, so `Unknown` is fine here.
        let band = JsRasterBand::new(self.dataset.clone(), self.index, DataType::Unknown);
        Ok(op(band.read_sync(self.target, &self.options)))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(Buffer::from)
            .map_err(|(code, reason)| into_status_error(code, reason))
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
