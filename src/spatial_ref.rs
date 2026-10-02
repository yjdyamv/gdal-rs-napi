//! `SpatialRef` and `CoordinateTransform`: CRS objects and reprojection.
//!
//! Everything here reaches PROJ through GDAL, so the callers initialise first —
//! resolving a CRS needs the packaged `proj.db`. They take the **shared** side of the
//! GDAL lock rather than the exclusive one: `OGRSpatialReference` draws its PROJ
//! context from `OSRGetProjTLSContext()`, so two threads transform through separate
//! contexts, and the error slot they read is thread-local. See `runtime`.

use gdal::spatial_ref::{
    AxisMappingStrategy, CoordTransform, CoordTransformOptions as GdalTransformOptions, SpatialRef,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::error::{GdalErrorCode, IntoGdalResult, Result, bad_argument, into_status_error, split};
use crate::geometry::JsGeometry;
use crate::runtime::{ensure_initialized, lock_gdal_shared};

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

    /// Build from a CRS definition **without taking the lock** — for a caller that
    /// already holds it. `MDArray::srs` reads the array's CRS inside the dataset lock
    /// and would deadlock going through the `fromDefinition` factory, which takes the
    /// shared side again.
    pub(crate) fn build_from_definition(definition: &str) -> Result<Self> {
        Ok(Self::wrap(SpatialRef::from_definition(definition).gdal()?))
    }
}

