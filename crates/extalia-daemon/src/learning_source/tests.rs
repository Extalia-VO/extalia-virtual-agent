use super::*;
use std::io::Cursor;

fn public() -> Vec<SocketAddr> {
    vec!["93.184.216.34:443".parse().unwrap()]
}
fn text(body: &[u8]) -> Hop {
    Hop {
        status: 200,
        location: None,
        content_type: "text/plain; charset=utf-8".to_owned(),
        body: body.to_vec(),
    }
}

#[test]
fn url_scope_is_strict_and_fragments_are_removed() {
    assert_eq!(
        normalize_url("https://EXAMPLE.com:443/guide#part")
            .unwrap()
            .as_str(),
        "https://example.com/guide"
    );
    for raw in [
        "file:///etc/hosts",
        "https://user:secret@example.com/",
        "https://@example.com/",
        "https:////@example.com/",
        "https://example.com/?",
        "https://example.com/?token=opaque",
        "https://example.com:8443/",
        "https://example.com\\@example.org/",
        " https://example.com/",
        "https://example.com/\n",
        "http://localhost/",
        "http://sub.localhost/",
        "http://host.local/",
        "http://metadata/",
        "http://2130706433/",
        "http://[::1]/",
        "http://[::ffff:127.0.0.1]/",
    ] {
        assert!(normalize_url(raw).is_err(), "{raw}");
    }
}

#[test]
fn special_private_reserved_and_transition_ips_fail_closed() {
    for raw in [
        "0.0.0.0",
        "10.1.2.3",
        "100.64.0.1",
        "127.0.0.1",
        "169.254.169.254",
        "172.16.0.1",
        "192.0.0.8",
        "192.0.2.1",
        "192.88.99.1",
        "192.168.1.1",
        "198.18.0.1",
        "198.51.100.1",
        "203.0.113.1",
        "224.0.0.1",
        "255.255.255.255",
        "::",
        "::1",
        "fc00::1",
        "fe80::1",
        "ff02::1",
        "::ffff:8.8.8.8",
        "64:ff9b::808:808",
        "2001::1",
        "2001:db8::1",
        "2002:808:808::1",
        "3fff::1",
    ] {
        assert!(!public_ip(raw.parse().unwrap()), "{raw}");
    }
    for raw in [
        "8.8.8.8",
        "93.184.216.34",
        "2606:4700:4700::1111",
        "2001:4860:4860::8888",
    ] {
        assert!(public_ip(raw.parse().unwrap()), "{raw}");
    }
    let mixed = vec![public()[0], "127.0.0.1:443".parse().unwrap()];
    assert_eq!(admit_addresses(mixed).unwrap_err(), "blocked_address");
    assert!(admit_addresses(Vec::new()).is_err());
    assert!(admit_addresses(vec![public()[0]; 65]).is_err());
}

#[tokio::test]
async fn network_resolver_uses_only_the_pinned_hop_addresses() {
    use reqwest::dns::Resolve;
    let resolver = PinnedDns {
        host: "example.com".to_owned(),
        addresses: public(),
    };
    let actual: Vec<_> = resolver
        .resolve("example.com".parse().unwrap())
        .await
        .unwrap()
        .collect();
    assert_eq!(actual, public());
    assert!(
        resolver
            .resolve("other.example".parse().unwrap())
            .await
            .is_err()
    );
}

#[test]
fn redirect_targets_are_readmitted_before_fetch() {
    let mut fetches = 0;
    let result = read_with(
        "https://example.com/",
        |_| Ok(public()),
        |_, admitted, _| {
            fetches += 1;
            assert_eq!(admitted, public());
            Ok(Hop {
                status: 302,
                location: Some("http://127.0.0.1/secret".to_owned()),
                ..text(b"")
            })
        },
    );
    assert_eq!(result.unwrap_err(), "blocked_address");
    assert_eq!(fetches, 1);
    let mut lookups = 0;
    let result = read_with(
        "https://example.com/",
        |_| {
            lookups += 1;
            Ok(if lookups == 1 {
                public()
            } else {
                vec!["10.0.0.1:443".parse().unwrap()]
            })
        },
        |_, _, _| {
            Ok(Hop {
                status: 302,
                location: Some("/next".to_owned()),
                ..text(b"")
            })
        },
    );
    assert_eq!(result.unwrap_err(), "blocked_address");
    assert_eq!(lookups, 2);
}

#[test]
fn redirects_cannot_add_credentials_queries_or_odd_ports() {
    for location in [
        "https://user:secret@example.com/",
        "https://@example.com/",
        "////@example.com/",
        "/guide?",
        "/guide?token=opaque",
        "https://example.com:8443/",
        "file:///etc/hosts",
        " /guide",
    ] {
        let mut fetches = 0;
        let result = read_with(
            "https://example.com/",
            |_| Ok(public()),
            |_, _, _| {
                fetches += 1;
                Ok(Hop {
                    status: 302,
                    location: Some(location.to_owned()),
                    ..text(b"")
                })
            },
        );
        assert!(result.is_err(), "{location}");
        assert_eq!(fetches, 1, "{location}");
    }
}

