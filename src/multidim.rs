//! The multidimensional model — `Group`, `MDArray`, `Attribute`, `Dimension`.
//!
//! GDAL's multidimensional API is a second data model beside the raster/vector one:
//! a dataset with a `root` group holds arrays that may have any number of
//! dimensions, each with its own attributes and coordinate variables. It is what
//! NetCDF, HDF5 and Zarr look like through GDAL.
//!
//! Every handle here is **owned**: `GDALGroupOpenMDArray` and friends hand back a
//! reference the caller releases, so each type frees its own in `Drop` and keeps a
//! clone of the dataset's handle alive for as long as it is used. Every call takes
//! the exclusive side of the global lock, because all of it reaches into an open
//! dataset.

use std::collections::HashMap;
use std::ffi::CString;

use napi::bindgen_prelude::*;
use napi_derive::napi;

use crate::dataset::{DatasetRef, JsDataset};
use crate::dtype::DataType;
use crate::error::{Result, bad_argument, cpl_failure, driver_failure};
use crate::runtime::{c_string, ensure_initialized, lock_gdal};
use crate::spatial_ref::JsSpatialRef;

/// Walk a GDAL string list. It stays the driver's: `CSLConstList` is what GDAL hands
/// back for structural information, and that one must not be destroyed.
fn borrowed_string_list(list: gdal_sys::CSLConstList) -> Vec<String> {
    if list.is_null() {
        return Vec::new();
    }
    let mut names = Vec::new();
    let mut index = 0;
    loop {
        let entry = unsafe { *list.add(index) };
        if entry.is_null() {
            break;
        }
        names.push(c_string(entry));
        index += 1;
    }
    names
}

/// Walk a GDAL string list and destroy it. It is `CSLDestroy`'s list, so it is
/// owned; an empty list is a null pointer, not an empty one.
fn owned_string_list(list: gdal_sys::CSLConstList) -> Vec<String> {
    let names = borrowed_string_list(list);
    if !list.is_null() {
        unsafe { gdal_sys::CSLDestroy(list) };
    }
    names
}

/// A C string list entry as an owned `CString`, for the names GDAL wants back.
fn c_name(name: &str, what: &str) -> Result<CString> {
    CString::new(name).map_err(|_| bad_argument(format!("{what} cannot contain a NUL byte")))
}

