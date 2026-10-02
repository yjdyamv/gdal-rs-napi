//! The numeric vocabularies `gdal-async` speaks, for the compatibility layer.

use std::collections::HashMap;

use napi_derive::napi;

/// GDAL's C enums by name, as `gdal-async` exports them — `OFTString`, `wkbPoint`,
/// `GRA_Bilinear`.
///
/// This binding's own vocabulary is **strings** (`band.dataType === 'Float32'`,
/// `fieldType === 'String'`) and stays that way; the numbers exist for the
/// compatibility layer, whose whole job is to answer the reference's spelling.
///
/// Every value is read out of `gdal_sys` — the headers this build compiles against.
/// None is written out by hand, because a hand-written table is right for the GDAL
/// someone remembers rather than the one linked, and a wrong numeric code is the kind
/// of bug that only shows up as a silently mis-typed field.
///
/// That rule is also why some families are **absent**: `gdal-sys` does not bind every
/// one. `OLC*` (layer capabilities), `ODrC*` / `ODsC*` (driver capabilities), `DIM_*`
/// (dimension types), the `CPLE_*` error numbers and `wkb25DBit` are C macros or
/// unnamed enums that never reach the Rust side, and a number this binding cannot read
/// out of GDAL is a number it will not guess. Callers who need one of those should ask
/// GDAL for the behaviour instead: `testCapability()` answers the capability questions
/// by name, and `lastError().number` reports the error number that actually occurred.
///
/// The **compatibility layer** answers them anyway, from its own table: GDAL's strings
/// for the capability families and the ABI numbers for the error codes are the
/// reference's vocabulary, so `gdal-rs-napi/compat` supplies them where this
/// headers-only table leaves a hole. See `compat/index.js`'s `GDAL_CONSTANTS`.
#[napi(catch_unwind)]
pub fn numeric_constants() -> HashMap<String, u32> {
    use gdal_sys::{
        CPLErr, GDALColorInterp, GDALDataType, GDALExtendedDataTypeClass, GDALPaletteInterp,
        GDALResampleAlg, OGRFieldType, OGRJustification, OGRwkbGeometryType,
    };

    let mut table: HashMap<String, u32> = HashMap::new();
    let mut add = |name: &str, value: u32| {
        table.insert(name.to_owned(), value);
    };

    // Sample types — the `GDT_*` names the reference uses.
    for (name, value) in [
        ("GDT_Unknown", GDALDataType::GDT_Unknown),
        ("GDT_Byte", GDALDataType::GDT_Byte),
        ("GDT_UInt16", GDALDataType::GDT_UInt16),
        ("GDT_Int16", GDALDataType::GDT_Int16),
        ("GDT_UInt32", GDALDataType::GDT_UInt32),
        ("GDT_Int32", GDALDataType::GDT_Int32),
        ("GDT_UInt64", GDALDataType::GDT_UInt64),
        ("GDT_Int64", GDALDataType::GDT_Int64),
        ("GDT_Float16", GDALDataType::GDT_Float16),
        ("GDT_Float32", GDALDataType::GDT_Float32),
        ("GDT_Float64", GDALDataType::GDT_Float64),
        ("GDT_CInt16", GDALDataType::GDT_CInt16),
        ("GDT_CInt32", GDALDataType::GDT_CInt32),
        ("GDT_CFloat32", GDALDataType::GDT_CFloat32),
        ("GDT_CFloat64", GDALDataType::GDT_CFloat64),
    ] {
        add(name, value);
    }

    // Field types — `OFT_*`.
    for (name, value) in [
        ("OFTInteger", OGRFieldType::OFTInteger),
        ("OFTIntegerList", OGRFieldType::OFTIntegerList),
        ("OFTReal", OGRFieldType::OFTReal),
        ("OFTRealList", OGRFieldType::OFTRealList),
        ("OFTString", OGRFieldType::OFTString),
        ("OFTStringList", OGRFieldType::OFTStringList),
        ("OFTWideString", OGRFieldType::OFTWideString),
        ("OFTWideStringList", OGRFieldType::OFTWideStringList),
        ("OFTBinary", OGRFieldType::OFTBinary),
        ("OFTDate", OGRFieldType::OFTDate),
        ("OFTTime", OGRFieldType::OFTTime),
        ("OFTDateTime", OGRFieldType::OFTDateTime),
        ("OFTInteger64", OGRFieldType::OFTInteger64),
        ("OFTInteger64List", OGRFieldType::OFTInteger64List),
    ] {
        add(name, value);
    }

    // Geometry types — `wkb*`. The Z / M / ZM forms are **not** here: GDAL spells most
    // of them as C macros rather than enum members, so only a few reach `gdal_sys`, and
    // half a family is worse than none — the same rule as the families above, applied
    // at the level of a name rather than a whole table.
    for (name, value) in [
        ("wkbUnknown", OGRwkbGeometryType::wkbUnknown),
        ("wkbPoint", OGRwkbGeometryType::wkbPoint),
        ("wkbLineString", OGRwkbGeometryType::wkbLineString),
        ("wkbPolygon", OGRwkbGeometryType::wkbPolygon),
        ("wkbMultiPoint", OGRwkbGeometryType::wkbMultiPoint),
        ("wkbMultiLineString", OGRwkbGeometryType::wkbMultiLineString),
        ("wkbMultiPolygon", OGRwkbGeometryType::wkbMultiPolygon),
        (
            "wkbGeometryCollection",
            OGRwkbGeometryType::wkbGeometryCollection,
        ),
        ("wkbCircularString", OGRwkbGeometryType::wkbCircularString),
        ("wkbCompoundCurve", OGRwkbGeometryType::wkbCompoundCurve),
        ("wkbCurvePolygon", OGRwkbGeometryType::wkbCurvePolygon),
        ("wkbMultiCurve", OGRwkbGeometryType::wkbMultiCurve),
        ("wkbMultiSurface", OGRwkbGeometryType::wkbMultiSurface),
        ("wkbCurve", OGRwkbGeometryType::wkbCurve),
        ("wkbSurface", OGRwkbGeometryType::wkbSurface),
        (
            "wkbPolyhedralSurface",
            OGRwkbGeometryType::wkbPolyhedralSurface,
        ),
        ("wkbTIN", OGRwkbGeometryType::wkbTIN),
        ("wkbTriangle", OGRwkbGeometryType::wkbTriangle),
    ] {
        add(name, value);
    }

    // Colour interpretations, palette interpretations and resampling.
    for (name, value) in [
        ("GCI_Undefined", GDALColorInterp::GCI_Undefined),
        ("GCI_GrayIndex", GDALColorInterp::GCI_GrayIndex),
        ("GCI_PaletteIndex", GDALColorInterp::GCI_PaletteIndex),
        ("GCI_RedBand", GDALColorInterp::GCI_RedBand),
        ("GCI_GreenBand", GDALColorInterp::GCI_GreenBand),
        ("GCI_BlueBand", GDALColorInterp::GCI_BlueBand),
        ("GCI_AlphaBand", GDALColorInterp::GCI_AlphaBand),
        ("GCI_HueBand", GDALColorInterp::GCI_HueBand),
        ("GCI_SaturationBand", GDALColorInterp::GCI_SaturationBand),
        ("GCI_LightnessBand", GDALColorInterp::GCI_LightnessBand),
        ("GCI_CyanBand", GDALColorInterp::GCI_CyanBand),
        ("GCI_MagentaBand", GDALColorInterp::GCI_MagentaBand),
        ("GCI_YellowBand", GDALColorInterp::GCI_YellowBand),
        ("GCI_BlackBand", GDALColorInterp::GCI_BlackBand),
        ("GCI_YCbCr_YBand", GDALColorInterp::GCI_YCbCr_YBand),
        ("GCI_YCbCr_CbBand", GDALColorInterp::GCI_YCbCr_CbBand),
        ("GCI_YCbCr_CrBand", GDALColorInterp::GCI_YCbCr_CrBand),
        ("GPI_Gray", GDALPaletteInterp::GPI_Gray),
        ("GPI_RGB", GDALPaletteInterp::GPI_RGB),
        ("GPI_CMYK", GDALPaletteInterp::GPI_CMYK),
        ("GPI_HLS", GDALPaletteInterp::GPI_HLS),
        (
            "GRA_NearestNeighbour",
            GDALResampleAlg::GRA_NearestNeighbour,
        ),
        ("GRA_Bilinear", GDALResampleAlg::GRA_Bilinear),
        ("GRA_Cubic", GDALResampleAlg::GRA_Cubic),
        ("GRA_CubicSpline", GDALResampleAlg::GRA_CubicSpline),
        ("GRA_Lanczos", GDALResampleAlg::GRA_Lanczos),
        ("GRA_Average", GDALResampleAlg::GRA_Average),
        ("GRA_Mode", GDALResampleAlg::GRA_Mode),
    ] {
        add(name, value);
    }

    // Justifications, error classes and extended data type classes.
    for (name, value) in [
        ("OJUndefined", OGRJustification::OJUndefined),
        ("OJLeft", OGRJustification::OJLeft),
        ("OJRight", OGRJustification::OJRight),
        ("CE_None", CPLErr::CE_None),
        ("CE_Debug", CPLErr::CE_Debug),
        ("CE_Warning", CPLErr::CE_Warning),
        ("CE_Failure", CPLErr::CE_Failure),
        ("CE_Fatal", CPLErr::CE_Fatal),
        ("GEDTC_NUMERIC", GDALExtendedDataTypeClass::GEDTC_NUMERIC),
        ("GEDTC_STRING", GDALExtendedDataTypeClass::GEDTC_STRING),
        ("GEDTC_COMPOUND", GDALExtendedDataTypeClass::GEDTC_COMPOUND),
    ] {
        add(name, value);
    }

    table
}
