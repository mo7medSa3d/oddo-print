//! Runtime regressions for the exact GTK 3 dependency backports.

#[cfg(test)]
mod tests {
    use glib::{prelude::*, Variant};

    fn strings() -> Variant {
        ["first", "مرحبا", "", "last"].to_variant()
    }

    #[test]
    fn variant_strings_iterate_forward_and_reverse_under_optimization() {
        let variant = strings();
        assert_eq!(
            variant.array_iter_str().unwrap().collect::<Vec<_>>(),
            vec!["first", "مرحبا", "", "last"]
        );
        assert_eq!(
            variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(),
            vec!["last", "", "مرحبا", "first"]
        );
    }

    #[test]
    fn variant_strings_nth_nth_back_and_last_share_sound_out_pointer() {
        let variant = strings();
        assert_eq!(variant.array_iter_str().unwrap().nth(1), Some("مرحبا"));
        assert_eq!(variant.array_iter_str().unwrap().nth_back(1), Some(""));
        assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
        let mut iter = variant.array_iter_str().unwrap();
        assert_eq!(iter.next(), Some("first"));
        assert_eq!(iter.next_back(), Some("last"));
        assert_eq!(iter.len(), 2);
        assert_eq!(iter.nth(usize::MAX), None);
        assert_eq!(iter.next_back(), None);
    }

    #[derive(Debug, PartialEq, Eq, Clone, Copy, glib::Enum)]
    #[enum_type(name = "YaseirNativeRegressionKind")]
    enum Kind {
        First = 1,
        Second = 2,
    }

    #[test]
    fn glib_derive_still_emits_working_value_conversion() {
        let value = Kind::Second.to_value();
        assert_eq!(value.get::<Kind>().unwrap(), Kind::Second);
    }
}
