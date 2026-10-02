//! Vector layers: reading features, their attributes and their geometry.
//!
//! Features are **materialised** into plain JS data rather than wrapped. A
//! `gdal::vector::Feature<'a>` borrows its layer, which borrows the dataset, so
//! handing one to JS would mean keeping three lifetimes and a GDAL handle alive
//! behind the user's back — and a `Feature`'s geometry is lazily populated, so it
//! is only valid while the feature lives. Copying the fields out removes the
//! whole class of problems, and the values are what JS wants anyway.

use std::collections::HashSet;
use std::ffi::{CString, c_int};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use gdal::Dataset as GdalDataset;
use gdal::Metadata;
use gdal::errors::GdalError;
use gdal::vector::{
    Defn, Feature, FieldDefn, FieldValue, LayerAccess, OGRFieldType, OGRwkbGeometryType,
    geometry_type_flatten, geometry_type_has_m, geometry_type_has_z,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use serde_json::{Map, Value};

use crate::dataset::DatasetRef;
use crate::error::{
    GdalErrorCode, IntoGdalResult, Result, bad_argument, gdal_error, into_status_error, split,
};
use crate::geometry::JsGeometry;
use crate::json::{is_scalar, json_f64, json_i64, json_joined_text, json_text};
use crate::runtime::{ensure_initialized, lock_gdal_shared};
use crate::spatial_ref::JsSpatialRef;

/// One attribute of a layer.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FieldInfo {
    pub name: String,
    /// GDAL's name for the field type, e.g. `String`, `Integer64`, `RealList`.
    pub field_type: String,
    pub width: i32,
    pub precision: i32,
    /// Whether the field accepts `NULL`. Independent of the *value* being `null`:
    /// a non-nullable field with nothing written reads back as the driver's
    /// default, not as `null`.
    pub nullable: bool,
    /// Whether the driver enforces uniqueness on the field. Few drivers do, and
    /// GDAL itself does not check it, so read it as a declared intent.
    pub unique: bool,
    /// The default, **as text** — GDAL stores a field's default as a string
    /// whatever the field's type, so an `Integer` default reads back as `'0'`. That
    /// is also the value a caller gets here to hand back to `FieldDefinition`.
    ///
    /// `null` when the field has none, which is a `Value` rather than an
    /// `Option<String>` so that "no default" is an explicit `null` rather than a
    /// property that is merely absent — the same reason `FeatureRecord.fid` is one.
    #[napi(ts_type = "string | null")]
    pub default_value: Value,
    /// `Undefined`, `Left` or `Right`: how a display should align the field. A
    /// rendering hint rather than a constraint.
    pub justification: String,
}

/// A field to declare when creating a layer.
///
/// Declaring fields is how a layer gets a schema before it has any features, and
/// how a type is *chosen* rather than inferred from whatever the first feature
/// happened to carry — an `Integer` stays an `Integer` even though JS numbers
/// would otherwise infer `Integer64`. A `StringList` field is also the way to get
/// a real list column, since inference deliberately writes joined text instead.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FieldDefinition {
    pub name: String,
    /// The same vocabulary `fields` reports: `String`, `Integer`, `Integer64`,
    /// `Real`, `Date`, `DateTime`, `Time`, `Binary`, the `…List` forms and the
    /// `WideString` pair.
    pub field_type: String,
    /// Driver-dependent, and left alone when omitted. GeoPackage keeps the width
    /// and ignores the precision, because SQLite stores every number as a float
    /// and has nothing for a precision to describe.
    pub width: Option<i32>,
    pub precision: Option<i32>,
    /// Whether the field accepts `NULL`. Left alone when omitted, which means the
    /// driver's own default — usually nullable.
    pub nullable: Option<bool>,
    /// Declare the field unique. Few drivers enforce it.
    pub unique: Option<bool>,
    /// A default value, written as text — GDAL's own representation, so an integer
    /// default is the string `'0'`. Omit for no default.
    pub default_value: Option<String>,
    /// `Undefined` (default), `Left` or `Right`.
    pub justification: Option<String>,
}

/// A feature, copied out of GDAL.
///
/// `fid` and `geometry` are `Value` rather than `Option` so that "absent" is an
/// explicit `null`. `napi` turns `None` into a *missing* property (`undefined`),
/// which would sit oddly next to `properties`, where a SQL `NULL` already shows
/// up as `null`.
#[napi(object)]
pub struct FeatureRecord {
    /// The feature id, or `null` when the driver does not expose one.
    pub fid: Value,
    /// Field name to value. A `NULL` field is present with the value `null`,
    /// which is how you tell it apart from a field that does not exist.
    pub properties: Value,
    /// The geometry as GeoJSON, or `null` when the feature has none.
    pub geometry: Value,
}

#[napi(js_name = "Layer")]
pub struct JsLayer {
    dataset: DatasetRef,
    index: usize,
}

impl JsLayer {
    pub fn new(dataset: DatasetRef, index: usize) -> Self {
        Self { dataset, index }
    }

    /// The dataset this layer belongs to.
    ///
    /// For the operations that need two datasets at once — see
    /// [`crate::dataset::with_two`] — rather than a fourth way to reach the layer
    /// itself.
    pub(crate) fn dataset(&self) -> &DatasetRef {
        &self.dataset
    }

    /// Write this layer's pending changes to disk. The dataset `flush()` covers the
    /// whole file; this is the per-layer one a bulk write into one layer wants.
    fn flush_pending(&self) -> Result<()> {
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("flush_pending")?;
            ogr_result(
                unsafe { gdal_sys::OGR_L_SyncToDisk(layer.c_layer()) },
                "flush the layer",
            )
        })
    }
}

/// Pull one feature across the FFI boundary.
fn to_record(feature: &Feature<'_>, field_names: &[String]) -> Result<FeatureRecord> {
    let mut properties = Map::with_capacity(field_names.len());
    for (index, name) in field_names.iter().enumerate() {
        let value = match feature.field(index).gdal_context("to_record")? {
            // The `gdal` crate pulls chrono in without its `alloc` feature, so
            // the date types cannot be formatted here. Let GDAL render them —
            // it already knows the field's date format.
            Some(FieldValue::DateValue(_)) | Some(FieldValue::DateTimeValue(_)) => feature
                .field_as_string(index)
                .gdal_context("to_record")?
                .map_or(Value::Null, Value::from),
            other => field_value_to_json(other),
        };
        properties.insert(name.clone(), value);
    }

    // A feature may have no geometry, and `Feature::geometry()` still returns
    // `Some` for it: it lazily fills the wrapper from `OGR_F_GetGeometryRef`,
    // which hands back NULL. Exporting that asks GDAL to serialise nothing and
    // fails.
    //
    // `Geometry::has_gdal_ptr()` cannot be used to tell the difference — upstream
    // `set_c_geometry` stores `Some(ptr)` unconditionally, so a NULL geometry
    // still reports `true`. Ask GDAL directly instead.
    let has_geometry = unsafe { !gdal_sys::OGR_F_GetGeometryRef(feature.c_feature()).is_null() };
    let geometry = if has_geometry {
        // This call is what populates the wrapper's pointer.
        match feature.geometry() {
            Some(geometry) => to_geojson(geometry)?,
            None => Value::Null,
        }
    } else {
        Value::Null
    };

    Ok(FeatureRecord {
        fid: feature
            .fid()
            .map_or(Value::Null, |fid| Value::from(fid as i64)),
        properties: Value::Object(properties),
        geometry,
    })
}

fn field_value_to_json(value: Option<FieldValue>) -> Value {
    match value {
        None => Value::Null,
        Some(FieldValue::IntegerValue(v)) => Value::from(v),
        Some(FieldValue::IntegerListValue(v)) => Value::from(v),
        Some(FieldValue::Integer64Value(v)) => Value::from(v),
        Some(FieldValue::Integer64ListValue(v)) => Value::from(v),
        Some(FieldValue::StringValue(v)) => Value::from(v),
        Some(FieldValue::StringListValue(v)) => Value::from(v),
        Some(FieldValue::RealValue(v)) => Value::from(v),
        Some(FieldValue::RealListValue(v)) => Value::from(v),
        // `to_record` intercepts these and asks GDAL to render them, because the
        // `gdal` crate pulls chrono in without its `alloc` feature, so the date
        // types cannot be formatted here. Reaching this arm would mean the
        // interception was bypassed, so returning `null` is deliberate.
        Some(FieldValue::DateValue(_)) | Some(FieldValue::DateTimeValue(_)) => Value::Null,
    }
}

fn layer_field_names(layer: &impl LayerAccess) -> Vec<String> {
    layer.defn().fields().map(|field| field.name()).collect()
}

/// A field's **0-based** index in the layer's schema, by name.
///
/// OGR's own `OGR_L_GetFieldIndex` answers a negative number for a miss, and the
/// message a caller needs is the list of names that *would* have worked.
fn field_position(layer: &impl LayerAccess, name: &str) -> Result<c_int> {
    let names = layer_field_names(layer);
    names
        .iter()
        .position(|candidate| candidate == name)
        .map(|index| index as c_int)
        .ok_or_else(|| {
            bad_argument(format!(
                "no field named {name:?}; the layer has {}",
                names.join(", ")
            ))
        })
}

/// The layer's fields as `(name, type)` pairs.
///
/// The type is needed when writing: several drivers have no list columns and
/// quietly downgrade a list field to a scalar one, so the *field* has to decide
/// which setter is used.
fn layer_fields(layer: &impl LayerAccess) -> Vec<(String, OGRFieldType::Type)> {
    layer
        .defn()
        .fields()
        .map(|field| (field.name(), field.field_type()))
        .collect()
}

