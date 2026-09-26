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
use crate::error::{GdalErrorCode, IntoGdalResult, Result, into_status_error, split};
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

    #[napi]
    pub fn read_pixels(&self, options: Option<ReadOptions>) -> AsyncTask<ReadBandTask> {
        AsyncTask::new(ReadBandTask {
            dataset: self.dataset.clone(),
            index: self.index,
            target: None,
            options: options.unwrap_or_default(),
        })
    }

    #[napi]
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

    #[napi]
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
