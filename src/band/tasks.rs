//! The raster band's `napi::Task` types and the overview read helpers they
//! use. Split out of the napi surface so that file is the surface alone.

use super::*;

pub struct ReadOverviewTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) level: usize,
}

impl Task for ReadOverviewTask {
    type Output = OpResult<Vec<u8>>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let ReadOverviewTask {
                dataset,
                kind,
                level,
            } = self;
            Ok(op(dataset.with(|dataset| {
                with_band(dataset, *kind, |band| read_overview_bytes(band, *level))
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(Buffer::from)
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Describe one overview level of `band`.
pub(crate) fn overview_level(
    band: &mut RasterBand<'_>,
    dataset: &DatasetRef,
    kind: BandKind,
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
        kind,
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
pub(crate) fn overview_band(
    band: &mut RasterBand<'_>,
    level: usize,
) -> Result<gdal_sys::GDALRasterBandH> {
    let overview = unsafe { gdal_sys::GDALGetOverview(band.c_rasterband(), level as i32) };
    if overview.is_null() {
        return Err(bad_argument(format!(
            "this band has no overview level {level}"
        )));
    }
    Ok(overview)
}

/// Read one level whole, in the level's own sample type.
pub(crate) fn read_overview_bytes(band: &mut RasterBand<'_>, level: usize) -> Result<Vec<u8>> {
    let overview = overview_band(band, level)?;
    let (width, height) = unsafe {
        (
            gdal_sys::GDALGetRasterBandXSize(overview),
            gdal_sys::GDALGetRasterBandYSize(overview),
        )
    };
    let data_type = unsafe { gdal_sys::GDALGetRasterDataType(overview) };
    // Size the buffer from the overview's own GDAL type code, not from the binding's
    // `DataType`: that enum has no complex or half-float variants and folds them into
    // `Unknown`, whose `size()` is one byte — so a complex level would be
    // under-allocated and `GDALRasterIO` would write past the buffer.
    // `GDALGetDataTypeSizeBytes` is GDAL's own answer for every code, complex included.
    let sample_bytes = unsafe { gdal_sys::GDALGetDataTypeSizeBytes(data_type) };
    if sample_bytes <= 0 {
        return Err(bad_argument(
            "this overview's sample type has no byte size GDAL can report",
        ));
    }
    let sample_bytes = sample_bytes as usize;

    // `checked_mul` rather than `*`: an overview large enough to overflow `usize` is
    // refused, not wrapped into a small allocation the read would then overrun.
    let len = (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(sample_bytes))
        .ok_or_else(|| bad_argument("this overview is too large to read in one piece"))?;
    let mut bytes = vec![0u8; len];
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
pub struct ReadBandTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) target: Option<DataType>,
    pub(crate) options: ReadOptions,
    /// The caller's buffer, when the read was asked to fill one instead of allocating.
    /// GDAL writes through it on the worker, and it goes home as the object it came in
    /// as.
    pub(crate) into: Option<Buffer>,
    /// Keeps this read's claim on `into`'s memory until the task is done, so a second
    /// read into the same buffer is refused rather than raced.
    pub(crate) reservation: Option<IntoReservation>,
}

/// What a read produced. `Reused` carries nothing, because the buffer is already on the
/// task — and has to stay there until `resolve` runs.
pub enum ReadOutput {
    Allocated(Vec<u8>),
    Reused,
}

impl ReadBandTask {
    /// The task for a read, or an error when its `into` buffer is already being filled.
    ///
    /// The claim is taken here, on the JS thread, so a second read into the same buffer
    /// is refused by the call that asks for it rather than by a promise that rejects
    /// later. Argument mistakes on this surface are thrown synchronously (`readPixels`
    /// with a wrongly-sized `into` rejects only because the size is resolved on the
    /// worker), and this is one of them.
    pub(crate) fn new(
        dataset: DatasetRef,
        kind: BandKind,
        target: Option<DataType>,
        options: Option<ReadOptions>,
    ) -> Result<AsyncTask<Self>> {
        // Taken out of the options here rather than on the worker: the buffer travels
        // with the task, not inside the description of the read.
        let mut options = options.unwrap_or_default();
        let into = options.into.take();
        let reservation = into.as_deref().map(reserve_into).transpose()?.flatten();
        Ok(AsyncTask::new(Self {
            dataset,
            kind,
            target,
            options,
            into,
            reservation,
        }))
    }
}

impl Task for ReadBandTask {
    type Output = OpResult<ReadOutput>;
    type JsValue = Buffer;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            // `data_type` is only used when writing, so `Unknown` is fine here.
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(match self.into.as_mut() {
                Some(into) => band
                    .read_into_sync(self.target, &self.options, into.as_mut())
                    .map(|()| ReadOutput::Reused),
                None => band
                    .read_sync(self.target, &self.options)
                    .map(ReadOutput::Allocated),
            }))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        // The read is done, so the buffer is free for the next one. Released here rather
        // than in `Drop` so it is free by the time the promise settles — `Drop` is the
        // backstop for a task that never reaches this.
        self.reservation.take();
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
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) data_type: DataType,
    pub(crate) options: ReadOptions,
    pub(crate) data: Vec<u8>,
}

impl Task for WriteBandTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, self.data_type);
            Ok(op(band.write_sync(&self.data, &self.options)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Computing statistics reads the whole band when nothing is cached, so it earns
/// the thread pool more than most things here.
pub struct StatisticsTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) request: StatisticsRequest,
}

impl Task for StatisticsTask {
    type Output = OpResult<Option<BandStatistics>>;
    type JsValue = Option<BandStatistics>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            // `data_type` only matters when writing; this path never does.
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.compute_statistics(self.request)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

pub struct HistogramTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) request: HistogramRequest,
}

impl Task for HistogramTask {
    type Output = OpResult<BandHistogram>;
    type JsValue = BandHistogram;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.compute_histogram(self.request)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// A checksum reads the whole window, which on a large raster is what a read costs,
/// so it earns the thread pool.
pub struct ChecksumTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) options: ReadOptions,
}