/// `OGRFieldType::Type` is a `c_uint` alias, not a Rust enum, so it has no
/// `Debug` worth printing — formatting it yields a bare number. Map it to the
/// names GDAL itself uses (`OGR_GetFieldTypeName` returns the same vocabulary).
fn field_type_name(field_type: gdal_sys::OGRFieldType::Type) -> String {
    use gdal_sys::OGRFieldType as OFT;

    let name = match field_type {
        OFT::OFTInteger => "Integer",
        OFT::OFTIntegerList => "IntegerList",
        OFT::OFTReal => "Real",
        OFT::OFTRealList => "RealList",
        OFT::OFTString => "String",
        OFT::OFTStringList => "StringList",
        OFT::OFTWideString => "WideString",
        OFT::OFTWideStringList => "WideStringList",
        OFT::OFTBinary => "Binary",
        OFT::OFTDate => "Date",
        OFT::OFTTime => "Time",
        OFT::OFTDateTime => "DateTime",
        OFT::OFTInteger64 => "Integer64",
        OFT::OFTInteger64List => "Integer64List",
        // GDAL documents the list as extensible, so an unrecognised value is
        // not an error — surface it rather than guessing.
        other => return format!("Unknown({other})"),
    };
    name.to_string()
}

/// Every field type name this binding understands, in the spelling
/// [`field_type_name`] produces.
pub(crate) const FIELD_TYPE_NAMES: [&str; 14] = [
    "Integer",
    "IntegerList",
    "Integer64",
    "Integer64List",
    "Real",
    "RealList",
    "String",
    "StringList",
    "WideString",
    "WideStringList",
    "Binary",
    "Date",
    "Time",
    "DateTime",
];

/// Map a field type name onto GDAL's enum — the inverse of [`field_type_name`].
///
/// Compared the way `geometry_type_from_name` compares: case, spaces, underscores
/// and hyphens are ignored, so `integer 64` and `Integer64` are the same request.
pub(crate) fn field_type_from_name(name: &str) -> Result<OGRFieldType::Type> {
    use OGRFieldType as OFT;

    let normalised: String = name
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();

    let field_type = match normalised.as_str() {
        "integer" => OFT::OFTInteger,
        "integerlist" => OFT::OFTIntegerList,
        "integer64" => OFT::OFTInteger64,
        "integer64list" => OFT::OFTInteger64List,
        "real" => OFT::OFTReal,
        "reallist" => OFT::OFTRealList,
        "string" => OFT::OFTString,
        "stringlist" => OFT::OFTStringList,
        "widestring" => OFT::OFTWideString,
        "widestringlist" => OFT::OFTWideStringList,
        "binary" => OFT::OFTBinary,
        "date" => OFT::OFTDate,
        "time" => OFT::OFTTime,
        "datetime" => OFT::OFTDateTime,
        other => {
            return Err(bad_argument(format!(
                "unknown field type {other:?}; expected one of {}",
                FIELD_TYPE_NAMES.join(", ")
            )));
        }
    };
    Ok(field_type)
}

/// Every justification name this binding understands.
pub(crate) const JUSTIFICATION_NAMES: [&str; 3] = ["Undefined", "Left", "Right"];

/// `OGRJustification::Type` as one of [`JUSTIFICATION_NAMES`].
fn justification_name(justification: gdal_sys::OGRJustification::Type) -> &'static str {
    match justification {
        gdal_sys::OGRJustification::OJLeft => "Left",
        gdal_sys::OGRJustification::OJRight => "Right",
        // The enum is extensible and `OJUndefined` is the default, so anything
        // unrecognised reads as undefined rather than as an error.
        _ => "Undefined",
    }
}

/// The inverse of [`justification_name`], compared the way the other name maps
/// compare: case, spaces, underscores and hyphens are ignored.
fn justification_from_name(name: &str) -> Result<gdal_sys::OGRJustification::Type> {
    let normalised: String = name
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();

    Ok(match normalised.as_str() {
        "undefined" => gdal_sys::OGRJustification::OJUndefined,
        "left" => gdal_sys::OGRJustification::OJLeft,
        "right" => gdal_sys::OGRJustification::OJRight,
        other => {
            return Err(bad_argument(format!(
                "unknown justification {other:?}; expected one of {}",
                JUSTIFICATION_NAMES.join(", ")
            )));
        }
    })
}

/// A layer's schema, as [`FieldInfo`]s.
///
/// The `gdal` crate's `Field` exposes everything here except the justification,
/// and keeps its `OGRFieldDefnH` private — so that one value comes off the feature
/// definition by index while the rest come from the wrapper.
fn layer_field_infos(layer: &impl LayerAccess) -> Vec<FieldInfo> {
    let defn = layer.defn();
    let c_defn = unsafe { defn.c_defn() };

    defn.fields()
        .enumerate()
        .map(|(index, field)| {
            let c_field = unsafe { gdal_sys::OGR_FD_GetFieldDefn(c_defn, index as c_int) };
            FieldInfo {
                name: field.name(),
                field_type: field_type_name(field.field_type()),
                width: field.width(),
                precision: field.precision(),
                nullable: field.is_nullable(),
                unique: field.is_unique(),
                default_value: field.default_value().map_or(Value::Null, Value::from),
                justification: justification_name(unsafe { gdal_sys::OGR_Fld_GetJustify(c_field) })
                    .to_string(),
            }
        })
        .collect()
}

/// A field definition built directly through the C API, destroyed on drop.
///
/// The `gdal` crate's `FieldDefn` sets only width and precision and keeps its
/// `OGRFieldDefnH` private, so `nullable`, `unique`, `default` and `justification`
/// would be unreachable through it. Building from `OGR_Fld_Create` instead gives one
/// path for every attribute this binding exposes — and the `Drop` is what keeps the
/// C object from leaking when a definition is rejected half-way through.
pub(crate) struct FieldDefnHandle(gdal_sys::OGRFieldDefnH);

impl Drop for FieldDefnHandle {
    fn drop(&mut self) {
        unsafe { gdal_sys::OGR_Fld_Destroy(self.0) };
    }
}

/// Build a field definition from the JS shape `createLayer` and `addField` share,
/// so a field declared one way and added the other cannot differ.
///
/// The defaults are GDAL's own: omitting `width` / `precision` / `nullable` /
/// `unique` / `defaultValue` / `justification` leaves whatever `OGR_Fld_Create`
/// started with, which is what a caller who does not care wants.
pub(crate) fn build_field_defn(definition: &FieldDefinition) -> Result<FieldDefnHandle> {
    let field_type = field_type_from_name(&definition.field_type)?;
    let name = CString::new(definition.name.as_str())
        .map_err(|_| bad_argument("a field name cannot contain a NUL byte"))?;

    let field = unsafe { gdal_sys::OGR_Fld_Create(name.as_ptr(), field_type) };
    if field.is_null() {
        return Err(bad_argument(format!(
            "GDAL could not build a field definition for {:?}",
            definition.name
        )));
    }
    let field = FieldDefnHandle(field);

    if let Some(width) = definition.width {
        unsafe { gdal_sys::OGR_Fld_SetWidth(field.0, width as c_int) };
    }
    if let Some(precision) = definition.precision {
        unsafe { gdal_sys::OGR_Fld_SetPrecision(field.0, precision as c_int) };
    }
    if let Some(nullable) = definition.nullable {
        unsafe { gdal_sys::OGR_Fld_SetNullable(field.0, c_int::from(nullable)) };
    }
    if let Some(unique) = definition.unique {
        unsafe { gdal_sys::OGR_Fld_SetUnique(field.0, c_int::from(unique)) };
    }
    if let Some(default) = &definition.default_value {
        let text = CString::new(default.as_str())
            .map_err(|_| bad_argument("a field default cannot contain a NUL byte"))?;
        unsafe { gdal_sys::OGR_Fld_SetDefault(field.0, text.as_ptr()) };
    }
    if let Some(justification) = &definition.justification {
        unsafe { gdal_sys::OGR_Fld_SetJustify(field.0, justification_from_name(justification)?) };
    }

    Ok(field)
}

/// Add a built field definition to a layer — `OGR_L_CreateField`, with
/// `bApproxOK` set so a driver may widen the type rather than refuse.
///
/// A driver that cannot add fields at all reports the refusal here; GDAL's warning
/// becomes this binding's error, which is what `testCapability('CreateField')`
/// exists to predict.
pub(crate) fn add_field_to_layer(
    definition: &FieldDefnHandle,
    layer: &impl LayerAccess,
) -> Result<()> {
    ogr_result(
        unsafe { gdal_sys::OGR_L_CreateField(layer.c_layer(), definition.0, 1) },
        "add the field",
    )
}

/// An `OGRErr` as this binding's error.
///
/// OGR has no `CPLErr` behind a layer status, so the class is synthesised — but GDAL
/// still leaves its own explanation in the last-error store, and that message is
/// usually the useful half: an `ALTER TABLE` that failed says *why* it failed
/// ("cannot drop UNIQUE column") while the status is a bare number.
///
/// The read-then-reset is the same discipline [`crate::raster_tools::cpl_result`]
/// follows: a failure that became an exception is gone from `lastError()`, which is
/// left for the errors that never did.
fn ogr_result(status: gdal_sys::OGRErr::Type, what: &str) -> Result<()> {
    if status == 0 {
        return Ok(());
    }

    let number = unsafe { gdal_sys::CPLGetLastErrorNo() };
    let detail = crate::runtime::c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() });
    unsafe { gdal_sys::CPLErrorReset() };

    let message = if detail.is_empty() {
        format!("the driver could not {what} (OGR error {status})")
    } else {
        format!("the driver could not {what}: {detail} (OGR error {status})")
    };
    Err(gdal_error(GdalError::CplError {
        class: gdal_sys::CPLErr::CE_Failure,
        number,
        msg: message,
    }))
}

/// Canonical name for a geometry type.
///
/// Deliberately *not* `OGRGeometryTypeToName`: GDAL spells that value
/// `Multi Polygon`, while GeoJSON, WKT and PostGIS all write `MultiPolygon`.
/// This is the inverse of [`geometry_type_from_name`], so the two agree.
///
/// A `Z` / `M` / `Z M` suffix reports the coordinate modifiers, but see
/// `geometry_type_from_name` for why it is informational only.
pub(crate) fn geometry_type_name(ty: OGRwkbGeometryType::Type) -> String {
    use OGRwkbGeometryType as WKB;

    let base = match geometry_type_flatten(ty) {
        WKB::wkbNone => "None",
        WKB::wkbPoint => "Point",
        WKB::wkbLineString => "LineString",
        WKB::wkbPolygon => "Polygon",
        WKB::wkbMultiPoint => "MultiPoint",
        WKB::wkbMultiLineString => "MultiLineString",
        WKB::wkbMultiPolygon => "MultiPolygon",
        WKB::wkbGeometryCollection => "GeometryCollection",
        // `wkbUnknown`, and any type GDAL grows later.
        _ => "Unknown",
    };

    let mut name = base.to_string();
    if geometry_type_has_z(ty) {
        name.push_str(" Z");
    }
    if geometry_type_has_m(ty) {
        name.push_str(" M");
    }
    name
}

