//! `Geometry` — an OGR geometry as an object, rather than the GeoJSON plain
//! object the rest of this binding exchanges.
//!
//! The module-level `geometryToWkt` / `geometryFromWkb` / … stay exactly as they
//! were: they take and return GeoJSON, which is what `featuresSync()` hands back
//! and `createFeature` accepts. This class is the other half — something you can
//! hold, measure and transform without going through JSON on every step.
//!
//! Every call takes the process-wide lock: the operations reach into GDAL, and
//! GEOS-backed ones (see the predicate group) share its error state.

use gdal::vector::Geometry;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::error::{IntoGdalResult, Result, bad_argument};
use crate::runtime::{ensure_initialized, lock_gdal};
use crate::spatial_ref::JsSpatialRef;
use crate::vector::{from_geojson, geometry_type_name, to_geojson};

/// An axis-aligned bounding box, as `Geometry.envelope` reports it.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct GeometryEnvelope {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// A geometry.
///
/// Build one with `fromWkt`, `fromWkb` or `fromJson` (the general GeoJSON entry —
/// `fromJson({ type: 'Point', coordinates: [10, 20] })`), or from the GeoJSON a
/// feature carries. `toJson()` / `toObject()` hand back the same shape the rest of
/// the binding uses, so the two worlds meet in one call.
///
/// Everything here is a **value**: the transforms return a new `Geometry` rather
/// than mutating this one, so a geometry you have stored does not change under
/// you. `clone()` is only needed when you want two independent handles to the same
/// shape.
#[napi(js_name = "Geometry")]
pub struct JsGeometry {
    inner: Geometry,
}

impl JsGeometry {
    pub(crate) fn wrap(inner: Geometry) -> Self {
        Self { inner }
    }

    /// The raw handle. The caller holds the lock.
    fn handle(&self) -> gdal_sys::OGRGeometryH {
        unsafe { self.inner.c_geometry() }
    }
}

/// GDAL implements the predicates and algorithms below through GEOS, and a build
/// without it answers a bare `FALSE` (plus a warning) rather than refusing. So
/// each one asks first: "this build has no GEOS" is an answer a caller can act on,
/// where a wrong `false` is not.
///
/// See `docs/GEOS.md`. The bundled build links GEOS, so these work there;
/// `gdal.features().geos` is how a caller branches in a build that does not.
fn require_geos() -> Result<()> {
    if gdal::version::VersionInfo::has_geos() {
        return Ok(());
    }
    Err(bad_argument(
        "this build has no GEOS, so the geometry predicates and algorithms are unavailable \
         (gdal.features().geos is false) — see docs/GEOS.md",
    ))
}

/// Adopt a geometry GDAL just made: export it to WKB and re-parse it, so the value
/// owns itself. The `gdal` crate keeps `with_c_geometry` private, so this round
/// trip is how a C-owned handle becomes one of its `Geometry`s — cheaper than
/// hand-rolling a `Drop` for a handle this crate would then not understand.
///
/// # Safety
///
/// `handle` must be a geometry GDAL returned, owned by the caller, or null.
unsafe fn adopt(handle: gdal_sys::OGRGeometryH) -> Result<JsGeometry> {
    if handle.is_null() {
        return Err(bad_argument(
            "GDAL could not compute this geometry — one of the inputs may be invalid",
        ));
    }

    let size = unsafe { gdal_sys::OGR_G_WkbSize(handle) } as usize;
    let mut bytes = vec![0u8; size];
    let status = unsafe {
        gdal_sys::OGR_G_ExportToWkb(
            handle,
            gdal_sys::OGRwkbByteOrder::wkbNDR,
            bytes.as_mut_ptr(),
        )
    };
    unsafe { gdal_sys::OGR_G_DestroyGeometry(handle) };

    if status != 0 {
        return Err(bad_argument(
            "GDAL could not serialize the computed geometry",
        ));
    }
    Ok(JsGeometry::wrap(Geometry::from_wkb(&bytes).gdal()?))
}

