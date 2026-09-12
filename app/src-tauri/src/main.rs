// LayerText 分层读 · 桌面主进程
// 全离线：仅本地文件读写与对话框，无任何网络与遥测。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 构建指纹（版权举证用）：git commit + 构建时间，由 build.rs 编译期注入。
/// 官方 Release 每个构建唯一；盗版者自行重编译的指纹与官方发布记录对不上。诊断包含此字段。
#[tauri::command]
fn get_build_id() -> String {
    build_id()
}

/// 编译期注入的构建指纹；未注入（如极简环境）时退化为版本号
fn build_id() -> String {
    match option_env!("LAYERTEXT_BUILD_ID") {
        Some(id) => format!("{}|{}", env!("CARGO_PKG_VERSION"), id),
        None => format!("{}|unmarked", env!("CARGO_PKG_VERSION")),
    }
}

/// 本地词典（macOS Dictionary Services / 牛津英汉）：查词返回首个中文义项，零网络零 AI
#[cfg(target_os = "macos")]
mod dict {
    use std::ffi::{c_char, CStr, CString};

    type CFStringRef = *const u8; // opaque
    #[repr(C)]
    struct CFRange {
        location: i64,
        length: i64,
    }

    extern "C" {
        fn CFStringCreateWithCString(
            alloc: *const u8,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFStringGetLength(the_string: CFStringRef) -> i64;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut c_char,
            buffer_size: i64,
            encoding: u32,
        ) -> u8;
        fn CFRelease(cf: *const u8);
        fn DCSCopyTextDefinition(
            dictionary: CFStringRef,
            term: CFStringRef,
            range: CFRange,
        ) -> CFStringRef;
    }
    const K_CFSTRING_ENCODING_UTF8: u32 = 0x0800_0100;

    /// 查询一个词，返回首个中文义项（如 boar→野猪）；查不到返回 None
    pub fn lookup_zh(word: &str) -> Option<String> {
        let c_word = CString::new(word).ok()?;
        unsafe {
            let cf_word = CFStringCreateWithCString(
                std::ptr::null(),
                c_word.as_ptr(),
                K_CFSTRING_ENCODING_UTF8,
            );
            if cf_word.is_null() {
                return None;
            }
            let len = CFStringGetLength(cf_word);
            let def = DCSCopyTextDefinition(
                std::ptr::null(),
                cf_word,
                CFRange {
                    location: 0,
                    length: len,
                },
            );
            CFRelease(cf_word);
            if def.is_null() {
                return None;
            }
            let mut buf = vec![0 as c_char; 16384];
            let ok = CFStringGetCString(
                def,
                buf.as_mut_ptr(),
                buf.len() as i64,
                K_CFSTRING_ENCODING_UTF8,
            );
            CFRelease(def);
            if ok == 0 {
                return None;
            }
            let text = CStr::from_ptr(buf.as_ptr()).to_string_lossy().to_string();
            first_zh_phrase(&text)
        }
    }