/// A GDAL string list of `key=value` pairs as a map — the shape `GetStructuralInfo`
/// answers in. Borrowed, so it is read and left alone.
fn keyed_list(list: gdal_sys::CSLConstList) -> HashMap<String, String> {
    borrowed_string_list(list)
        .into_iter()
        .filter_map(|entry| {
            entry
                .split_once('=')
                .map(|(k, v)| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// The data type of an extended type handle, as this binding names it.
fn extended_type_name(handle: gdal_sys::GDALExtendedDataTypeH) -> String {
    let class = unsafe { gdal_sys::GDALExtendedDataTypeGetClass(handle) };
    match class {
        gdal_sys::GDALExtendedDataTypeClass::GEDTC_STRING => "String".to_string(),
        gdal_sys::GDALExtendedDataTypeClass::GEDTC_COMPOUND => "Compound".to_string(),
        _ => {
            DataType::from_code(unsafe { gdal_sys::GDALExtendedDataTypeGetNumericDataType(handle) })
                .name()
                .to_string()
        }
    }
}

/// Whether an extended type is numeric, and so readable into a plain buffer.
fn is_numeric(handle: gdal_sys::GDALExtendedDataTypeH) -> bool {
    (unsafe { gdal_sys::GDALExtendedDataTypeGetClass(handle) })
        == gdal_sys::GDALExtendedDataTypeClass::GEDTC_NUMERIC
}

/// A group: a node in the multidimensional tree, and the entry point to it.
#[napi(js_name = "Group")]
pub struct JsGroup {
    handle: gdal_sys::GDALGroupH,
    /// Keeps the dataset the handle came from alive for as long as it is used.
    dataset: DatasetRef,
}

impl Drop for JsGroup {
    fn drop(&mut self) {
        unsafe { gdal_sys::GDALGroupRelease(self.handle) };
    }
}

impl JsGroup {
    pub(crate) fn new(handle: gdal_sys::GDALGroupH, dataset: DatasetRef) -> Self {
        Self { handle, dataset }
    }

    /// Open one of the group's arrays by name, or answer `null`.
    fn array(&self, name: &str) -> Result<Option<JsMdArray>> {
        let name = c_name(name, "an array name")?;
        let handle = unsafe {
            gdal_sys::GDALGroupOpenMDArray(self.handle, name.as_ptr(), std::ptr::null_mut())
        };
        if handle.is_null() {
            return Ok(None);
        }
        Ok(Some(JsMdArray::new(handle, self.dataset.clone())))
    }

    /// The group's own dimensions, which are what its arrays index by.
    fn dimension_list(&self) -> Vec<JsDimension> {
        let mut count = 0usize;
        let list = unsafe {
            gdal_sys::GDALGroupGetDimensions(self.handle, &mut count, std::ptr::null_mut())
        };
        if list.is_null() {
            return Vec::new();
        }
        let dimensions = (0..count)
            .map(|index| {
                let handle = unsafe { *list.add(index) };
                JsDimension::new(handle, self.dataset.clone())
            })
            .collect();
        // The handles are now owned by the `JsDimension`s; only the array goes.
        unsafe { gdal_sys::VSIFree(list.cast()) };
        dimensions
    }
}

#[napi]
impl JsGroup {
    /// The group's own name — the empty string for a root group.
    #[napi(catch_unwind, getter)]
    pub fn name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALGroupGetName(self.handle) })
    }

    /// The name including its parents, e.g. `/group/sub`.
    #[napi(catch_unwind, getter)]
    pub fn full_name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALGroupGetFullName(self.handle) })
    }

    /// The names of the arrays in this group.
    #[napi(catch_unwind)]
    pub fn array_names(&self) -> Result<Vec<String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(owned_string_list(unsafe {
            gdal_sys::GDALGroupGetMDArrayNames(self.handle, std::ptr::null_mut())
        }))
    }

    /// The names of the sub-groups of this group.
    #[napi(catch_unwind)]
    pub fn group_names(&self) -> Result<Vec<String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(owned_string_list(unsafe {
            gdal_sys::GDALGroupGetGroupNames(self.handle, std::ptr::null_mut())
        }))
    }

    /// The group's own attributes — a whole group can carry metadata as attributes.
    #[napi(catch_unwind)]
    pub fn attributes(&self) -> Result<Vec<JsAttribute>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut count = 0usize;
        let list = unsafe {
            gdal_sys::GDALGroupGetAttributes(self.handle, &mut count, std::ptr::null_mut())
        };
        if list.is_null() {
            return Ok(Vec::new());
        }
        let attributes = (0..count)
            .map(|index| {
                let handle = unsafe { *list.add(index) };
                JsAttribute::new(handle, self.dataset.clone())
            })
            .collect();
        unsafe { gdal_sys::VSIFree(list.cast()) };
        Ok(attributes)
    }

    /// This group's dimensions, by name and size.
    #[napi(catch_unwind)]
    pub fn dimensions(&self) -> Result<Vec<JsDimension>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.dimension_list())
    }

    /// One array by name, or `null` when this group has no such array.
    #[napi(catch_unwind)]
    pub fn open_array(&self, name: String) -> Result<Option<JsMdArray>> {
        ensure_initialized();
        let _guard = lock_gdal();
        self.array(&name)
    }

    /// One sub-group by name, or `null`.
    #[napi(catch_unwind)]
    pub fn open_group(&self, name: String) -> Result<Option<JsGroup>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let name = c_name(&name, "a group name")?;
        let handle = unsafe {
            gdal_sys::GDALGroupOpenGroup(self.handle, name.as_ptr(), std::ptr::null_mut())
        };
        if handle.is_null() {
            return Ok(None);
        }
        Ok(Some(JsGroup::new(handle, self.dataset.clone())))
    }

    /// One attribute by name, or `null`.
    #[napi(catch_unwind)]
    pub fn open_attribute(&self, name: String) -> Result<Option<JsAttribute>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let name = c_name(&name, "an attribute name")?;
        let handle = unsafe { gdal_sys::GDALGroupGetAttribute(self.handle, name.as_ptr()) };
        if handle.is_null() {
            return Ok(None);
        }
        Ok(Some(JsAttribute::new(handle, self.dataset.clone())))
    }

    /// One dimension by name, or `null`.
    #[napi(catch_unwind)]
    pub fn open_dimension(&self, name: String) -> Result<Option<JsDimension>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self
            .dimension_list()
            .into_iter()
            .find(|dimension| dimension.name() == name))
    }

    /// GDAL's own metadata about the group — `IMAGE_STRUCTURE` and friends.
    #[napi(catch_unwind)]
    pub fn structural_info(&self) -> Result<HashMap<String, String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(keyed_list(unsafe {
            gdal_sys::GDALGroupGetStructuralInfo(self.handle)
        }))
    }
}

