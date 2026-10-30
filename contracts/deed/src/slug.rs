//! Slug and title validation. Pure logic.

pub const SLUG_MIN: usize = 2;
pub const SLUG_MAX: usize = 32;
pub const ACCOUNT_ID_MAX: usize = 64;
pub const TITLE_MAX: usize = 64;

/// A slug becomes both the token id and the first part of the vault account id, so it must
/// be `[a-z0-9-]`, 2 to 32 chars, and a valid account id part: no leading, trailing or
/// doubled hyphen.
pub fn validate_slug(slug: &str, deed_account: &str) -> Result<(), &'static str> {
    if slug.len() < SLUG_MIN || slug.len() > SLUG_MAX {
        return Err("slug must be 2 to 32 characters");
    }
    if !slug.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return Err("slug may only contain a-z, 0-9 and -");
    }
    if slug.starts_with('-') || slug.ends_with('-') || slug.contains("--") {
        return Err("slug may not start or end with - or contain --");
    }
    if slug.len() + 1 + deed_account.len() > ACCOUNT_ID_MAX {
        return Err("vault account id would exceed 64 characters");
    }
    Ok(())
}

pub fn validate_title(title: &str) -> Result<(), &'static str> {
    let trimmed = title.trim();
    if trimmed.is_empty() || title.chars().count() > TITLE_MAX {
        return Err("title must be 1 to 64 characters");
    }
    if title.chars().any(|c| c.is_control()) {
        return Err("title may not contain control characters");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const DEED: &str = "deed.deedlab.testnet";

    #[test]
    fn accepts_valid_slugs() {
        for s in ["relay", "ab", "web-hook-2", "a1", &"x".repeat(32)] {
            assert_eq!(validate_slug(s, DEED), Ok(()), "{s}");
        }
    }

    #[test]
    fn rejects_bad_characters_and_lengths() {
        for s in ["a", "", "Relay", "re_lay", "re.lay", "ré", "a b", &"x".repeat(33)] {
            assert!(validate_slug(s, DEED).is_err(), "{s}");
        }
    }

    #[test]
    fn rejects_bad_hyphens() {
        for s in ["-ab", "ab-", "a--b"] {
            assert!(validate_slug(s, DEED).is_err(), "{s}");
        }
    }

    #[test]
    fn rejects_overlong_account_id() {
        let long_deed = format!("{}.testnet", "d".repeat(40));
        assert!(validate_slug(&"x".repeat(20), &long_deed).is_err());
        assert!(validate_slug(&"x".repeat(14), &long_deed).is_ok());
    }

    #[test]
    fn title_rules() {
        assert!(validate_title("Webhook Relay").is_ok());
        assert!(validate_title("   ").is_err());
        assert!(validate_title("a\nb").is_err());
        assert!(validate_title(&"t".repeat(65)).is_err());
    }
}
