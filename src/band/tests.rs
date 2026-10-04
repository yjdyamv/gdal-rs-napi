//! Unit tests for the raster band surface.

use super::*;

const INTERPRETATIONS: [PaletteInterpretation; 4] = [
    PaletteInterpretation::Gray,
    PaletteInterpretation::Rgba,
    PaletteInterpretation::Cmyk,
    PaletteInterpretation::Hls,
];

#[test]
fn palette_names_round_trip() {
    for interpretation in INTERPRETATIONS {
        let name = palette_interpretation_to_str(interpretation);
        assert_eq!(
            palette_interpretation_from_str(name).unwrap(),
            interpretation,
            "{name} did not come back"
        );
    }
}

/// The setter takes whatever the getter reports, in whatever case it arrives.
#[test]
fn palette_names_ignore_case() {
    assert_eq!(
        palette_interpretation_from_str("gRaY").unwrap(),
        PaletteInterpretation::Gray
    );
}

#[test]
fn an_unknown_palette_interpretation_lists_the_alternatives() {
    let message = palette_interpretation_from_str("cmy").unwrap_err().reason;
    for name in [PALETTE_GRAY, PALETTE_RGBA, PALETTE_CMYK, PALETTE_HLS] {
        assert!(message.contains(name), "{message:?} does not name {name}");
    }
}

/// The ordinary table is RGBA, so the component order has to be the obvious one:
/// `c1` red, `c2` green, `c3` blue, `c4` alpha.
#[test]
fn an_rgba_entry_is_red_green_blue_alpha() {
    let entry = ColorTableEntry {
        c1: 1,
        c2: 2,
        c3: 3,
        c4: 4,
    };
    assert_eq!(
        ColorTableEntry::from_entry(entry.into_entry(PaletteInterpretation::Rgba)),
        entry
    );
}

/// GDAL's components are unsigned 16-bit even though its C struct is a signed
/// `short`, so the top half of that range has to survive the sign change.
#[test]
fn components_above_the_signed_maximum_survive() {
    let entry = ColorTableEntry {
        c1: 65000,
        c2: 32768,
        c3: 65535,
        c4: 1,
    };
    assert_eq!(
        ColorTableEntry::from_entry(entry.into_entry(PaletteInterpretation::Rgba)),
        entry
    );
}

/// What the getter hands out has to be accepted by the setter exactly, including
/// for the interpretations that use fewer than four components — otherwise
/// `setColorTable(band.colorTable, band.paletteInterpretation)` would not be the
/// round trip the docs claim.
#[test]
fn entries_survive_a_round_trip_through_every_interpretation() {
    let entry = ColorTableEntry {
        c1: 1,
        c2: 2,
        c3: 3,
        c4: 4,
    };
    for interpretation in INTERPRETATIONS {
        // The getter reports a component the interpretation does not use as zero,
        // so that is the shape a round trip has to preserve.
        let reported = ColorTableEntry::from_entry(entry.into_entry(interpretation));
        assert_eq!(
            ColorTableEntry::from_entry(reported.into_entry(interpretation)),
            reported,
            "{interpretation:?} did not round-trip"
        );
    }
}

/// The `into` claim is a byte *range*, so it catches a view overlapping one that
/// is in flight — not just the same buffer passed twice — and releases on drop.
#[test]
fn an_into_claim_covers_a_range_and_is_released_on_drop() {
    let buffer = [0u8; 16];
    let first = reserve_into(&buffer)
        .unwrap()
        .expect("a non-empty buffer is claimed");

    // The same range and an overlapping view are both refused.
    assert!(
        reserve_into(&buffer)
            .unwrap_err()
            .reason
            .contains("already being filled")
    );
    assert!(
        reserve_into(&buffer[4..8])
            .unwrap_err()
            .reason
            .contains("already being filled")
    );

    // A disjoint buffer is untouched by the claim.
    let disjoint = [0u8; 4];
    assert!(reserve_into(&disjoint).unwrap().is_some());

    // Releasing the first frees the range for the next reader.
    drop(first);
    assert!(reserve_into(&buffer).unwrap().is_some());
}

/// An empty buffer is never claimed: two of them can share a dangling address.
#[test]
fn an_empty_into_buffer_is_not_claimed() {
    let empty: [u8; 0] = [];
    assert!(reserve_into(&empty).unwrap().is_none());
    assert!(reserve_into(&empty).unwrap().is_none());
}
