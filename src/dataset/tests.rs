//! Unit tests for the dataset surface.

use super::*;

/// Where this API's 0-based indices meet GDAL's 1-based band numbers. GTiff
/// will not take a partial band list, so this cannot be pinned from a test
/// against a real file — hence a unit test on the translation itself.
#[test]
fn overviews_translate_band_indices_to_gdals_numbering() {
    let request = build_overviews_request(Some(BuildOverviewsOptions {
        bands: Some(vec![0, 2]),
        ..Default::default()
    }))
    .unwrap();
    assert_eq!(request.bands, vec![1, 3]);

    // No bands and no levels means "all bands" and "whatever suits this size",
    // both of which are settled later, once the dataset is in hand.
    let defaults = build_overviews_request(None).unwrap();
    assert!(defaults.bands.is_empty());
    assert!(defaults.levels.is_none());
    assert_eq!(defaults.resampling, "nearest");
}

#[test]
fn overviews_take_their_options_as_written() {
    let request = build_overviews_request(Some(BuildOverviewsOptions {
        levels: Some(vec![2, 4]),
        // Checked, and handed on in GDAL's own spelling.
        resampling: Some("CUBIC".to_string()),
        ..Default::default()
    }))
    .unwrap();
    assert_eq!(request.levels, Some(vec![2, 4]));
    assert_eq!(request.resampling, "cubic");

    // A decimation factor of 1 would ask for an overview the size of the
    // raster itself, which is not an overview.
    let err = build_overviews_request(Some(BuildOverviewsOptions {
        levels: Some(vec![4, 1]),
        ..Default::default()
    }))
    .unwrap_err();
    assert!(err.reason.contains("at least 2"), "{}", err.reason);

    let err = build_overviews_request(Some(BuildOverviewsOptions {
        resampling: Some("cubicc".to_string()),
        ..Default::default()
    }))
    .unwrap_err();
    assert!(
        err.reason.contains("unknown overview resampling"),
        "{}",
        err.reason
    );
}

/// An `open(buffer)` dataset owns the `/vsimem/` file its bytes live in. The
/// unlink is owned by the shared handle, so it waits for the **last** reference:
/// losing the `Dataset` object without `close()` still frees the file, while a band
/// that outlives the dataset keeps the file it reads from.
#[test]
fn a_mem_file_dataset_unlinks_its_file_when_the_last_reference_goes() {
    ensure_initialized();
    let path = "/vsimem/gdal-rs-napi-dataset-drop-test.tif";
    let _ = gdal::vsi::unlink_mem_file(path);

    let options = CreateOptions {
        driver: "GTiff".to_string(),
        width: 2,
        height: 2,
        band_count: Some(1),
        data_type: None,
        options: None,
    };
    let dataset = create_gdal(path, &options).unwrap();
    assert!(crate::fs::exists(path.to_string()));

    let handle = DatasetRef::serialised_mem_file(dataset, path.to_string());
    let band_side = handle.clone();
    drop(handle);
    // A clone still holds the dataset, so the file has to stay for it to read.
    assert!(crate::fs::exists(path.to_string()));

    drop(band_side);
    // Last reference gone: the dataset closed and the file went with it.
    assert!(!crate::fs::exists(path.to_string()));
}
