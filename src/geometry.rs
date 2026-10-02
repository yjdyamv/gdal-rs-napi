//! `Geometry` — an OGR geometry as an object, rather than the GeoJSON plain
//! object the rest of this binding exchanges.
//!
//! The module-level `geometryToWkt` / `geometryFromWkb` / … stay exactly as they
//! were: they take and return GeoJSON, which is what `featuresSync()` hands back
//! and `createFeature` accepts. This class is the other half — something you can
//! hold, measure and transform without going through JSON on every step.
//!
//! Every call takes the **shared** side of the GDAL lock. A geometry is a plain
//! object with no dataset behind it, `OGRGeometry::createGEOSContext()` gives each
//! GEOS call its own context, and the last-error slot is thread-local — so two of
//! these run at once without touching each other. See `runtime` for the split.

use std::ffi::{CString, c_char};

use gdal::vector::{Geometry, OGRwkbGeometryType, geometry_type_flatten, geometry_type_has_z};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::Value;

use crate::error::{IntoGdalResult, Result, bad_argument, driver_failure};
use crate::runtime::{ensure_initialized, lock_gdal_shared};
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

    /// Which accessor applies to this geometry. Reads the *flattened* type, so a
    /// `Point Z` is still a `Point` and a `LinearRing` is still a `Line`.
    fn kind(&self) -> GeometryKind {
        match geometry_type_flatten(self.inner.geometry_type()) {
            OGRwkbGeometryType::wkbPoint => GeometryKind::Point,
            OGRwkbGeometryType::wkbLineString => GeometryKind::Line,
            OGRwkbGeometryType::wkbPolygon => GeometryKind::Polygon,
            OGRwkbGeometryType::wkbMultiPoint
            | OGRwkbGeometryType::wkbMultiLineString
            | OGRwkbGeometryType::wkbMultiPolygon
            | OGRwkbGeometryType::wkbGeometryCollection => GeometryKind::Collection,
            _ => GeometryKind::Other,
        }
    }

    /// Whether the coordinates carry a Z, so a 2D point reports no `z` rather than
    /// a `0` that looks like a height.
    fn has_z(&self) -> bool {
        geometry_type_has_z(self.inner.geometry_type())
    }

    /// One coordinate of a `Point`, by axis. `null` for any other shape, so the
    /// three accessors are safe to read without a type check.
    fn point_scalar(
        &self,
        axis: unsafe extern "C" fn(gdal_sys::OGRGeometryH, std::ffi::c_int) -> f64,
    ) -> Result<Option<f64>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() != GeometryKind::Point {
            return Ok(None);
        }
        Ok(Some(unsafe { axis(self.handle(), 0) }))
    }
}

/// Which shape-specific accessor applies to a geometry.
///
/// A geometry is one of these, so `points` on a polygon is `null` rather than a
/// wrong answer, and a caller can read any accessor without asking the type
/// first. `type` stays the exact answer when one is needed.
#[derive(PartialEq, Eq, Clone, Copy)]
enum GeometryKind {
    Point,
    /// `LineString`, and `LinearRing` — GDAL flattens the ring to a line.
    Line,
    Polygon,
    /// `MultiPoint`, `MultiLineString`, `MultiPolygon` or `GeometryCollection`.
    Collection,
    Other,
}

/// A geometry's own points, each as `[x, y]` or `[x, y, z]`.
fn point_list(handle: gdal_sys::OGRGeometryH, has_z: bool) -> Vec<Vec<f64>> {
    let count = unsafe { gdal_sys::OGR_G_GetPointCount(handle) };
    let mut points = Vec::with_capacity(count.max(0) as usize);
    for index in 0..count {
        let mut point = vec![unsafe { gdal_sys::OGR_G_GetX(handle, index) }, unsafe {
            gdal_sys::OGR_G_GetY(handle, index)
        }];
        if has_z {
            point.push(unsafe { gdal_sys::OGR_G_GetZ(handle, index) });
        }
        points.push(point);
    }
    points
}

