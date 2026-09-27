//! Raster algorithms that are neither I/O nor a program: the ones GDAL exposes as
//! plain `GDAL*` calls on a band.
//!
//! They live here for the same reason `raster_io` does — `band.rs` stays the napi
//! surface, and the raw glue sits in one place. Nothing here takes the global GDAL
//! lock; the callers do.

use std::ffi::c_int;

use gdal::cpl::CslStringList;
use gdal::errors::GdalError;
use gdal::raster::RasterBand;
use gdal::vector::{FieldDefn, LayerAccess, OGRFieldType};
use napi_derive::napi;
use serde_json::Value;

use crate::error::{IntoGdalResult, Result, bad_argument, gdal_error};
use crate::json::option_pairs;
use crate::raster_io::ReadOptions;
use crate::runtime::c_string;

/// Turn a `CPLErr` into this binding's error.
///
/// The `gdal` crate reads GDAL's last error and then resets it inside helpers that
/// are not reachable from here, so this reads the class, number and message by hand
/// and builds the same `GdalError` — which is what gives the sync surface its
/// `err.code`.
pub fn cpl_result(class: gdal_sys::CPLErr::Type) -> Result<()> {
    if class == gdal_sys::CPLErr::CE_None {
        return Ok(());
    }
    Err(gdal_error(GdalError::CplError {
        class,
        number: unsafe { gdal_sys::CPLGetLastErrorNo() },
        msg: c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() }),
    }))
}