#[napi]
impl JsSpatialRef {
    /// From an EPSG code — `4326`, not `"EPSG:4326"`.
    #[napi(catch_unwind, factory)]
    pub fn from_epsg(code: u32) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(SpatialRef::from_epsg(code).gdal()?))
    }

    #[napi(catch_unwind, factory)]
    pub fn from_wkt(wkt: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(SpatialRef::from_wkt(&wkt).gdal()?))
    }

    /// From a PROJ string, e.g. `+proj=longlat +datum=WGS84 +no_defs`.
    #[napi(catch_unwind, factory)]
    pub fn from_proj4(proj4: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(SpatialRef::from_proj4(&proj4).gdal()?))
    }

    /// The general entry point: `EPSG:4326`, a WKT string, PROJJSON, or a PROJ
    /// string. Whatever `gdalinfo` would accept as a CRS description.
    #[napi(catch_unwind, factory)]
    pub fn from_definition(definition: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Self::build_from_definition(&definition)
    }

    #[napi(catch_unwind, getter)]
    pub fn wkt(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.to_wkt().gdal()
    }

    /// The same WKT, indented. Lovely in a terminal, and slower to produce.
    #[napi(catch_unwind, getter)]
    pub fn pretty_wkt(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.to_pretty_wkt().gdal()
    }

    #[napi(catch_unwind, getter)]
    pub fn proj4(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.to_proj4().gdal()
    }

    #[napi(catch_unwind, getter)]
    pub fn proj_json(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.to_projjson().gdal()
    }

    #[napi(catch_unwind, getter)]
    pub fn name(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.name())
    }

    /// The authority that defines this CRS, e.g. `EPSG`.
    #[napi(catch_unwind, getter)]
    pub fn auth_name(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.auth_name())
    }

    #[napi(catch_unwind, getter)]
    pub fn auth_code(&self) -> Result<Option<i32>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        // `auth_code` fails when the CRS carries no identifier, which is normal
        // for a WKT that was written by hand — that is `null`, not an error.
        Ok(self.inner.auth_code().ok())
    }

    /// `EPSG:4326` and friends, or `null` when the CRS carries no identifier.
    ///
    /// This reads what the CRS already knows. It does **not** search the CRS
    /// database — that is `identifyEpsg`, which is why that one is a promise.
    #[napi(catch_unwind, getter)]
    pub fn authority(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.authority().ok())
    }

    #[napi(catch_unwind, getter)]
    pub fn axis_mapping(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(axis_mapping_to_str(self.inner.axis_mapping_strategy()).to_string())
    }

    #[napi(catch_unwind, getter)]
    pub fn linear_unit(&self) -> Result<Option<UnitInfo>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.linear_units_name().map(|name| UnitInfo {
            name,
            factor: self.inner.linear_units(),
        }))
    }

    #[napi(catch_unwind, getter)]
    pub fn angular_unit(&self) -> Result<Option<UnitInfo>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.angular_units_name().map(|name| UnitInfo {
            name,
            factor: self.inner.angular_units(),
        }))
    }

    #[napi(catch_unwind, getter)]
    pub fn is_geographic(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_geographic())
    }

    #[napi(catch_unwind, getter)]
    pub fn is_projected(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_projected())
    }

    #[napi(catch_unwind, getter)]
    pub fn is_compound(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_compound())
    }

    #[napi(catch_unwind, getter)]
    pub fn is_vertical(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_vertical())
    }

    #[napi(catch_unwind, getter)]
    pub fn area_of_use(&self) -> Result<Option<AreaOfUse>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
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
    #[napi(catch_unwind)]
    pub fn equals(&self, other: &JsSpatialRef) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner == other.inner)
    }

    /// A copy of this CRS that reads coordinates in the other axis order.
    ///
    /// Returns a new object rather than mutating this one, so a `SpatialRef` you
    /// have stored keeps meaning what it meant, and a `CoordinateTransform` built
    /// from it cannot change under you.
    #[napi(catch_unwind)]
    pub fn with_axis_mapping(&self, mapping: String) -> Result<JsSpatialRef> {
        ensure_initialized();
        let _guard = lock_gdal_shared();

        let strategy = axis_mapping_from_str(&mapping)?;
        let mut clone = self.inner.clone();
        clone.set_axis_mapping_strategy(strategy);
        Ok(JsSpatialRef { inner: clone })
    }

    /// Build a CRS from an **ESRI WKT** string — the `.prj` ArcGIS writes, whose
    /// dialect differs from OGC WKT. GDAL morphs it on the way in.
    #[napi(catch_unwind, factory, js_name = "fromESRI")]
    pub fn from_esri(esri_wkt: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(SpatialRef::from_esri(&esri_wkt).gdal()?))
    }

    /// This CRS as XML — OSR's own serialization, alongside `wkt` and `projJson`.
    #[napi(catch_unwind, js_name = "toXML")]
    pub fn to_xml(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.to_xml().gdal()
    }

    /// Whether the CRS is internally consistent — the check a hand-written WKT
    /// wants. `false` is a real answer, not an error.
    #[napi(catch_unwind)]
    pub fn validate(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(unsafe { gdal_sys::OSRValidate(self.inner.to_c_hsrs()) } == 0)
    }

    /// The geographic CRS underneath this one — WGS 84 for a UTM zone, say. A new
    /// object; this one is unchanged.
    #[napi(catch_unwind, js_name = "cloneGeogCS")]
    pub fn clone_geog_cs(&self) -> Result<JsSpatialRef> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let handle = unsafe { gdal_sys::OSRCloneGeogCS(self.inner.to_c_hsrs()) };
        if handle.is_null() {
            return Err(bad_argument(
                "this CRS has no geographic component to clone",
            ));
        }
        // The crate keeps `from_c_hsrs` private, so the clone goes out as WKT and
        // comes back as an owned `SpatialRef`; the intermediate is freed either way.
        let mut wkt: *mut std::ffi::c_char = std::ptr::null_mut();
        let status = unsafe { gdal_sys::OSRExportToWkt(handle, &mut wkt) };
        let text = crate::runtime::c_string(wkt);
        if !wkt.is_null() {
            unsafe { gdal_sys::VSIFree(wkt.cast()) };
        }
        unsafe { gdal_sys::OSRDestroySpatialReference(handle) };
        if status != 0 {
            return Err(bad_argument("the geographic CRS could not be serialized"));
        }
        Ok(Self::wrap(SpatialRef::from_wkt(&text).gdal()?))
    }

    /// Rewrite the CRS in ESRI's dialect, in place — the reverse of `fromESRI`.
    #[napi(catch_unwind, js_name = "morphToESRI")]
    pub fn morph_to_esri(&self) -> Result<()> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.morph_to_esri().gdal()
    }

    /// Rewrite the CRS from ESRI's dialect into OGC's, in place.
    #[napi(catch_unwind, js_name = "morphFromESRI")]
    pub fn morph_from_esri(&self) -> Result<()> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if unsafe { gdal_sys::OSRMorphFromESRI(self.inner.to_c_hsrs()) } != 0 {
            return Err(bad_argument(
                "this CRS could not be morphed from ESRI's dialect",
            ));
        }
        Ok(())
    }

    /// Reset this CRS, in place, to a well-known geographic one — `"WGS84"`,
    /// `"NAD27"`, or any other name `OSRSetWellKnownGeogCS` accepts.
    #[napi(catch_unwind, js_name = "setWellKnownGeogCS")]
    pub fn set_well_known_geog_cs(&self, name: String) -> Result<()> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let name = std::ffi::CString::new(name)
            .map_err(|_| bad_argument("a well-known CRS name cannot contain a NUL byte"))?;
        if unsafe { gdal_sys::OSRSetWellKnownGeogCS(self.inner.to_c_hsrs(), name.as_ptr()) } != 0 {
            return Err(bad_argument("unknown well-known CRS name — try \"WGS84\""));
        }
        Ok(())
    }

    /// Whether the **EPSG authority** reads this CRS as latitude,longitude. It is
    /// the authority's own order, independent of the one in force here, which
    /// `axisMapping` reports (`traditional` unless `withAxisMapping` changed it).
    #[napi(catch_unwind, getter)]
    pub fn epsg_treats_as_lat_long(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(unsafe { gdal_sys::OSREPSGTreatsAsLatLong(self.inner.to_c_hsrs()) } != 0)
    }

    /// Whether the CRS is geocentric — an Earth-centred XYZ system rather than a
    /// projected or geographic one.
    #[napi(catch_unwind, getter)]
    pub fn is_geocentric(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_geocentric())
    }

    /// Whether the CRS is *local* — a `LOCAL_CS` such as an engineering grid with no
    /// relation to the Earth. It is the one kind PROJ will not transform.
    #[napi(catch_unwind, getter)]
    pub fn is_local(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_local())
    }

    /// Whether two CRSes share a geographic basis — same datum, same ellipsoid —
    /// whatever their projections are. Weaker than `equals`, which compares the whole
    /// definition.
    #[napi(catch_unwind, js_name = "isSameGeogCS")]
    pub fn is_same_geog_cs(&self, other: &JsSpatialRef) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(
            unsafe { gdal_sys::OSRIsSameGeogCS(self.inner.to_c_hsrs(), other.inner.to_c_hsrs()) }
                != 0,
        )
    }

    /// Whether two CRSes share a vertical component. `false` when either has none.
    #[napi(catch_unwind, js_name = "isSameVertCS")]
    pub fn is_same_vert_cs(&self, other: &JsSpatialRef) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(
            unsafe { gdal_sys::OSRIsSameVertCS(self.inner.to_c_hsrs(), other.inner.to_c_hsrs()) }
                != 0,
        )
    }

    /// A named attribute out of the CRS, the way `gdalinfo` reaches into a WKT —
    /// `getAttrValue('PROJCS')`, `getAttrValue('UNIT', 0)`. `null` when there is no
    /// such node; `child` defaults to 0.
    #[napi(catch_unwind)]
    pub fn get_attr_value(&self, name: String, child: Option<i32>) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let name = std::ffi::CString::new(name)
            .map_err(|_| bad_argument("an attribute name cannot contain a NUL byte"))?;
        let value = unsafe {
            gdal_sys::OSRGetAttrValue(self.inner.to_c_hsrs(), name.as_ptr(), child.unwrap_or(0))
        };
        if value.is_null() {
            return Ok(None);
        }
        Ok(Some(crate::runtime::c_string(value)))
    }

    /// Work out the CRS's EPSG code from its definition and set it, in place — for a
    /// hand-built WKT that carries no authority. A code GDAL cannot determine leaves
    /// the CRS alone rather than failing.
    #[napi(catch_unwind, js_name = "autoIdentifyEPSG")]
    pub fn auto_identify_epsg(&self) -> Result<()> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { gdal_sys::OSRAutoIdentifyEPSG(self.inner.to_c_hsrs()) };
        Ok(())
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
    /// The same transformation, in the form that can travel to a worker.
    def: TransformDef,
}

