//! Field definitions and the plain-data feature helpers, split out of the napi
//! surface in `mod.rs`: building an `OGRFieldDefn` by hand, reading and writing
//! a feature's typed values, and the geometry<->JSON bridge.

use super::*;

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
pub(crate) fn ogr_result(status: gdal_sys::OGRErr::Type, what: &str) -> Result<()> {
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
        // The curve and surface types, so a `CIRCULARSTRING` / `COMPOUNDCURVE` parsed
        // from WKT reports its own name rather than `Unknown` — the reference has a
        // class per shape and re-tags on this string.
        WKB::wkbCircularString => "CircularString",
        WKB::wkbCompoundCurve => "CompoundCurve",
        WKB::wkbCurvePolygon => "CurvePolygon",
        WKB::wkbMultiCurve => "MultiCurve",
        WKB::wkbMultiSurface => "MultiSurface",
        WKB::wkbCurve => "Curve",
        WKB::wkbSurface => "Surface",
        WKB::wkbPolyhedralSurface => "PolyhedralSurface",
        WKB::wkbTIN => "TIN",
        WKB::wkbTriangle => "Triangle",
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
        // A ring is not a name WKT carries (`geometry_type_name` flattens it to
        // `LineString`), so this is the one arm that has no inverse — it is here for
        // `Geometry.create('LinearRing')`, which is how a ring is *made*.
        "linearring" => OGRwkbGeometryType::wkbLinearRing,
        "circularstring" => OGRwkbGeometryType::wkbCircularString,
        "compoundcurve" => OGRwkbGeometryType::wkbCompoundCurve,
        "curvepolygon" => OGRwkbGeometryType::wkbCurvePolygon,
        "multicurve" => OGRwkbGeometryType::wkbMultiCurve,
        "multisurface" => OGRwkbGeometryType::wkbMultiSurface,
        "curve" => OGRwkbGeometryType::wkbCurve,
        "surface" => OGRwkbGeometryType::wkbSurface,
        "polyhedralsurface" => OGRwkbGeometryType::wkbPolyhedralSurface,
        "tin" => OGRwkbGeometryType::wkbTIN,
        "triangle" => OGRwkbGeometryType::wkbTriangle,
        other => {
            return Err(bad_argument(format!(
                "unknown geometry type {other:?}; expected one of Point, LineString, Polygon, \
                 MultiPoint, MultiLineString, MultiPolygon, GeometryCollection, CircularString, \
                 CompoundCurve, CurvePolygon, MultiCurve, MultiSurface, Curve, Surface, \
                 PolyhedralSurface, TIN, Triangle, Unknown"
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
pub(crate) fn inferred_field_type(value: &Value) -> Option<OGRFieldType::Type> {
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
pub(crate) fn set_field_value(
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
pub(crate) fn write_feature(
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
pub(crate) fn update_existing(
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
pub(crate) fn delete_feature(layer: &gdal::vector::Layer<'_>, fid: u64) -> Result<()> {
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
pub(crate) fn named_column(value: *const std::ffi::c_char) -> Option<String> {
    let name = crate::runtime::c_string(value);
    (!name.is_empty()).then_some(name)
}