/// Map a geometry type name onto GDAL's enum, accepting the spellings
/// [`geometry_type_name`] produces.
///
/// Comparison ignores case, spaces, underscores and hyphens, so `MultiPolygon`,
/// `multi polygon` and `multipolygon` all land on the same value. A trailing
/// `Z` / `M` / `ZM` is accepted but ignored: geometries are exchanged as GeoJSON,
/// which carries the Z coordinate in the position itself rather than in the
/// layer's type.
pub(crate) fn geometry_type_from_name(name: &str) -> Result<OGRwkbGeometryType::Type> {
    let normalised: String = name
        .chars()
        .filter(|c| !matches!(c, ' ' | '_' | '-'))
        .flat_map(char::to_lowercase)
        .collect();

    // No base name ends in `z` or `m`, so this cannot eat part of one.
    let base = normalised
        .strip_suffix("zm")
        .or_else(|| normalised.strip_suffix('z'))
        .or_else(|| normalised.strip_suffix('m'))
        .unwrap_or(normalised.as_str());

    let ty = match base {
        "" | "unknown" => OGRwkbGeometryType::wkbUnknown,
        "none" => OGRwkbGeometryType::wkbNone,
        "point" => OGRwkbGeometryType::wkbPoint,
        "linestring" => OGRwkbGeometryType::wkbLineString,
        "polygon" => OGRwkbGeometryType::wkbPolygon,
        "multipoint" => OGRwkbGeometryType::wkbMultiPoint,
        "multilinestring" => OGRwkbGeometryType::wkbMultiLineString,
        "multipolygon" => OGRwkbGeometryType::wkbMultiPolygon,
        "geometrycollection" => OGRwkbGeometryType::wkbGeometryCollection,
        other => {
            return Err(bad_argument(format!(
                "unknown geometry type {other:?}; expected one of Point, LineString, Polygon, \
                 MultiPoint, MultiLineString, MultiPolygon, GeometryCollection, Unknown"
            )));
        }
    };
    Ok(ty)
}

/// Guess a field type from a JS value.
///
/// `None` means "do not make a field for this", which is what `null` and nested
/// objects get — inventing a column for a value we cannot represent would be
/// worse than leaving it out.
///
/// Arrays deliberately become a plain `String` holding comma-joined text rather
/// than a list field. A driver with no list columns (GPKG, for one) *accepts* a
/// list field request, creates a scalar column, and then keeps reporting the
/// list type from its definition — so a list setter afterwards stores GDAL's
/// internal `(2:a,b)` form instead of the value. `String` is the request that
/// behaves the same on every driver. Fields that are *already* list-typed are
/// still written as real lists; see `set_field_value`.
fn inferred_field_type(value: &Value) -> Option<OGRFieldType::Type> {
    use OGRFieldType as OFT;

    Some(match value {
        Value::Null => return None,
        Value::Bool(_) => OFT::OFTInteger,
        Value::Number(number) if number.is_i64() || number.is_u64() => OFT::OFTInteger64,
        Value::Number(_) => OFT::OFTReal,
        Value::String(_) => OFT::OFTString,
        Value::Array(items) if items.iter().all(is_scalar) => OFT::OFTString,
        Value::Array(_) | Value::Object(_) => return None,
    })
}

/// Write `value` into a field **whose type is `field_type`**.
///
/// The field's type chooses the setter, not the JS value's. A driver with no
/// list columns (GPKG, for one) silently downgrades a list field to a scalar
/// one, and asking for a list setter afterwards stores GDAL's internal
/// `(2:a,b)` form rather than the value.
fn set_field_value(
    feature: &mut Feature<'_>,
    index: usize,
    field_type: OGRFieldType::Type,
    value: &Value,
) -> Result<()> {
    use OGRFieldType as OFT;

    if value.is_null() {
        return feature.set_field_null(index).gdal();
    }

    match field_type {
        OFT::OFTStringList | OFT::OFTWideStringList => {
            let owned = match value {
                Value::Array(items) => items.iter().map(json_text).collect::<Result<Vec<_>>>()?,
                other => vec![json_text(other)?],
            };
            let values: Vec<&str> = owned.iter().map(String::as_str).collect();
            feature.set_field_string_list(index, &values).gdal()
        }
        OFT::OFTIntegerList | OFT::OFTInteger64List => {
            let owned = match value {
                Value::Array(items) => items.iter().map(json_i64).collect::<Result<Vec<_>>>()?,
                other => vec![json_i64(other)?],
            };
            feature.set_field_integer64_list(index, &owned).gdal()
        }
        OFT::OFTRealList => {
            let owned = match value {
                Value::Array(items) => items.iter().map(json_f64).collect::<Result<Vec<_>>>()?,
                other => vec![json_f64(other)?],
            };
            feature.set_field_double_list(index, &owned).gdal()
        }
        OFT::OFTString | OFT::OFTWideString => feature
            .set_field_string(index, &json_joined_text(value)?)
            .gdal(),
        OFT::OFTInteger | OFT::OFTInteger64 => {
            if matches!(value, Value::Array(_)) {
                return Err(bad_argument(
                    "the target field is an integer but the value is an array, and this driver \
                     has no list columns",
                ));
            }
            feature.set_field_integer64(index, json_i64(value)?).gdal()
        }
        OFT::OFTReal => {
            if matches!(value, Value::Array(_)) {
                return Err(bad_argument(
                    "the target field is a number but the value is an array, and this driver \
                     has no list columns",
                ));
            }
            feature.set_field_double(index, json_f64(value)?).gdal()
        }
        // Dates: GDAL parses the text into the field's own format. Anything else
        // GDAL grows later takes the text form too, rather than being dropped.
        _ => {
            if matches!(value, Value::Array(_)) {
                return Err(bad_argument(format!(
                    "cannot write an array into a field of type {field_type}"
                )));
            }
            feature.set_field_string(index, &json_text(value)?).gdal()
        }
    }
}

/// Add a feature to `layer`, creating any missing fields first.
fn write_feature(
    layer: &gdal::vector::Layer<'_>,
    geometry: Option<&Value>,
    properties: Option<Value>,
) -> Result<()> {
    let properties = match properties {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Object(map)) => map.into_iter().collect::<Vec<_>>(),
        Some(_) => return Err(bad_argument("properties must be an object")),
    };

    // GDAL fixes a layer's schema up front, so a property with no matching field
    // needs one made for it. Inferring the type from the JS value keeps the
    // common case — hand it a GeoJSON Feature and be done — to a single call.
    let existing = layer_fields(layer);
    for (name, value) in &properties {
        if existing.iter().any(|(field, _)| field == name) {
            continue;
        }
        if let Some(field_type) = inferred_field_type(value) {
            FieldDefn::new(name, field_type)
                .gdal_context("write_feature")?
                .add_to_layer(layer)
                .gdal_context("write_feature")?;
        }
    }

    // Re-read: creating fields just changed the definition.
    let fields = layer_fields(layer);
    let mut feature = Feature::new(layer.defn()).gdal_context("write_feature")?;

    if let Some(geometry) = geometry
        && !geometry.is_null()
    {
        feature
            .set_geometry(from_geojson(geometry)?)
            .gdal_context("write_feature")?;
    }

    for (name, value) in &properties {
        // A `null` for a field that does not exist leaves nothing to write.
        let Some(index) = fields.iter().position(|(field, _)| field == name) else {
            continue;
        };
        set_field_value(&mut feature, index, fields[index].1, value)?;
    }

    // The `gdal` crate's `Feature::create` and `Layer::set_feature` drop the OGR
    // status and return `Ok(())` whatever GDAL said, so a write a read-only
    // datasource refuses looked like a success — the only trace was GDAL's warning
    // on stderr. These two are the same calls with the status kept.
    ogr_result(
        unsafe { gdal_sys::OGR_L_CreateFeature(layer.c_layer(), feature.c_feature()) },
        "create the feature",
    )
}

/// Overwrite fields on an existing feature.
///
/// Unlike `write_feature` this never reshapes the schema: an update should not
/// silently add columns, so an unknown property is an error. A `null` geometry
/// means "leave the geometry alone".
fn update_existing(
    layer: &gdal::vector::Layer<'_>,
    fid: u64,
    geometry: Option<&Value>,
    properties: Option<Value>,
) -> Result<()> {
    let fields = layer_fields(layer);
    let mut feature = layer
        .feature(fid)
        .ok_or_else(|| bad_argument(format!("no feature with id {fid}")))?;

    if let Some(geometry) = geometry
        && !geometry.is_null()
    {
        feature
            .set_geometry(from_geojson(geometry)?)
            .gdal_context("update_existing")?;
    }

    if let Some(Value::Object(map)) = properties {
        for (name, value) in &map {
            let index = fields
                .iter()
                .position(|(field, _)| field == name)
                .ok_or_else(|| bad_argument(format!("the layer has no field named {name:?}")))?;
            set_field_value(&mut feature, index, fields[index].1, value)?;
        }
    }

    ogr_result(
        unsafe { gdal_sys::OGR_L_SetFeature(layer.c_layer(), feature.c_feature()) },
        "write the feature",
    )
}

/// Remove a feature by id.
///
/// The `gdal` crate has no wrapper for this one, so it is the single place that
/// reaches into the C API directly. GDAL's own message is relayed rather than
/// replaced: it knows whether the id was missing or the driver simply cannot
/// delete, and those are different problems.
fn delete_feature(layer: &gdal::vector::Layer<'_>, fid: u64) -> Result<()> {
    // SAFETY: the layer handle is live for as long as `layer` is.
    let status = unsafe { gdal_sys::OGR_L_DeleteFeature(layer.c_layer(), fid as i64) };
    if status == gdal_sys::OGRErr::OGRERR_NONE {
        return Ok(());
    }

    // SAFETY: GDAL owns this string; null means it has nothing to say.
    let detail = unsafe {
        let message = gdal_sys::CPLGetLastErrorMsg();
        if message.is_null() {
            String::new()
        } else {
            std::ffi::CStr::from_ptr(message)
                .to_string_lossy()
                .into_owned()
        }
    };

    Err(bad_argument(if detail.is_empty() {
        format!("GDAL could not delete feature {fid}")
    } else {
        format!("GDAL could not delete feature {fid}: {detail}")
    }))
}