/// A transformation in a form that can cross to the thread pool.
///
/// `CoordTransform` is not `Send` — it owns a PROJ object — so a threaded call
/// cannot carry one. This carries what the two ends are *made of* instead: their
/// WKT, and the axis order in force. The WKT alone would not do, because a round
/// trip through it does not remember the mapping — and re-applying the wrong one is
/// exactly the silent failure this area is prone to, a plausible coordinate for the
/// wrong part of the world. The worker rebuilds the transform from this and nothing
/// else, which is why `build` has to put the axis order back.
#[derive(Clone)]
struct TransformDef {
    from_wkt: String,
    from_axis: AxisMappingStrategy,
    to_wkt: String,
    to_axis: AxisMappingStrategy,
    options: Option<CoordinateTransformOptions>,
}

impl TransformDef {
    /// Capture the two ends as they stand. The caller holds the GDAL lock.
    fn capture(
        from: &SpatialRef,
        to: &SpatialRef,
        options: Option<CoordinateTransformOptions>,
    ) -> Result<Self> {
        Ok(Self {
            from_wkt: from.to_wkt().gdal()?,
            from_axis: from.axis_mapping_strategy(),
            to_wkt: to.to_wkt().gdal()?,
            to_axis: to.axis_mapping_strategy(),
            options,
        })
    }

