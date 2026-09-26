use std::env;

fn main() {
    napi_build::setup();
    detect_thread_safe_support();
}

/// Emit `gd_thread_safe` when the GDAL we are linking against is 3.10 or newer.
///
/// `gdal::ThreadSafeDataset` only exists for GDAL >= 3.10, and that `cfg` is set
/// inside the `gdal` crate where we cannot observe it. `gdal-sys` declares
/// `links = "gdal"` and is a direct dependency, so the version it detected does
/// reach us as `DEP_GDAL_VERSION_NUMBER`, encoded the way `GDAL_COMPUTE_VERSION`
/// does it: `major * 1_000_000 + minor * 10_000 + patch * 100`.
///
/// Mirroring the check here means linking a system GDAL older than 3.10 still
/// compiles — it just lacks `openThreadSafe` instead of failing outright.
fn detect_thread_safe_support() {
    println!("cargo:rerun-if-env-changed=DEP_GDAL_VERSION_NUMBER");

    let version = env::var("DEP_GDAL_VERSION_NUMBER")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok());

    // No version at all means an unusual dependency setup; assume a modern GDAL
    // rather than silently dropping the API from the default build.
    if version.is_none_or(|version| version >= 3_100_000) {
        println!("cargo:rustc-cfg=gd_thread_safe");
    }
}
