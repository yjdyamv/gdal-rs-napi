//! Raster algorithms that are neither I/O nor a program: the ones GDAL exposes as
//! plain `GDAL*` calls on a band.
//!
//! They live here for the same reason `raster_io` does — `band.rs` stays the napi
//! surface, and the raw glue sits in one place. Nothing here takes the global GDAL
//! lock; the callers do.

use std::ffi::c_int;

use gdal::errors::GdalError;
use gdal::raster::RasterBand;
use napi_derive::napi;

use crate::error::{Result, bad_argument, gdal_error};
use crate::raster_io::ReadOptions;
use crate::runtime::c_string;

/// Turn a `CPLErr` into this binding's error.
///
/// The `gdal` crate reads GDAL's last error and then resets it inside helpers that
/// are not reachable from here, so this reads the class, number and message by hand
/// and builds the same `GdalError` — which is what gives the sync surface its
/// `err.code`.
pub fn cpl_result(class: gdal_sys::CPLErr::Type) -> Result<()> {
    if class == gdal_sys::CPLErr::CE_None {
        return Ok(());
    }
    Err(gdal_error(GdalError::CplError {
        class,
        number: unsafe { gdal_sys::CPLGetLastErrorNo() },
        msg: c_string(unsafe { gdal_sys::CPLGetLastErrorMsg() }),
    }))
}

/// The options a checksum takes: the window, and nothing else.
///
/// A checksum is of the samples as they are, so `resampling` / `outWidth` /
/// `outHeight` have nothing to act on — they are refused rather than quietly
/// ignored, so a caller who passes them finds out.
pub fn checksum_options(options: Option<ReadOptions>) -> Result<ReadOptions> {
    let options = options.unwrap_or_default();
    if options.resampling.is_some() || options.out_width.is_some() || options.out_height.is_some() {
        return Err(bad_argument(
            "a checksum is of the window as it is, so resampling, outWidth and outHeight do not apply",
        ));
    }
    Ok(options)
}

#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct FillNoDataOptions {
    /// How far, in pixels, to look for a value to fill from. Default 100, which is
    /// GDAL's own default.
    pub max_distance: Option<f64>,
    /// Smoothing passes over the filled area afterwards. Default 0, GDAL's default.
    pub smoothing_iterations: Option<u32>,
}

/// `FillNoDataOptions` resolved and checked, so a bad request fails on the JS
/// thread and the worker only ever sees numbers that make sense.
#[derive(Debug, Clone, Copy)]
pub struct FillNoDataRequest {
    max_distance: f64,
    smoothing_iterations: c_int,
}

pub fn fill_nodata_request(options: Option<FillNoDataOptions>) -> Result<FillNoDataRequest> {
    let options = options.unwrap_or_default();
    let max_distance = options.max_distance.unwrap_or(100.0);
    // A positive test, because NaN fails every comparison.
    if !(max_distance.is_finite() && max_distance > 0.0) {
        return Err(bad_argument(format!(
            "a fill distance has to be a positive number of pixels, but it is {max_distance}"
        )));
    }
    let iterations = options.smoothing_iterations.unwrap_or(0);
    let smoothing_iterations = c_int::try_from(iterations)
        .map_err(|_| bad_argument(format!("{iterations} smoothing iterations is too many")))?;
    Ok(FillNoDataRequest {
        max_distance,
        smoothing_iterations,
    })
}

#[napi(object)]
#[derive(Debug, Clone)]
pub struct SieveFilterOptions {
    /// Smallest connected region, in pixels, worth keeping. Regions below it take
    /// the value of their largest neighbour.
    pub threshold: u32,
    /// Either 4 or 8 neighbouring pixels. Default 4, as in GDAL.
    pub connectedness: Option<u32>,
}

/// `SieveFilterOptions` resolved and checked.
#[derive(Debug, Clone, Copy)]
pub struct SieveFilterRequest {
    threshold: c_int,
    connectedness: c_int,
}

