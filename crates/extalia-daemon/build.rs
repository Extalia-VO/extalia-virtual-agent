fn main() {
    println!("cargo:rerun-if-env-changed=EXTALIA_SKILLSPECTOR_MANIFEST_SHA256");
    if let Ok(pin) = std::env::var("EXTALIA_SKILLSPECTOR_MANIFEST_SHA256") {
        assert!(
            pin.len() == 64
                && pin
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
            "invalid scanner manifest pin"
        );
        println!("cargo:rustc-env=EXTALIA_SKILLSPECTOR_MANIFEST_SHA256={pin}");
    }
}