    /// Rebuild the transform where this runs. The caller holds the GDAL lock.
    fn build(&self) -> Result<CoordTransform> {
        let mut from = SpatialRef::from_wkt(&self.from_wkt).gdal()?;
        from.set_axis_mapping_strategy(self.from_axis);
        let mut to = SpatialRef::from_wkt(&self.to_wkt).gdal()?;
        to.set_axis_mapping_strategy(self.to_axis);

        match &self.options {
            None => CoordTransform::new(&from, &to),
            Some(options) => {
                CoordTransform::new_with_options(&from, &to, &build_transform_options(options)?)
            }
        }
        .gdal()
    }
}

/// How GDAL should choose the coordinate operation a `CoordinateTransform` uses.
///
/// Without one, GDAL picks the best operation it can find — which is what most
/// callers want. These are for when "best" is not the question: a specific
/// pipeline, an accuracy floor, or an area to choose by.
///
/// It is a pass-through of `OGRCoordinateTransformationOptions`; the `gdal` crate
/// wraps that type, so nothing here reaches into the C API directly.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct CoordinateTransformOptions {
    /// A specific coordinate operation, instead of the one GDAL would compute: a
    /// PROJ string (`+proj=pipeline …`), a WKT2 `CoordinateOperation`, or a
    /// `urn:ogc:def:coordinateOperation:EPSG::XXXX` URN.
    ///
    /// The pipeline has to account for the axis order of both ends, which is why
    /// this is an override rather than a hint.
    pub pipeline: Option<String>,
    /// Evaluate `pipeline` in the reverse direction. Only means something with a
    /// `pipeline`.
    pub reverse: Option<bool>,
    /// The accuracy to require, in metres. Only operations at least this good are
    /// considered. `0` asks for one made only of conversions (a projection, a unit
    /// change); a ballpark transformation has no known accuracy and is filtered
    /// out by any non-negative value.
    pub accuracy: Option<f64>,
    /// Whether PROJ may fall back to a "ballpark" transformation when no precise
    /// one is missing. Default: allowed.
    ///
    /// `false` is the strict setting, and it turns "there is no proper
    /// transformation" from a silently approximate answer into a failure.
    pub ballpark: Option<bool>,
    /// `[west, south, east, north]` in degrees, to help GDAL choose — useful where
    /// several operations exist for one pair of CRSes. The west value may be
    /// greater than the east across the antimeridian.
    pub area_of_interest: Option<Vec<f64>>,
}

/// Build GDAL's options object from the JS shape, checking what can be checked
/// before GDAL sees it.
fn build_transform_options(options: &CoordinateTransformOptions) -> Result<GdalTransformOptions> {
    let mut built = GdalTransformOptions::new().gdal()?;

    if let Some(pipeline) = &options.pipeline {
        built
            .set_coordinate_operation(pipeline, options.reverse.unwrap_or(false))
            .gdal()?;
    } else if options.reverse.is_some() {
        return Err(bad_argument(
            "`reverse` only means something alongside a `pipeline` — there is nothing to reverse",
        ));
    }

    if let Some(accuracy) = options.accuracy {
        // Positive test, because NaN fails every comparison.
        let usable = accuracy.is_finite() && accuracy >= 0.0;
        if !usable {
            return Err(bad_argument(format!(
                "an accuracy target has to be a finite number and not negative, got {accuracy}"
            )));
        }
        built.desired_accuracy(accuracy).gdal()?;
    }

    if let Some(ballpark) = options.ballpark {
        built.set_ballpark_allowed(ballpark).gdal()?;
    }

    if let Some(area) = &options.area_of_interest {
        let [west, south, east, north] = <[f64; 4]>::try_from(area.as_slice()).map_err(|_| {
            bad_argument(format!(
                "areaOfInterest takes four numbers — west, south, east, north — got {}",
                area.len()
            ))
        })?;
        built
            .set_area_of_interest(west, south, east, north)
            .gdal()?;
    }

    Ok(built)
}