/// A multidimensional array: N-dimensional, with its own type, attributes and CRS.
#[napi(js_name = "MDArray")]
pub struct JsMdArray {
    handle: gdal_sys::GDALMDArrayH,
    dataset: DatasetRef,
}

impl Drop for JsMdArray {
    fn drop(&mut self) {
        unsafe { gdal_sys::GDALMDArrayRelease(self.handle) };
    }
}

impl JsMdArray {
    pub(crate) fn new(handle: gdal_sys::GDALMDArrayH, dataset: DatasetRef) -> Self {
        Self { handle, dataset }
    }

    fn dimension_list(&self) -> Vec<JsDimension> {
        let mut count = 0usize;
        let list = unsafe { gdal_sys::GDALMDArrayGetDimensions(self.handle, &mut count) };
        if list.is_null() {
            return Vec::new();
        }
        let dimensions = (0..count)
            .map(|index| {
                let handle = unsafe { *list.add(index) };
                JsDimension::new(handle, self.dataset.clone())
            })
            .collect();
        unsafe { gdal_sys::VSIFree(list.cast()) };
        dimensions
    }
}

#[napi]
impl JsMdArray {
    #[napi(catch_unwind, getter)]
    pub fn name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALMDArrayGetName(self.handle) })
    }

    #[napi(catch_unwind, getter)]
    pub fn full_name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALMDArrayGetFullName(self.handle) })
    }

    /// How many dimensions the array has.
    #[napi(catch_unwind, getter)]
    pub fn dimension_count(&self) -> u32 {
        (unsafe { gdal_sys::GDALMDArrayGetDimensionCount(self.handle) }) as u32
    }

    /// The size along each dimension, in order.
    #[napi(catch_unwind, getter)]
    pub fn shape(&self) -> Result<Vec<u32>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self
            .dimension_list()
            .into_iter()
            .map(|dimension| dimension.size())
            .collect())
    }

    /// The array's sample type — `'Float32'`, `'Int16'`, `'String'`, `'Compound'`.
    #[napi(catch_unwind, getter)]
    pub fn data_type(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        let handle = unsafe { gdal_sys::GDALMDArrayGetDataType(self.handle) };
        let name = extended_type_name(handle);
        unsafe { gdal_sys::GDALExtendedDataTypeRelease(handle) };
        Ok(name)
    }

    /// The array's unit, or `null`.
    #[napi(catch_unwind, getter)]
    pub fn unit(&self) -> Result<Option<String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let unit = c_string(unsafe { gdal_sys::GDALMDArrayGetUnit(self.handle) });
        Ok(if unit.is_empty() { None } else { Some(unit) })
    }

    /// The array's missing-data value, or `null` when it has none.
    #[napi(catch_unwind, getter)]
    pub fn no_data_value(&self) -> Result<Option<f64>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut present: std::ffi::c_int = 0;
        let value =
            unsafe { gdal_sys::GDALMDArrayGetNoDataValueAsDouble(self.handle, &mut present) };
        Ok(if present == 0 { None } else { Some(value) })
    }

    /// The offset of a scaled array. `null` when it carries none.
    #[napi(catch_unwind, getter)]
    pub fn offset(&self) -> Result<Option<f64>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut present: std::ffi::c_int = 0;
        let value = unsafe { gdal_sys::GDALMDArrayGetOffset(self.handle, &mut present) };
        Ok(if present == 0 { None } else { Some(value) })
    }

    /// The scale of a scaled array. `null` when it carries none.
    #[napi(catch_unwind, getter)]
    pub fn scale(&self) -> Result<Option<f64>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut present: std::ffi::c_int = 0;
        let value = unsafe { gdal_sys::GDALMDArrayGetScale(self.handle, &mut present) };
        Ok(if present == 0 { None } else { Some(value) })
    }

    /// The array's CRS, or `null` when it has none.
    #[napi(catch_unwind, getter)]
    pub fn srs(&self) -> Result<Option<JsSpatialRef>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let handle = unsafe { gdal_sys::GDALMDArrayGetSpatialRef(self.handle) };
        if handle.is_null() {
            return Ok(None);
        }
        // The array owns that reference; the binding's `SpatialRef` wants its own.
        let wkt = unsafe {
            let mut text: *mut std::ffi::c_char = std::ptr::null_mut();
            gdal_sys::OSRExportToWkt(handle, &mut text);
            let wkt = c_string(text);
            if !text.is_null() {
                gdal_sys::VSIFree(text.cast());
            }
            wkt
        };
        // Not the `fromDefinition` factory: it takes the shared side of the lock, and
        // this already holds the write side. Same call, without the nested lock.
        Ok(Some(JsSpatialRef::build_from_definition(&wkt)?))
    }

    /// The array's dimensions, in order.
    #[napi(catch_unwind)]
    pub fn dimensions(&self) -> Result<Vec<JsDimension>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(self.dimension_list())
    }

    /// The array's attributes.
    #[napi(catch_unwind)]
    pub fn attributes(&self) -> Result<Vec<JsAttribute>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let mut count = 0usize;
        let list = unsafe {
            gdal_sys::GDALMDArrayGetAttributes(self.handle, &mut count, std::ptr::null_mut())
        };
        if list.is_null() {
            return Ok(Vec::new());
        }
        let attributes = (0..count)
            .map(|index| {
                let handle = unsafe { *list.add(index) };
                JsAttribute::new(handle, self.dataset.clone())
            })
            .collect();
        unsafe { gdal_sys::VSIFree(list.cast()) };
        Ok(attributes)
    }

    /// One attribute by name, or `null`.
    #[napi(catch_unwind)]
    pub fn open_attribute(&self, name: String) -> Result<Option<JsAttribute>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let name = c_name(&name, "an attribute name")?;
        let handle = unsafe { gdal_sys::GDALMDArrayGetAttribute(self.handle, name.as_ptr()) };
        if handle.is_null() {
            return Ok(None);
        }
        Ok(Some(JsAttribute::new(handle, self.dataset.clone())))
    }

    /// GDAL's own metadata about the array.
    #[napi(catch_unwind)]
    pub fn structural_info(&self) -> Result<HashMap<String, String>> {
        ensure_initialized();
        let _guard = lock_gdal();
        Ok(keyed_list(unsafe {
            gdal_sys::GDALMDArrayGetStructuralInfo(self.handle)
        }))
    }

    /// Read a hyperslab whole, as raw bytes in the array's own numeric type — the
    /// multidimensional counterpart of `readPixels`. `start` and `count` are one
    /// entry per dimension; with none, the whole array is read. A `String` or
    /// `Compound` array has no plain byte form and is refused.
    #[napi(catch_unwind)]
    pub fn read(&self, options: Option<MdReadOptions>) -> Result<Buffer> {
        ensure_initialized();
        let _guard = lock_gdal();

        let data_type = unsafe { gdal_sys::GDALMDArrayGetDataType(self.handle) };
        // The type handle is released once on every path out, which the closure makes
        // structural rather than a `Release` repeated at each early return.
        let outcome = (|| -> Result<Vec<u8>> {
            if !is_numeric(data_type) {
                return Err(driver_failure(
                    "only a numeric MDArray can be read as bytes; a String or Compound one cannot",
                ));
            }
            let sample_bytes = unsafe { gdal_sys::GDALExtendedDataTypeGetSize(data_type) };

            let shape: Vec<u64> = self
                .dimension_list()
                .into_iter()
                .map(|dimension| dimension.size() as u64)
                .collect();
            let options = options.unwrap_or_default();
            let start: Vec<u64> = match options.start {
                Some(start) if start.len() == shape.len() => {
                    start.iter().map(|value| *value as u64).collect()
                }
                Some(start) => {
                    return Err(bad_argument(format!(
                        "start has to name every dimension: {} of them, got {}",
                        shape.len(),
                        start.len()
                    )));
                }
                None => vec![0; shape.len()],
            };
            let count: Vec<usize> = match options.count {
                Some(count) if count.len() == shape.len() => {
                    count.iter().map(|c| *c as usize).collect()
                }
                Some(count) => {
                    return Err(bad_argument(format!(
                        "count has to name every dimension: {} of them, got {}",
                        shape.len(),
                        count.len()
                    )));
                }
                None => shape.iter().map(|size| *size as usize).collect(),
            };

            // The window has to sit inside the array. GDAL would otherwise read
            // whatever an out-of-range start or count pointed at, so it is checked
            // here rather than left to it.
            for (axis, ((&start, &count), &size)) in
                start.iter().zip(&count).zip(&shape).enumerate()
            {
                let end = start.checked_add(count as u64);
                if start > size || end.is_none_or(|end| end > size) {
                    return Err(bad_argument(format!(
                        "the window on dimension {axis} starts at {start} for {count} element(s), \
                         which runs past that dimension's size of {size}"
                    )));
                }
            }

            // `checked_mul` rather than `*`: a window large enough to overflow `usize`
            // is refused, not wrapped into a small allocation the read would then
            // overrun.
            let bytes = count
                .iter()
                .try_fold(1usize, |product, &count| product.checked_mul(count))
                .and_then(|elements| elements.checked_mul(sample_bytes))
                .ok_or_else(|| {
                    bad_argument("the requested window is too large to read in one piece")
                })?;

            let mut data = vec![0u8; bytes];
            let status = unsafe {
                gdal_sys::GDALMDArrayRead(
                    self.handle,
                    start.as_ptr(),
                    count.as_ptr(),
                    std::ptr::null(),
                    std::ptr::null(),
                    data_type,
                    data.as_mut_ptr().cast(),
                    std::ptr::null(),
                    0,
                )
            };
            if status == 0 {
                return Err(cpl_failure("this array could not be read".to_owned()));
            }
            Ok(data)
        })();
        unsafe { gdal_sys::GDALExtendedDataTypeRelease(data_type) };
        Ok(outcome?.into())
    }

    /// A classic 2D view of the array, as a `Dataset` — the bridge back to the
    /// raster side, so a 3D array's band can be read with `readPixels`. `null` when
    /// GDAL will not make one.
    ///
    /// The X and Y dimensions are the ones GDAL marks `HORIZONTAL_X` /
    /// `HORIZONTAL_Y`; failing that, the last two. A file that leaves the axes
    /// untagged — a classic netCDF, for one — lands on that fallback, so pass
    /// `xDim` and `yDim` to say which is which.
    #[napi(catch_unwind)]
    pub fn as_dataset(&self, options: Option<MdAsDatasetOptions>) -> Result<Option<JsDataset>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let dimensions = self.dimension_list();
        if dimensions.len() < 2 {
            return Err(bad_argument(
                "asDataset needs at least two dimensions to make a raster of",
            ));
        }
        let options = options.unwrap_or_default();
        let (x, y) = match (options.x_dim, options.y_dim) {
            (Some(x), Some(y)) => (x as usize, y as usize),
            (None, None) => {
                let index_of = |wanted: &str| {
                    dimensions
                        .iter()
                        .position(|dimension| dimension.type_name().eq_ignore_ascii_case(wanted))
                };
                match (index_of("HORIZONTAL_X"), index_of("HORIZONTAL_Y")) {
                    (Some(x), Some(y)) => (x, y),
                    _ => (dimensions.len() - 2, dimensions.len() - 1),
                }
            }
            _ => {
                return Err(bad_argument(
                    "give both xDim and yDim, or neither: one alone has no meaning",
                ));
            }
        };
        if x >= dimensions.len() || y >= dimensions.len() {
            return Err(bad_argument(format!(
                "xDim and yDim have to be dimension indexes below {}",
                dimensions.len()
            )));
        }
        if x == y {
            return Err(bad_argument("xDim and yDim cannot be the same dimension"));
        }

        let handle = unsafe { gdal_sys::GDALMDArrayAsClassicDataset(self.handle, x, y) };
        if handle.is_null() {
            return Ok(None);
        }
        // GDAL hands over a dataset this binding now owns and closes.
        let dataset = unsafe { gdal::Dataset::from_c_dataset(handle) };
        Ok(Some(JsDataset::wrap(dataset, String::new())))
    }

    /// The array's validity mask, as another `MDArray`.
    #[napi(catch_unwind)]
    pub fn get_mask(&self) -> Result<JsMdArray> {
        ensure_initialized();
        let _guard = lock_gdal();
        let handle = unsafe { gdal_sys::GDALMDArrayGetMask(self.handle, std::ptr::null_mut()) };
        if handle.is_null() {
            return Err(cpl_failure("this array has no mask".to_owned()));
        }
        Ok(JsMdArray::new(handle, self.dataset.clone()))
    }

    /// A view of the array under a GDAL view expression, e.g. `[0,::2]`. A new
    /// array; the original is unchanged.
    #[napi(catch_unwind)]
    pub fn get_view(&self, expression: String) -> Result<JsMdArray> {
        ensure_initialized();
        let _guard = lock_gdal();
        let expression = c_name(&expression, "a view expression")?;
        let handle = unsafe { gdal_sys::GDALMDArrayGetView(self.handle, expression.as_ptr()) };
        if handle.is_null() {
            // Our own message rather than GDAL's: a malformed expression leaves
            // something like `Missing ]'`, which is less use than naming the call.
            return Err(driver_failure("this view expression could not be applied"));
        }
        Ok(JsMdArray::new(handle, self.dataset.clone()))
    }
}

