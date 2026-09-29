//! `SpatialRef` and `CoordinateTransform`: CRS objects and reprojection.
//!
//! Everything here reaches PROJ through GDAL, so the callers take the global lock
//! and initialise first — resolving a CRS needs the packaged `proj.db`.

use gdal::spatial_ref::{AxisMappingStrategy, CoordTransform, SpatialRef};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, into_status_error, split};
use crate::runtime::{ensure_initialized, lock_gdal};

/// Axis-order strategies, as the strings this API takes.
///
/// This is the one part of CRS handling that fails *silently*, so it is worth
/// stating plainly: GDAL 3 reads `EPSG:4326` as **latitude,longitude** ("authority
/// compliant"), while GeoJSON, WKT and every other corner of this binding are
/// **longitude,latitude**. Under the authority order, `[13.4, 52.5]` means 13.4°N
/// 52.5°E — a real coordinate, in the Gulf of Aden, and not Berlin.
///
/// Every constructor here therefore asks for `traditional` explicitly rather than
/// trusting GDAL's default, and [`JsSpatialRef::with_axis_mapping`] is how you opt
/// into the other order.
const TRADITIONAL: &str = "traditional";
const AUTHORITY: &str = "authority";
const CUSTOM: &str = "custom";

fn axis_mapping_from_str(name: &str) -> Result<AxisMappingStrategy> {
    match name.to_ascii_lowercase().as_str() {
        TRADITIONAL => Ok(AxisMappingStrategy::TraditionalGisOrder),
        AUTHORITY => Ok(AxisMappingStrategy::AuthorityCompliant),
        CUSTOM => Ok(AxisMappingStrategy::Custom),
        other => Err(bad_argument(format!(
            "unknown axis mapping {other:?}; expected one of {TRADITIONAL}, {AUTHORITY}, {CUSTOM}"
        ))),
    }
}

fn axis_mapping_to_str(strategy: AxisMappingStrategy) -> &'static str {
    match strategy {
        AxisMappingStrategy::TraditionalGisOrder => TRADITIONAL,
        AxisMappingStrategy::AuthorityCompliant => AUTHORITY,
        AxisMappingStrategy::Custom => CUSTOM,
    }
}

/// A unit, as GDAL reports it: a name and how many metres (or radians) it is.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct UnitInfo {
    pub name: String,
    pub factor: f64,
}

/// Where a CRS is meant to be used. Handy for sanity-checking an extent.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct AreaOfUse {
    pub name: String,
    pub west: f64,
    pub south: f64,
    pub east: f64,
    pub north: f64,
}

/// A coordinate reference system.
///
/// Construct one with `fromEpsg`, `fromWkt`, `fromProj4` or `fromDefinition` (the
/// general entry point, which also takes `AUTHORITY:CODE` strings and PROJJSON),
/// then hand it to `CoordinateTransform` or read it apart.
#[napi(js_name = "SpatialRef")]
pub struct JsSpatialRef {
    inner: SpatialRef,
}

impl JsSpatialRef {
    /// Wrap a CRS, with the axis order this API promises.
    ///
    /// Setting it here rather than at each call site means a caller cannot forget:
    /// longitude,latitude is the order every other part of this binding uses.
    pub(crate) fn wrap(mut inner: SpatialRef) -> Self {
        inner.set_axis_mapping_strategy(AxisMappingStrategy::TraditionalGisOrder);
        Self { inner }
    }

    /// The CRS behind this object, for the callers that need it rather than its
    /// WKT — `Geometry.transform` builds a `CoordTransform` from two of these.
    pub(crate) fn inner(&self) -> &SpatialRef {
        &self.inner
    }
}