pub fn sieve_filter_request(options: SieveFilterOptions) -> Result<SieveFilterRequest> {
    let connectedness = options.connectedness.unwrap_or(4);
    if connectedness != 4 && connectedness != 8 {
        return Err(bad_argument(format!(
            "connectedness is 4 or 8, following GDAL, not {connectedness}"
        )));
    }
    if options.threshold == 0 {
        return Err(bad_argument(
            "a threshold of 0 would remove nothing: give the smallest region size to keep, in pixels",
        ));
    }
    let threshold = c_int::try_from(options.threshold)
        .map_err(|value| bad_argument(format!("a threshold of {value} pixels is too large")))?;
    Ok(SieveFilterRequest {
        threshold,
        connectedness: connectedness as c_int,
    })
}

/// Fill no-data pixels from their neighbours. `GDALFillNodata`, in place.
pub fn fill_no_data(band: &RasterBand<'_>, request: FillNoDataRequest) -> Result<()> {
    // Without a no-data value GDAL has no way to tell a hole from data, and it
    // reports that as a failure a long way from here — so say it plainly.
    if band.no_data_value().is_none() {
        return Err(bad_argument(
            "the band has no no-data value, so there is nothing to fill",
        ));
    }

    let class = unsafe {
        gdal_sys::GDALFillNodata(
            band.c_rasterband(),
            // A null mask band means the band's own mask, which is the usual case.
            std::ptr::null_mut(),
            request.max_distance,
            0, // the deprecated `bCon` argument
            request.smoothing_iterations,
            std::ptr::null_mut(),
            None,
            std::ptr::null_mut(),
        )
    };
    cpl_result(class)
}

/// Remove connected regions smaller than the threshold. `GDALSieveFilter`, in
/// place: the band is its own source and destination.
pub fn sieve_filter(band: &RasterBand<'_>, request: SieveFilterRequest) -> Result<()> {
    let class = unsafe {
        // The band is both source and destination, which is what "in place" means
        // here: GDAL reads and rewrites the samples of this one band.
        let handle = band.c_rasterband();
        gdal_sys::GDALSieveFilter(
            handle,
            // Null mask, as in `fill_no_data`.
            std::ptr::null_mut(),
            handle,
            request.threshold,
            request.connectedness,
            std::ptr::null_mut(),
            None,
            std::ptr::null_mut(),
        )
    };
    cpl_result(class)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_fill_distance_has_to_be_a_positive_number() {
        let request = fill_nodata_request(Some(FillNoDataOptions {
            max_distance: Some(25.0),
            smoothing_iterations: Some(3),
        }))
        .unwrap();
        assert_eq!(request.max_distance, 25.0);
        assert_eq!(request.smoothing_iterations, 3);

        // The defaults are GDAL's own.
        let defaults = fill_nodata_request(None).unwrap();
        assert_eq!(defaults.max_distance, 100.0);
        assert_eq!(defaults.smoothing_iterations, 0);

        for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(
                fill_nodata_request(Some(FillNoDataOptions {
                    max_distance: Some(bad),
                    ..Default::default()
                }))
                .is_err(),
                "{bad} should be refused"
            );
        }
    }

    #[test]
    fn sieve_takes_four_or_eight_and_a_real_threshold() {
        let request = sieve_filter_request(SieveFilterOptions {
            threshold: 10,
            connectedness: Some(8),
        })
        .unwrap();
        assert_eq!(request.threshold, 10);
        assert_eq!(request.connectedness, 8);

        // Four is what GDAL uses when nobody says otherwise.
        let defaults = sieve_filter_request(SieveFilterOptions {
            threshold: 10,
            connectedness: None,
        })
        .unwrap();
        assert_eq!(defaults.connectedness, 4);

        assert!(
            sieve_filter_request(SieveFilterOptions {
                threshold: 10,
                connectedness: Some(6)
            })
            .is_err()
        );
        assert!(
            sieve_filter_request(SieveFilterOptions {
                threshold: 0,
                connectedness: None
            })
            .is_err()
        );
    }

    #[test]
    fn a_checksum_refuses_the_resampling_knobs() {
        use crate::raster_io::ReadOptions;

        assert!(checksum_options(None).is_ok());
        assert!(checksum_options(Some(ReadOptions::default())).is_ok());

        for options in [
            ReadOptions {
                resampling: Some("average".to_string()),
                ..Default::default()
            },
            ReadOptions {
                out_width: Some(2),
                ..Default::default()
            },
            ReadOptions {
                out_height: Some(2),
                ..Default::default()
            },
        ] {
            assert!(checksum_options(Some(options)).is_err());
        }
    }
}
