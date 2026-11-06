//! The outlive certificate: an SVG built on the fly from the latest vault stats. Pure logic.

use near_sdk::base64::{engine::general_purpose::STANDARD, Engine};

pub const TOKEN_DECIMALS: u32 = 6;

// The palette of the web app's exchange board: white plate, true ink, one signal orange.
const PLATE: &str = "#ffffff";
const INK: &str = "#131313";
const INK_2: &str = "#55575a";
const HAIR: &str = "#e6e6e3";
const SIGNAL: &str = "#ff4b00";
/// Archivo when the viewer has it, otherwise the nearest grotesque a wallet will have.
const SANS: &str = "'Archivo','Helvetica Neue',Arial,sans-serif";

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

/// Title font size: 40px up to 22 characters, then shrinks so 64 characters still fit.
fn title_font_size(title: &str) -> usize {
    const FULL_SIZE_CHARS: usize = 22;
    let n = title.chars().count().max(1);
    if n <= FULL_SIZE_CHARS {
        40
    } else {
        (40 * FULL_SIZE_CHARS / n).max(14)
    }
}

/// Layout, 640 x 400: a 3px ink frame; a header band with the ink "D" mark, the outlive line and
/// the owner epoch tag; a heavy title and the vault; six figure rows on hairlines; the one
/// orange element, a square OUTLIVE stamp on a hard ink offset; token and date along the foot.
pub fn render(c: &Certificate) -> String {
    let amount = |v: u128| format!("{} {}", format_amount(v, TOKEN_DECIMALS), escape_xml(c.symbol));
    let rows: [(&str, String); 6] = [
        ("Price per call", amount(c.price_per_call)),
        ("Calls, last 30 days", format_count(c.calls_30d)),
        ("Revenue, last 30 days", amount(c.revenue_30d)),
        ("Withdrawable proceeds", amount(c.cash)),
        ("Customer credit owed", amount(c.liabilities)),
        ("Held by", escape_xml(&shorten(c.owner_id, 30))),
    ];
    let mut body = String::new();
    for (i, (label, value)) in rows.iter().enumerate() {
        let y = 196 + i as u32 * 27;
        body.push_str(&format!(
            "<text x=\"36\" y=\"{y}\" class=\"l\">{label}</text><text x=\"456\" y=\"{y}\" class=\"v\">{value}</text>"
        ));
        if i + 1 < rows.len() {
            body.push_str(&format!("<path d=\"M36 {ly}.5H456\" stroke=\"{HAIR}\"/>", ly = y + 9));
        }
    }
    let updated = match c.updated_at_ms {
        Some(ms) => format!("Figures as of {}", format_utc(ms)),
        None => "No figures reported yet".to_string(),
    };
    // The epoch tag grows with the number so it never overflows its box.
    let epoch = c.owner_epoch.to_string();
    let tag_w = 100 + 9 * epoch.len();

    let mut svg = String::with_capacity(3_200);
    svg.push_str("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 640 400\" width=\"640\" height=\"400\">");
    svg.push_str(&format!(
        "<style>text{{font-family:{SANS};font-variant-numeric:tabular-nums;fill:{INK}}}\
         .l{{font-size:16px;font-weight:500;fill:{INK_2}}}\
         .v{{font-size:17px;font-weight:700;text-anchor:end}}\
         .s{{font-size:13.5px;fill:{INK_2}}}</style>"
    ));
    svg.push_str(&format!(
        "<rect width=\"640\" height=\"400\" fill=\"{PLATE}\"/>\
         <rect x=\"11.5\" y=\"11.5\" width=\"617\" height=\"377\" fill=\"none\" stroke=\"{INK}\" stroke-width=\"3\"/>\
         <rect x=\"36\" y=\"32\" width=\"24\" height=\"24\" fill=\"{INK}\"/>\
         <text x=\"48\" y=\"50\" text-anchor=\"middle\" style=\"font-size:15px;font-weight:900;fill:{PLATE}\">D</text>\
         <text x=\"72\" y=\"50\" style=\"font-size:16px;font-weight:700\">Outlive to a transferable service instance</text>"
    ));
    svg.push_str(&format!(
        "<rect x=\"{x}\" y=\"31.75\" width=\"{tag_w}\" height=\"24.5\" fill=\"none\" stroke=\"{INK}\" stroke-width=\"1.5\"/>\
         <text x=\"{mid}\" y=\"48.5\" text-anchor=\"middle\" style=\"font-size:13.5px;font-weight:600\">owner epoch {epoch}</text>\
         <path d=\"M13 72H627\" stroke=\"{INK}\" stroke-width=\"2\"/>",
        x = 604 - tag_w,
        mid = 604 - tag_w / 2,
    ));
    svg.push_str(&format!(
        "<text x=\"36\" y=\"124\" style=\"font-size:{size}px;font-weight:900;letter-spacing:-0.02em\">{title}</text>\
         <text x=\"36\" y=\"150\" class=\"s\">vault {vault}</text>\
         <path d=\"M36 170.5H604\" stroke=\"{INK}\"/>",
        size = title_font_size(c.title),
        title = escape_xml(c.title),
        vault = escape_xml(c.vault_id),
    ));
    svg.push_str(&body);
    svg.push_str(&format!(
        "<rect x=\"490\" y=\"190\" width=\"110\" height=\"110\" fill=\"{INK}\"/>\
         <rect x=\"485\" y=\"185\" width=\"110\" height=\"110\" fill=\"{SIGNAL}\"/>\
         <text x=\"540\" y=\"251\" text-anchor=\"middle\" style=\"font-size:29px;font-weight:900;letter-spacing:-0.02em;fill:{PLATE}\">OUTLIVE</text>\
         <path d=\"M36 344.5H604\" stroke=\"{INK}\"/>\
         <text x=\"36\" y=\"368\" class=\"s\">token {token}</text>\
         <text x=\"604\" y=\"368\" class=\"s\" text-anchor=\"end\">{updated}</text></svg>",
        token = escape_xml(c.token_id),
    ));
    svg
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
            vault_id: "relay.outlive.outlive.testnet",
            owner_id: "outlivelab-seller.testnet",
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
        assert!(svg.contains(">12,345<"));
        assert!(svg.contains("24.69 tUSDC"));
        assert!(svg.contains("1.50 tUSDC"));
        assert!(svg.contains("10.00 tUSDC"));
        assert!(svg.contains("outlivelab-seller.testnet"));
        assert!(svg.contains("vault relay.outlive.outlive.testnet"));
        assert!(svg.contains("token relay"));
        assert!(svg.contains("2026-10-30 05:00 UTC"));
        assert!(svg.contains("owner epoch 3"));
    }

    #[test]
    fn svg_uses_the_board_style() {
        let svg = render(&sample());
        assert!(svg.contains("fill=\"#ffffff\""), "white plate");
        assert!(svg.contains("'Archivo','Helvetica Neue',Arial,sans-serif"), "sans stack with fallbacks");
        assert!(svg.contains("tabular-nums"));
        assert_eq!(svg.matches(SIGNAL).count(), 1, "exactly one orange element");
        for gone in ["Georgia", "Times", ",serif", "Courier", "#f3ead3", "#7a1f1f", "polygon", "circle", "\u{b7}"] {
            assert!(!svg.contains(gone), "{gone} belongs to the old certificate");
        }
    }

    #[test]
    fn epoch_tag_fits_long_numbers() {
        let mut c = sample();
        c.owner_epoch = u64::MAX;
        let svg = render(&c);
        assert!(svg.contains(&format!("owner epoch {}", u64::MAX)));
        assert!(svg.contains("width=\"280\""), "tag widens with the digits");
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
    fn svg_stays_small() {
        assert!(render(&sample()).len() < 3_200);
    }

    #[test]
    fn svg_without_stats() {
        let mut c = sample();
        c.updated_at_ms = None;
        assert!(render(&c).contains("No figures reported yet"));
    }

    #[test]
    fn long_titles_get_smaller_type() {
        assert_eq!(title_font_size("Webhook Relay"), 40);
        assert_eq!(title_font_size(&"t".repeat(22)), 40);
        assert!(title_font_size(&"t".repeat(40)) < 40);
        assert_eq!(title_font_size(&"t".repeat(64)), 14);
    }

    #[test]
    fn long_owner_is_shortened() {
        let s = shorten(&"a".repeat(64), 30);
        assert_eq!(s.chars().count(), 30);
        assert!(s.contains("..."));
    }

    /// `cargo test -p outlive print_sample_certificate -- --ignored --nocapture` prints a sample.
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