impl Task for ChecksumTask {
    type Output = OpResult<u32>;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            // `data_type` only matters when writing; this path never does.
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.compute_checksum(&self.options)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Filling reads the band and writes it back, the same cost as a checksum of that
/// size — so it goes on the pool for the same reason.
pub struct FillNoDataTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) request: FillNoDataRequest,
}

impl Task for FillNoDataTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.apply_fill_no_data(self.request)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// The sieve reads and rewrites the band, so it is on the pool for the same reason
/// `FillNoDataTask` is.
pub struct SieveFilterTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) request: SieveFilterRequest,
}

impl Task for SieveFilterTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.apply_sieve_filter(self.request)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Polygonizing reads the whole band and writes features into another dataset's
/// layer, so it belongs on the pool.
pub struct PolygonizeTask {
    pub(crate) dataset: DatasetRef,
    /// The layer's own dataset: it is usually not the one the band is in.
    pub(crate) layer: DatasetRef,
    pub(crate) layer_index: usize,
    pub(crate) kind: BandKind,
    pub(crate) request: PolygonizeRequest,
}

impl Task for PolygonizeTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let PolygonizeTask {
                dataset,
                layer,
                layer_index,
                kind,
                request,
            } = self;
            let (kind, layer_index) = (*kind, *layer_index);

            Ok(op(with_two(dataset, layer, |raster, vector| {
                let mut target = vector.layer(layer_index).gdal_context("compute")?;
                with_band(raster, kind, |band| polygonize(band, &mut target, request))
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Contouring reads the whole band and writes a feature per line, into whichever
/// dataset holds the layer.
pub struct ContourGenerateTask {
    pub(crate) dataset: DatasetRef,
    /// The layer's own dataset, as in `PolygonizeTask`.
    pub(crate) layer: DatasetRef,
    pub(crate) layer_index: usize,
    pub(crate) kind: BandKind,
    pub(crate) request: ContourGenerateRequest,
}

impl Task for ContourGenerateTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let ContourGenerateTask {
                dataset,
                layer,
                layer_index,
                kind,
                request,
            } = self;
            let (kind, layer_index) = (*kind, *layer_index);

            Ok(op(with_two(dataset, layer, |raster, vector| {
                let mut target = vector.layer(layer_index).gdal_context("compute")?;
                with_band(raster, kind, |band| {
                    contour_generate(band, &mut target, request)
                })
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// The thread-pool half of `readChunks`: the strip walk runs off the event loop, and
/// each strip is handed to the JS callback through a threadsafe function.
pub struct ChunkStreamTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
    pub(crate) options: ChunkOptions,
    pub(crate) on_chunk: ChunkCallback,
}

impl Task for ChunkStreamTask {
    type Output = OpResult<u32>;
    type JsValue = u32;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            // `data_type` only matters when writing; this path never does.
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.stream_chunks(&self.options, &self.on_chunk)))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// The thread-pool half of `RasterBand.flush`, the same body `flushSync()` runs.
pub struct FlushBandTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) kind: BandKind,
}

impl Task for FlushBandTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            // `data_type` only matters when writing; this path never does.
            let band = JsRasterBand::from_kind(self.dataset.clone(), self.kind, DataType::Unknown);
            Ok(op(band.flush_pending()))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}
