//! The deed certificate: an SVG built on the fly from the latest vault stats. Pure logic.

use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};

pub const TOKEN_DECIMALS: u32 = 6;

const PAPER: &str = "#f3ead3";
const INK: &str = "#1f1c17";
const FADED_INK: &str = "#5b5040";
const RULE: &str = "#9a8761";
const SEAL: &str = "#7a1f1f";
const SEAL_LIGHT: &str = "#ead9b2";

pub struct Certificate<'a> {
    pub title: &'a str,
    pub token_id: &'a str,
    pub vault_id: &'a str,
    pub owner_id: &'a str,
    pub owner_epoch: u64,
    pub symbol: &'a str,
    pub price_per_call: u128,
    pub calls_30d: u64,
    pub revenue_30d: u128,
    pub cash: u128,
    pub liabilities: u128,
    /// None until the vault pushed its first stats.
    pub updated_at_ms: Option<u64>,
}

pub fn escape_xml(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

fn group_thousands(n: u128) -> String {
    let digits = n.to_string();
    let mut out = String::with_capacity(digits.len() + digits.len() / 3);
    for (i, ch) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(ch);
    }
    out
}

/// Token amount in display units: thousands separators, at least 2 decimals, trailing
/// zeros beyond that trimmed. `1_234_560_000` with 6 decimals is "1,234.56".
pub fn format_amount(amount: u128, decimals: u32) -> String {
    let unit = 10u128.pow(decimals);
    let whole = amount / unit;
    let mut frac = format!("{:0width$}", amount % unit, width = decimals as usize);
    while frac.len() > 2 && frac.ends_with('0') {
        frac.pop();
    }
    format!("{}.{}", group_thousands(whole), frac)
}

pub fn format_count(n: u64) -> String {
    group_thousands(n as u128)
}

/// Unix milliseconds to "YYYY-MM-DD HH:MM UTC" (civil-from-days, proleptic Gregorian).
pub fn format_utc(ms: u64) -> String {
    let secs = ms / 1_000;
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    format!("{:04}-{:02}-{:02} {:02}:{:02} UTC", year, month, day, rem / 3_600, (rem % 3_600) / 60)
}

fn shorten(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let keep = max.saturating_sub(3);
    let head: String = s.chars().take(keep / 2 + keep % 2).collect();
    let tail: String = s.chars().skip(s.chars().count() - keep / 2).collect();
    format!("{head}...{tail}")
}

/// 16-point star for the seal centred at (548, 300), outer radius 46, inner 39. Precomputed
/// so the contract needs no floating point.
const SEAL_STAR: &str = "548.0,254.0 555.6,261.7 565.6,257.5 569.7,267.6 580.5,267.5 \
580.4,278.3 590.5,282.4 586.3,292.4 594.0,300.0 586.3,307.6 590.5,317.6 580.4,321.7 \
580.5,332.5 569.7,332.4 565.6,342.5 555.6,338.3 548.0,346.0 540.4,338.3 530.4,342.5 \
526.3,332.4 515.5,332.5 515.6,321.7 505.5,317.6 509.7,307.6 502.0,300.0 509.7,292.4 \
505.5,282.4 515.6,278.3 515.5,267.5 526.3,267.6 530.4,257.5 540.4,261.7";

/// Title font size: 30px up to 26 characters, then shrinks so 64 characters still fit.
fn title_font_size(title: &str) -> usize {
    const FULL_SIZE_CHARS: usize = 26;
    let n = title.chars().count().max(1);
    if n <= FULL_SIZE_CHARS {
        30
    } else {
        (30 * FULL_SIZE_CHARS / n).max(14)
    }
}