/// A column name GDAL reports, where its empty string means "there is none".
fn named_column(value: *const std::ffi::c_char) -> Option<String> {
    let name = crate::runtime::c_string(value);
    (!name.is_empty()).then_some(name)
}

#[napi]
impl JsLayer {
    /// Position of this layer in the dataset, 0-based.
    #[napi(catch_unwind, getter)]
    pub fn index(&self) -> u32 {
        self.index as u32
    }

    #[napi(catch_unwind, getter)]
    pub fn name(&self) -> Result<String> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("name")?;
            Ok(layer.name())
        })
    }

    /// Begin a transaction on this layer: everything written until the commit — or
    /// the rollback — becomes one unit. GDAL's `StartTransaction`.
    ///
    /// Whether the driver has them at all is `testCapability('Transactions')`. A
    /// driver without support warns and carries on as if there were no transaction, so
    /// a `false` there is worth reading before relying on the grouping. Beginning a
    /// transaction inside one is the failure this can report.
    #[napi(catch_unwind)]
    pub fn start_transaction(&self) -> Result<()> {
        self.transaction(gdal_sys::OGR_L_StartTransaction, "start")
    }

    /// Keep everything the transaction wrote. GDAL's `CommitTransaction`.
    #[napi(catch_unwind)]
    pub fn commit_transaction(&self) -> Result<()> {
        self.transaction(gdal_sys::OGR_L_CommitTransaction, "commit")
    }

    /// Throw everything the transaction wrote away. GDAL's `RollbackTransaction`.
    #[napi(catch_unwind)]
    pub fn rollback_transaction(&self) -> Result<()> {
        self.transaction(gdal_sys::OGR_L_RollbackTransaction, "roll back")
    }

    /// The three transaction calls differ only in which one they are, so they come
    /// through here. `with_mut` rather than `with_exclusive`, because a transaction is
    /// a write like any other and a read-only dataset has to refuse it.
    fn transaction(
        &self,
        call: unsafe extern "C" fn(gdal_sys::OGRLayerH) -> gdal_sys::OGRErr::Type,
        what: &str,
    ) -> Result<()> {
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            // Not `mut`: `c_layer()` takes the layer by shared reference, unlike the
            // iterating call sites where the layer is borrowed mutably.
            let layer = dataset.layer(self.index).gdal_context("transaction")?;
            ogr_result(
                unsafe { call(layer.c_layer()) },
                &format!("{what} the transaction"),
            )
        })
    }

    /// The field the layer stores its feature ids in, or `null` when it has none and
    /// GDAL generates them — the catalogue calls this the `FIDColumn`.
    #[napi(catch_unwind, getter)]
    pub fn fid_column(&self) -> Result<Option<String>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("fid_column")?;
            Ok(named_column(unsafe {
                gdal_sys::OGR_L_GetFIDColumn(layer.c_layer())
            }))
        })
    }

    /// The field the layer keeps its geometry in, or `null` for a layer with none —
    /// GDAL's `GeometryColumn`, empty exactly when there is no geometry.
    #[napi(catch_unwind, getter)]
    pub fn geom_column(&self) -> Result<Option<String>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("geom_column")?;
            Ok(named_column(unsafe {
                gdal_sys::OGR_L_GetGeometryColumn(layer.c_layer())
            }))
        })
    }

    /// Whether the layer can do `capability`, using GDAL's own capability names —
    /// `FastFeatureCount`, `FastGetExtent`, `RandomRead`, `SequentialWrite`,
    /// `DeleteFeature`, `Transactions`, `CreateField`, `CreateGeomField`, ...
    ///
    /// A name GDAL does not know answers `false` rather than throwing: the call is a
    /// question, and "no" is one of its answers.
    #[napi(catch_unwind)]
    pub fn test_capability(&self, capability: String) -> Result<bool> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("test_capability")?;
            let capability = std::ffi::CString::new(capability)
                .map_err(|_| bad_argument("a capability name cannot contain a NUL byte"))?;
            let answer =
                unsafe { gdal_sys::OGR_L_TestCapability(layer.c_layer(), capability.as_ptr()) };
            Ok(answer != 0)
        })
    }

    /// Feature count, or `null` when the driver cannot answer without a full
    /// scan. Use the count only as a hint: filter it if you need certainty.
    #[napi(catch_unwind, getter)]
    pub fn feature_count(&self) -> Result<Option<i64>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("feature_count")?;
            Ok(layer.try_feature_count().map(|count| count as i64))
        })
    }

    /// The layer's geometry type, e.g. `Point`, `MultiPolygon`, `Unknown`.
    #[napi(catch_unwind, getter)]
    pub fn geometry_type(&self) -> Result<String> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("geometry_type")?;
            Ok(geometry_type_name(layer.defn().geometry_type()))
        })
    }

    #[napi(catch_unwind, getter)]
    pub fn fields(&self) -> Result<Vec<FieldInfo>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("fields")?;
            Ok(layer_field_infos(&layer))
        })
    }

    /// One field by name, or `null`. The lookup `fields` exists to make possible
    /// without walking the array.
    #[napi(catch_unwind)]
    pub fn field(&self, name: String) -> Result<Option<FieldInfo>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("field")?;
            Ok(layer_field_infos(&layer)
                .into_iter()
                .find(|field| field.name == name))
        })
    }

    /// Add a field to a layer that already exists — the missing half of declaring
    /// a schema in `createLayer`.
    ///
    /// `FieldDefinition` is the same shape `createLayer` takes, so `fieldType` is
    /// chosen rather than inferred, and `width` / `precision` / `nullable` /
    /// `unique` / `defaultValue` / `justification` are all settable here.
    ///
    /// The driver decides whether it can: `testCapability('CreateField')` is the
    /// question to ask first, and a driver without it reports the refusal rather
    /// than silently ignoring the call.
    ///
    /// ```js
    /// layer.addField({ name: 'population', fieldType: 'Integer64' })
    /// ```
    #[napi(catch_unwind)]
    pub fn add_field(&self, field: FieldDefinition) -> Result<()> {
        ensure_initialized();
        // Built before the lock, so a typo in the type name is thrown by the call
        // rather than inside it.
        let definition = build_field_defn(&field)?;
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("add_field")?;
            add_field_to_layer(&definition, &layer)
        })
    }

    /// Drop a field by name — the counterpart of `addField`.
    ///
    /// By name rather than by index for the same reason `deleteLayer` is: dropping
    /// one shifts every later index, so a list of indices is a trap. The data in
    /// the column goes with it, and there is no undo beyond a transaction.
    #[napi(catch_unwind)]
    pub fn delete_field(&self, name: String) -> Result<()> {
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("delete_field")?;
            let index = field_position(&layer, &name)?;
            ogr_result(
                unsafe { gdal_sys::OGR_L_DeleteField(layer.c_layer(), index) },
                &format!("delete the field {name:?}"),
            )
        })
    }

    /// Reorder the schema.
    //
    // The names have to be exactly the fields the layer already has, each once: a
    // partial list is rejected here rather than handed to GDAL, whose own answer to
    // one is to build a malformed schema.
    #[napi(catch_unwind)]
    pub fn reorder_fields(&self, names: Vec<String>) -> Result<()> {
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("reorder_fields")?;
            let existing = layer_field_names(&layer);

            let mut seen = HashSet::with_capacity(names.len());
            let mut map = Vec::with_capacity(names.len());
            for name in &names {
                if !seen.insert(name.as_str()) {
                    return Err(bad_argument(format!("the field {name:?} is named twice")));
                }
                map.push(field_position(&layer, name)?);
            }
            if names.len() != existing.len() {
                return Err(bad_argument(format!(
                    "reordering has to name every field, and the layer has {}: {}",
                    existing.len(),
                    existing.join(", ")
                )));
            }

            ogr_result(
                unsafe { gdal_sys::OGR_L_ReorderFields(layer.c_layer(), map.as_mut_ptr()) },
                "reorder the fields",
            )
        })
    }

    /// Bounding box as `[minX, minY, maxX, maxY]`, or `null` when the layer has
    /// no extent (an empty layer, typically).
    #[napi(catch_unwind, getter)]
    pub fn extent(&self) -> Result<Option<Vec<f64>>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("extent")?;
            Ok(layer
                .try_get_extent()
                .gdal_context("extent")?
                .map(|envelope| vec![envelope.MinX, envelope.MinY, envelope.MaxX, envelope.MaxY]))
        })
    }

    /// The same extent, under the name the reference uses for it.
    ///
    /// `extent` is the shorter spelling this binding started with; a port from
    /// gdal-async will be looking for `getExtent()`, and both go through one read.
    #[napi(catch_unwind, js_name = "getExtent")]
    pub fn get_extent(&self) -> Result<Option<Vec<f64>>> {
        self.extent()
    }

    /// The layer's CRS as WKT, or `null` when it has none.
    #[napi(catch_unwind, getter)]
    pub fn spatial_ref_wkt(&self) -> Result<Option<String>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("spatial_ref_wkt")?;
            match layer.spatial_ref() {
                Some(srs) => Ok(srs.to_wkt().ok()),
                None => Ok(None),
            }
        })
    }

    /// The same CRS as `spatialRefWkt`, as an object.
    #[napi(catch_unwind, getter)]
    pub fn spatial_ref(&self) -> Result<Option<JsSpatialRef>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("spatial_ref")?;
            match layer.spatial_ref() {
                Some(srs) => Ok(Some(JsSpatialRef::wrap(srs))),
                None => Ok(None),
            }
        })
    }

    /// Set the layer's CRS, from WKT or a `SpatialRef`.
    ///
    /// The C API has no `OGR_L_SetSpatialRef`, and a layer's CRS *is* its geometry
    /// field's — so this goes through `OGR_L_AlterGeomFieldDefn`, which hands a new
    /// definition to the **driver** rather than writing through the definition object.
    /// That is the whole difference, and it is what makes it possible at all: the
    /// definition is sealed once the layer exists (`OGRGeomFieldDefn::SetSpatialRef()
    /// not allowed on a sealed object`), and only the driver may reopen it.
    ///
    /// A driver that cannot alter its schema answers with an error naming it, rather
    /// than silently doing nothing.
    #[napi(catch_unwind, js_name = "setSpatialRef")]
    pub fn set_spatial_ref(&self, spatial_ref: Either<String, &JsSpatialRef>) -> Result<()> {
        /// `ALTER_GEOM_FIELD_DEFN_SRS_FLAG` from `ogr_core.h`: take the SRS from the new
        /// definition and leave the field's name, type and nullability as they are.
        /// `gdal-sys` binds `OGR_L_AlterGeomFieldDefn` but not the macros that go with it.
        const ALTER_SRS_ONLY: c_int = 0x8000;

        ensure_initialized();
        // Resolve a `SpatialRef` before taking the lock: `wkt()` takes it itself, and
        // the lock is not reentrant.
        let wkt = match spatial_ref {
            Either::A(wkt) => wkt,
            Either::B(spatial_ref) => spatial_ref.wkt()?,
        };
        let definition =
            CString::new(wkt).map_err(|_| bad_argument("a CRS cannot contain a NUL byte"))?;
        self.dataset.with_exclusive(|dataset| {
            let layer =
                unsafe { gdal_sys::GDALDatasetGetLayer(dataset.c_dataset(), self.index as c_int) };
            if layer.is_null() {
                return Err(bad_argument("this layer is no longer there"));
            }
            // `OSRSetFromUserInput`, so WKT, `AUTH:CODE` and a PROJ string all work.
            let spatial_ref = unsafe { gdal_sys::OSRNewSpatialReference(std::ptr::null()) };
            let status = unsafe { gdal_sys::OSRSetFromUserInput(spatial_ref, definition.as_ptr()) };
            if status != gdal_sys::OGRErr::OGRERR_NONE {
                unsafe { gdal_sys::OSRDestroySpatialReference(spatial_ref) };
                return Err(bad_argument("GDAL could not read that CRS"));
            }
            unsafe {
                let field = gdal_sys::OGR_GFld_Create(
                    c"".as_ptr(),
                    gdal_sys::OGRwkbGeometryType::wkbUnknown,
                );
                // `SetSpatialRef` *references* what it is given rather than copying it,
                // so the definition has its own reference now and ours is released
                // after. `OGR_L_AlterGeomFieldDefn` only borrows the definition, so it
                // is ours to destroy either way.
                gdal_sys::OGR_GFld_SetSpatialRef(field, spatial_ref);
                gdal_sys::OSRRelease(spatial_ref);
                let status = gdal_sys::OGR_L_AlterGeomFieldDefn(layer, 0, field, ALTER_SRS_ONLY);
                gdal_sys::OGR_GFld_Destroy(field);
                if status != gdal_sys::OGRErr::OGRERR_NONE {
                    return Err(bad_argument(format!(
                        "the {} driver would not change this layer's CRS ({status})",
                        dataset.driver().short_name(),
                    )));
                }
            }
            Ok(())
        })
    }

    #[napi(catch_unwind)]
    pub fn metadata(
        &self,
        domain: Option<String>,
    ) -> Result<std::collections::HashMap<String, String>> {
        ensure_initialized();
        let domain = domain.unwrap_or_default();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("metadata")?;

            let mut out = std::collections::HashMap::new();
            for entry in layer.metadata() {
                if entry.domain == domain {
                    out.insert(entry.key, entry.value);
                }
            }
            Ok(out)
        })
    }

    /// Read every feature the current filters leave visible.
    ///
    /// Materialising the whole layer is the simple half of the API; `features()` is
    /// the same read on the thread pool, and `openCursor` is the one that streams.
    #[napi(catch_unwind)]
    pub fn features_sync(&self) -> Result<Vec<FeatureRecord>> {
        self.read_features()
    }

    /// The same read, on the libuv thread pool.
    ///
    /// `featuresSync()` holds the event loop for the whole read; this one does not,
    /// which is the difference that matters for a layer too large to want to block
    /// on. It is still all-or-nothing — one array of every visible feature — so a
    /// layer that will not fit in memory wants `openCursor` instead.
    #[napi(catch_unwind, ts_return_type = "Promise<Array<FeatureRecord>>")]
    pub fn features(&self) -> AsyncTask<FeaturesTask> {
        AsyncTask::new(FeaturesTask {
            dataset: self.dataset.clone(),
            index: self.index,
        })
    }

    /// The body both of the above share, so the sync and thread-pool forms cannot
    /// drift apart.
    fn read_features(&self) -> Result<Vec<FeatureRecord>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let mut layer = dataset.layer(self.index).gdal_context("read_features")?;

            // Rewound on purpose. GDAL keeps the reading position on the layer, and
            // its `FeatureIterator` only resets it when it is *dropped* — so without
            // this, a read that follows a cursor starts wherever that cursor stopped
            // and collects just the tail. "Every visible feature" is the contract.
            // SAFETY: the layer handle is live for as long as `layer` is.
            unsafe { gdal_sys::OGR_L_ResetReading(layer.c_layer()) };

            // Collected before iterating: `features()` borrows the layer mutably.
            let field_names = layer_field_names(&layer);

            let mut records = Vec::new();
            for feature in layer.features() {
                records.push(to_record(&feature, &field_names)?);
            }
            Ok(records)
        })
    }

    /// A single feature by id, or `null`.
    #[napi(catch_unwind)]
    pub fn feature(&self, fid: i64) -> Result<Option<FeatureRecord>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("feature")?;
            let field_names = layer_field_names(&layer);

            match layer.feature(fid as u64) {
                Some(feature) => Ok(Some(to_record(&feature, &field_names)?)),
                None => Ok(None),
            }
        })
    }

    /// Write a feature.
    ///
    /// Properties that name no existing field get one created for them, with the
    /// type inferred from the JS value: a string becomes a `String` field, an
    /// integer `Integer64`, a number `Real`, a boolean `Integer`, and an array of
    /// scalars a `String` holding comma-joined text (see `inferred_field_type`
    /// for why not a list field). A `null` or a nested object creates nothing.
    /// Fields that already exist keep their declared type, lists included.
    #[napi(catch_unwind)]
    pub fn create_feature(
        &self,
        geometry: Option<Either<&JsGeometry, Unknown<'_>>>,
        properties: Option<Value>,
    ) -> Result<()> {
        let geometry = geometry_argument(geometry)?;
        ensure_initialized();
        // `with_mut` rather than `with_exclusive` so that a write is refused on a
        // read-only thread-safe dataset.
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("create_feature")?;
            write_feature(&layer, geometry.as_ref(), properties)
        })
    }

    /// Overwrite fields on an existing feature.
    ///
    /// Only the fields you name change, and unlike `createFeature` an unknown
    /// property is an error rather than a new column. A `null` geometry leaves
    /// the current geometry alone.
    #[napi(catch_unwind)]
    pub fn update_feature(
        &self,
        fid: i64,
        geometry: Option<Either<&JsGeometry, Unknown<'_>>>,
        properties: Option<Value>,
    ) -> Result<()> {
        let geometry = geometry_argument(geometry)?;
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("update_feature")?;
            update_existing(&layer, fid as u64, geometry.as_ref(), properties)
        })
    }

    /// This layer's schema as one object — the things `name`, `geometryType`,
    /// `fidColumn`, `geomColumn` and `fields` report, grouped.
    ///
    /// A snapshot taken at the call, like `fields`: it describes the schema now,
    /// and a later `addField` does not change what an earlier read returned.
    #[napi(catch_unwind, getter)]
    pub fn defn(&self) -> Result<FeatureDefn> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("defn")?;
            Ok(feature_defn(&layer))
        })
    }

    /// One feature as an object with methods, rather than the copied-out record
    /// `feature(fid)` returns.
    ///
    /// `null` when there is no feature with that id. This is the object form: its
    /// `fields` reads and writes through the layer, and `geometry` is the GeoJSON
    /// the record would have carried. `feature(fid)` stays the plain-data read.
    ///
    /// ```js
    /// const feature = layer.getFeature(3)
    /// feature.fields.get('population')   // 4500
    /// feature.fields.set('population', 4600)   // written straight through
    /// ```
    #[napi(catch_unwind)]
    pub fn get_feature(&self, fid: i64) -> Result<Option<JsFeature>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("get_feature")?;
            if layer.feature(fid as u64).is_none() {
                return Ok(None);
            }
            Ok(Some(JsFeature {
                dataset: self.dataset.clone(),
                index: self.index,
                fid,
            }))
        })
    }

    /// Read this layer in batches, rather than materialising all of it the way
    /// `featuresSync` does.
    ///
    /// See `FeatureCursor` for the one-cursor-per-layer rule: GDAL keeps the
    /// reading position on the layer, not in the cursor, which is what lets
    /// batches resume — and what makes a second reader rewind the first.
    #[napi(catch_unwind)]
    pub fn open_cursor(&self, options: Option<CursorOptions>) -> Result<JsFeatureCursor> {
        let batch_size = options
            .unwrap_or_default()
            .batch_size
            .unwrap_or(DEFAULT_CURSOR_BATCH);

        if batch_size == 0 {
            return Err(bad_argument("batchSize has to be at least 1"));
        }

        Ok(JsFeatureCursor {
            dataset: self.dataset.clone(),
            index: self.index,
            batch_size: batch_size as usize,
            state: Arc::new(CursorState::default()),
        })
    }

    /// Delete a feature by id.
    ///
    /// An id that is not there is an error rather than a silent no-op, and not
    /// every driver supports deleting at all — GDAL decides, and its answer is
    /// passed on.
    #[napi(catch_unwind)]
    pub fn delete_feature(&self, fid: i64) -> Result<()> {
        ensure_initialized();
        // A write, so `with_mut`: a read-only dataset refuses it, which is also
        // how a thread-safe one stays read-only.
        self.dataset.with_mut(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("delete_feature")?;
            delete_feature(&layer, fid as u64)
        })
    }

    /// Limit the layer to features matching an OGR SQL `WHERE` clause, e.g.
    /// `"population > 1000 AND name LIKE 'A%'"`. Pass `null` to clear.
    #[napi(catch_unwind)]
    pub fn set_attribute_filter(&self, query: Option<String>) -> Result<()> {
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            let mut layer = dataset
                .layer(self.index)
                .gdal_context("set_attribute_filter")?;
            match query {
                Some(query) => layer
                    .set_attribute_filter(&query)
                    .gdal_context("set_attribute_filter")?,
                None => layer.clear_attribute_filter(),
            }
            Ok(())
        })
    }

    #[napi(catch_unwind)]
    pub fn set_spatial_filter_rect(
        &self,
        min_x: f64,
        min_y: f64,
        max_x: f64,
        max_y: f64,
    ) -> Result<()> {
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            let mut layer = dataset
                .layer(self.index)
                .gdal_context("set_spatial_filter_rect")?;
            layer.set_spatial_filter_rect(min_x, min_y, max_x, max_y);
            Ok(())
        })
    }

    /// Limit the layer to features whose geometry intersects `geometry` — the
    /// arbitrary-shape counterpart of `setSpatialFilterRect`.
    ///
    /// `geometry` is any GeoJSON geometry, the same shape `createFeature` and
    /// `rasterize` take. Pass `null` to clear, which is what `clearSpatialFilter`
    /// does too; the two exist because both read better at their own call site.
    ///
    /// ```js
    /// layer.setSpatialFilter({ type: 'Polygon', coordinates: [ring] })
    /// ```
    #[napi(catch_unwind)]
    pub fn set_spatial_filter(
        &self,
        geometry: Option<Either<&JsGeometry, Unknown<'_>>>,
    ) -> Result<()> {
        let geometry = geometry_argument(geometry)?;
        ensure_initialized();
        // Converted before the lock, so a malformed geometry is thrown by the call.
        let geometry = geometry.as_ref().map(from_geojson).transpose()?;
        self.dataset.with_mut(|dataset| {
            let mut layer = dataset
                .layer(self.index)
                .gdal_context("set_spatial_filter")?;
            match &geometry {
                Some(geometry) => layer.set_spatial_filter(geometry),
                None => layer.clear_spatial_filter(),
            }
            Ok(())
        })
    }

    #[napi(catch_unwind)]
    pub fn clear_spatial_filter(&self) -> Result<()> {
        ensure_initialized();
        self.dataset.with_mut(|dataset| {
            let mut layer = dataset
                .layer(self.index)
                .gdal_context("clear_spatial_filter")?;
            layer.clear_spatial_filter();
            Ok(())
        })
    }

    /// The spatial filter currently in force, as a `Geometry`, or `null` when there
    /// is none — the read side of `setSpatialFilter`. A rectangle set with
    /// `setSpatialFilterRect` comes back as a polygon, which is what GDAL stores.
    #[napi(catch_unwind)]
    pub fn get_spatial_filter(&self) -> Result<Option<JsGeometry>> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset
                .layer(self.index)
                .gdal_context("get_spatial_filter")?;
            let handle = unsafe { gdal_sys::OGR_L_GetSpatialFilter(layer.c_layer()) };
            if handle.is_null() {
                return Ok(None);
            }
            // The layer owns the filter, so clone it before adopting — which destroys.
            Ok(Some(crate::geometry::adopt_handle(unsafe {
                gdal_sys::OGR_G_Clone(handle)
            })?))
        })
    }

    /// Write the layer's pending changes to disk — `OGR_L_SyncToDisk`. The dataset
    /// `flush()` covers the whole file; this is the per-layer one a bulk write into a
    /// single layer wants.
    #[napi(catch_unwind)]
    pub fn flush_sync(&self) -> Result<()> {
        ensure_initialized();
        self.flush_pending()
    }

    /// The same on the thread pool — a bulk write to commit is exactly what should
    /// not hold up the event loop.
    #[napi(catch_unwind, ts_return_type = "Promise<void>")]
    pub fn flush(&self) -> AsyncTask<FlushLayerTask> {
        AsyncTask::new(FlushLayerTask {
            dataset: self.dataset.clone(),
            index: self.index,
        })
    }
}

