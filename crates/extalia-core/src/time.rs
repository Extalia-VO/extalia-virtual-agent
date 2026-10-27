//! UTC timestamps as the contracts write them (`isUtcTimestamp` in `@extalia/protocol`):
//! `YYYY-MM-DDTHH:mm:ss[.sss]Z` on a real proleptic Gregorian date, compared as
//! milliseconds since the Unix epoch like `Date.parse`.

use std::time::{SystemTime, UNIX_EPOCH};

const MS_PER_DAY: i64 = 86_400_000;

/// Milliseconds since the Unix epoch of a contract timestamp, or `None` when the text is
/// not one (wrong shape, calendar overflow such as `2026-02-30`, hour 24, leap second).
pub fn parse_utc(text: &str) -> Option<i64> {
    let bytes = text.as_bytes();
    if !(bytes.len() == 20 || (22..=24).contains(&bytes.len())) || bytes.last() != Some(&b'Z') {
        return None;
    }
    let digits = |range: std::ops::Range<usize>| -> Option<i64> {
        bytes[range].iter().try_fold(0i64, |sum, &byte| {
            byte.is_ascii_digit()
                .then(|| sum * 10 + i64::from(byte - b'0'))
        })
    };
    let separators = [(4, b'-'), (7, b'-'), (10, b'T'), (13, b':'), (16, b':')];
    if separators.iter().any(|&(index, byte)| bytes[index] != byte) {
        return None;
    }
    let (year, month, day) = (digits(0..4)?, digits(5..7)?, digits(8..10)?);
    let (hour, minute, second) = (digits(11..13)?, digits(14..16)?, digits(17..19)?);
    let millis = if bytes.len() == 20 {
        0
    } else {
        if bytes[19] != b'.' {
            return None;
        }
        let fraction = &bytes[20..bytes.len() - 1];
        let value = digits(20..bytes.len() - 1)?;
        value * 10i64.pow(3 - fraction.len() as u32)
    };
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    Some(
        days_from_civil(year, month, day) * MS_PER_DAY
            + ((hour * 60 + minute) * 60 + second) * 1_000
            + millis,
    )
}

/// `Date.prototype.toISOString` of a millisecond instant in years 0000-9999.
pub fn format_utc(millis: i64) -> String {
    let days = millis.div_euclid(MS_PER_DAY);
    let rest = millis.rem_euclid(MS_PER_DAY);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rest / 3_600_000,
        rest / 60_000 % 60,
        rest / 1_000 % 60,
        rest % 1_000
    )
}

/// The current time in milliseconds since the Unix epoch.
pub fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        2 if is_leap(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Days since 1970-01-01 (Howard Hinnant's `days_from_civil`).
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = year.div_euclid(400);
    let year_of_era = year - era * 400;
    let month_index = (month + 9) % 12;
    let day_of_year = (153 * month_index + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = days.div_euclid(146_097);
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_like_is_utc_timestamp() {
        assert_eq!(parse_utc("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_utc("1970-01-01T00:00:00.5Z"), Some(500));
        assert_eq!(parse_utc("1970-01-01T00:00:00.05Z"), Some(50));
        assert_eq!(
            parse_utc("2026-01-01T00:01:00.000Z"),
            Some(1_767_225_660_000)
        );
        assert_eq!(
            parse_utc("2024-02-29T23:59:59.999Z"),
            Some(1_709_251_199_999)
        );
        for invalid in [
            "2026-02-29T00:00:00Z",
            "2026-02-30T00:00:00Z",
            "2026-01-01T24:00:00Z",
            "2026-01-01T23:59:60Z",
            "2026-13-01T00:00:00Z",
            "2026-01-01T00:00:00.Z",
            "2026-01-01T00:00:00.1234Z",
            "2026-01-01 00:00:00Z",
            "2026-01-01T00:00:00+00:00",
            "+2026-01-01T00:00:00Z",
            "２026-01-01T00:00:00Z",
        ] {
            assert_eq!(parse_utc(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn formats_like_to_iso_string() {
        for text in [
            "1970-01-01T00:00:00.000Z",
            "2026-10-22T14:33:05.123Z",
            "2000-02-29T12:00:00.001Z",
            "0001-01-01T00:00:00.000Z",
            "9999-12-31T23:59:59.999Z",
        ] {
            assert_eq!(format_utc(parse_utc(text).unwrap()), text);
        }
    }
}
