//! The GDAL sample types, mapped to the string literals JS sees.

use gdal::raster::GdalDataType;
use napi_derive::napi;

/// Sample type of a raster band, as `band.dataType`.
///
/// GDAL has no complex-number sample types in 0.19's enum, so this list is the
/// complete set.
#[napi(string_enum)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DataType {
    Unknown,
    Uint8,
    Int8,
    Uint16,
    Int16,
    Uint32,
    Int32,
    Uint64,
    Int64,
    Float32,
    Float64,
}

impl DataType {
    pub fn from_gdal(value: GdalDataType) -> Self {
        match value {
            GdalDataType::UInt8 => Self::Uint8,
            GdalDataType::Int8 => Self::Int8,
            GdalDataType::UInt16 => Self::Uint16,
            GdalDataType::Int16 => Self::Int16,
            GdalDataType::UInt32 => Self::Uint32,
            GdalDataType::Int32 => Self::Int32,
            GdalDataType::UInt64 => Self::Uint64,
            GdalDataType::Int64 => Self::Int64,
            GdalDataType::Float32 => Self::Float32,
            GdalDataType::Float64 => Self::Float64,
            _ => Self::Unknown,
        }
    }

    /// `None` for [`DataType::Unknown`], which cannot be requested explicitly.
    pub fn to_gdal(self) -> Option<GdalDataType> {
        Some(match self {
            Self::Uint8 => GdalDataType::UInt8,
            Self::Int8 => GdalDataType::Int8,
            Self::Uint16 => GdalDataType::UInt16,
            Self::Int16 => GdalDataType::Int16,
            Self::Uint32 => GdalDataType::UInt32,
            Self::Int32 => GdalDataType::Int32,
            Self::Uint64 => GdalDataType::UInt64,
            Self::Int64 => GdalDataType::Int64,
            Self::Float32 => GdalDataType::Float32,
            Self::Float64 => GdalDataType::Float64,
            Self::Unknown => return None,
        })
    }

    /// This binding's type for GDAL's numeric ordinal, for the FFI corners that hand
    /// back a bare code rather than a `GdalDataType`.
    pub fn from_code(code: gdal_sys::GDALDataType::Type) -> Self {
        match code {
            gdal_sys::GDALDataType::GDT_Byte => Self::Uint8,
            gdal_sys::GDALDataType::GDT_Int8 => Self::Int8,
            gdal_sys::GDALDataType::GDT_UInt16 => Self::Uint16,
            gdal_sys::GDALDataType::GDT_Int16 => Self::Int16,
            gdal_sys::GDALDataType::GDT_UInt32 => Self::Uint32,
            gdal_sys::GDALDataType::GDT_Int32 => Self::Int32,
            gdal_sys::GDALDataType::GDT_UInt64 => Self::Uint64,
            gdal_sys::GDALDataType::GDT_Int64 => Self::Int64,
            gdal_sys::GDALDataType::GDT_Float32 => Self::Float32,
            gdal_sys::GDALDataType::GDT_Float64 => Self::Float64,
            // Complex and half-float samples have no counterpart here.
            _ => Self::Unknown,
        }
    }

    /// The literal JS sees, as `band.dataType` spells it.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Unknown => "Unknown",
            Self::Uint8 => "Uint8",
            Self::Int8 => "Int8",
            Self::Uint16 => "Uint16",
            Self::Int16 => "Int16",
            Self::Uint32 => "Uint32",
            Self::Int32 => "Int32",
            Self::Uint64 => "Uint64",
            Self::Int64 => "Int64",
            Self::Float32 => "Float32",
            Self::Float64 => "Float64",
        }
    }

    pub const fn size(self) -> usize {
        match self {
            Self::Uint8 | Self::Int8 | Self::Unknown => 1,
            Self::Uint16 | Self::Int16 => 2,
            Self::Uint32 | Self::Int32 | Self::Float32 => 4,
            Self::Uint64 | Self::Int64 | Self::Float64 => 8,
        }
    }

    /// The `GDALDataType` ordinal, for the FFI calls that take one — `GDALRasterIO`,
    /// where this says how to read the bytes in the caller's buffer.
    ///
    /// `GdalDataType`'s variants are *declared as* the `GDALDataType` constants, which
    /// is the cast the crate itself makes; its own `gdal_ordinal` is not public.
    pub(crate) fn gdal_data_type(self) -> Option<gdal_sys::GDALDataType::Type> {
        self.to_gdal()
            .map(|value| value as gdal_sys::GDALDataType::Type)
    }
}

/// Bytes per sample. Handy for turning the raw buffer returned by `readPixels`
/// into a typed array: `new Float32Array(buf.buffer, buf.byteOffset, buf.length / gdal.bytesPerSample(t))`.
#[napi(catch_unwind)]
pub fn bytes_per_sample(data_type: DataType) -> u32 {
    data_type.size() as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    const KNOWN: [DataType; 10] = [
        DataType::Uint8,
        DataType::Int8,
        DataType::Uint16,
        DataType::Int16,
        DataType::Uint32,
        DataType::Int32,
        DataType::Uint64,
        DataType::Int64,
        DataType::Float32,
        DataType::Float64,
    ];

    #[test]
    fn every_known_type_survives_a_gdal_round_trip() {
        for data_type in KNOWN {
            let gdal_type = data_type.to_gdal().expect("known types map to GDAL");
            assert_eq!(DataType::from_gdal(gdal_type), data_type);
        }
    }

    #[test]
    fn unknown_is_not_requestable_but_is_representable() {
        assert!(DataType::Unknown.to_gdal().is_none());
        assert_eq!(
            DataType::from_gdal(GdalDataType::Unknown),
            DataType::Unknown
        );
    }

    #[test]
    fn the_gdal_ordinals_map_back_to_the_binding_names() {
        // GDAL's code 1 is `Byte`, which this binding spells `Uint8` — the one
        // ordinal whose name differs, and the one `fromDataType` translates.
        assert_eq!(
            DataType::from_code(gdal_sys::GDALDataType::GDT_Byte),
            DataType::Uint8
        );
        assert_eq!(
            DataType::from_code(gdal_sys::GDALDataType::GDT_Float64),
            DataType::Float64
        );
        // Complex and half-float samples have no counterpart here.
        assert_eq!(
            DataType::from_code(gdal_sys::GDALDataType::GDT_CInt16),
            DataType::Unknown
        );
        assert_eq!(
            DataType::from_code(gdal_sys::GDALDataType::GDT_Float16),
            DataType::Unknown
        );
    }

    #[test]
    fn sample_sizes_match_the_rust_types() {
        for data_type in KNOWN {
            let rust_size = match data_type {
                DataType::Uint8 | DataType::Int8 => 1,
                DataType::Uint16 | DataType::Int16 => 2,
                DataType::Uint32 | DataType::Int32 | DataType::Float32 => 4,
                _ => 8,
            };
            assert_eq!(data_type.size(), rust_size, "{data_type:?}");
        }
    }
}