#[napi]
impl JsGeometry {
    /// Parse a WKT string: `'POINT (10 20)'`, `'POLYGON ((…))'`, …
    #[napi(factory)]
    pub fn from_wkt(wkt: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(Geometry::from_wkt(&wkt).gdal()?))
    }

    /// Parse a WKB buffer, as `geometryToWkb` produces.
    #[napi(factory)]
    pub fn from_wkb(wkb: Buffer) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(Geometry::from_wkb(wkb.as_ref()).gdal()?))
    }

    /// Parse a GeoJSON geometry — the same `{ type, coordinates }` object every
    /// other part of this binding takes and returns.
    #[napi(factory)]
    pub fn from_json(geometry: Value) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(from_geojson(&geometry)?))
    }

    /// The canonical type name — `Point`, `LineString`, `Polygon`,
    /// `MultiPolygon`, `GeometryCollection`, … with a ` Z` / ` M` suffix when the
    /// coordinates carry one.
    #[napi(getter, js_name = "type")]
    pub fn geometry_type(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(geometry_type_name(self.inner.geometry_type()))
    }

    /// Whether the geometry holds nothing — an empty collection, or a ring with
    /// no points. Not the same as "absent": a `null` where a geometry is expected
    /// is `null`.
    #[napi(getter)]
    pub fn is_empty(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.is_empty())
    }

    /// GDAL's own point count — `OGR_G_GetPointCount`, which answers for a `Point`
    /// or a `LineString` and is `0` for anything else. A polygon's points live in
    /// its rings; this does not walk into them, and saying so beats returning a
    /// number that looks like an answer.
    #[napi(getter)]
    pub fn point_count(&self) -> Result<u32> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.point_count() as u32)
    }

    /// The geometry as WKT.
    #[napi]
    pub fn to_wkt(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        self.inner.wkt().gdal()
    }

    /// The geometry as WKB, as a `Buffer`.
    #[napi]
    pub fn to_wkb(&self) -> Result<Buffer> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Buffer::from(self.inner.wkb().gdal()?))
    }

    /// The geometry as a GeoJSON object — exactly what `featuresSync()` puts in a
    /// feature's `geometry`.
    #[napi]
    pub fn to_json(&self) -> Result<Value> {
        ensure_initialized();
        let _guard = lock_gdal();
        to_geojson(&self.inner)
    }

    /// The same as `toJson()`. Both names exist because one reads better at a
    /// call site than the other, and neither costs anything.
    #[napi]
    pub fn to_object(&self) -> Result<Value> {
        self.to_json()
    }

    /// The axis-aligned bounding box, or `null` for an empty geometry.
    ///
    /// Note this is the box *of this geometry*, not of any CRS: a line that
    /// crosses the antimeridian gets a box that spans the world, which is what
    /// GDAL's own envelope says too.
    #[napi]
    pub fn envelope(&self) -> Result<Option<GeometryEnvelope>> {
        ensure_initialized();
        let _guard = lock_gdal();
        if self.inner.is_empty() {
            return Ok(None);
        }
        let envelope = self.inner.envelope();
        Ok(Some(GeometryEnvelope {
            min_x: envelope.MinX,
            min_y: envelope.MinY,
            max_x: envelope.MaxX,
            max_y: envelope.MaxY,
        }))
    }

    /// Area in the square units of the geometry's coordinates. Zero for anything
    /// that is not a surface — a point or a line.
    #[napi]
    pub fn area(&self) -> Result<f64> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.area())
    }

    /// Length in the units of the geometry's coordinates: the perimeter of a
    /// polygon, the length of a line, zero for a point.
    #[napi]
    pub fn length(&self) -> Result<f64> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.inner.length())
    }

    /// A copy. Only needed when two independent handles to the same shape are
    /// wanted — nothing else here mutates in place.
    #[napi]
    pub fn clone(&self) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(Self::wrap(self.inner.clone()))
    }

    /// The same geometry with its Z coordinate dropped, as a new object.
    #[napi]
    pub fn flatten_to_2d(&self) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut flattened = self.inner.clone();
        flattened.flatten_to_2d();
        Ok(Self::wrap(flattened))
    }

    /// The same geometry with every segment no longer than `maxLength`, as a new
    /// object — `OGR_G_Segmentize`. This is what makes a line follow a projection
    /// instead of cutting the corner.
    #[napi]
    pub fn segmentize(&self, max_length: f64) -> Result<JsGeometry> {
        // Written as a positive test because NaN fails every comparison: `<= 0`
        // would let it through.
        let usable = max_length.is_finite() && max_length > 0.0;
        if !usable {
            return Err(bad_argument(format!(
                "a segment length has to be a finite number greater than zero, got {max_length}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal();
        let dense = self.inner.clone();
        unsafe { gdal_sys::OGR_G_Segmentize(dense.c_geometry(), max_length) };
        Ok(Self::wrap(dense))
    }

    /// The same geometry with X and Y exchanged, as a new object — the fix for a
    /// file whose coordinates came in the wrong order.
    #[napi(js_name = "swapXY")]
    pub fn swap_xy(&self) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal();
        let swapped = self.inner.clone();
        unsafe { gdal_sys::OGR_G_SwapXY(swapped.c_geometry()) };
        Ok(Self::wrap(swapped))
    }

    /// The geometry moved from one CRS to another, as a new object.
    ///
    /// Both ends are named because a bare OGR geometry carries no CRS of its own —
    /// unlike a dataset or a layer, which know theirs. For a feature read with
    /// `featuresSync()`, the layer's `spatialRefWkt` is the `from`.
    #[napi]
    pub fn transform(&self, from: &JsSpatialRef, to: &JsSpatialRef) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal();
        let transform = gdal::spatial_ref::CoordTransform::new(from.inner(), to.inner()).gdal()?;
        Ok(Self::wrap(self.inner.transform(&transform).gdal()?))
    }
}

/// The GEOS-backed operations — predicates, measures and the set algebra.
///
/// Every one of these asks [`require_geos`] first, so a build without GEOS answers
/// with a clear error instead of a `false` that looks like an answer. Nothing here
/// is `#[cfg]`-gated: the surface is the same in every build, and only the answer
/// differs, which is what `gdal.features().geos` exists to let a caller branch on.
#[napi]
impl JsGeometry {
    /// Whether the two geometries share any point at all.
    #[napi]
    pub fn intersects(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Intersects)
    }

    /// Whether `other` lies entirely inside this geometry.
    #[napi]
    pub fn contains(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Contains)
    }

    /// The inverse of `contains`.
    #[napi]
    pub fn within(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Within)
    }

    /// Whether the interiors cross — the relation two lines have at a point.
    #[napi]
    pub fn crosses(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Crosses)
    }

    /// Whether the two touch at their boundaries and nowhere else.
    #[napi]
    pub fn touches(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Touches)
    }

    /// Whether the two overlap without either containing the other.
    #[napi]
    pub fn overlaps(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Overlaps)
    }

    /// Whether the two share nothing at all.
    #[napi]
    pub fn disjoint(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Disjoint)
    }

    /// Whether the two are geometrically identical — which is not the same as
    /// `===`, and not the same as one spelling. Two differently-written WKTs for
    /// the same square are equal here.
    #[napi]
    pub fn equals(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Equals)
    }

    /// The shortest distance between the two, in the units of their coordinates.
    /// Zero when they intersect.
    #[napi]
    pub fn distance(&self, other: &JsGeometry) -> Result<f64> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(unsafe { gdal_sys::OGR_G_Distance(self.handle(), other.handle()) })
    }

    /// Whether the geometry is well-formed — no self-intersecting rings, no
    /// repeated points. `false` for a geometry that is merely empty is not the
    /// same thing: see `isEmpty`.
    #[napi]
    pub fn is_valid(&self) -> Result<bool> {
        self.unary(gdal_sys::OGR_G_IsValid)
    }

    /// Whether the geometry has no self-intersections — the weaker question a
    /// line can answer.
    #[napi]
    pub fn is_simple(&self) -> Result<bool> {
        self.unary(gdal_sys::OGR_G_IsSimple)
    }

    /// The area within `distance` of the geometry, as a new polygon.
    ///
    /// `quadSegments` is how many segments GDAL uses to approximate a quarter
    /// circle (default 30, as everywhere in GDAL): more is smoother and heavier.
    #[napi]
    pub fn buffer(&self, distance: f64, quad_segments: Option<i32>) -> Result<JsGeometry> {
        require_geos()?;
        if !distance.is_finite() {
            return Err(bad_argument(format!(
                "a buffer distance has to be a finite number, got {distance}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal();
        let segments = quad_segments.unwrap_or(30);
        if segments < 0 {
            return Err(bad_argument("quadSegments cannot be negative"));
        }
        unsafe { adopt(gdal_sys::OGR_G_Buffer(self.handle(), distance, segments)) }
    }

    /// The representative point of the geometry, as a new `Point`.
    #[napi]
    pub fn centroid(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal();
        // `OGR_G_Centroid` writes into a geometry it is given, rather than
        // returning one, so the output is made first.
        let output =
            unsafe { gdal_sys::OGR_G_CreateGeometry(gdal_sys::OGRwkbGeometryType::wkbPoint) };
        if output.is_null() {
            return Err(bad_argument("GDAL could not allocate a centroid geometry"));
        }
        unsafe { gdal_sys::OGR_G_Centroid(self.handle(), output) };
        unsafe { adopt(output) }
    }

    /// The smallest convex polygon containing the geometry, as a new object.
    #[napi]
    pub fn convex_hull(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal();
        unsafe { adopt(gdal_sys::OGR_G_ConvexHull(self.handle())) }
    }

    /// The geometry simplified within `tolerance`, as a new object — Douglas-Peucker.
    #[napi]
    pub fn simplify(&self, tolerance: f64) -> Result<JsGeometry> {
        require_geos()?;
        if !(tolerance.is_finite() && tolerance >= 0.0) {
            return Err(bad_argument(format!(
                "a simplify tolerance has to be a finite number and not negative, got {tolerance}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal();
        unsafe { adopt(gdal_sys::OGR_G_Simplify(self.handle(), tolerance)) }
    }

    /// The union of the two, as a new object.
    #[napi]
    pub fn union(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_Union)
    }

    /// The part the two share, as a new object.
    #[napi]
    pub fn intersection(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_Intersection)
    }

    /// The part of this geometry that `other` does not cover, as a new object.
    #[napi]
    pub fn difference(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_Difference)
    }

    /// The part covered by exactly one of the two, as a new object.
    #[napi]
    pub fn sym_difference(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_SymDifference)
    }
}

impl JsGeometry {
    /// A GEOS predicate, which is one C call and a `bool`.
    fn predicate(
        &self,
        other: &JsGeometry,
        predicate: unsafe extern "C" fn(
            gdal_sys::OGRGeometryH,
            gdal_sys::OGRGeometryH,
        ) -> std::ffi::c_int,
    ) -> Result<bool> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(unsafe { predicate(self.handle(), other.handle()) } != 0)
    }

    /// A GEOS predicate of one geometry.
    fn unary(
        &self,
        predicate: unsafe extern "C" fn(gdal_sys::OGRGeometryH) -> std::ffi::c_int,
    ) -> Result<bool> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(unsafe { predicate(self.handle()) } != 0)
    }

    /// A GEOS set operation, which returns a geometry GDAL owns until we adopt it.
    fn overlay(
        &self,
        other: &JsGeometry,
        overlay: unsafe extern "C" fn(
            gdal_sys::OGRGeometryH,
            gdal_sys::OGRGeometryH,
        ) -> gdal_sys::OGRGeometryH,
    ) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal();
        unsafe { adopt(overlay(self.handle(), other.handle())) }
    }
}
