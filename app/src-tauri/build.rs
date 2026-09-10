fn main() {
    // 构建指纹（版权举证用，见 docs/维权.md）：git commit + epoch 秒，编译期注入 LAYERTEXT_BUILD_ID。
    // 官方 Release 每个构建唯一；盗版者自行重编译的指纹与官方发布记录对不上。
    let mut id = String::from("dev");
    if let Ok(out) = std::process::Command::new("git")
        .args(["rev-parse", "--short", "HEAD"])
        .output()
    {
        if out.status.success() {
            let commit = String::from_utf8_lossy(&out.stdout).trim().to_string();
            let secs = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            id = format!("{}-{}", commit, secs);
        }
    }
    println!("cargo:rustc-env=LAYERTEXT_BUILD_ID={}", id);
    println!("cargo:rerun-if-changed=../../.git/HEAD");
    println!("cargo:rerun-if-changed=src/main.rs");
    tauri_build::build()
}