    /// 牛津英汉格式 "… noun ① countable (wild) 野猪 yězhū …"——取首个连续中文块（≤6 字，即义项本身，不含其后的拼音）
    fn first_zh_phrase(def: &str) -> Option<String> {
        let mut best: Option<String> = None;
        let mut run = String::new();
        for ch in def.chars() {
            let is_zh = ('\u{4e00}'..='\u{9fff}').contains(&ch) || ch == '的';
            if is_zh {
                run.push(ch);
                if run.chars().count() >= 6 {
                    break; // 义项过长即截断
                }
            } else if !run.is_empty() {
                if run.chars().count() >= 1 && best.is_none() {
                    best = Some(run.clone());
                }
                run.clear();
                if best.is_some() {
                    break;
                }
            }
        }
        if best.is_none() && !run.is_empty() {
            best = Some(run);
        }
        best
    }
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn dict_lookup_zh(words: Vec<String>) -> Vec<Option<String>> {
    words.iter().map(|w| dict::lookup_zh(w)).collect()
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn dict_lookup_zh(_words: Vec<String>) -> Vec<Option<String>> {
    vec![None; _words.len()]
}

/// 二进制读取（base64），供前端解析 xlsx 等格式
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use std::io::Read;
    let mut buf = Vec::new();
    std::fs::File::open(&path)
        .map_err(|e| e.to_string())?
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    Ok(base64_encode(&buf))
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 {
            T[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if c.len() > 2 {
            T[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    let p = std::path::Path::new(&path);
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    // **原子写**：先写同目录临时文件，再 rename 覆盖。
    // `std::fs::write` 是"截断 → 写"，中途失败（进程被杀、磁盘满、断电）会留下
    // **半份正文**——对教师唯一的一份稿，半份比没有更糟：没有你知道丢了，
    // 半份看起来像改坏了，而它其实已经被毁掉了。
    // rename 在同一文件系统内是原子的：读者要么看到旧内容、要么看到新内容。
    // 临时文件必须与目标同目录（跨文件系统的 rename 会退化成 copy+unlink，就不原子了）。
    let name = match p.file_name().and_then(|n| n.to_str()) {
        Some(n) => n.to_string(),
        None => return Err(format!("路径没有文件名，无法原子写：{path}")),
    };
    let tmp = p.with_file_name(format!(".{}.tmp-{}", name, std::process::id()));
    let write = || -> std::io::Result<()> {
        use std::io::Write;
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        // 先落盘再 rename：否则断电后可能 rename 了一个"还没写完"的文件
        f.sync_all()?;
        Ok(())
    };
    if let Err(e) = write() {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = std::fs::rename(&tmp, p) {
        let _ = std::fs::remove_file(&tmp);
        return Err(e.to_string());
    }
    Ok(())
}

/// 二进制写入（base64），供导出 Word/音频等
#[tauri::command]
fn write_file_base64(path: String, b64: String) -> Result<(), String> {
    let bin = base64_decode(&b64)?;
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, bin).map_err(|e| e.to_string())
}

/// **追加**一行到文本文件（append-only 账本专用：决定日志、版本日志）。
///
/// 为什么不复用 `write_text_file`：账本是"读全文 → 拼一行 → 写全文"，
/// 两个人（或两个窗口）同时追加时后写的那次会把前一次的整份内容覆盖掉——
/// 丢的是一整条决定或一整版记录，而且**没有任何迹象**。
/// `O_APPEND` 的内核语义是"写入时原子地把偏移推到文件末尾再写"，
/// 所以一行一次 append 不会互相覆盖。账本行都很短（远小于一次写的大小上限），
/// 这是"不改存储引擎也能拿到的原子性"。
#[tauri::command]
fn append_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

fn base64_decode(s: &str) -> Result<Vec<u8>, String> {
    const REV: &[i8] = &[
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, 62, -1, -1,
        -1, 63, 52, 53, 54, 55, 56, 57, 58, 59, 60, 61, -1, -1, -1, -1, -1, -1, -1, 0, 1, 2, 3, 4,
        5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, -1, -1, -1,
        -1, -1, -1, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45,
        46, 47, 48, 49, 50, 51, -1, -1, -1, -1, -1,
    ];
    let mut out = Vec::with_capacity(s.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        if c == b'=' || c == b'\n' || c == b'\r' {
            continue;
        }
        let v = *REV.get(c as usize).unwrap_or(&-1);
        if v < 0 {
            return Err(format!("base64 非法字符: {}", c as char));
        }
        buf = (buf << 6) | v as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// 朗读音频导出：macOS 系统语音 say → AIFF
#[tauri::command]
fn export_tts(text: String, path: String, voice: String) -> Result<(), String> {
    let status = std::process::Command::new("say")
        .arg("-o")
        .arg(&path)
        .arg("-v")
        .arg(&voice)
        .arg(&text)
        .output()
        .map_err(|e| e.to_string())?;
    if status.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&status.stderr).into_owned())
    }
}

/// 示例模式的报告落盘目录：~/Documents/LayerText质检报告
#[tauri::command]
fn reports_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{}/Documents/LayerText质检报告", home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 本地示例目录：~/Documents/LayerText示例（教师可放入自己的章节/词库/术语表，不随应用分发）
/// 通用配置目录（书架注册表等；本地数据，不进仓库）
#[tauri::command]
fn config_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{}/Documents/LayerText配置", home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 班级分组配置目录（班级多人定制：分组/个人词库与复现队列；本地数据，不进仓库）
#[tauri::command]
fn class_groups_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{}/Documents/LayerText配置/班级分组", home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

#[tauri::command]
fn examples_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{}/Documents/LayerText示例", home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 列出本地示例目录中的章节文件（.md/.txt，_ 开头的配置文件除外）
#[tauri::command]
fn list_local_examples() -> Result<Vec<String>, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{}/Documents/LayerText示例", home);
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            if (ext == "md" || ext == "txt")
                && !p
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .starts_with('_')
            {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

/// 列出书稿文件夹中的章节文件（.md/.txt/.docx；_ 开头的配置与词库、既有产物（简化/工作稿/备份/质检报告）除外）
#[tauri::command]
fn list_dir(dir: String) -> Result<Vec<String>, String> {
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !(ext == "md" || ext == "txt" || ext == "markdown" || ext == "docx") {
                continue;
            }
            if name.starts_with('_')
                || name.contains("简化")
                || name.contains("工作稿")
                || name.contains("原始备份")
                || name.contains("质检报告")
            {
                continue;
            }
            out.push(p.to_string_lossy().to_string());
        }
    }
    out.sort();
    Ok(out)
}

/// 删除文件（批处理队列完结后清理进度文件；找不到视为成功）
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

/// 书架书封：列出书稿文件夹里的封面图（cover/封面/front 等命名的 jpg/jpeg/png/webp，取第一个用）
#[tauri::command]
fn list_cover_images(dir: String) -> Result<Vec<String>, String> {
    const COVER_STEMS: [&str; 6] = [
        "cover",
        "封面",
        "front",
        "front-cover",
        "book-cover",
        "书封",
    ];
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let p = e.path();
            if !p.is_file() {
                continue;
            }
            let ext = p
                .extension()
                .and_then(|x| x.to_str())
                .unwrap_or("")
                .to_lowercase();
            if !matches!(ext.as_str(), "jpg" | "jpeg" | "png" | "webp") {
                continue;
            }
            let stem = p
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            if COVER_STEMS.contains(&stem.as_str()) {
                out.push(p.to_string_lossy().to_string());
            }
        }
    }
    out.sort();
    Ok(out)
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/* ---------- AI 配置（Key 存 macOS 钥匙串；地址/模型存本地配置文件） ---------- */

fn config_path() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    Ok(format!("{}/.layertext.json", home))
}

/// 教师自定义提示词目录：~/Documents/LayerText配置/prompts（存在同名 .md 则覆盖内置提示词）
#[tauri::command]
fn prompts_dir() -> Result<String, String> {
    let home = std::env::var("HOME").map_err(|e| e.to_string())?;
    let dir = format!("{}/Documents/LayerText配置/prompts", home);
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/* ---------- 本地错误日志（W5：轮转保留 5 份；零遥测——只写本机，绝不上报） ---------- */

fn logs_dir() -> Result<String, String> {
    reports_dir() // 复用报告目录：~/Documents/LayerText质检报告
}

fn log_path() -> Result<String, String> {
    Ok(format!("{}/错误日志.log", logs_dir()?))
}

const LOG_MAX_BYTES: u64 = 512 * 1024;
const LOG_KEEP: u32 = 5;

/// 追加错误日志（超 512KB 轮转：错误日志.log → .1.log → … → .5.log，最老删除）
fn append_log_impl(content: &str) -> Result<(), String> {
    let path = log_path()?;
    if let Ok(meta) = std::fs::metadata(&path) {
        if meta.len() > LOG_MAX_BYTES {
            for i in (1..LOG_KEEP).rev() {
                let from = format!("{}/错误日志.{}.log", logs_dir()?, i);
                let to = format!("{}/错误日志.{}.log", logs_dir()?, i + 1);
                let _ = std::fs::rename(&from, &to);
            }
            let _ = std::fs::rename(&path, format!("{}/错误日志.1.log", logs_dir()?));
        }
    }
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(content.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
fn append_log(lines: String) -> Result<(), String> {
    append_log_impl(&format!("[{}] {}", chrono_like_now(), lines.trim_end()))
}

#[tauri::command]
fn read_error_log() -> Result<String, String> {
    let path = log_path()?;
    match std::fs::read_to_string(&path) {
        Ok(s) => Ok(s),
        Err(_) => Ok(String::new()), // 尚无日志属正常
    }
}

/// 无 chrono 依赖的本地时间戳（诊断用途，格式对齐 sv-SE 即可）
fn chrono_like_now() -> String {
    let out = std::process::Command::new("date")
        .arg("+%Y-%m-%d %H:%M:%S")
        .output();
    match out {
        Ok(o) if o.status.success() => String::from_utf8_lossy(&o.stdout).trim().to_string(),
        _ => String::from("unknown-time"),
    }
}

/// account=None → 主 Key（layertext.apikey）；Some("fb0") → 第一备用的 Key（layertext.apikey.fb0）
fn key_service(account: &Option<String>) -> String {
    match account {
        Some(a) if !a.is_empty() => format!("layertext.apikey.{}", a),
        _ => "layertext.apikey".to_string(),
    }
}

#[tauri::command]
fn save_api_key(key: String, account: Option<String>) -> Result<(), String> {
    let service = key_service(&account);
    // -A：条目允许本机应用读取，避免每次读写都弹钥匙串授权框（个人电脑上的 API Key 场景可接受）
    let st = std::process::Command::new("security")
        .args([
            "add-generic-password",
            "-U",
            "-A",
            "-a",
            "layertext",
            "-s",
            &service,
            "-w",
            &key,
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if st.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&st.stderr).into_owned())
    }
}

#[tauri::command]
fn load_api_key(account: Option<String>) -> Result<String, String> {
    let service = key_service(&account);
    let out = std::process::Command::new("security")
        .args([
            "find-generic-password",
            "-a",
            "layertext",
            "-s",
            &service,
            "-w",
        ])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_owned())
    } else {
        let err = String::from_utf8_lossy(&out.stderr).into_owned();
        if err.contains("could not be found") {
            Ok(String::new()) // 尚未保存过
        } else {
            Err(err) // 读取被拒/失败，如实上报
        }
    }
}

#[tauri::command]
fn save_app_config(config: String) -> Result<(), String> {
    std::fs::write(config_path()?, config).map_err(|e| e.to_string())
}

#[tauri::command]
fn load_app_config() -> Result<String, String> {
    Ok(std::fs::read_to_string(config_path()?).unwrap_or_else(|_| "{}".into()))
}

fn open_help(app: &tauri::AppHandle, label: &str, title: &str, url: &str, w: f64, h: f64) {
    if let Some(win) = app.get_webview_window(label) {
        let _ = win.show();
        let _ = win.set_focus();
        return;
    }
    let _ = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(w, h)
        .build();
}

#[tauri::command]
fn open_help_window(app: tauri::AppHandle, which: String) {
    match which.as_str() {
        "usage" => open_help(
            &app,
            "help-usage",
            "LayerText 使用说明",
            "/help.html",
            760.0,
            780.0,
        ),
        "qc" => open_help(
            &app,
            "help-qc",
            "LayerText · QC 指标说明",
            "/help-qc.html",
            760.0,
            860.0,
        ),
        _ => open_help(
            &app,
            "help-key",
            "如何获取 AI 的 Key（新手向）",
            "/help-key.html",
            760.0,
            720.0,
        ),
    }
}

fn main() {
    // W5：未捕获的 Rust panic 落本地错误日志（零遥测：只写本机，绝不上报）
    std::panic::set_hook(Box::new(|info| {
        let _ = append_log_impl(&format!("[panic] {}\n", info));
    }));

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // ---- 原生菜单栏（低频项收子菜单：导入/导出/诊断各一组，高频保持平铺） ----
            let mi_open = MenuItemBuilder::with_id("file-open", "打开章节文件…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let mi_demo = MenuItemBuilder::with_id("file-demo", "载入示例…").build(app)?;
            let mi_vocab = MenuItemBuilder::with_id("conf-vocab", "自定义词库…").build(app)?;
            let mi_terms = MenuItemBuilder::with_id("conf-terms", "术语表…").build(app)?;
            let mi_proper = MenuItemBuilder::with_id("conf-proper", "专名表…").build(app)?;
            let mi_exp = MenuItemBuilder::with_id("marks-export", "标记…").build(app)?;
            let mi_imp = MenuItemBuilder::with_id("marks-import", "标记…").build(app)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;

            let import_menu = SubmenuBuilder::new(app, "导入…")
                .item(&mi_vocab)
                .item(&mi_terms)
                .item(&mi_proper)
                .item(&mi_imp)
                .build()?;
            let export_menu = SubmenuBuilder::new(app, "导出…")
                .item(&mi_exp)
                .text("export-docx", "Word 版（含章末词句卡）…")
                .text("export-tts", "朗读音频（AIFF，系统语音）…")
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "文件")
                .item(&mi_open)
                .item(&mi_demo)
                .item(&sep1)
                .text("book-config", "保存为本书配置（词库/约定随文件夹）")
                .text("rewrite-rules", "书级改写规则…（人名替换/叙事视角）")
                .item(&sep2)
                .item(&import_menu)
                .item(&export_menu)
                .build()?;

            let mi_run = MenuItemBuilder::with_id("qc-run", "重新质检本章")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let mi_ai = MenuItemBuilder::with_id("ai-suggest", "AI 审核建议…").build(app)?;
            let mi_draft = MenuItemBuilder::with_id("draft", "AI 简化本章…").build(app)?;
            let mi_batch = MenuItemBuilder::with_id("batch", "全书批处理…（多章队列+汇总报告）").build(app)?;
            let mi_cls = MenuItemBuilder::with_id("cls", "班级多人定制…（勾选分组，质检/改写按其口径）").build(app)?;
            let mi_sync = MenuItemBuilder::with_id(
                "sync-marks",
                "同步本章标记到其他版本…（词/短语级，同章多版本共用审校意图）",
            )
            .build(app)?;
            let mi_anki = MenuItemBuilder::with_id(
                "anki-cards",
                "导出生词卡（Anki + 复现队列）…",
            )
            .build(app)?;
            let mi_grade_one = MenuItemBuilder::with_id("grade-one", "学生产出体检…（单份：粘贴/选文件）")
                .build(app)?;
            let mi_grade_class = MenuItemBuilder::with_id("grade-class", "全班批改队列…（一个文件夹=一个班）")
                .build(app)?;
            let grading_menu = SubmenuBuilder::new(app, "批改")
                .item(&mi_grade_one)
                .item(&mi_grade_class)
                .build()?;
            let mi_rev = MenuItemBuilder::with_id(
                "rev-material",
                "定向复习材料…（作业/教材→复现注入+语法点）",
            )
            .build(app)?;
            let qc_menu = SubmenuBuilder::new(app, "质检")
                .item(&mi_run)
                .item(&mi_draft)
                .item(&mi_batch)
                .item(&mi_cls)
                .item(&mi_sync)
                .item(&mi_anki)
                .item(&mi_rev)
                .separator()
                .item(&mi_ai)
                .build()?;

            let mi_vt = MenuItemBuilder::with_id("view-text", "正文审校").build(app)?;
            let mi_vr = MenuItemBuilder::with_id("view-report", "质检报告").build(app)?;
            let view_menu = SubmenuBuilder::new(app, "显示")
                .item(&mi_vt)
                .item(&mi_vr)
                .text("view-retro", "复盘（AI 建议采纳情况）…")
                .text("view-diff", "版本对比…")
                .item(&sep3)
                .fullscreen()
                .build()?;

            let diag_menu = SubmenuBuilder::new(app, "诊断")
                .text("export-diag", "导出诊断包…（出错记录打包，可发给开发者；不含你的书稿内容）")
                .text("diag-test", "测试诊断包（故意制造一条错误记录，验证打包正常）")
                .build()?;
            let help_menu = SubmenuBuilder::new(app, "帮助")
                .text("help-usage", "使用说明")
                .text("help-key", "如何获取 AI 的 Key（新手向）")
                .text("help-qc", "QC 指标说明")
                .separator()
                .text("help-example-dir", "打开本地示例文件夹")
                .separator()
                .item(&diag_menu)
                .build()?;

            let app_menu = SubmenuBuilder::new(app, "LayerText")
                .about(Some(tauri::menu::AboutMetadataBuilder::new()
                    .name(Some("LayerText 分层读"))
                    .version(Some(env!("CARGO_PKG_VERSION"))) // 构建期从 Cargo.toml 注入（与 package.json 由 check_versions 门禁对齐）
                    .authors(Some(vec!["Wayne & LayerText contributors".to_string()]))
                    .copyright(Some("© 2026 Wayne · PolyForm Noncommercial 1.0.0（教师/学校免费，商用需授权）"))
                    .comments(Some("分层英语文本简化与审校工作台 · AI 只出候选，教师握定稿权 · 数据全在本机"))
                    .build()))
                .text("ai-settings", "AI 设置…")
                .text("tier-plan", "简化标准…（句长上限可调）")
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .separator()
                .quit()
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "窗口")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let edit_menu = SubmenuBuilder::new(app, "编辑")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &qc_menu, &grading_menu, &view_menu, &window_menu, &help_menu])
                .build()?;
            app.set_menu(menu)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.clone();
            match id.as_str() {
                "help-usage" => open_help(app, "help-usage", "LayerText 使用说明", "/help.html", 760.0, 780.0),
                "help-qc" => open_help(app, "help-qc", "LayerText · QC 指标说明", "/help-qc.html", 760.0, 860.0),
                "help-example-dir" => {
                    if let Ok(dir) = examples_dir() {
                        let _ = std::process::Command::new("open").arg(dir).spawn();
                    }
                }
                _ => {
                    let _ = app.emit("menu-action", id);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_text_file,
            read_file_base64,
            write_text_file,
            append_text_file,
            get_build_id,
            dict_lookup_zh,
            reports_dir,
            examples_dir,
        class_groups_dir,
        config_dir,
            list_local_examples,
            list_dir,
            list_cover_images,
            remove_file,
            reveal_path,
            save_api_key,
            load_api_key,
            save_app_config,
            load_app_config,
            open_help_window,
            write_file_base64,
            export_tts,
            prompts_dir,
            append_log,
            read_error_log
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/* ================= 单元测试（纯逻辑：base64 编解码、封面过滤、目录清单） ================= */

#[cfg(test)]
mod dict_tests {
    #[test]
    fn local_dict_returns_zh_gloss() {
        // 系统（牛津英汉）词典：boar 的首个中文义项含"猪"
        // CI/新机器可能没有系统词典；缺少外部资源不是实现失败，跳过而不是伪造释义。
        let Some(zh) = crate::dict::lookup_zh("boar") else {
            return;
        };
        assert!(zh.contains('猪'), "boar 释义应含 猪，实得 {zh}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_roundtrip() {
        for s in [
            "",
            "a",
            "ab",
            "abc",
            "abcd",
            "中文内容测试",
            "The quick brown fox jumps over the lazy dog. 0123456789 !?",
        ] {
            let enc = base64_encode(s.as_bytes());
            assert_eq!(
                base64_decode(&enc).unwrap(),
                s.as_bytes(),
                "roundtrip 失败: {s:?}"
            );
        }
    }

    #[test]
    fn base64_known_vectors() {
        // RFC 4648 示例向量
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_decode("Zm9vYmFy").unwrap(), b"foobar");
        assert_eq!(base64_decode("Zm9vYg==").unwrap(), b"foob");
        // 含换行的宽松输入（openssl 风格）
        assert_eq!(base64_decode("Zm9v\nYmFy\r\n").unwrap(), b"foobar");
        // 非法字符如实报错
        assert!(base64_decode("Zm9v*").is_err());
    }

    #[test]
    fn cover_filter_picks_recognized_names_only() {
        let dir = std::env::temp_dir().join(format!("lt_cover_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "cover.jpg",
            "封面.PNG",
            "front-cover.webp",
            "book-cover.jpeg",
            "书封.png",
            "trailer.jpg",
            "cover.pdf",
            "mycover.png",
            "cover.txt",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let mut got: Vec<String> = list_cover_images(dir.to_string_lossy().to_string())
            .unwrap()
            .iter()
            .map(|p| p.rsplit('/').next().unwrap().to_lowercase())
            .collect();
        got.sort();
        assert_eq!(
            got,
            vec![
                "book-cover.jpeg",
                "cover.jpg",
                "front-cover.webp",
                "书封.png",
                "封面.png"
            ]
        ); // sort()=字节序：ASCII 在前，中文按 UTF-8 码点
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn list_dir_excludes_products_and_config() {
        let dir = std::env::temp_dir().join(format!("lt_listdir_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for name in [
            "第一章.md",
            "notes.txt",
            "_词库.csv",
            "_工作区.json",
            "ch1_简化_2026.md",
            "ch1_工作稿.md",
            "ch1_原始备份.md",
            "质检报告_v01.json",
            "cover.jpg",
        ] {
            std::fs::write(dir.join(name), b"x").unwrap();
        }
        let got: Vec<String> = list_dir(dir.to_string_lossy().to_string())
            .unwrap()
            .iter()
            .map(|p| p.rsplit('/').next().unwrap().to_string())
            .collect();
        assert_eq!(got, vec!["notes.txt", "第一章.md"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