/// How many features a cursor pulls per read.
pub const DEFAULT_CURSOR_BATCH: u32 = 1000;

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct CursorOptions {
    /// Default 1000. Bigger batches mean fewer round trips and more memory held
    /// at once — a thousand features is a few hundred kilobytes of JS objects.
    pub batch_size: Option<u32>,
}

/// A cursor's bookkeeping.
///
/// Atomics rather than `&mut self`, because a batch read can be running on the
/// thread pool while JS asks whether the cursor is finished.
#[derive(Debug, Default)]
struct CursorState {
    started: AtomicBool,
    finished: AtomicBool,
    closed: AtomicBool,
}

/// Reads a layer in batches, so a large layer costs one batch of memory instead
/// of all of it.
///
/// # One cursor per layer at a time
///
/// GDAL keeps the reading position *on the layer*, not in this object. That is
/// what lets a batch resume where the last one stopped, and it also means a
/// second cursor — or a `featuresSync()` call, which builds an iterator that
/// rewinds on drop — will pull the ground out from under the first. Use one
/// reader per layer, and read the batches in order.
#[napi(js_name = "FeatureCursor")]
pub struct JsFeatureCursor {
    dataset: DatasetRef,
    index: usize,
    batch_size: usize,
    state: Arc<CursorState>,
}

