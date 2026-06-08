fn main() {
    // Link ApplicationServices for AXIsProcessTrusted (macOS accessibility check)
    if std::env::var("TARGET")
        .unwrap_or_default()
        .contains("apple")
    {
        println!("cargo:rustc-link-lib=framework=ApplicationServices");
    }
    tauri_build::build();
}