#[test]
fn redirects_are_bounded_and_public_receipts_keep_original_url() {
    let mut fetches = 0;
    let result = read_with(
        "https://example.com/",
        |_| Ok(public()),
        |_, _, _| {
            fetches += 1;
            Ok(Hop {
                status: 302,
                location: Some("/again".to_owned()),
                ..text(b"")
            })
        },
    );
    assert_eq!(result.unwrap_err(), "redirect_limit");
    assert_eq!(fetches, 4);
    let result = read_with(
        "https://example.com/#part",
        |_| Ok(public()),
        |url, _, _| {
            Ok(if url.path() == "/" {
                Hop {
                    status: 302,
                    location: Some("/guide#section".to_owned()),
                    ..text(b"")
                }
            } else {
                text(b"Guide text")
            })
        },
    )
    .unwrap();
    assert_eq!(result.source_url, "https://example.com/");
    assert_eq!(result.final_url, "https://example.com/guide");
    assert_eq!(result.bytes, 10);
    assert_eq!(result.sha256, digest(b"Guide text"));
}

#[test]
fn body_and_excerpt_limits_are_independent_and_utf8_safe() {
    assert_eq!(
        bounded_body(Cursor::new(vec![b'a'; BODY_LIMIT + 1]), None).unwrap_err(),
        "too_large"
    );
    assert_eq!(
        bounded_body(Cursor::new(b"small"), Some(BODY_LIMIT as u64 + 1)).unwrap_err(),
        "too_large"
    );
    assert_eq!(
        bounded_body(Cursor::new(vec![b'a'; BODY_LIMIT]), None)
            .unwrap()
            .len(),
        BODY_LIMIT
    );
    let source = normalize_url("https://example.com/").unwrap();
    let body = "界".repeat(20_000);
    let result = receipt(&source, &source, text(body.as_bytes())).unwrap();
    assert!(result.truncated);
    assert!(result.excerpt.len() <= EXCERPT_LIMIT);
    assert_eq!(result.bytes, body.len());
    assert!(result.excerpt.chars().all(|c| c == '界'));
}

#[test]
fn content_is_text_only_and_html_active_content_is_removed() {
    let source = normalize_url("https://example.com/").unwrap();
    for content_type in [
        "application/octet-stream",
        "image/png",
        "text/javascript",
        "text/html; charset=windows-1252",
    ] {
        let mut hop = text(b"data");
        hop.content_type = content_type.to_owned();
        assert_eq!(
            receipt(&source, &source, hop).unwrap_err(),
            "unsupported_content"
        );
    }
    for bytes in [b"binary\0text".as_slice(), &[0xff, 0xfe]] {
        assert_eq!(
            receipt(&source, &source, text(bytes)).unwrap_err(),
            "unsupported_content"
        );
    }
    for bytes in [b"".as_slice(), b" \n\t "] {
        assert_eq!(
            receipt(&source, &source, text(bytes)).unwrap_err(),
            "unsupported_content"
        );
    }
    for body in [
        "<script>hidden</script><style>hidden</style>",
        "<html><head><title>Hidden</title></head><body> \n </body></html>",
        "<!-- hidden -->",
    ] {
        let mut hop = text(body.as_bytes());
        hop.content_type = "text/html".to_owned();
        assert_eq!(
            receipt(&source, &source, hop).unwrap_err(),
            "unsupported_content"
        );
    }
    let mut hop = text(br#"<html><head><title>Hidden</title><style>secret style</style></head><body>Hello &amp; <b title=">">world</b><!-- hidden --><script type="text/javascript">secret script</script><STYLE>secret style</STYLE><noscript>hidden</noscript><p>&#x754c; &#30028;</p></body></html>"#);
    hop.content_type = "text/html; charset=UTF-8".to_owned();
    let result = receipt(&source, &source, hop).unwrap();
    assert_eq!(result.excerpt, "Hello & world 界 界");
    assert!(!result.truncated);
    assert_eq!(
        html_text("Hello<script>unterminated hidden content"),
        "Hello"
    );
}

#[test]
fn malformed_protocol_and_oversized_input_fail_without_fetching() {
    for input in [
        b"{}".to_vec(),
        vec![b'a'; 4097],
        br#"{"schema":"other","requestId":"bad","url":"https://example.com/"}"#.to_vec(),
    ] {
        let mut output = Vec::new();
        assert_eq!(serve(Cursor::new(input), &mut output), 2);
        assert!(output.is_empty());
    }
}

#[test]
fn one_shot_protocol_returns_an_honest_blocked_address_error() {
    let request = json!({ "schema": SCHEMA, "requestId": "10000000-0000-4000-8000-000000000001", "url": "http://127.0.0.1/" });
    let mut output = Vec::new();
    assert_eq!(
        serve(
            Cursor::new(serde_json::to_vec(&request).unwrap()),
            &mut output
        ),
        0
    );
    let reply: serde_json::Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(reply["requestId"], request["requestId"]);
    assert_eq!(reply["outcome"], "error");
    assert_eq!(reply["code"], "blocked_address");
    assert!(reply.get("result").is_none());
}