pub fn render(c: &Certificate) -> String {
    let amount = |v: u128| format!("{} {}", format_amount(v, TOKEN_DECIMALS), escape_xml(c.symbol));
    let rows: [(&str, String); 6] = [
        ("Price per call", amount(c.price_per_call)),
        ("Calls, last 30 days", format_count(c.calls_30d)),
        ("Revenue, last 30 days", amount(c.revenue_30d)),
        ("Cash in vault", amount(c.cash)),
        ("Customer credit held", amount(c.liabilities)),
        ("Held by", escape_xml(&shorten(c.owner_id, 30))),
    ];
    let mut body = String::new();
    for (i, (label, value)) in rows.iter().enumerate() {
        let y = 182 + i as u32 * 30;
        body.push_str(&format!(
            "<text x=\"64\" y=\"{y}\" class=\"l\">{label}</text>\
             <line x1=\"64\" y1=\"{ly}\" x2=\"470\" y2=\"{ly}\" stroke=\"{RULE}\" stroke-width=\"0.5\" stroke-dasharray=\"1 3\"/>\
             <text x=\"470\" y=\"{y}\" class=\"v\" text-anchor=\"end\">{value}</text>",
            ly = y + 6,
        ));
    }
    let updated = match c.updated_at_ms {
        Some(ms) => format!("Figures as of {}", format_utc(ms)),
        None => "No figures reported yet".to_string(),
    };
    let star = SEAL_STAR;

    format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 640 400\" width=\"640\" height=\"400\">\
<style>.l{{font:italic 15px Georgia,'Times New Roman',serif;fill:{FADED_INK}}}\
.v{{font:15px 'Courier New',monospace;fill:{INK}}}\
.s{{font:11px Georgia,serif;letter-spacing:3px;fill:{FADED_INK}}}</style>\
<rect width=\"640\" height=\"400\" fill=\"{PAPER}\"/>\
<rect x=\"12\" y=\"12\" width=\"616\" height=\"376\" fill=\"none\" stroke=\"{INK}\" stroke-width=\"2.5\"/>\
<rect x=\"20\" y=\"20\" width=\"600\" height=\"360\" fill=\"none\" stroke=\"{INK}\" stroke-width=\"0.8\"/>\
<path d=\"M20 34L34 20M606 20L620 34M20 366L34 380M606 380L620 366\" stroke=\"{INK}\" stroke-width=\"0.8\"/>\
<text x=\"320\" y=\"58\" text-anchor=\"middle\" class=\"s\">DEED OF TITLE TO A RUNNING BUSINESS</text>\
<text x=\"320\" y=\"100\" text-anchor=\"middle\" style=\"font:600 {title_size}px Georgia,'Times New Roman',serif;fill:{INK}\">{title}</text>\
<text x=\"320\" y=\"126\" text-anchor=\"middle\" style=\"font:13px 'Courier New',monospace;fill:{FADED_INK}\">vault {vault}</text>\
<path d=\"M64 146H290M350 146H576\" stroke=\"{RULE}\" stroke-width=\"1\"/>\
<path d=\"M320 140L326 146L320 152L314 146Z\" fill=\"{SEAL}\"/>\
{body}\
<polygon points=\"{star}\" fill=\"{SEAL}\"/>\
<circle cx=\"548\" cy=\"300\" r=\"33\" fill=\"none\" stroke=\"{SEAL_LIGHT}\" stroke-width=\"1\" stroke-dasharray=\"2 2\"/>\
<text x=\"548\" y=\"297\" text-anchor=\"middle\" style=\"font:700 12px Georgia,serif;letter-spacing:2px;fill:{SEAL_LIGHT}\">DEED</text>\
<text x=\"548\" y=\"312\" text-anchor=\"middle\" style=\"font:9px Georgia,serif;letter-spacing:1px;fill:{SEAL_LIGHT}\">NO. {epoch}</text>\
<text x=\"64\" y=\"360\" style=\"font:11px 'Courier New',monospace;fill:{FADED_INK}\">token {token} · {updated}</text>\
</svg>",
        title = escape_xml(c.title),
        title_size = title_font_size(c.title),
        vault = escape_xml(c.vault_id),
        token = escape_xml(c.token_id),
        epoch = c.owner_epoch,
    )
}