#[napi]
impl JsSpatialRef {
    /// From an EPSG code — `4326`, not `"EPSG:4326"`.
    #[napi(factory)]
    pub fn from_epsg(code: u32) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(SpatialRef::from_epsg(code).gdal()?))
    }

    #[napi(factory)]
    pub fn from_wkt(wkt: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(SpatialRef::from_wkt(&wkt).gdal()?))
    }

    /// From a PROJ string, e.g. `+proj=longlat +datum=WGS84 +no_defs`.
    #[napi(factory)]
    pub fn from_proj4(proj4: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(SpatialRef::from_proj4(&proj4).gdal()?))
    }

    /// The general entry point: `EPSG:4326`, a WKT string, PROJJSON, or a PROJ
    /// string. Whatever `gdalinfo` would accept as a CRS description.
    #[napi(factory)]
    pub fn from_definition(definition: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(SpatialRef::from_definition(&definition).gdal()?))
    }

    #[napi(getter)]
    pub fn wkt(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        self.inner.to_wkt().gdal()
    }

    /// The same WKT, indented. Lovely in a terminal, and slower to produce.
    #[napi(getter)]
    pub fn pretty_wkt(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        self.inner.to_pretty_wkt().gdal()
    }

    #[napi(getter)]
    pub fn proj4(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        self.inner.to_proj4().gdal()
    }

    #[napi(getter)]
    pub fn proj_json(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        self.inner.to_projjson().gdal()
    }

    #[napi(getter)]
    pub fn name(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.name())
    }

    /// The authority that defines this CRS, e.g. `EPSG`.
    #[napi(getter)]
    pub fn auth_name(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.auth_name())
    }

    #[napi(getter)]
    pub fn auth_code(&self) -> Result<Option<i32>> {
        ensure_initialized();
        let _guard = lock_gdal();
        // `auth_code` fails when the CRS carries no identifier, which is normal
        // for a WKT that was written by hand — that is `null`, not an error.
        Ok(self.inner.auth_code().ok())
    }

    /// `EPSG:4326` and friends, or `null` when the CRS carries no identifier.
    ///
    /// This reads what the CRS already knows. It does **not** search the CRS
    /// database — that is `identifyEpsg`, which is why that one is a promise.
    #[napi(getter)]
    pub fn authority(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.authority().ok())
    }

    #[napi(getter)]
    pub fn axis_mapping(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(axis_mapping_to_str(self.inner.axis_mapping_strategy()).to_string())
    }

    #[napi(getter)]
    pub fn linear_unit(&self) -> Result<Option<UnitInfo>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.linear_units_name().map(|name| UnitInfo {
            name,
            factor: self.inner.linear_units(),
        }))
    }

    #[napi(getter)]
    pub fn angular_unit(&self) -> Result<Option<UnitInfo>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.angular_units_name().map(|name| UnitInfo {
            name,
            factor: self.inner.angular_units(),
        }))
    }

    #[napi(getter)]
    pub fn is_geographic(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.is_geographic())
    }

    #[napi(getter)]
    pub fn is_projected(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.is_projected())
    }

    #[napi(getter)]
    pub fn is_compound(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.is_compound())
    }

    #[napi(getter)]
    pub fn is_vertical(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.is_vertical())
    }

    #[napi(getter)]
    pub fn area_of_use(&self) -> Result<Option<AreaOfUse>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.area_of_use().map(|area| AreaOfUse {
            name: area.name,
            west: area.west_lon_degree,
            south: area.south_lat_degree,
            east: area.east_lon_degree,
            north: area.north_lat_degree,
        }))
    }

    /// Whether this is the same CRS as `other`, compared by definition rather than
    /// by spelling: two differently-written WKTs for WGS 84 are equal here.
    #[napi]
    pub fn equals(&self, other: &JsSpatialRef) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner == other.inner)
    }

    /// A copy of this CRS that reads coordinates in the other axis order.
    ///
    /// Returns a new object rather than mutating this one, so a `SpatialRef` you
    /// have stored keeps meaning what it meant, and a `CoordinateTransform` built
    /// from it cannot change under you.
    #[napi]
    pub fn with_axis_mapping(&self, mapping: String) -> Result<JsSpatialRef> {
        ensure_initialized();
        let _guard = lock_gdal();

        let strategy = axis_mapping_from_str(&mapping)?;
        let mut clone = self.inner.clone();
        clone.set_axis_mapping_strategy(strategy);
        Ok(JsSpatialRef { inner: clone })
    }
}

/// A coordinate transformation from one CRS to another.
///
/// Build it once and reuse it: GDAL works out a transformation pipeline (and may
/// consult the CRS database to do it), which is not free. The axis order in force
/// is the one the two `SpatialRef`s carry — see `SpatialRef.withAxisMapping`.
#[napi(js_name = "CoordinateTransform")]
pub struct JsCoordinateTransform {
    inner: CoordTransform,
}

