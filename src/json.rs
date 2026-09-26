//! Coercions between JS values and the plain shapes GDAL asks for.
//!
//! Raster creation options and vector field writers both take `serde_json::Value`
//! from JS and both need the same "this has to be text / an integer / a number"
//! rules, so they live here rather than being duplicated in either caller.

use serde_json::Value;

use crate::error::{Result, bad_argument};

pub(crate) fn is_scalar(value: &Value) -> bool {
    matches!(value, Value::String(_) | Value::Bool(_) | Value::Number(_))
}

pub(crate) fn json_text(value: &Value) -> Result<String> {
    match value {
        Value::String(text) => Ok(text.clone()),
        Value::Bool(flag) => Ok(flag.to_string()),
        Value::Number(number) => Ok(number.to_string()),
        other => Err(bad_argument(format!("cannot write {other} as text"))),
    }
}

pub(crate) fn json_i64(value: &Value) -> Result<i64> {
    match value {
        Value::Bool(flag) => Ok(i64::from(*flag)),
        Value::Number(number) => number
            .as_i64()
            .ok_or_else(|| bad_argument(format!("{number} is not an integer"))),
        other => Err(bad_argument(format!("cannot write {other} as an integer"))),
    }
}

pub(crate) fn json_f64(value: &Value) -> Result<f64> {
    match value {
        Value::Bool(flag) => Ok(f64::from(u8::from(*flag))),
        Value::Number(number) => number
            .as_f64()
            .ok_or_else(|| bad_argument(format!("{number} is not a number"))),
        other => Err(bad_argument(format!("cannot write {other} as a number"))),
    }
}

/// Render an array as the comma-separated text a scalar field can hold. This is
/// what a driver without list columns needs, and it is the only thing we can do
/// without silently discarding values.
pub(crate) fn json_joined_text(value: &Value) -> Result<String> {
    match value {
        Value::Array(items) => {
            let mut parts = Vec::with_capacity(items.len());
            for item in items {
                parts.push(json_text(item)?);
            }
            Ok(parts.join(","))
        }
        other => json_text(other),
    }
}

/// Driver-specific creation options, as `(name, value)` pairs.
///
/// Every GDAL creation option is a string, so numbers and booleans are rendered
/// as text, which is what callers expect from `{ TILED: true, BLOCKSIZE: 256 }`.
pub(crate) fn option_pairs(options: Option<&Value>) -> Result<Vec<(String, String)>> {
    let Some(options) = options else {
        return Ok(Vec::new());
    };
    if options.is_null() {
        return Ok(Vec::new());
    }
    let Value::Object(map) = options else {
        return Err(bad_argument(
            "options must be an object of name/value pairs",
        ));
    };

    map.iter()
        .map(|(name, value)| Ok((name.clone(), json_text(value)?)))
        .collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_scalars_as_text() {
        assert_eq!(json_text(&json!("a")).unwrap(), "a");
        assert_eq!(json_text(&json!(42)).unwrap(), "42");
        assert_eq!(json_text(&json!(1.5)).unwrap(), "1.5");
        assert_eq!(json_text(&json!(true)).unwrap(), "true");
        assert!(json_text(&json!({})).is_err());
    }

    #[test]
    fn joins_arrays_into_text() {
        assert_eq!(json_joined_text(&json!(["a", "b"])).unwrap(), "a,b");
        assert_eq!(json_joined_text(&json!([1, 2, 3])).unwrap(), "1,2,3");
        assert_eq!(json_joined_text(&json!("solo")).unwrap(), "solo");
        assert!(json_joined_text(&json!([{}])).is_err());
    }

    #[test]
    fn reads_numbers_where_an_integer_is_wanted() {
        assert_eq!(json_i64(&json!(7)).unwrap(), 7);
        assert_eq!(json_i64(&json!(true)).unwrap(), 1);
        assert!(json_i64(&json!(1.5)).is_err());
        assert_eq!(json_f64(&json!(1.5)).unwrap(), 1.5);
        assert_eq!(json_f64(&json!(7)).unwrap(), 7.0);
        assert!(json_f64(&json!("nope")).is_err());
    }

    #[test]
    fn treats_absent_and_null_options_as_empty() {
        assert!(option_pairs(None).unwrap().is_empty());
        assert!(option_pairs(Some(&json!(null))).unwrap().is_empty());
        assert!(option_pairs(Some(&json!({}))).unwrap().is_empty());
        assert!(option_pairs(Some(&json!([1]))).is_err());
    }

    #[test]
    fn stringifies_option_values() {
        let pairs = option_pairs(Some(&json!({ "TILED": true, "BLOCKSIZE": 256 }))).unwrap();
        let mut sorted = pairs.clone();
        sorted.sort();
        assert_eq!(
            sorted,
            vec![
                ("BLOCKSIZE".to_string(), "256".to_string()),
                ("TILED".to_string(), "true".to_string()),
            ]
        );
    }

    #[test]
    fn recognises_scalars() {
        assert!(is_scalar(&json!("a")));
        assert!(is_scalar(&json!(1)));
        assert!(is_scalar(&json!(false)));
        assert!(!is_scalar(&json!([])));
        assert!(!is_scalar(&json!({})));
        assert!(!is_scalar(&json!(null)));
    }
}