impl JsFeatureCursor {
    /// Pull the next batch. Shared by the sync method and the async task.
    fn next_batch(&self) -> Result<Vec<FeatureRecord>> {
        if self.state.closed.load(Ordering::Relaxed) {
            return Err(bad_argument("the cursor is closed"));
        }

        // `swap` hands the rewind to exactly one caller even if two reads are
        // issued at once: the layer has to be rewound once, not twice.
        let reset = !self.state.started.swap(true, Ordering::Relaxed);
        let batch = self
            .dataset
            .with_exclusive(|dataset| read_batch(dataset, self.index, self.batch_size, reset))?;

        if batch.is_empty() {
            self.state.finished.store(true, Ordering::Relaxed);
        }
        Ok(batch)
    }
}

#[napi]
impl JsFeatureCursor {
    #[napi(catch_unwind, getter)]
    pub fn batch_size(&self) -> u32 {
        self.batch_size as u32
    }

    /// True once a read has come back empty. `read()` returning `[]` says the
    /// same thing; this is for a `while (!cursor.finished)` loop.
    #[napi(catch_unwind, getter)]
    pub fn finished(&self) -> bool {
        self.state.finished.load(Ordering::Relaxed)
    }

    /// The next batch, or an empty array once the layer is exhausted.
    #[napi(catch_unwind)]
    pub fn read_sync(&self) -> Result<Vec<FeatureRecord>> {
        self.next_batch()
    }

    #[napi(catch_unwind, ts_return_type = "Promise<Array<FeatureRecord>>")]
    pub fn read(&self) -> AsyncTask<CursorTask> {
        AsyncTask::new(CursorTask {
            dataset: self.dataset.clone(),
            index: self.index,
            batch_size: self.batch_size,
            state: Arc::clone(&self.state),
        })
    }

    /// Stop reading. Idempotent, and it does not touch GDAL on purpose: every
    /// other way of reading this layer rewinds it anyway, so leaving the position
    /// where it stopped costs nothing.
    #[napi(catch_unwind)]
    pub fn close(&self) {
        self.state.closed.store(true, Ordering::Relaxed);
    }
}

/// Pull up to `count` features from wherever the layer's reading position is.
///
/// The position lives on the layer, so `reset` is only for the first batch. Each
/// `Feature` is dropped as soon as it has been converted, and that drop is what
/// frees the C-side memory: it is why a cursor's footprint is the batch rather
/// than the layer.
fn read_batch(
    dataset: &GdalDataset,
    index: usize,
    count: usize,
    reset: bool,
) -> Result<Vec<FeatureRecord>> {
    let layer = dataset.layer(index).gdal_context("read_batch")?;

    if reset {
        // SAFETY: the layer handle is live for as long as `layer` is.
        unsafe { gdal_sys::OGR_L_ResetReading(layer.c_layer()) };
    }

    let field_names = layer_field_names(&layer);

    let mut records = Vec::new();
    for _ in 0..count {
        // SAFETY: the layer handle is live, and `OGR_L_GetNextFeature` hands over
        // ownership of what it returns — which is why it goes straight into a
        // `Feature`, whose drop destroys it.
        let handle = unsafe { gdal_sys::OGR_L_GetNextFeature(layer.c_layer()) };
        if handle.is_null() {
            break;
        }
        let feature = unsafe { Feature::from_c_feature(layer.defn(), handle) };
        records.push(to_record(&feature, &field_names)?);
    }
    Ok(records)
}