/// A hyperslab: one `start` and one `count` per dimension.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MdReadOptions {
    /// Where to start along each dimension. Default: the origin.
    pub start: Option<Vec<u32>>,
    /// How many elements to read along each dimension. Default: to the end.
    pub count: Option<Vec<u32>>,
}

/// Which dimensions `asDataset` should turn into X and Y.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MdAsDatasetOptions {
    /// The dimension that becomes the raster's X axis, by index.
    pub x_dim: Option<u32>,
    /// The dimension that becomes the raster's Y axis, by index.
    pub y_dim: Option<u32>,
}

/// An attribute: a value attached to a group or an array.
#[napi(js_name = "Attribute")]
pub struct JsAttribute {
    handle: gdal_sys::GDALAttributeH,
    /// Keeps the dataset behind the attribute alive for as long as it is held. The
    /// handle is never read through, only held.
    #[allow(dead_code)]
    dataset: DatasetRef,
}

impl Drop for JsAttribute {
    fn drop(&mut self) {
        unsafe { gdal_sys::GDALAttributeRelease(self.handle) };
    }
}

impl JsAttribute {
    pub(crate) fn new(handle: gdal_sys::GDALAttributeH, dataset: DatasetRef) -> Self {
        Self { handle, dataset }
    }
}

#[napi]
impl JsAttribute {
    #[napi(catch_unwind, getter)]
    pub fn name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALAttributeGetName(self.handle) })
    }

    #[napi(catch_unwind, getter)]
    pub fn full_name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALAttributeGetFullName(self.handle) })
    }

    /// The attribute's type as this binding names it — `'String'`, `'Float64'`, …
    #[napi(catch_unwind, getter)]
    pub fn data_type(&self) -> Result<String> {
        ensure_initialized();
        let _guard = lock_gdal();
        let handle = unsafe { gdal_sys::GDALAttributeGetDataType(self.handle) };
        let name = extended_type_name(handle);
        unsafe { gdal_sys::GDALExtendedDataTypeRelease(handle) };
        Ok(name)
    }

    /// The attribute's value — a string, a number, or an array of either, according
    /// to its type and how many elements it holds.
    #[napi(catch_unwind, getter)]
    pub fn value(&self) -> Result<serde_json::Value> {
        ensure_initialized();
        let _guard = lock_gdal();

        let count = unsafe { gdal_sys::GDALAttributeGetTotalElementsCount(self.handle) } as usize;
        let class = unsafe { gdal_sys::GDALAttributeGetDataType(self.handle) };
        let is_string = unsafe { gdal_sys::GDALExtendedDataTypeGetClass(class) }
            == gdal_sys::GDALExtendedDataTypeClass::GEDTC_STRING;
        unsafe { gdal_sys::GDALExtendedDataTypeRelease(class) };

        if is_string {
            if count <= 1 {
                return Ok(serde_json::Value::from(c_string(unsafe {
                    gdal_sys::GDALAttributeReadAsString(self.handle)
                })));
            }
            let list = unsafe { gdal_sys::GDALAttributeReadAsStringArray(self.handle) };
            return Ok(serde_json::Value::from(owned_string_list(list)));
        }

        let data_type = unsafe { gdal_sys::GDALAttributeGetDataType(self.handle) };
        let numeric = unsafe { gdal_sys::GDALExtendedDataTypeGetNumericDataType(data_type) };
        let float = matches!(
            numeric,
            gdal_sys::GDALDataType::GDT_Float32 | gdal_sys::GDALDataType::GDT_Float64
        );
        unsafe { gdal_sys::GDALExtendedDataTypeRelease(data_type) };

        if count <= 1 {
            let value = if float {
                unsafe { gdal_sys::GDALAttributeReadAsDouble(self.handle) }
            } else {
                (unsafe { gdal_sys::GDALAttributeReadAsInt64(self.handle) }) as f64
            };
            return Ok(serde_json::Value::from(value));
        }

        let mut length = 0usize;
        if float {
            let list =
                unsafe { gdal_sys::GDALAttributeReadAsDoubleArray(self.handle, &mut length) };
            let values = if list.is_null() {
                Vec::new()
            } else {
                let values = (0..length).map(|i| unsafe { *list.add(i) }).collect();
                unsafe { gdal_sys::VSIFree(list.cast()) };
                values
            };
            Ok(serde_json::Value::from(values))
        } else {
            let list = unsafe { gdal_sys::GDALAttributeReadAsInt64Array(self.handle, &mut length) };
            let values: Vec<i64> = if list.is_null() {
                Vec::new()
            } else {
                let values = (0..length).map(|i| unsafe { *list.add(i) }).collect();
                unsafe { gdal_sys::VSIFree(list.cast()) };
                values
            };
            Ok(serde_json::Value::from(values))
        }
    }
}