pub fn data_uri(svg: &str) -> String {
    format!("data:image/svg+xml;base64,{}", STANDARD.encode(svg.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Certificate<'static> {
        Certificate {
            title: "Relay <&> \"Co\"",
            token_id: "relay",
            vault_id: "relay.deed.deedlab.testnet",
            owner_id: "deedlab-seller.testnet",
            owner_epoch: 3,
            symbol: "tUSDC",
            price_per_call: 2_000,
            calls_30d: 12_345,
            revenue_30d: 24_690_000,
            cash: 1_500_000,
            liabilities: 10_000_000,
            updated_at_ms: Some(1_793_336_400_000),
        }
    }

    #[test]
    fn amounts() {
        assert_eq!(format_amount(0, 6), "0.00");
        assert_eq!(format_amount(1_000, 6), "0.001");
        assert_eq!(format_amount(1_234_560_000, 6), "1,234.56");
        assert_eq!(format_amount(1_000_000_000_000, 6), "1,000,000.00");
        assert_eq!(format_amount(123_456_789, 6), "123.456789");
    }

    #[test]
    fn counts() {
        assert_eq!(format_count(0), "0");
        assert_eq!(format_count(999), "999");
        assert_eq!(format_count(1_000), "1,000");
        assert_eq!(format_count(12_345_678), "12,345,678");
    }

    #[test]
    fn utc_dates() {
        assert_eq!(format_utc(0), "1970-01-01 00:00 UTC");
        assert_eq!(format_utc(951_782_400_000), "2000-02-29 00:00 UTC");
        assert_eq!(format_utc(1_793_336_400_000), "2026-10-30 05:00 UTC");
        assert_eq!(format_utc(1_793_336_400_000 + 754_000), "2026-10-30 05:12 UTC");
    }

    #[test]
    fn svg_escapes_and_shows_figures() {
        let svg = render(&sample());
        assert!(svg.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\""));
        assert!(svg.ends_with("</svg>"));
        assert!(svg.contains("Relay &lt;&amp;&gt; &quot;Co&quot;"));
        assert!(!svg.contains("<&>"));
        assert!(svg.contains("0.002 tUSDC"));
        assert!(svg.contains("12,345"));
        assert!(svg.contains("24.69 tUSDC"));
        assert!(svg.contains("1.50 tUSDC"));
        assert!(svg.contains("10.00 tUSDC"));
        assert!(svg.contains("deedlab-seller.testnet"));
        assert!(svg.contains("2026-10-30 05:00 UTC"));
        assert!(svg.contains("NO. 3"));
    }

    #[test]
    fn svg_tags_balance() {
        let svg = render(&sample());
        for tag in ["text", "svg", "style"] {
            let open = svg.matches(&format!("<{tag}")).count();
            let close = svg.matches(&format!("</{tag}>")).count();
            assert_eq!(open, close, "{tag}");
        }
    }

    #[test]
    fn svg_without_stats() {
        let mut c = sample();
        c.updated_at_ms = None;
        assert!(render(&c).contains("No figures reported yet"));
    }

    #[test]
    fn long_titles_get_smaller_type() {
        assert_eq!(title_font_size("Webhook Relay"), 30);
        assert_eq!(title_font_size(&"t".repeat(26)), 30);
        assert!(title_font_size(&"t".repeat(40)) < 30);
        assert_eq!(title_font_size(&"t".repeat(64)), 14);
    }

    #[test]
    fn long_owner_is_shortened() {
        let s = shorten(&"a".repeat(64), 30);
        assert_eq!(s.chars().count(), 30);
        assert!(s.contains("..."));
    }

    /// `cargo test -p deed print_sample_certificate -- --ignored --nocapture` prints a sample.
    #[test]
    #[ignore]
    fn print_sample_certificate() {
        println!("{}", render(&sample()));
    }

    #[test]
    fn data_uri_is_base64_svg() {
        let uri = data_uri("<svg/>");
        assert_eq!(uri, "data:image/svg+xml;base64,PHN2Zy8+");
    }
}
