//! Worker half of the dataset surface: the `napi::Task` types the async entry
//! points hand their work to, and the helpers they use. They are plain Rust, so
//! they live apart from the napi surface in `mod.rs`.

use super::*;

/// `Task::compute` must be `Send`, and `napi::Error` is not guaranteed to be, so
/// failures travel as a plain pair and are rebuilt on the JS thread.
pub(crate) type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

pub(crate) fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// What `OpenTask` should produce. One task type covers opening, raster creation,
/// vector creation and thread-safe opening, so the async surface stays uniform and
/// `napi::Task` is implemented only once.
pub(crate) enum OpenKind {
    Open {
        update: bool,
        drivers: Option<Vec<String>>,
        multidimensional: bool,
    },
    /// Bytes that have no file yet. They are written to `OpenTask::path` — the
    /// `/vsimem/` name `open(buffer)` generated — before anything is opened, so from
    /// there on this is the plain `Open`, and the file is the dataset's to unlink.
    OpenBytes {
        bytes: Vec<u8>,
        update: bool,
        drivers: Option<Vec<String>>,
        multidimensional: bool,
    },
    CreateRaster(CreateOptions),
    CreateVector {
        driver: String,
    },
    #[cfg(gd_thread_safe)]
    ThreadSafe,
}

pub struct OpenTask {
    pub(crate) path: String,
    pub(crate) kind: OpenKind,
}

impl Task for OpenTask {
    type Output = OpResult<DatasetRef>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            Ok(op(match &self.kind {
                OpenKind::Open {
                    update,
                    drivers,
                    multidimensional,
                } => open_gdal(&self.path, *update, drivers.as_deref(), *multidimensional)
                    .map(DatasetRef::serialised),
                OpenKind::OpenBytes {
                    bytes,
                    update,
                    drivers,
                    multidimensional,
                } => open_bytes_gdal(
                    &self.path,
                    bytes,
                    *update,
                    drivers.as_deref(),
                    *multidimensional,
                )
                .map(|dataset| DatasetRef::serialised_mem_file(dataset, self.path.clone())),
                OpenKind::CreateRaster(options) => {
                    create_gdal(&self.path, options).map(DatasetRef::serialised)
                }
                OpenKind::CreateVector { driver } => {
                    create_vector_gdal(&self.path, driver).map(DatasetRef::serialised)
                }
                #[cfg(gd_thread_safe)]
                OpenKind::ThreadSafe => open_thread_safe_gdal(&self.path),
            }))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap_ref(dataset, self.path.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}
/// `gdaldem` on the thread pool: each algorithm reads the whole raster, so it
/// belongs off the event loop just as much as a warp does.
pub struct DemTask {
    pub(crate) algorithm: &'static str,
    pub(crate) dest: String,
    pub(crate) color_file: Option<String>,
    pub(crate) sources: ProgramSources,
    pub(crate) args: Vec<String>,
    /// Present only when the caller asked for progress. The sync entry points have
    /// no way to run it, so they pass `None` — see `programs::run_with_progress`.
    pub(crate) progress: Option<Arc<ProgressCallback>>,
    /// The JS thread the callback runs on, captured when the task was built on it.
    pub(crate) js_thread: ThreadId,
}

impl Task for DemTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let DemTask {
                algorithm,
                dest,
                color_file,
                sources,
                args,
                progress,
                js_thread,
            } = self;

            // The sink owns whatever the callback needs; `progress` below is the trait
            // object the programs take, and is `None` when nobody asked.
            let sink = progress
                .as_ref()
                .map(|callback| JsProgressSink::new(Arc::clone(callback), *js_thread));
            let progress = sink
                .as_ref()
                .map(|sink| sink as &dyn programs::ProgressSink);

            Ok(op(match sources {
                ProgramSources::Paths(paths) => dem_with_paths(
                    algorithm,
                    dest,
                    color_file.as_deref(),
                    paths,
                    args,
                    progress,
                ),
                ProgramSources::Open(dataset) => dataset.with_exclusive(|source| {
                    programs::dem_process_with_progress(
                        dest,
                        algorithm,
                        color_file.as_deref(),
                        source,
                        args,
                        progress,
                    )
                }),
            }))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.dest.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

pub struct FlushTask {
    pub(crate) dataset: DatasetRef,
}

impl Task for FlushTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            Ok(op(self
                .dataset
                .with_mut(|dataset| dataset.flush_cache().gdal())))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Resolve a geometry list to GeoJSON — a `Geometry` object and the GeoJSON plain
/// object are both accepted. Converted **before** the caller takes the lock,
/// because the object form's `toJson()` takes it itself.
pub(crate) fn geometry_values(
    geometries: Vec<Either<&JsGeometry, Unknown<'_>>>,
) -> Result<Vec<Value>> {
    geometries
        .into_iter()
        .map(|geometry| match geometry {
            Either::A(object) => object.to_json(),
            Either::B(unknown) => crate::vector::json_value(unknown),
        })
        .collect()
}

/// `createCopy` driven by a named driver, for `Dataset.createCopySync` and
/// `Driver.createCopySync` alike — one body, so the two cannot drift.
pub(crate) fn create_copy_sync_with(
    driver: &str,
    path: &str,
    source: &DatasetRef,
    options: Option<&Value>,
) -> Result<JsDataset> {
    ensure_initialized();
    let driver = DriverManager::get_driver_by_name(driver).gdal_context("create_copy_sync_with")?;
    let creation_options = build_creation_options(options)?;

    let dataset = source
        .with_exclusive(|source| source.create_copy(&driver, path, &creation_options).gdal())?;
    Ok(JsDataset::wrap(dataset, path.to_string()))
}

/// `createCopy` on the thread pool: writing a whole COG is exactly the kind of
/// operation that should not hold up the event loop.
pub struct CopyTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) path: String,
    pub(crate) driver: String,
    pub(crate) options: Vec<(String, String)>,
}