/// Run a SQL query against a dataset and copy the rows out.
///
/// `dialect` is one of GDAL's own names — `"OGRSQL"` forces the OGR dialect,
/// `"SQLITE"` asks for the SQLite one — or `None` for the driver's default.
///
/// The `gdal` crate's own `Dataset::execute_sql` hands back a `ResultSet` that
/// borrows the dataset, which cannot cross to JS; calling
/// `GDALDatasetExecuteSQL` directly also keeps the lifetime explicit, with the
/// set released once the rows are out.
pub(crate) fn execute_sql(
    dataset: &GdalDataset,
    sql: &str,
    dialect: Option<&str>,
) -> Result<Vec<FeatureRecord>> {
    let query = std::ffi::CString::new(sql)
        .map_err(|_| bad_argument("the SQL query cannot contain a NUL byte"))?;
    let dialect = dialect
        .map(|dialect| {
            std::ffi::CString::new(dialect)
                .map_err(|_| bad_argument("the dialect name cannot contain a NUL byte"))
        })
        .transpose()?;

    // A stale error left by an earlier call must not be read as this query's.
    unsafe { gdal_sys::CPLErrorReset() };

    // SAFETY: the dataset handle is live for as long as `dataset` is, and a null
    // spatial filter is GDAL's "no filter". GDAL copies both strings, so the
    // `CString`s only have to outlive the call.
    let layer = unsafe {
        gdal_sys::GDALDatasetExecuteSQL(
            dataset.c_dataset(),
            query.as_ptr(),
            std::ptr::null_mut(),
            dialect.as_ref().map_or(std::ptr::null(), |d| d.as_ptr()),
        )
    };

    // A warning is not a failure, so a non-null handle means the query ran,
    // warnings and all. GDAL reports a null handle both for a statement with no
    // result set — an `ALTER TABLE`, a `CREATE INDEX` — and for a query that
    // failed, and the error state is what tells those two apart.
    if layer.is_null() {
        let error_class = unsafe { gdal_sys::CPLGetLastErrorType() };
        if error_class != gdal_sys::CPLErr::CE_None {
            return Err(crate::error::gdal_error(
                gdal::errors::GdalError::CplError {
                    class: error_class,
                    number: unsafe { gdal_sys::CPLGetLastErrorNo() },
                    msg: crate::runtime::c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() }),
                },
            ));
        }
        // No layer and no error: nothing to copy out, so an empty array rather than
        // a failure.
        return Ok(Vec::new());
    }

    // The rows are read with the set alive; the closure holds the one release on
    // every exit path, error included.
    let result = (|| {
        // SAFETY: the layer is live and its definition stays valid for as long as
        // the set does.
        let defn = unsafe { Defn::from_c_defn(gdal_sys::OGR_L_GetLayerDefn(layer)) };
        let field_names: Vec<String> = defn.fields().map(|field| field.name()).collect();

        let mut records = Vec::new();
        loop {
            // SAFETY: as in `read_batch` — the layer is live, and ownership of each
            // feature passes to the `Feature`, whose drop frees it.
            let handle = unsafe { gdal_sys::OGR_L_GetNextFeature(layer) };
            if handle.is_null() {
                break;
            }
            let feature = unsafe { Feature::from_c_feature(&defn, handle) };
            records.push(to_record(&feature, &field_names)?);
        }
        Ok(records)
    })();

    // SAFETY: the set is ours, and this is its single release, after the rows have
    // been copied out.
    unsafe { gdal_sys::GDALDatasetReleaseResultSet(dataset.c_dataset(), layer) };

    result
}

type OpResult<T> = std::result::Result<T, (GdalErrorCode, String)>;

fn op<T>(result: Result<T>) -> OpResult<T> {
    result.map_err(split)
}

/// A batch read on the thread pool: pulling a page out of a large layer is
/// exactly the kind of work that should not hold up the event loop.
pub struct CursorTask {
    dataset: DatasetRef,
    index: usize,
    batch_size: usize,
    state: Arc<CursorState>,
}