#[napi]
impl JsCoordinateTransform {
    #[napi(constructor)]
    pub fn new(from: &JsSpatialRef, to: &JsSpatialRef) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self {
            inner: CoordTransform::new(&from.inner, &to.inner).gdal()?,
        })
    }

    /// Transform one coordinate: `[x, y]` in, `[x, y]` out.
    #[napi]
    pub fn transform_point(&self, x: f64, y: f64) -> Result<Vec<f64>> {
        ensure_initialized();
        let _guard = lock_gdal();

        let mut xs = [x];
        let mut ys = [y];
        self.inner
            .transform_coords(&mut xs, &mut ys, &mut [])
            .gdal()?;
        Ok(vec![xs[0], ys[0]])
    }

    /// Transform a flat `[x0, y0, x1, y1, …]` array, returning a new one.
    ///
    /// Two dimensions only: a vertical or geocentric transformation needs a z,
    /// which this does not carry.
    #[napi]
    pub fn transform_points(&self, points: Float64Array) -> Result<Float64Array> {
        ensure_initialized();

        let flat = points.as_ref();
        if flat.len() % 2 != 0 {
            return Err(bad_argument(format!(
                "coordinates come in pairs, but the array holds {} values",
                flat.len()
            )));
        }
        if flat.is_empty() {
            return Ok(Float64Array::new(Vec::new()));
        }

        let _guard = lock_gdal();
        let mut xs: Vec<f64> = flat.iter().step_by(2).copied().collect();
        let mut ys: Vec<f64> = flat.iter().skip(1).step_by(2).copied().collect();
        self.inner
            .transform_coords(&mut xs, &mut ys, &mut [])
            .gdal()?;

        let mut out = Vec::with_capacity(flat.len());
        for (x, y) in xs.into_iter().zip(ys) {
            out.push(x);
            out.push(y);
        }
        Ok(Float64Array::new(out))
    }

    /// Transform a bounding box, densifying the edges.
    ///
    /// Transforming the four corners and taking their extremes is wrong for any
    /// non-linear projection, so GDAL walks each edge with `densify` extra points.
    /// The result is a bounding box in the target CRS, which is at least as large
    /// as the true one.
    #[napi]
    pub fn transform_bounds(&self, bounds: Vec<f64>, densify: Option<i32>) -> Result<Vec<f64>> {
        ensure_initialized();

        let corners: [f64; 4] = bounds.try_into().map_err(|values: Vec<f64>| {
            bad_argument(format!(
                "a bounding box needs 4 numbers, got {}",
                values.len()
            ))
        })?;
        let densify = densify.unwrap_or(21);
        if densify < 0 {
            return Err(bad_argument("densify cannot be negative"));
        }

        let _guard = lock_gdal();
        let out = self.inner.transform_bounds(&corners, densify).gdal()?;
        Ok(out.to_vec())
    }

    /// Transform a geometry, in and out as GeoJSON.
    ///
    /// The geometry is walked by GDAL rather than by us, so every type is handled
    /// — polygons, collections, nested rings — and so is the fact that a straight
    /// line stops being straight under most projections. Transform a feature's
    /// `geometry` and write it back if that is what you need.
    #[napi]
    pub fn transform_geometry(&self, geometry: Value) -> Result<Value> {
        ensure_initialized();
        let _guard = lock_gdal();

        let geometry = crate::vector::from_geojson(&geometry)?;
        let moved = geometry.transform(&self.inner).gdal()?;
        crate::vector::to_geojson(&moved)
    }
}

type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// What CRS is this? Looks the description up in the CRS database, which is why it
/// runs on the thread pool rather than in the call.
pub struct IdentifyEpsgTask {
    wkt: String,
}

impl Task for IdentifyEpsgTask {
    type Output = OpResult<Option<String>>;
    type JsValue = Option<String>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op((|| {
            ensure_initialized();
            let _guard = lock_gdal();

            let mut srs = SpatialRef::from_wkt(&self.wkt).gdal()?;
            srs.auto_identify_epsg().gdal()?;
            Ok(srs.authority().ok())
        })()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Resolve a CRS description to an authority code, e.g. `"EPSG:4326"`.
///
/// Searches the CRS database, so this can take a moment — hence a promise. Returns
/// `null` when nothing matches, which is an answer rather than a failure.
#[napi(ts_return_type = "Promise<string | null>")]
pub fn identify_epsg(wkt: String) -> AsyncTask<IdentifyEpsgTask> {
    AsyncTask::new(IdentifyEpsgTask { wkt })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn axis_mapping_names_round_trip() {
        for (name, strategy) in [
            (TRADITIONAL, AxisMappingStrategy::TraditionalGisOrder),
            (AUTHORITY, AxisMappingStrategy::AuthorityCompliant),
            (CUSTOM, AxisMappingStrategy::Custom),
        ] {
            assert_eq!(axis_mapping_from_str(name).unwrap(), strategy);
            assert_eq!(axis_mapping_to_str(strategy), name);
        }
    }

    #[test]
    fn axis_mapping_ignores_case() {
        assert_eq!(
            axis_mapping_from_str("Traditional").unwrap(),
            AxisMappingStrategy::TraditionalGisOrder
        );
        assert_eq!(
            axis_mapping_from_str("AUTHORITY").unwrap(),
            AxisMappingStrategy::AuthorityCompliant
        );
    }

    #[test]
    fn an_unknown_axis_mapping_lists_the_alternatives() {
        let err = axis_mapping_from_str("lat-lon").unwrap_err();
        assert!(
            err.reason.contains("unknown axis mapping"),
            "{}",
            err.reason
        );
        assert!(err.reason.contains(TRADITIONAL), "{}", err.reason);
        assert!(err.reason.contains(AUTHORITY), "{}", err.reason);
    }
}