impl CopyTask {
    /// The task `Dataset.createCopy` and `Driver.createCopy` share.
    pub(crate) fn new(
        dataset: DatasetRef,
        path: String,
        driver: String,
        options: Option<&Value>,
    ) -> Result<Self> {
        Ok(Self {
            dataset,
            path,
            driver,
            // `CslStringList` wraps a raw GDAL pointer, so the task carries plain
            // pairs and rebuilds the list on the worker thread.
            options: crate::json::option_pairs(options)?,
        })
    }
}

impl Task for CopyTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let CopyTask {
                dataset,
                path,
                driver,
                options,
            } = self;

            Ok(op(dataset.with_exclusive(|source| {
                let driver = DriverManager::get_driver_by_name(driver).gdal_context("compute")?;

                let mut list = CslStringList::new();
                for (name, value) in options.iter() {
                    list.add_name_value(name, value).gdal_context("compute")?;
                }

                source.create_copy(&driver, path, &list).gdal()
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.path.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Where a program's sources come from.
pub enum ProgramSources {
    /// Paths to open inside the worker — the module-level API.
    Paths(Vec<String>),
    /// A dataset the caller already has open — the `Dataset` methods.
    Open(DatasetRef),
}

/// `gdal_translate` / `gdalwarp` / `ogr2ogr` on the thread pool. A warp of a large
/// raster is the longest single operation this binding offers, so it had better
/// not block the event loop.
pub struct ProgramTask {
    pub(crate) program: programs::Program,
    pub(crate) dest: String,
    pub(crate) sources: ProgramSources,
    pub(crate) args: Vec<String>,
    /// See `DemTask::progress`: present only when the caller asked for progress.
    pub(crate) progress: Option<Arc<ProgressCallback>>,
    /// The JS thread the callback runs on — see `DemTask::js_thread`.
    pub(crate) js_thread: ThreadId,
}

impl Task for ProgramTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let ProgramTask {
                program,
                dest,
                sources,
                args,
                progress,
                js_thread,
            } = self;

            let sink = progress
                .as_ref()
                .map(|callback| JsProgressSink::new(Arc::clone(callback), *js_thread));
            let progress = sink
                .as_ref()
                .map(|sink| sink as &dyn programs::ProgressSink);

            Ok(op(match sources {
                ProgramSources::Paths(paths) => {
                    programs::run_with_paths(*program, dest, paths, args, progress)
                }
                ProgramSources::Open(dataset) => dataset.with_exclusive(|source| {
                    programs::run_with_progress(*program, dest, &[source], args, progress)
                }),
            }))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.dest.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Building overviews reads the whole raster and writes smaller copies of it, so
/// of everything this binding offers it is the one that most needs to be off the
/// event loop.
pub struct BuildOverviewsTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) request: BuildOverviewsRequest,
}

impl Task for BuildOverviewsTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let BuildOverviewsTask { dataset, request } = self;
            Ok(op(
                dataset.with_mut(|source| write_overviews(source, request))
            ))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Burning geometry into a raster reads it and writes it back, so it is the kind of
/// operation that should not hold up the event loop.
pub struct RasterizeTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) geometries: Vec<Value>,
    pub(crate) request: RasterizeRequest,
}

impl Task for RasterizeTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let RasterizeTask {
                dataset,
                geometries,
                request,
            } = self;

            Ok(op(dataset.with_mut(|dataset| {
                // Built here rather than on the JS thread: GDAL makes the geometries, so
                // it happens under the lock either way, and this is where the pool is
                // already paying for the work.
                let geometries = geometries
                    .iter()
                    .map(crate::vector::from_geojson)
                    .collect::<Result<Vec<_>>>()?;
                rasterize_geometries(dataset, &geometries, request)
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Computing a suggested warp output walks the source's edges through a
/// transformation, which on a large raster is not free — so it goes on the pool.
pub struct SuggestedWarpOutputTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) request: SuggestedWarpRequest,
}

impl Task for SuggestedWarpOutputTask {
    type Output = OpResult<SuggestedWarpOutput>;
    type JsValue = SuggestedWarpOutput;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let SuggestedWarpOutputTask { dataset, request } = self;
            Ok(op(dataset.with_exclusive(|dataset| {
                suggested_warp_output(dataset, request)
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// A warp reads the source and writes the destination, so it belongs on the pool.
pub struct ReprojectImageTask {
    pub(crate) dataset: DatasetRef,
    pub(crate) dest: DatasetRef,
    pub(crate) request: ReprojectImageRequest,
}

impl Task for ReprojectImageTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            let ReprojectImageTask {
                dataset,
                dest,
                request,
            } = self;
            Ok(op(with_two(dataset, dest, |source, target| {
                reproject_image(source, target, request)
            })))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Building a VRT opens every source and reads their headers, so it is on the pool
/// for the same reason a program is.
pub struct BuildVrtTask {
    pub(crate) dest: String,
    pub(crate) sources: Vec<String>,
    pub(crate) args: Vec<String>,
}

impl Task for BuildVrtTask {
    type Output = OpResult<GdalDataset>;
    type JsValue = JsDataset;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        crate::guard::catch(|| {
            Ok(op(build_vrt_with_paths(
                &self.dest,
                &self.sources,
                &self.args,
            )))
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(|dataset| JsDataset::wrap(dataset, self.dest.clone()))
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
}