impl Task for CursorTask {
    type Output = OpResult<Vec<FeatureRecord>>;
    type JsValue = Vec<FeatureRecord>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        let cursor = JsFeatureCursor {
            dataset: self.dataset.clone(),
            index: self.index,
            batch_size: self.batch_size,
            state: Arc::clone(&self.state),
        };
        Ok(op(cursor.next_batch()))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// Materialising a whole layer on the thread pool: reading every visible feature is
/// I/O, and a large layer is exactly what should not hold up the event loop.
///
/// The work itself is `JsLayer::read_features`, the same body `featuresSync()` runs,
/// so the two answer identically.
pub struct FeaturesTask {
    dataset: DatasetRef,
    index: usize,
}

impl Task for FeaturesTask {
    type Output = OpResult<Vec<FeatureRecord>>;
    type JsValue = Vec<FeatureRecord>;

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op(
            JsLayer::new(self.dataset.clone(), self.index).read_features()
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

/// The thread-pool half of `Layer.flush`: `OGR_L_SyncToDisk`, the same body
/// `flushSync()` runs.
pub struct FlushLayerTask {
    dataset: DatasetRef,
    index: usize,
}

impl Task for FlushLayerTask {
    type Output = OpResult<()>;
    type JsValue = ();

    fn compute(&mut self) -> napi::Result<Self::Output> {
        Ok(op(
            JsLayer::new(self.dataset.clone(), self.index).flush_pending()
        ))
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> napi::Result<Self::JsValue> {
        output.map_err(|(code, reason)| into_status_error(code, reason))
    }
}

// ---------------------------------------------------------------------------
// Geometry conversion helpers//
// Geometries are exchanged as GeoJSON objects, which is what JS code already
// speaks. These are free functions rather than a class because the interesting
// operations are pure conversions; a `Geometry` wrapper earns its keep once
// geometries can be constructed for writing.
// ---------------------------------------------------------------------------

pub(crate) fn to_geojson(geometry: &gdal::vector::Geometry) -> Result<Value> {
    let json = geometry.json().gdal_context("to_geojson")?;
    serde_json::from_str(&json)
        .map_err(|err| bad_argument(format!("GDAL returned invalid GeoJSON: {err}")))
}

pub(crate) fn from_geojson(geometry: &Value) -> Result<gdal::vector::Geometry> {
    let encoded = serde_json::to_string(geometry)
        .map_err(|err| bad_argument(format!("cannot encode geometry as GeoJSON: {err}")))?;
    gdal::vector::Geometry::from_geojson(&encoded).gdal()
}

/// A geometry parameter that takes either a `Geometry` object or a GeoJSON plain
/// object, resolved to the GeoJSON the writers below already speak — so both
/// shapes travel the same road once they are here.
///
/// The `Geometry` form is converted **before** the caller takes the lock:
/// `toJson()` takes it itself, and the lock is not reentrant.
pub(crate) fn geometry_argument(
    geometry: Option<Either<&JsGeometry, Unknown<'_>>>,
) -> Result<Option<Value>> {
    match geometry {
        None => Ok(None),
        Some(Either::A(object)) => Ok(Some(object.to_json()?)),
        // The other arm is the GeoJSON plain object, which is what a
        // `serde_json::Value` parameter was before this overload existed. It has
        // to come through `Unknown` because napi's `Either` needs both variants
        // to be *validatable*, and `serde_json::Value` is not.
        Some(Either::B(unknown)) => Ok(Some(json_value(unknown)?)),
    }
}

/// A raw JS value as the JSON the geometry writers understand, with this
/// binding's error type rather than napi's plain one.
pub(crate) fn json_value(unknown: Unknown<'_>) -> Result<Value> {
    unsafe { unknown.cast::<Value>() }
        .map_err(|err| bad_argument(format!("expected a Geometry or a GeoJSON object: {err}")))
}

#[napi(catch_unwind)]
pub fn geometry_type_of(geometry: Value) -> Result<String> {
    ensure_initialized();
    // A geometry built from GeoJSON and then asked its type: no dataset, no global
    // configuration, so it takes the shared side like the rest of the geometry work.
    let _guard = lock_gdal_shared();
    Ok(geometry_type_name(from_geojson(&geometry)?.geometry_type()))
}

/// These four are the module-level spelling of what `Geometry` now does as an
/// object, and they are dataset-free the same way: building one from a string or
/// bytes and taking it back out touches no dataset, so they share the lock with the
/// rest of the geometry work.
#[napi(catch_unwind)]
pub fn geometry_to_wkt(geometry: Value) -> Result<String> {
    ensure_initialized();
    let _guard = lock_gdal_shared();
    from_geojson(&geometry)?.wkt().gdal()
}

#[napi(catch_unwind)]
pub fn geometry_to_wkb(geometry: Value) -> Result<Buffer> {
    ensure_initialized();
    let _guard = lock_gdal_shared();
    Ok(from_geojson(&geometry)?
        .wkb()
        .gdal_context("geometry_to_wkb")?
        .into())
}

#[napi(catch_unwind)]
pub fn geometry_from_wkt(wkt: String) -> Result<Value> {
    ensure_initialized();
    let _guard = lock_gdal_shared();
    to_geojson(&gdal::vector::Geometry::from_wkt(&wkt).gdal_context("geometry_from_wkt")?)
}

#[napi(catch_unwind)]
pub fn geometry_from_wkb(wkb: Buffer) -> Result<Value> {
    ensure_initialized();
    let _guard = lock_gdal_shared();
    to_geojson(&gdal::vector::Geometry::from_wkb(wkb.as_ref()).gdal_context("geometry_from_wkb")?)
}

/// A layer's schema, grouped the way `Layer.defn` reports it.
#[napi(object)]
#[derive(Debug, Clone)]
pub struct FeatureDefn {
    /// The layer's name.
    pub name: String,
    /// Canonical geometry type, as `layer.geometryType` reports it.
    pub geometry_type: String,
    /// The column the geometry lives in, or `null` — `Layer.geomColumn`.
    pub geometry_column: Option<String>,
    /// The column the feature ids come from, or `null` — `Layer.fidColumn`.
    pub fid_column: Option<String>,
    /// How many fields the layer has.
    pub field_count: u32,
    /// Each field's whole definition, in schema order.
    pub fields: Vec<FieldInfo>,
}

/// Build the schema snapshot. `Layer.defn` and `Feature.defn` share it, so the two
/// describe one layer identically.
fn feature_defn(layer: &impl LayerAccess) -> FeatureDefn {
    let fields = layer_field_infos(layer);
    FeatureDefn {
        name: layer.name(),
        geometry_type: geometry_type_name(layer.defn().geometry_type()),
        geometry_column: named_column(unsafe {
            gdal_sys::OGR_L_GetGeometryColumn(layer.c_layer())
        }),
        fid_column: named_column(unsafe { gdal_sys::OGR_L_GetFIDColumn(layer.c_layer()) }),
        field_count: fields.len() as u32,
        fields,
    }
}

/// Read one feature by id, as the copied-out record. Shared by the `Feature`
/// object's reads, so every one of them sees the layer as it is *now*.
fn read_feature(dataset: DatasetRef, index: usize, fid: i64) -> Result<FeatureRecord> {
    ensure_initialized();
    dataset.with_exclusive(|dataset| {
        let layer = dataset.layer(index).gdal_context("read_feature")?;
        let field_names = layer_field_names(&layer);
        match layer.feature(fid as u64) {
            Some(feature) => to_record(&feature, &field_names),
            None => Err(bad_argument(format!(
                "no feature with fid {fid} in this layer — it may have been deleted"
            ))),
        }
    })
}

/// Write to one existing feature. The single path behind `Feature.setGeometry`,
/// `FeatureFields.set` and `Layer.updateFeature`.
fn write_existing(
    dataset: DatasetRef,
    index: usize,
    fid: i64,
    geometry: Option<&Value>,
    properties: Option<Value>,
) -> Result<()> {
    ensure_initialized();
    dataset.with_mut(|dataset| {
        let layer = dataset.layer(index).gdal_context("write_existing")?;
        update_existing(&layer, fid as u64, geometry, properties)
    })
}

/// A feature as an object with methods — the `getFeature(fid)` counterpart of the
/// copied-out `FeatureRecord`.
///
/// Everything reads and writes **through the layer** rather than holding a copy:
/// `fields.get` re-reads the feature and `fields.set` writes immediately (the same
/// write `updateFeature(fid, …)` makes). Nothing is cached, so two reads with a
/// write between them cannot disagree, and there is no `save()` to forget.
#[napi(js_name = "Feature")]
pub struct JsFeature {
    dataset: DatasetRef,
    index: usize,
    fid: i64,
}

impl JsFeature {
    fn record(&self) -> Result<FeatureRecord> {
        read_feature(self.dataset.clone(), self.index, self.fid)
    }
}

#[napi]
impl JsFeature {
    /// The feature's id — the number `feature(fid)` and `updateFeature(fid, …)`
    /// take.
    #[napi(catch_unwind, getter)]
    pub fn fid(&self) -> i64 {
        self.fid
    }

    /// The schema this feature belongs to — the same object `layer.defn` returns.
    #[napi(catch_unwind, getter)]
    pub fn defn(&self) -> Result<FeatureDefn> {
        ensure_initialized();
        self.dataset.with_exclusive(|dataset| {
            let layer = dataset.layer(self.index).gdal_context("defn")?;
            Ok(feature_defn(&layer))
        })
    }

    /// The geometry as GeoJSON, or `null` when the feature has none.
    #[napi(catch_unwind, getter)]
    pub fn geometry(&self) -> Result<Value> {
        Ok(self.record()?.geometry)
    }

    /// Replace the geometry — a `Geometry` object or the GeoJSON `createFeature`
    /// takes.
    #[napi(catch_unwind)]
    pub fn set_geometry(&self, geometry: Either<&JsGeometry, Unknown<'_>>) -> Result<()> {
        let geometry = match geometry {
            Either::A(object) => object.to_json()?,
            Either::B(unknown) => json_value(unknown)?,
        };
        write_existing(
            self.dataset.clone(),
            self.index,
            self.fid,
            Some(&geometry),
            None,
        )
    }

    /// The feature's fields, read and written through the layer.
    #[napi(catch_unwind, getter)]
    pub fn fields(&self) -> JsFeatureFields {
        JsFeatureFields {
            dataset: self.dataset.clone(),
            index: self.index,
            fid: self.fid,
        }
    }

    /// The whole feature as the plain record `feature(fid)` would have returned —
    /// `fid`, `properties` and `geometry`.
    #[napi(catch_unwind)]
    pub fn to_object(&self) -> Result<FeatureRecord> {
        self.record()
    }
}

/// A feature's fields, as `Feature.fields`. Every call goes back to the layer, so a
/// value read here is the value in the file, not a snapshot.
#[napi(js_name = "FeatureFields")]
pub struct JsFeatureFields {
    dataset: DatasetRef,
    index: usize,
    fid: i64,
}

/// The "no such field" error, naming what the feature does have.
fn unknown_field(name: &str, record: &FeatureRecord) -> Error<GdalErrorCode> {
    let known: Vec<String> = record
        .properties
        .as_object()
        .map(|object| object.keys().cloned().collect())
        .unwrap_or_default();
    bad_argument(format!(
        "no field named {name:?}; the feature has {}",
        known.join(", ")
    ))
}

impl JsFeatureFields {
    fn record(&self) -> Result<FeatureRecord> {
        read_feature(self.dataset.clone(), self.index, self.fid)
    }
}

#[napi]
impl JsFeatureFields {
    /// Field names, in schema order.
    #[napi(catch_unwind)]
    pub fn names(&self) -> Result<Vec<String>> {
        Ok(self
            .record()?
            .properties
            .as_object()
            .map(|object| object.keys().cloned().collect())
            .unwrap_or_default())
    }

    /// How many fields the feature has.
    #[napi(catch_unwind)]
    pub fn count(&self) -> Result<u32> {
        Ok(self
            .record()?
            .properties
            .as_object()
            .map_or(0, |object| object.len() as u32))
    }

    /// One field's value. An unknown name is an error rather than `null`, so a
    /// typo reads as one — `has` is the question that answers `false`.
    #[napi(catch_unwind)]
    pub fn get(&self, name: String) -> Result<Value> {
        let record = self.record()?;
        match record.properties.get(&name) {
            Some(value) => Ok(value.clone()),
            None => Err(unknown_field(&name, &record)),
        }
    }

    #[napi(catch_unwind)]
    pub fn has(&self, name: String) -> Result<bool> {
        Ok(self.record()?.properties.get(&name).is_some())
    }

    /// Write one field, straight through to the layer — the same write
    /// `updateFeature(fid, null, { name: value })` makes.
    #[napi(catch_unwind)]
    pub fn set(&self, name: String, value: Value) -> Result<()> {
        let mut properties = Map::new();
        properties.insert(name, value);
        write_existing(
            self.dataset.clone(),
            self.index,
            self.fid,
            None,
            Some(Value::Object(properties)),
        )
    }

    /// Every field as an object — the `properties` of the copied-out record.
    #[napi(catch_unwind)]
    pub fn to_object(&self) -> Result<Value> {
        Ok(self.record()?.properties)
    }

    /// Every value, in field order.
    #[napi(catch_unwind)]
    pub fn to_array(&self) -> Result<Vec<Value>> {
        Ok(self
            .record()?
            .properties
            .as_object()
            .map(|object| object.values().cloned().collect())
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    const CANONICAL: [&str; 8] = [
        "Point",
        "LineString",
        "Polygon",
        "MultiPoint",
        "MultiLineString",
        "MultiPolygon",
        "GeometryCollection",
        "Unknown",
    ];

    #[test]
    fn geometry_names_round_trip() {
        // The pair has to be exact inverses, otherwise a name read off a layer
        // cannot be fed back into createLayer.
        for name in CANONICAL {
            let ty = geometry_type_from_name(name).expect(name);
            assert_eq!(geometry_type_name(ty), name, "{name} did not survive");
        }
    }

    #[test]
    fn geometry_names_are_reported_the_way_geojson_spells_them() {
        // GDAL's own OGRGeometryTypeToName would say "Multi Polygon" here.
        let ty = geometry_type_from_name("MultiPolygon").unwrap();
        assert_eq!(geometry_type_name(ty), "MultiPolygon");
    }

    #[test]
    fn geometry_names_tolerate_spacing_and_case() {
        for spelling in [
            "multipolygon",
            "MULTIPOLYGON",
            "MultiPolygon",
            "multi polygon",
            "Multi_Polygon",
            "multi-polygon",
        ] {
            assert_eq!(
                geometry_type_from_name(spelling).unwrap(),
                OGRwkbGeometryType::wkbMultiPolygon,
                "{spelling}"
            );
        }
    }

    #[test]
    fn geometry_names_reject_nonsense() {
        let err = geometry_type_from_name("hypercube").unwrap_err();
        assert!(
            err.reason.contains("unknown geometry type"),
            "{}",
            err.reason
        );
    }

    #[test]
    fn field_type_names_round_trip() {
        // The pair has to be exact inverses, or a name read off a layer cannot be
        // fed back into createLayer.
        for name in FIELD_TYPE_NAMES {
            let field_type = field_type_from_name(name).expect(name);
            assert_eq!(field_type_name(field_type), name, "{name} did not survive");
        }
    }

    #[test]
    fn field_type_names_tolerate_spacing_and_case() {
        for spelling in [
            "integer64",
            "INTEGER64",
            "Integer64",
            "integer 64",
            "integer_64",
            "Integer-64",
        ] {
            assert_eq!(
                field_type_from_name(spelling).unwrap(),
                OGRFieldType::OFTInteger64,
                "{spelling}"
            );
        }

        let err = field_type_from_name("currency").unwrap_err();
        assert!(err.reason.contains("unknown field type"), "{}", err.reason);
        // The alternatives come back with the complaint.
        assert!(err.reason.contains("Integer64"), "{}", err.reason);
    }

    #[test]
    fn field_type_names_use_gdal_vocabulary() {
        use OGRFieldType as OFT;

        assert_eq!(field_type_name(OFT::OFTInteger), "Integer");
        assert_eq!(field_type_name(OFT::OFTInteger64), "Integer64");
        assert_eq!(field_type_name(OFT::OFTReal), "Real");
        assert_eq!(field_type_name(OFT::OFTString), "String");
        assert_eq!(field_type_name(OFT::OFTStringList), "StringList");
        assert_eq!(field_type_name(OFT::OFTDateTime), "DateTime");
        // Unknown values are surfaced rather than silently mapped, because GDAL
        // documents the list as extensible.
        assert_eq!(field_type_name(999), "Unknown(999)");
    }

    #[test]
    fn field_types_come_from_the_js_value() {
        use OGRFieldType as OFT;

        assert_eq!(inferred_field_type(&json!("a")), Some(OFT::OFTString));
        assert_eq!(inferred_field_type(&json!(true)), Some(OFT::OFTInteger));
        assert_eq!(inferred_field_type(&json!(1)), Some(OFT::OFTInteger64));
        assert_eq!(inferred_field_type(&json!(1.5)), Some(OFT::OFTReal));
        // Arrays become text on purpose: see the doc comment on the function.
        assert_eq!(
            inferred_field_type(&json!(["a", "b"])),
            Some(OFT::OFTString)
        );
        assert_eq!(inferred_field_type(&json!([1, 2])), Some(OFT::OFTString));

        // Nothing is invented for values we cannot represent.
        assert_eq!(inferred_field_type(&json!(null)), None);
        assert_eq!(inferred_field_type(&json!({ "a": 1 })), None);
        assert_eq!(inferred_field_type(&json!([{ "a": 1 }])), None);
    }
}