#[napi]
impl JsCoordinateTransform {
    /// From a source CRS to a target one, optionally telling GDAL how to choose
    /// the operation.
    #[napi(catch_unwind, constructor)]
    pub fn new(
        from: &JsSpatialRef,
        to: &JsSpatialRef,
        options: Option<CoordinateTransformOptions>,
    ) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();

        let inner = match &options {
            None => CoordTransform::new(&from.inner, &to.inner),
            Some(options) => CoordTransform::new_with_options(
                &from.inner,
                &to.inner,
                &build_transform_options(options)?,
            ),
        }
        .gdal()?;

        // Captured now rather than on the first threaded call: it is two WKT
        // serialisations next to a `CoordTransform::new` that consults PROJ, and it
        // keeps the threaded path free of interior mutability.
        let def = TransformDef::capture(&from.inner, &to.inner, options)?;

        Ok(Self { inner, def })
    }

    /// Transform one coordinate: `[x, y]` in, `[x, y]` out.
    #[napi(catch_unwind)]
    pub fn transform_point(&self, x: f64, y: f64) -> Result<Vec<f64>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();

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
    /// which this does not carry. The whole array is moved in one call, on this
    /// thread; `transformPoints` is the same work on the pool.
    #[napi(catch_unwind, js_name = "transformPointsSync")]
    pub fn transform_points_sync(&self, points: Float64Array) -> Result<Float64Array> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Float64Array::new(transform_points_with(
            &self.inner,
            points.as_ref(),
        )?))
    }

    /// The same, on the thread pool.
    ///
    /// A million points is one call rather than a chunking loop the caller has to
    /// write, which is what the sync form would otherwise cost to stay responsive:
    /// the transform is rebuilt where the work runs, from the two CRSes and the axis
    /// order they were built with, because a `CoordTransform` cannot cross threads.
    /// Both forms run the same body, so their answers cannot drift apart.
    #[napi(catch_unwind, ts_return_type = "Promise<Float64Array>")]
    pub fn transform_points(&self, points: Float64Array) -> Result<AsyncTask<TransformPointsTask>> {
        let flat = points.as_ref();
        // Checked at the call rather than on the pool: a caller mistake should throw
        // here, not reject a promise.
        if !flat.len().is_multiple_of(2) {
            return Err(bad_argument(format!(
                "coordinates come in pairs, but the array holds {} values",
                flat.len()
            )));
        }

        Ok(AsyncTask::new(TransformPointsTask {
            def: self.def.clone(),
            points: flat.to_vec(),
        }))
    }

    /// Transform a bounding box, densifying the edges.
    ///
    /// Transforming the four corners and taking their extremes is wrong for any
    /// non-linear projection, so GDAL walks each edge with `densify` extra points.
    /// The result is a bounding box in the target CRS, which is at least as large
    /// as the true one.
    #[napi(catch_unwind)]
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

        let _guard = lock_gdal_shared();
        let out = self.inner.transform_bounds(&corners, densify).gdal()?;
        Ok(out.to_vec())
    }

    /// Transform a geometry, in and out as GeoJSON.
    ///
    /// The geometry is walked by GDAL rather than by us, so every type is handled
    /// — polygons, collections, nested rings — and so is the fact that a straight
    /// line stops being straight under most projections. Transform a feature's
    /// `geometry` and write it back if that is what you need.
    ///
    /// Synchronous, unlike `transformPoints`: a geometry is one object rather than
    /// bulk data, and this one hands back GDAL's own GeoJSON, which a threaded
    /// return cannot name a type for (`serde_json::Value` has no napi type name). The
    /// bulk case — the coordinates themselves — is the array.
    #[napi(catch_unwind)]
    pub fn transform_geometry(&self, geometry: Either<&JsGeometry, Unknown<'_>>) -> Result<Value> {
        ensure_initialized();

        // Resolved before the lock: a `Geometry`'s `toJson()` takes it itself.
        let geometry = match geometry {
            Either::A(object) => object.to_json()?,
            Either::B(unknown) => crate::vector::json_value(unknown)?,
        };

        let _guard = lock_gdal_shared();
        let geometry = crate::vector::from_geojson(&geometry)?;
        let moved = geometry.transform(&self.inner).gdal()?;
        crate::vector::to_geojson(&moved)
    }
}