/// A polygon's rings. Ring 0 is the exterior one — GDAL keeps them in order.
fn ring_list(handle: gdal_sys::OGRGeometryH, has_z: bool) -> Vec<Vec<Vec<f64>>> {
    let count = unsafe { gdal_sys::OGR_G_GetGeometryCount(handle) };
    let mut rings = Vec::with_capacity(count.max(0) as usize);
    for index in 0..count {
        let ring = unsafe { gdal_sys::OGR_G_GetGeometryRef(handle, index) };
        if ring.is_null() {
            continue;
        }
        rings.push(point_list(ring, has_z));
    }
    rings
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
        return Err(driver_failure(
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
        return Err(driver_failure(
            "GDAL could not serialize the computed geometry",
        ));
    }
    Ok(JsGeometry::wrap(
        Geometry::from_wkb(&bytes).gdal_context("adopt")?,
    ))
}

/// Adopt a geometry GDAL handed over, taking ownership of `handle`.
///
/// The same WKB round trip [`adopt`] makes, exposed for the callers outside this
/// module — a layer's spatial filter is a handle the layer owns, so it is cloned
/// first and the clone handed here.
pub(crate) fn adopt_handle(handle: gdal_sys::OGRGeometryH) -> Result<JsGeometry> {
    unsafe { adopt(handle) }
}

/// Copy a string GDAL allocated and release it.
///
/// `OGR_G_ExportToGML` / `ExportToKML` hand back `CPLMalloc`'d memory the caller
/// owns; `CPLFree` is `VSIFree` in GDAL's own headers, and that is the symbol bound
/// here.
fn take_owned_string(ptr: *mut c_char) -> String {
    let text = crate::runtime::c_string(ptr);
    if !ptr.is_null() {
        unsafe { gdal_sys::VSIFree(ptr.cast()) };
    }
    text
}

#[napi]
impl JsGeometry {
    /// Parse a WKT string: `'POINT (10 20)'`, `'POLYGON ((…))'`, …
    #[napi(catch_unwind, factory)]
    pub fn from_wkt(wkt: String) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(
            Geometry::from_wkt(&wkt).gdal_context("from_wkt")?,
        ))
    }

    /// Parse a WKB buffer, as `geometryToWkb` produces.
    #[napi(catch_unwind, factory)]
    pub fn from_wkb(wkb: Buffer) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(
            Geometry::from_wkb(wkb.as_ref()).gdal_context("from_wkb")?,
        ))
    }

    /// Parse a GeoJSON geometry — the same `{ type, coordinates }` object every
    /// other part of this binding takes and returns.
    #[napi(catch_unwind, factory)]
    pub fn from_json(geometry: Value) -> Result<Self> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(from_geojson(&geometry)?))
    }

    /// The canonical type name — `Point`, `LineString`, `Polygon`,
    /// `MultiPolygon`, `GeometryCollection`, … with a ` Z` / ` M` suffix when the
    /// coordinates carry one.
    #[napi(catch_unwind, getter, js_name = "type")]
    pub fn geometry_type(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(geometry_type_name(self.inner.geometry_type()))
    }

    /// Whether the geometry holds nothing — an empty collection, or a ring with
    /// no points. Not the same as "absent": a `null` where a geometry is expected
    /// is `null`.
    #[napi(catch_unwind, getter)]
    pub fn is_empty(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.is_empty())
    }

    /// GDAL's own point count — `OGR_G_GetPointCount`, which answers for a `Point`
    /// or a `LineString` and is `0` for anything else. A polygon's points live in
    /// its rings; this does not walk into them, and saying so beats returning a
    /// number that looks like an answer.
    #[napi(catch_unwind, getter)]
    pub fn point_count(&self) -> Result<u32> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.point_count() as u32)
    }

    /// The geometry as WKT.
    #[napi(catch_unwind)]
    pub fn to_wkt(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        self.inner.wkt().gdal()
    }

    /// The geometry as WKB, as a `Buffer`.
    #[napi(catch_unwind)]
    pub fn to_wkb(&self) -> Result<Buffer> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Buffer::from(self.inner.wkb().gdal_context("to_wkb")?))
    }

    /// The geometry as a GeoJSON object — exactly what `featuresSync()` puts in a
    /// feature's `geometry`.
    #[napi(catch_unwind)]
    pub fn to_json(&self) -> Result<Value> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        to_geojson(&self.inner)
    }

    /// The same as `toJson()`. Both names exist because one reads better at a
    /// call site than the other, and neither costs anything.
    #[napi(catch_unwind)]
    pub fn to_object(&self) -> Result<Value> {
        self.to_json()
    }

    /// This geometry's coordinates, as GeoJSON nests them: a `Point` is
    /// `[x, y]`, a `LineString` a list of those, a `Polygon` a list of rings, and
    /// a `Multi*` one level deeper. `null` for a `GeometryCollection`, whose parts
    /// are geometries rather than coordinates — read `children` there.
    ///
    /// Typed as `any` because the nesting depth is the geometry's type; the
    /// accessors below are the typed way to the same numbers.
    #[napi(catch_unwind, getter)]
    pub fn coordinates(&self) -> Result<Option<Value>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() == GeometryKind::Collection {
            return Ok(None);
        }
        Ok(to_geojson(&self.inner)?.get("coordinates").cloned())
    }

    /// A `Point`'s x, or `null` — for every other shape this is `null` rather than
    /// a wrong number, so it can be read without checking `type` first.
    #[napi(catch_unwind, getter)]
    pub fn x(&self) -> Result<Option<f64>> {
        self.point_scalar(gdal_sys::OGR_G_GetX)
    }

    /// A `Point`'s y. `null` for anything else.
    #[napi(catch_unwind, getter)]
    pub fn y(&self) -> Result<Option<f64>> {
        self.point_scalar(gdal_sys::OGR_G_GetY)
    }

    /// A `Point`'s z — `null` unless the geometry actually carries a Z, so a 2D
    /// point reports nothing rather than a `0` that reads like a height.
    #[napi(catch_unwind, getter)]
    pub fn z(&self) -> Result<Option<f64>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() != GeometryKind::Point || !self.has_z() {
            return Ok(None);
        }
        Ok(Some(unsafe { gdal_sys::OGR_G_GetZ(self.handle(), 0) }))
    }

    /// The point list of a `Point`, `LineString` or `LinearRing` — each point as
    /// `[x, y]`, or `[x, y, z]` when the geometry carries a Z. A `Point` yields
    /// one. `null` for a polygon or a collection, which have `rings` and
    /// `children` instead.
    #[napi(catch_unwind)]
    pub fn points(&self) -> Result<Option<Vec<Vec<f64>>>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if !matches!(self.kind(), GeometryKind::Point | GeometryKind::Line) {
            return Ok(None);
        }
        Ok(Some(point_list(self.handle(), self.has_z())))
    }

    /// A polygon's rings, exterior first, each ring a point list. `null` for
    /// anything that is not a polygon.
    #[napi(catch_unwind)]
    pub fn rings(&self) -> Result<Option<Vec<Vec<Vec<f64>>>>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() != GeometryKind::Polygon {
            return Ok(None);
        }
        Ok(Some(ring_list(self.handle(), self.has_z())))
    }

    /// A polygon's exterior ring — the same as `rings[0]`. `null` for anything
    /// else, including a polygon with no rings at all.
    #[napi(catch_unwind, getter)]
    pub fn exterior_ring(&self) -> Result<Option<Vec<Vec<f64>>>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() != GeometryKind::Polygon {
            return Ok(None);
        }
        Ok(ring_list(self.handle(), self.has_z()).into_iter().next())
    }

    /// A polygon's holes, in order. `[]` for a polygon that has none — an answer
    /// rather than an absence — and `null` for anything that is not a polygon.
    #[napi(catch_unwind, getter)]
    pub fn interior_rings(&self) -> Result<Option<Vec<Vec<Vec<f64>>>>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() != GeometryKind::Polygon {
            return Ok(None);
        }
        Ok(Some(
            ring_list(self.handle(), self.has_z())
                .into_iter()
                .skip(1)
                .collect(),
        ))
    }

    /// The parts of a `MultiPoint` / `MultiLineString` / `MultiPolygon` /
    /// `GeometryCollection`, as `Geometry` objects. `null` for a single geometry.
    ///
    /// Each part is **copied out** of GDAL, so it stays valid on its own — and so
    /// a caller can walk a tree without worrying about which handle owns what.
    #[napi(catch_unwind)]
    pub fn children(&self) -> Result<Option<Vec<JsGeometry>>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        if self.kind() != GeometryKind::Collection {
            return Ok(None);
        }

        let count = unsafe { gdal_sys::OGR_G_GetGeometryCount(self.handle()) };
        let mut children = Vec::with_capacity(count.max(0) as usize);
        for index in 0..count {
            // `OGR_G_GetGeometryRef` lends the part; the clone is what we own.
            let part = unsafe { gdal_sys::OGR_G_GetGeometryRef(self.handle(), index) };
            if part.is_null() {
                continue;
            }
            children.push(unsafe { adopt(gdal_sys::OGR_G_Clone(part)) }?);
        }
        Ok(Some(children))
    }

    /// The axis-aligned bounding box, or `null` for an empty geometry.
    ///
    /// Note this is the box *of this geometry*, not of any CRS: a line that
    /// crosses the antimeridian gets a box that spans the world, which is what
    /// GDAL's own envelope says too.
    #[napi(catch_unwind)]
    pub fn envelope(&self) -> Result<Option<GeometryEnvelope>> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
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
    #[napi(catch_unwind)]
    pub fn area(&self) -> Result<f64> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.area())
    }

    /// Length in the units of the geometry's coordinates: the perimeter of a
    /// polygon, the length of a line, zero for a point.
    #[napi(catch_unwind)]
    pub fn length(&self) -> Result<f64> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(self.inner.length())
    }

    /// A copy. Only needed when two independent handles to the same shape are
    /// wanted — nothing else here mutates in place.
    #[napi(catch_unwind)]
    pub fn clone(&self) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(Self::wrap(self.inner.clone()))
    }

    /// The same geometry with its Z coordinate dropped, as a new object.
    #[napi(catch_unwind)]
    pub fn flatten_to_2d(&self) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let mut flattened = self.inner.clone();
        flattened.flatten_to_2d();
        Ok(Self::wrap(flattened))
    }

    /// The same geometry with every segment no longer than `maxLength`, as a new
    /// object — `OGR_G_Segmentize`. This is what makes a line follow a projection
    /// instead of cutting the corner.
    #[napi(catch_unwind)]
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
        let _guard = lock_gdal_shared();
        let dense = self.inner.clone();
        unsafe { gdal_sys::OGR_G_Segmentize(dense.c_geometry(), max_length) };
        Ok(Self::wrap(dense))
    }

    /// The same geometry with X and Y exchanged, as a new object — the fix for a
    /// file whose coordinates came in the wrong order.
    #[napi(catch_unwind, js_name = "swapXY")]
    pub fn swap_xy(&self) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let swapped = self.inner.clone();
        unsafe { gdal_sys::OGR_G_SwapXY(swapped.c_geometry()) };
        Ok(Self::wrap(swapped))
    }

    /// The geometry moved from one CRS to another, as a new object.
    ///
    /// Both ends are named because a bare OGR geometry carries no CRS of its own —
    /// unlike a dataset or a layer, which know theirs. For a feature read with
    /// `featuresSync()`, the layer's `spatialRefWkt` is the `from`.
    #[napi(catch_unwind)]
    pub fn transform(&self, from: &JsSpatialRef, to: &JsSpatialRef) -> Result<JsGeometry> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let transform = gdal::spatial_ref::CoordTransform::new(from.inner(), to.inner())
            .gdal_context("transform")?;
        Ok(Self::wrap(
            self.inner.transform(&transform).gdal_context("transform")?,
        ))
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
    #[napi(catch_unwind)]
    pub fn intersects(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Intersects)
    }

    /// Whether `other` lies entirely inside this geometry.
    #[napi(catch_unwind)]
    pub fn contains(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Contains)
    }

    /// The inverse of `contains`.
    #[napi(catch_unwind)]
    pub fn within(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Within)
    }

    /// Whether the interiors cross — the relation two lines have at a point.
    #[napi(catch_unwind)]
    pub fn crosses(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Crosses)
    }

    /// Whether the two touch at their boundaries and nowhere else.
    #[napi(catch_unwind)]
    pub fn touches(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Touches)
    }

    /// Whether the two overlap without either containing the other.
    #[napi(catch_unwind)]
    pub fn overlaps(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Overlaps)
    }

    /// Whether the two share nothing at all.
    #[napi(catch_unwind)]
    pub fn disjoint(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Disjoint)
    }

    /// Whether the two are geometrically identical — which is not the same as
    /// `===`, and not the same as one spelling. Two differently-written WKTs for
    /// the same square are equal here.
    #[napi(catch_unwind)]
    pub fn equals(&self, other: &JsGeometry) -> Result<bool> {
        self.predicate(other, gdal_sys::OGR_G_Equals)
    }

    /// The shortest distance between the two, in the units of their coordinates.
    /// Zero when they intersect.
    #[napi(catch_unwind)]
    pub fn distance(&self, other: &JsGeometry) -> Result<f64> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(unsafe { gdal_sys::OGR_G_Distance(self.handle(), other.handle()) })
    }

    /// Whether the geometry is well-formed — no self-intersecting rings, no
    /// repeated points. `false` for a geometry that is merely empty is not the
    /// same thing: see `isEmpty`.
    #[napi(catch_unwind)]
    pub fn is_valid(&self) -> Result<bool> {
        self.unary(gdal_sys::OGR_G_IsValid)
    }

    /// Whether the geometry has no self-intersections — the weaker question a
    /// line can answer.
    #[napi(catch_unwind)]
    pub fn is_simple(&self) -> Result<bool> {
        self.unary(gdal_sys::OGR_G_IsSimple)
    }

    /// The area within `distance` of the geometry, as a new polygon.
    ///
    /// `quadSegments` is how many segments GDAL uses to approximate a quarter
    /// circle (default 30, as everywhere in GDAL): more is smoother and heavier.
    #[napi(catch_unwind)]
    pub fn buffer(&self, distance: f64, quad_segments: Option<i32>) -> Result<JsGeometry> {
        require_geos()?;
        if !distance.is_finite() {
            return Err(bad_argument(format!(
                "a buffer distance has to be a finite number, got {distance}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let segments = quad_segments.unwrap_or(30);
        if segments < 0 {
            return Err(bad_argument("quadSegments cannot be negative"));
        }
        unsafe { adopt(gdal_sys::OGR_G_Buffer(self.handle(), distance, segments)) }
    }

    /// The representative point of the geometry, as a new `Point`.
    #[napi(catch_unwind)]
    pub fn centroid(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        // `OGR_G_Centroid` writes into a geometry it is given, rather than
        // returning one, so the output is made first.
        let output =
            unsafe { gdal_sys::OGR_G_CreateGeometry(gdal_sys::OGRwkbGeometryType::wkbPoint) };
        if output.is_null() {
            return Err(driver_failure(
                "GDAL could not allocate a centroid geometry",
            ));
        }
        unsafe { gdal_sys::OGR_G_Centroid(self.handle(), output) };
        unsafe { adopt(output) }
    }

    /// The smallest convex polygon containing the geometry, as a new object.
    #[napi(catch_unwind)]
    pub fn convex_hull(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_ConvexHull(self.handle())) }
    }

    /// The geometry simplified within `tolerance`, as a new object — Douglas-Peucker.
    #[napi(catch_unwind)]
    pub fn simplify(&self, tolerance: f64) -> Result<JsGeometry> {
        require_geos()?;
        if !(tolerance.is_finite() && tolerance >= 0.0) {
            return Err(bad_argument(format!(
                "a simplify tolerance has to be a finite number and not negative, got {tolerance}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_Simplify(self.handle(), tolerance)) }
    }

    /// The union of the two, as a new object.
    #[napi(catch_unwind)]
    pub fn union(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_Union)
    }

    /// The part the two share, as a new object.
    #[napi(catch_unwind)]
    pub fn intersection(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_Intersection)
    }

    /// The part of this geometry that `other` does not cover, as a new object.
    #[napi(catch_unwind)]
    pub fn difference(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_Difference)
    }

    /// The part covered by exactly one of the two, as a new object.
    #[napi(catch_unwind)]
    pub fn sym_difference(&self, other: &JsGeometry) -> Result<JsGeometry> {
        self.overlay(other, gdal_sys::OGR_G_SymDifference)
    }

    /// Whether the geometry is a ring — closed and not self-intersecting, the
    /// question a `LinearRing` answers yes to. No GEOS needed.
    #[napi(catch_unwind)]
    pub fn is_ring(&self) -> Result<bool> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(unsafe { gdal_sys::OGR_G_IsRing(self.handle()) } != 0)
    }

    /// A valid version of the geometry, as a new object — GEOS's repair for a
    /// self-intersecting polygon.
    #[napi(catch_unwind)]
    pub fn make_valid(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_MakeValid(self.handle())) }
    }

    /// The boundary of the geometry, as a new object: a polygon's rings, a line's
    /// endpoints. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn boundary(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_Boundary(self.handle())) }
    }

    /// The geometry simplified within `tolerance` while keeping its topology —
    /// `simplify`'s shape-preserving cousin. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn simplify_preserve_topology(&self, tolerance: f64) -> Result<JsGeometry> {
        require_geos()?;
        if !(tolerance.is_finite() && tolerance >= 0.0) {
            return Err(bad_argument(format!(
                "a simplify tolerance has to be a finite number and not negative, got {tolerance}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe {
            adopt(gdal_sys::OGR_G_SimplifyPreserveTopology(
                self.handle(),
                tolerance,
            ))
        }
    }

    /// A point guaranteed to lie on the geometry, as a new `Point` — the
    /// representative point `centroid` is not: a centroid can fall outside a
    /// concave shape. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn point_on_surface(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_PointOnSurface(self.handle())) }
    }

    /// The union of the parts of a collection, as one geometry, without a second
    /// operand — `union` for a geometry that is already many. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn unary_union(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_UnaryUnion(self.handle())) }
    }

    /// The union of every polygon in this geometry — OGR's `UnionCascaded`, which is
    /// what a `MULTIPOLYGON` wants and is cheaper than folding `union()` over the parts.
    /// The reference exposes it under this name. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn union_cascaded(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_UnionCascaded(self.handle())) }
    }

    /// A concave hull around the geometry: the tight shape `convexHull` is too
    /// generous to be. `ratio` runs from 0 (tightest) to 1 (the convex hull);
    /// `allowHoles` defaults to false. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn concave_hull(&self, ratio: f64, allow_holes: Option<bool>) -> Result<JsGeometry> {
        require_geos()?;
        if !(ratio.is_finite() && (0.0..=1.0).contains(&ratio)) {
            return Err(bad_argument(format!(
                "a concave hull ratio is between 0 and 1, got {ratio}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe {
            adopt(gdal_sys::OGR_G_ConcaveHull(
                self.handle(),
                ratio,
                allow_holes.unwrap_or(false),
            ))
        }
    }

    /// The geometry put into a canonical form — rings wound the same way, points
    /// where GEOS would put them — as a new object. Same shape, standard spelling;
    /// needed when two geometries are to be compared byte for byte. Requires GEOS.
    #[napi(catch_unwind)]
    pub fn normalize(&self) -> Result<JsGeometry> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_Normalize(self.handle())) }
    }

    /// The geometry snapped to a `grid_size` precision grid, as a new object — how
    /// points an epsilon apart are made to be the same point. Needs GEOS.
    #[napi(catch_unwind)]
    pub fn set_precision(&self, grid_size: f64) -> Result<JsGeometry> {
        require_geos()?;
        if !(grid_size.is_finite() && grid_size >= 0.0) {
            return Err(bad_argument(format!(
                "a precision grid size has to be a finite number and not negative, got {grid_size}"
            )));
        }
        ensure_initialized();
        let _guard = lock_gdal_shared();
        unsafe { adopt(gdal_sys::OGR_G_SetPrecision(self.handle(), grid_size, 0)) }
    }

    /// The geometry as GML — the XML encoding OGR can also read. No GEOS needed.
    #[napi(catch_unwind, js_name = "toGML")]
    pub fn to_gml(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        Ok(take_owned_string(unsafe {
            gdal_sys::OGR_G_ExportToGML(self.handle())
        }))
    }

    /// The geometry as KML. `altitudeMode` is KML's own (`'clampToGround'`,
    /// `'relativeToGround'`, `'absolute'`); omit it for GDAL's default.
    #[napi(catch_unwind, js_name = "toKML")]
    pub fn to_kml(&self, altitude_mode: Option<String>) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal_shared();
        let mode = altitude_mode
            .map(CString::new)
            .transpose()
            .map_err(|_| bad_argument("an altitude mode cannot contain a NUL byte"))?;
        Ok(take_owned_string(unsafe {
            gdal_sys::OGR_G_ExportToKML(
                self.handle(),
                mode.as_ref().map_or(std::ptr::null(), |text| text.as_ptr()),
            )
        }))
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
        let _guard = lock_gdal_shared();
        Ok(unsafe { predicate(self.handle(), other.handle()) } != 0)
    }

    /// A GEOS predicate of one geometry.
    fn unary(
        &self,
        predicate: unsafe extern "C" fn(gdal_sys::OGRGeometryH) -> std::ffi::c_int,
    ) -> Result<bool> {
        require_geos()?;
        ensure_initialized();
        let _guard = lock_gdal_shared();
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
        let _guard = lock_gdal_shared();
        unsafe { adopt(overlay(self.handle(), other.handle())) }
    }
}
