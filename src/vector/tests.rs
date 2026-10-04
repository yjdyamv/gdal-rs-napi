//! Unit tests for the vector surface.

use serde_json::json;

use super::*;

const CANONICAL: [&str; 18] = [
    "Point",
    "LineString",
    "Polygon",
    "MultiPoint",
    "MultiLineString",
    "MultiPolygon",
    "GeometryCollection",
    "CircularString",
    "CompoundCurve",
    "CurvePolygon",
    "MultiCurve",
    "MultiSurface",
    "Curve",
    "Surface",
    "PolyhedralSurface",
    "TIN",
    "Triangle",
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
