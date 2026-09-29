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