type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// The body behind both point transforms — validated flat array in, flat array out.
///
/// Shared by the sync and threaded forms on purpose: they are the same operation
/// and should not be able to answer differently.
fn transform_points_with(transform: &CoordTransform, flat: &[f64]) -> Result<Vec<f64>> {
    if !flat.len().is_multiple_of(2) {
        return Err(bad_argument(format!(
            "coordinates come in pairs, but the array holds {} values",
            flat.len()
        )));
    }
    if flat.is_empty() {
        return Ok(Vec::new());
    }

    let mut xs: Vec<f64> = flat.iter().step_by(2).copied().collect();
    let mut ys: Vec<f64> = flat.iter().skip(1).step_by(2).copied().collect();
    transform
        .transform_coords(&mut xs, &mut ys, &mut [])
        .gdal()?;

    let mut out = Vec::with_capacity(flat.len());
    for (x, y) in xs.into_iter().zip(ys) {
        out.push(x);
        out.push(y);
    }
    Ok(out)
}

/// A coordinate array, transformed on the thread pool.
pub struct TransformPointsTask {
    def: TransformDef,
    points: Vec<f64>,
}

impl Task for TransformPointsTask {
    type Output = OpResult<Vec<f64>>;
    type JsValue = Float64Array;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op((|| {
            ensure_initialized();
            let _guard = lock_gdal_shared();
            let transform = self.def.build()?;
            transform_points_with(&transform, &self.points)
        })()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output
            .map(Float64Array::new)
            .map_err(|(code, reason)| into_status_error(code, reason))
    }
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
            let _guard = lock_gdal_shared();

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
#[napi(catch_unwind, ts_return_type = "Promise<string | null>")]
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

    /// The threaded path rebuilds the transform from WKT, so the axis order has to
    /// travel beside it. This is the whole risk of that path: a rebuilt transform
    /// that quietly lost the mapping would answer for the wrong place, plausibly.
    fn transformed(transform: &CoordTransform, x: f64, y: f64) -> (f64, f64) {
        let mut xs = [x];
        let mut ys = [y];
        transform
            .transform_coords(&mut xs, &mut ys, &mut [])
            .unwrap();
        (xs[0], ys[0])
    }

    fn a_pair(
        from_axis: AxisMappingStrategy,
        to_axis: AxisMappingStrategy,
    ) -> (CoordTransform, CoordTransform) {
        ensure_initialized();
        let mut from = SpatialRef::from_epsg(4326).unwrap();
        from.set_axis_mapping_strategy(from_axis);
        let mut to = SpatialRef::from_epsg(3857).unwrap();
        to.set_axis_mapping_strategy(to_axis);

        let live = CoordTransform::new(&from, &to).unwrap();
        let rebuilt = TransformDef::capture(&from, &to, None)
            .unwrap()
            .build()
            .unwrap();
        (live, rebuilt)
    }

    #[test]
    fn a_rebuilt_transform_answers_what_the_live_one_does() {
        let _guard = lock_gdal_shared();
        let (live, rebuilt) = a_pair(
            AxisMappingStrategy::TraditionalGisOrder,
            AxisMappingStrategy::TraditionalGisOrder,
        );
        assert_eq!(
            transformed(&live, 13.4, 52.5),
            transformed(&rebuilt, 13.4, 52.5)
        );
    }

    #[test]
    fn the_axis_order_really_does_travel_with_the_rebuild() {
        let _guard = lock_gdal_shared();

        let (live_traditional, rebuilt_traditional) = a_pair(
            AxisMappingStrategy::TraditionalGisOrder,
            AxisMappingStrategy::TraditionalGisOrder,
        );
        let (live_authority, rebuilt_authority) = a_pair(
            AxisMappingStrategy::AuthorityCompliant,
            AxisMappingStrategy::TraditionalGisOrder,
        );

        // Each rebuild agrees with the transform it stands in for…
        assert_eq!(
            transformed(&live_traditional, 13.4, 52.5),
            transformed(&rebuilt_traditional, 13.4, 52.5)
        );
        assert_eq!(
            transformed(&live_authority, 13.4, 52.5),
            transformed(&rebuilt_authority, 13.4, 52.5)
        );

        // …and the two orders are different answers, so this is not vacuous. Read as
        // longitude,latitude this is Berlin; read as latitude,longitude it is not.
        let (traditional_x, _) = transformed(&rebuilt_traditional, 13.4, 52.5);
        let (authority_x, _) = transformed(&rebuilt_authority, 13.4, 52.5);
        assert!(
            (traditional_x - authority_x).abs() > 1.0,
            "the two orders should not agree: {traditional_x} vs {authority_x}"
        );
    }
}