/// The options a checksum takes: the window, and nothing else.
///
/// A checksum is of the samples as they are, so `resampling` / `outWidth` /
/// `outHeight` have nothing to act on — they are refused rather than quietly
/// ignored, so a caller who passes them finds out.
pub fn checksum_options(options: Option<ReadOptions>) -> Result<ReadOptions> {
    let options = options.unwrap_or_default();
    if options.resampling.is_some() || options.out_width.is_some() || options.out_height.is_some() {
        return Err(bad_argument(
            "a checksum is of the window as it is, so resampling, outWidth and outHeight do not apply",
        ));
    }
    Ok(options)
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct FillNoDataOptions {
    /// How far, in pixels, to look for a value to fill from. Default 100, which is
    /// GDAL's own default.
    pub max_distance: Option<f64>,
    /// Smoothing passes over the filled area afterwards. Default 0, GDAL's default.
    pub smoothing_iterations: Option<u32>,
}

/// `FillNoDataOptions` resolved and checked, so a bad request fails on the JS
/// thread and the worker only ever sees numbers that make sense.
#[derive(Debug, Clone, Copy)]
pub struct FillNoDataRequest {
    max_distance: f64,
    smoothing_iterations: c_int,
}

pub fn fill_nodata_request(options: Option<FillNoDataOptions>) -> Result<FillNoDataRequest> {
    let options = options.unwrap_or_default();
    let max_distance = options.max_distance.unwrap_or(100.0);
    // A positive test, because NaN fails every comparison.
    if !(max_distance.is_finite() && max_distance > 0.0) {
        return Err(bad_argument(format!(
            "a fill distance has to be a positive number of pixels, but it is {max_distance}"
        )));
    }
    let iterations = options.smoothing_iterations.unwrap_or(0);
    let smoothing_iterations = c_int::try_from(iterations)
        .map_err(|_| bad_argument(format!("{iterations} smoothing iterations is too many")))?;
    Ok(FillNoDataRequest {
        max_distance,
        smoothing_iterations,
    })
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct SieveFilterOptions {
    /// Smallest connected region, in pixels, worth keeping. Regions below it take
    /// the value of their largest neighbour.
    pub threshold: u32,
    /// Either 4 or 8 neighbouring pixels. Default 4, as in GDAL.
    pub connectedness: Option<u32>,
}

/// `SieveFilterOptions` resolved and checked.
#[derive(Debug, Clone, Copy)]
pub struct SieveFilterRequest {
    threshold: c_int,
    connectedness: c_int,
}

pub fn sieve_filter_request(options: SieveFilterOptions) -> Result<SieveFilterRequest> {
    let connectedness = options.connectedness.unwrap_or(4);
    if connectedness != 4 && connectedness != 8 {
        return Err(bad_argument(format!(
            "connectedness is 4 or 8, following GDAL, not {connectedness}"
        )));
    }
    if options.threshold == 0 {
        return Err(bad_argument(
            "a threshold of 0 would remove nothing: give the smallest region size to keep, in pixels",
        ));
    }
    let threshold = c_int::try_from(options.threshold)
        .map_err(|value| bad_argument(format!("a threshold of {value} pixels is too large")))?;
    Ok(SieveFilterRequest {
        threshold,
        connectedness: connectedness as c_int,
    })
}

/// Fill no-data pixels from their neighbours. `GDALFillNodata`, in place.
pub fn fill_no_data(band: &RasterBand<'_>, request: FillNoDataRequest) -> Result<()> {
    // Without a no-data value GDAL has no way to tell a hole from data, and it
    // reports that as a failure a long way from here — so say it plainly.
    if band.no_data_value().is_none() {
        return Err(bad_argument(
            "the band has no no-data value, so there is nothing to fill",
        ));
    }

    let class = unsafe {
        gdal_sys::GDALFillNodata(
            band.c_rasterband(),
            // A null mask band means the band's own mask, which is the usual case.
            std::ptr::null_mut(),
            request.max_distance,
            0, // the deprecated `bCon` argument
            request.smoothing_iterations,
            std::ptr::null_mut(),
            None,
            std::ptr::null_mut(),
        )
    };
    cpl_result(class)
}

/// Remove connected regions smaller than the threshold. `GDALSieveFilter`, in
/// place: the band is its own source and destination.
pub fn sieve_filter(band: &RasterBand<'_>, request: SieveFilterRequest) -> Result<()> {
    let class = unsafe {
        // The band is both source and destination, which is what "in place" means
        // here: GDAL reads and rewrites the samples of this one band.
        let handle = band.c_rasterband();
        gdal_sys::GDALSieveFilter(
            handle,
            // Null mask, as in `fill_no_data`.
            std::ptr::null_mut(),
            handle,
            request.threshold,
            request.connectedness,
            std::ptr::null_mut(),
            None,
            std::ptr::null_mut(),
        )
    };
    cpl_result(class)
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct RasterizeOptions {
    /// Bands to burn into, **0-based**. Default: the first band. GDAL's own C
    /// parameter is 1-based, so this is translated like every other band index in
    /// this binding.
    pub bands: Option<Vec<u32>>,
    /// One burn value per geometry. Required, and it has to match: GDAL reads it
    /// positionally.
    pub burn_values: Vec<f64>,
    /// `GDALRasterizeGeometries` options, passed through as written: `ALL_TOUCHED`,
    /// `MERGE_ALG`, `CHUNKYSIZE`, `INIT_DEST`, `BURN_VALUE_FROM`, ...
    pub options: Option<Value>,
}

/// `RasterizeOptions` resolved and checked.
#[derive(Debug, Clone)]
pub struct RasterizeRequest {
    /// GDAL's 1-based band numbers.
    bands: Vec<c_int>,
    burn_values: Vec<f64>,
    options: Vec<(String, String)>,
}

pub fn rasterize_request(
    options: Option<RasterizeOptions>,
    geometry_count: usize,
) -> Result<RasterizeRequest> {
    let options = options.unwrap_or_default();

    if options.burn_values.len() != geometry_count {
        return Err(bad_argument(format!(
            "a burn value per geometry is needed: {geometry_count} geometries, {} burn value(s)",
            options.burn_values.len()
        )));
    }

    // 0-based here, 1-based in GDAL — the one place the two meet, as in
    // `buildOverviews`.
    let bands = match options.bands {
        Some(bands) if !bands.is_empty() => bands
            .into_iter()
            .map(|index| {
                i32::try_from(index)
                    .map(|index| index + 1)
                    .map_err(|_| bad_argument(format!("band index {index} is out of range")))
            })
            .collect::<Result<Vec<i32>>>()?,
        // Nothing said means the first band, which is what `gdal_rasterize` does
        // with no `-b` either.
        _ => vec![1],
    };

    Ok(RasterizeRequest {
        bands,
        burn_values: options.burn_values,
        options: option_pairs(options.options.as_ref())?,
    })
}

/// Burn geometries into a dataset's bands. `GDALRasterizeGeometries`, the call
/// behind `gdal_rasterize`.
///
/// The geometries are expected to be in the dataset's own coordinate system: this
/// does not reproject, and `warp` is the tool that does.
pub fn rasterize(
    dataset: &gdal::Dataset,
    geometries: &[gdal::vector::Geometry],
    request: &RasterizeRequest,
) -> Result<()> {
    let mut options = CslStringList::new();
    for (name, value) in &request.options {
        options.add_name_value(name, value).gdal()?;
    }

    let handles: Vec<gdal_sys::OGRGeometryH> = geometries
        .iter()
        .map(|geometry| unsafe { geometry.c_geometry() })
        .collect();

    let class = unsafe {
        gdal_sys::GDALRasterizeGeometries(
            dataset.c_dataset(),
            request.bands.len() as c_int,
            request.bands.as_ptr(),
            handles.len() as c_int,
            handles.as_ptr(),
            // No transformer: the geometries are already where they belong.
            None,
            std::ptr::null_mut(),
            request.burn_values.as_ptr(),
            options.as_ptr(),
            None,
            std::ptr::null_mut(),
        )
    };
    cpl_result(class)
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct PolygonizeOptions {
    /// Field the pixel values are written to. Default `DN`, as in
    /// `gdal_polygonize.py`. Created when the layer does not already have it.
    pub field_name: Option<String>,
    /// Either 4 or 8 neighbouring pixels. Default 4, as in GDAL.
    pub connectedness: Option<u32>,
}

/// `PolygonizeOptions` resolved and checked.
#[derive(Debug, Clone)]
pub struct PolygonizeRequest {
    field_name: String,
    connectedness: c_int,
}

pub fn polygonize_request(options: Option<PolygonizeOptions>) -> Result<PolygonizeRequest> {
    let options = options.unwrap_or_default();
    let connectedness = options.connectedness.unwrap_or(4);
    if connectedness != 4 && connectedness != 8 {
        return Err(bad_argument(format!(
            "connectedness is 4 or 8, following GDAL, not {connectedness}"
        )));
    }
    let field_name = options.field_name.unwrap_or_else(|| "DN".to_string());
    if field_name.is_empty() {
        return Err(bad_argument("the field the values go into needs a name"));
    }
    Ok(PolygonizeRequest {
        field_name,
        connectedness: connectedness as c_int,
    })
}

/// Whether a band holds floats, which decides both the polygonize entry point and
/// the type of field its values need.
fn band_is_float(band: &RasterBand<'_>) -> bool {
    matches!(
        crate::dtype::DataType::from_gdal(band.band_type()),
        crate::dtype::DataType::Float32 | crate::dtype::DataType::Float64
    )
}

/// Turn a band's values into polygons in `layer`. `GDALPolygonize`, or
/// `GDALFPolygonize` when the band holds floats — the same pair
/// `gdal_polygonize.py` chooses between.
pub fn polygonize(
    band: &RasterBand<'_>,
    layer: &mut gdal::vector::Layer<'_>,
    request: &PolygonizeRequest,
) -> Result<()> {
    let float = band_is_float(band);

    // The values have to land in a field of a matching type, and GDAL's own tool
    // creates that field rather than asking the caller to — so do the same. `Real`
    // for a float band, `Integer` otherwise.
    let field_type = if float {
        OGRFieldType::OFTReal
    } else {
        OGRFieldType::OFTInteger
    };
    let field = ensure_field(&*layer, &request.field_name, field_type)?;

    let mut options = CslStringList::new();
    if request.connectedness == 8 {
        // The option name GDAL's own tool passes for 8-connectivity.
        options.add_string("8CONNECTED=8").gdal()?;
    }

    let source = unsafe { band.c_rasterband() };
    let target = unsafe { layer.c_layer() };
    let class = unsafe {
        if float {
            gdal_sys::GDALFPolygonize(
                source,
                std::ptr::null_mut(),
                target,
                field as c_int,
                options.as_ptr(),
                None,
                std::ptr::null_mut(),
            )
        } else {
            gdal_sys::GDALPolygonize(
                source,
                std::ptr::null_mut(),
                target,
                field as c_int,
                options.as_ptr(),
                None,
                std::ptr::null_mut(),
            )
        }
    };
    cpl_result(class)
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct ContourGenerateOptions {
    /// Elevations to draw contours at, e.g. `[0, 100, 200]`. Give this or
    /// `interval`, not both.
    pub levels: Option<Vec<f64>>,
    /// Spacing between contours. Give this or `levels`, not both.
    pub interval: Option<f64>,
    /// Elevation the interval is counted from. Default 0, and only read alongside
    /// `interval`.
    pub base: Option<f64>,
    /// Field the elevations are written to. Default `ELEV`, created when the layer
    /// does not have it.
    pub elev_field: Option<String>,
    /// Field to write each contour's id into. No ids are written unless this names
    /// one — it is `gdal_contour`'s `-i`.
    pub id_field: Option<String>,
    /// Anything else `GDALContourGenerateEx` takes, passed through as written:
    /// `USE_NODATA`, `POLYGONIZE`, `SMOOTHING`, ...
    pub options: Option<Value>,
}

/// `ContourGenerateOptions` resolved and checked.
///
/// The level options are built here; the two field options are not, because
/// `GDALContourGenerateEx` wants field *indexes* rather than names — GDAL parses
/// them with `atoi` — so they can only be filled in once the layer is in hand.
#[derive(Debug, Clone)]
pub struct ContourGenerateRequest {
    levels: Vec<(String, String)>,
    elev_field: String,
    id_field: Option<String>,
    extra: Vec<(String, String)>,
}

pub fn contour_generate_request(
    options: Option<ContourGenerateOptions>,
) -> Result<ContourGenerateRequest> {
    let options = options.unwrap_or_default();

    let elev_field = options.elev_field.unwrap_or_else(|| "ELEV".to_string());
    if elev_field.is_empty() {
        return Err(bad_argument("the elevation field needs a name"));
    }
    if let Some(id_field) = &options.id_field
        && id_field.is_empty()
    {
        return Err(bad_argument("the id field needs a name"));
    }

    let mut levels: Vec<(String, String)> = Vec::new();
    match (&options.levels, options.interval) {
        (Some(_), Some(_)) => {
            return Err(bad_argument(
                "give either levels or an interval, not both: they say different things",
            ));
        }
        (Some(fixed), None) => {
            if fixed.is_empty() {
                return Err(bad_argument("a contour level list cannot be empty"));
            }
            if let Some(odd) = fixed.iter().find(|level| !level.is_finite()) {
                return Err(bad_argument(format!(
                    "contour levels have to be numbers, and {odd} is not"
                )));
            }
            levels.push((
                "FIXED_LEVELS".to_string(),
                fixed
                    .iter()
                    .map(f64::to_string)
                    .collect::<Vec<_>>()
                    .join(","),
            ));
        }
        (None, Some(interval)) => {
            if !(interval.is_finite() && interval > 0.0) {
                return Err(bad_argument(format!(
                    "a contour interval has to be a positive number, not {interval}"
                )));
            }
            let base = options.base.unwrap_or(0.0);
            if !base.is_finite() {
                return Err(bad_argument(format!(
                    "the elevation an interval counts from has to be a number, not {base}"
                )));
            }
            levels.push(("LEVEL_INTERVAL".to_string(), interval.to_string()));
            levels.push(("LEVEL_BASE".to_string(), base.to_string()));
        }
        (None, None) => {
            return Err(bad_argument(
                "give levels or an interval: contours are drawn at one or the other",
            ));
        }
    }

    Ok(ContourGenerateRequest {
        levels,
        elev_field,
        id_field: options.id_field,
        extra: option_pairs(options.options.as_ref())?,
    })
}

/// Add `name` to the layer unless it is already there, and answer with its index.
fn ensure_field(
    layer: &gdal::vector::Layer<'_>,
    name: &str,
    field_type: OGRFieldType::Type,
) -> Result<usize> {
    match layer.defn().fields().position(|field| field.name() == name) {
        Some(index) => Ok(index),
        None => {
            let definition = FieldDefn::new(name, field_type).gdal()?;
            definition.add_to_layer(layer).gdal()?;
            // Appended, so it is the last one.
            Ok(layer.defn().fields().count() - 1)
        }
    }
}

/// Draw contour lines for a band into `layer`. `GDALContourGenerateEx`, the call
/// behind `gdal_contour`.
///
/// The band wants a geotransform, and the layer is the one that carries the CRS —
/// the lines are written in the layer's coordinate system.
pub fn contour_generate(
    band: &RasterBand<'_>,
    layer: &mut gdal::vector::Layer<'_>,
    request: &ContourGenerateRequest,
) -> Result<()> {
    // The fields have to exist before GDAL is asked to fill them, and `gdal_contour`
    // creates them rather than asking the caller to — so do the same.
    let elev = ensure_field(&*layer, &request.elev_field, OGRFieldType::OFTReal)?;
    let id = match &request.id_field {
        Some(id_field) => Some(ensure_field(&*layer, id_field, OGRFieldType::OFTInteger)?),
        None => None,
    };

    let mut options = CslStringList::new();
    for (name, value) in &request.levels {
        options.add_name_value(name, value).gdal()?;
    }
    // These two are field *indexes*, not names: GDAL parses them with `atoi`, and
    // `gdal_contour` hands it an index as well.
    options
        .add_name_value("ELEV_FIELD", &elev.to_string())
        .gdal()?;
    if let Some(id) = id {
        options.add_name_value("ID_FIELD", &id.to_string()).gdal()?;
    }
    // The pass-through goes last on purpose: GDAL takes the first match for a name,
    // so what this binding filled in wins over an accidental duplicate.
    for (name, value) in &request.extra {
        options.add_name_value(name, value).gdal()?;
    }

    let class = unsafe {
        gdal_sys::GDALContourGenerateEx(
            band.c_rasterband(),
            layer.c_layer(),
            options.as_ptr(),
            None,
            std::ptr::null_mut(),
        )
    };
    cpl_result(class)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fill_distance_has_to_be_a_positive_number() {
        let request = fill_nodata_request(Some(FillNoDataOptions {
            max_distance: Some(25.0),
            smoothing_iterations: Some(3),
        }))
        .unwrap();
        assert_eq!(request.max_distance, 25.0);
        assert_eq!(request.smoothing_iterations, 3);

        // The defaults are GDAL's own.
        let defaults = fill_nodata_request(None).unwrap();
        assert_eq!(defaults.max_distance, 100.0);
        assert_eq!(defaults.smoothing_iterations, 0);

        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                fill_nodata_request(Some(FillNoDataOptions {
                    max_distance: Some(bad),
                    ..Default::default()
                }))
                .is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn sieve_takes_four_or_eight_and_a_real_threshold() {
        let request = sieve_filter_request(SieveFilterOptions {
            threshold: 10,
            connectedness: Some(8),
        })
        .unwrap();
        assert_eq!(request.threshold, 10);
        assert_eq!(request.connectedness, 8);

        // Four is what GDAL uses when nobody says otherwise.
        let defaults = sieve_filter_request(SieveFilterOptions {
            threshold: 10,
            connectedness: None,
        })
        .unwrap();
        assert_eq!(defaults.connectedness, 4);

        assert!(
            sieve_filter_request(SieveFilterOptions {
                threshold: 10,
                connectedness: Some(6)
            })
            .is_err()
        );
        assert!(
            sieve_filter_request(SieveFilterOptions {
                threshold: 0,
                connectedness: None
            })
            .is_err()
        );
    }

    #[test]
    fn contours_take_levels_or_an_interval_but_not_both() {
        let fixed = contour_generate_request(Some(ContourGenerateOptions {
            levels: Some(vec![0.0, 12.5, 25.0]),
            ..Default::default()
        }))
        .unwrap();
        assert_eq!(
            fixed.levels,
            vec![("FIXED_LEVELS".to_string(), "0,12.5,25".to_string())]
        );
        assert_eq!(fixed.elev_field, "ELEV");
        assert_eq!(fixed.id_field, None);

        // An interval brings its base along, and the field names are the caller's.
        let interval = contour_generate_request(Some(ContourGenerateOptions {
            levels: None,
            interval: Some(10.0),
            base: Some(5.0),
            elev_field: Some("height".to_string()),
            id_field: Some("id".to_string()),
            options: None,
        }))
        .unwrap();
        assert_eq!(
            interval.levels,
            vec![
                ("LEVEL_INTERVAL".to_string(), "10".to_string()),
                ("LEVEL_BASE".to_string(), "5".to_string()),
            ]
        );
        assert_eq!(interval.elev_field, "height");
        assert_eq!(interval.id_field.as_deref(), Some("id"));

        // Neither or both is a mistake, and so is an interval that draws nothing.
        for bad in [
            ContourGenerateOptions::default(),
            ContourGenerateOptions {
                levels: Some(vec![1.0]),
                interval: Some(1.0),
                ..Default::default()
            },
            ContourGenerateOptions {
                levels: Some(Vec::new()),
                ..Default::default()
            },
            ContourGenerateOptions {
                interval: Some(0.0),
                ..Default::default()
            },
            ContourGenerateOptions {
                interval: Some(f64::NAN),
                ..Default::default()
            },
        ] {
            assert!(contour_generate_request(Some(bad)).is_err());
        }
    }

    #[test]
    fn polygonize_names_its_field_and_takes_four_or_eight() {
        let defaults = polygonize_request(None).unwrap();
        assert_eq!(defaults.field_name, "DN");
        assert_eq!(defaults.connectedness, 4);

        let named = polygonize_request(Some(PolygonizeOptions {
            field_name: Some("value".to_string()),
            connectedness: Some(8),
        }))
        .unwrap();
        assert_eq!(named.field_name, "value");
        assert_eq!(named.connectedness, 8);

        assert!(
            polygonize_request(Some(PolygonizeOptions {
                field_name: None,
                connectedness: Some(6)
            }))
            .is_err()
        );
        // A field with no name is not a field.
        assert!(
            polygonize_request(Some(PolygonizeOptions {
                field_name: Some(String::new()),
                connectedness: None
            }))
            .is_err()
        );
    }

    #[test]
    fn rasterize_needs_a_burn_value_per_geometry_and_maps_the_bands() {
        let request = rasterize_request(
            Some(RasterizeOptions {
                bands: Some(vec![0, 2]),
                burn_values: vec![1.0, 2.0],
                options: None,
            }),
            2,
        )
        .unwrap();
        // 0-based indices here, GDAL's 1-based band numbers there.
        assert_eq!(request.bands, vec![1, 3]);
        assert_eq!(request.burn_values, vec![1.0, 2.0]);

        // Saying nothing about bands means the first one, as in `gdal_rasterize`.
        let defaults = rasterize_request(
            Some(RasterizeOptions {
                burn_values: vec![7.0],
                ..Default::default()
            }),
            1,
        )
        .unwrap();
        assert_eq!(defaults.bands, vec![1]);

        // The burn values are positional, so a short list is a mistake rather than
        // something to pad.
        assert!(
            rasterize_request(
                Some(RasterizeOptions {
                    burn_values: vec![1.0],
                    ..Default::default()
                }),
                3
            )
            .is_err()
        );
    }

    #[test]
    fn a_checksum_refuses_the_resampling_knobs() {
        use crate::raster_io::ReadOptions;

        assert!(checksum_options(None).is_ok());
        assert!(checksum_options(Some(ReadOptions::default())).is_ok());

        for options in [
            ReadOptions {
                resampling: Some("average".to_string()),
                ..Default::default()
            },
            ReadOptions {
                out_width: Some(2),
                ..Default::default()
            },
            ReadOptions {
                out_height: Some(2),
                ..Default::default()
            },
        ] {
            assert!(checksum_options(Some(options)).is_err());
        }
    }
}