/// One dimension of a multidimensional array.
#[napi(js_name = "Dimension")]
pub struct JsDimension {
    handle: gdal_sys::GDALDimensionH,
    dataset: DatasetRef,
}

impl Drop for JsDimension {
    fn drop(&mut self) {
        unsafe { gdal_sys::GDALDimensionRelease(self.handle) };
    }
}

impl JsDimension {
    pub(crate) fn new(handle: gdal_sys::GDALDimensionH, dataset: DatasetRef) -> Self {
        Self { handle, dataset }
    }
}

#[napi]
impl JsDimension {
    #[napi(catch_unwind, getter)]
    pub fn name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALDimensionGetName(self.handle) })
    }

    #[napi(catch_unwind, getter)]
    pub fn full_name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALDimensionGetFullName(self.handle) })
    }

    /// How many elements the dimension has.
    #[napi(catch_unwind, getter)]
    pub fn size(&self) -> u32 {
        (unsafe { gdal_sys::GDALDimensionGetSize(self.handle) }) as u32
    }

    /// The axis type: `HORIZONTAL_X` / `HORIZONTAL_Y` / `VERTICAL` / `TEMPORAL` /
    /// `PARAMETRIC`, or the empty string when GDAL does not say.
    #[napi(catch_unwind, getter)]
    pub fn type_name(&self) -> String {
        c_string(unsafe { gdal_sys::GDALDimensionGetType(self.handle) })
    }

    /// The direction the values run in — `EAST`, `NORTH`, `UP`, … — or `null`.
    #[napi(catch_unwind, getter)]
    pub fn direction(&self) -> Option<String> {
        let direction = c_string(unsafe { gdal_sys::GDALDimensionGetDirection(self.handle) });
        if direction.is_empty() {
            None
        } else {
            Some(direction)
        }
    }

    /// The coordinate variable this dimension indexes by, if it has one.
    #[napi(catch_unwind, getter)]
    pub fn indexing_variable(&self) -> Result<Option<JsMdArray>> {
        ensure_initialized();
        let _guard = lock_gdal();
        let handle = unsafe { gdal_sys::GDALDimensionGetIndexingVariable(self.handle) };
        if handle.is_null() {
            return Ok(None);
        }
        Ok(Some(JsMdArray::new(handle, self.dataset.clone())))
    }
}
