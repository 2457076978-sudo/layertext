// LayerText 分层读 · 桌面主进程
// 全离线：仅本地文件读写与对话框，无任何网络与遥测。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
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
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(T[(n >> 18) as usize & 63] as char);
        out.push(T[(n >> 12) as usize & 63] as char);
        out.push(if c.len() > 1 { T[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if c.len() > 2 { T[n as usize & 63] as char } else { '=' });
    }
    out
}

#[tauri::command]
fn write_text_file(path: String, content: String) -> Result<(), String> {
    if let Some(dir) = std::path::Path::new(&path).parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())
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
            let ext = p.extension().and_then(|x| x.to_str()).unwrap_or("").to_lowercase();
            if (ext == "md" || ext == "txt")
                && !p.file_name().and_then(|n| n.to_str()).unwrap_or("").starts_with('_')
            {
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

#[tauri::command]
fn save_api_key(key: String) -> Result<(), String> {
    // -A：条目允许本机应用读取，避免每次读写都弹钥匙串授权框（个人电脑上的 API Key 场景可接受）
    let st = std::process::Command::new("security")
        .args(["add-generic-password", "-U", "-A", "-a", "layertext", "-s", "layertext.apikey", "-w", &key])
        .output()
        .map_err(|e| e.to_string())?;
    if st.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&st.stderr).into_owned())
    }
}

#[tauri::command]
fn load_api_key() -> Result<String, String> {
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-a", "layertext", "-s", "layertext.apikey", "-w"])
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
        "usage" => open_help(&app, "help-usage", "LayerText 使用说明", "/help.html", 760.0, 780.0),
        "qc" => open_help(&app, "help-qc", "LayerText · QC 指标说明", "/help-qc.html", 760.0, 860.0),
        _ => open_help(&app, "help-key", "如何获取 AI 的 Key（新手向）", "/help-key.html", 760.0, 720.0),
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            // ---- 原生菜单栏 ----
            let mi_open = MenuItemBuilder::with_id("file-open", "打开章节文件…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let mi_demo = MenuItemBuilder::with_id("file-demo", "载入示例…").build(app)?;
            let mi_vocab = MenuItemBuilder::with_id("conf-vocab", "导入自定义词库…").build(app)?;
            let mi_terms = MenuItemBuilder::with_id("conf-terms", "导入术语表…").build(app)?;
            let mi_proper = MenuItemBuilder::with_id("conf-proper", "导入专名表…").build(app)?;
            let mi_exp = MenuItemBuilder::with_id("marks-export", "导出标记…").build(app)?;
            let mi_imp = MenuItemBuilder::with_id("marks-import", "导入标记…").build(app)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let sep3 = PredefinedMenuItem::separator(app)?;

            let file_menu = SubmenuBuilder::new(app, "文件")
                .item(&mi_open)
                .item(&mi_demo)
                .item(&sep1)
                .item(&mi_vocab)
                .item(&mi_terms)
                .item(&mi_proper)
                .text("book-config", "保存为本书配置（词库/约定随文件夹）")
                .item(&sep2)
                .item(&mi_exp)
                .item(&mi_imp)
                .build()?;

            let mi_run = MenuItemBuilder::with_id("qc-run", "质检本章")
                .accelerator("CmdOrCtrl+R")
                .build(app)?;
            let mi_ai = MenuItemBuilder::with_id("ai-suggest", "AI 审核建议…").build(app)?;
            let mi_draft = MenuItemBuilder::with_id("draft", "生成分层初稿…").build(app)?;
            let qc_menu = SubmenuBuilder::new(app, "质检").item(&mi_run).item(&mi_draft).separator().item(&mi_ai).build()?;

            let mi_vt = MenuItemBuilder::with_id("view-text", "正文审校").build(app)?;
            let mi_vr = MenuItemBuilder::with_id("view-report", "质检报告").build(app)?;
            let view_menu = SubmenuBuilder::new(app, "显示")
                .item(&mi_vt)
                .item(&mi_vr)
                .item(&sep3)
                .fullscreen()
                .build()?;

            let help_menu = SubmenuBuilder::new(app, "帮助")
                .text("help-usage", "使用说明")
                .text("help-key", "如何获取 AI 的 Key（新手向）")
                .text("help-qc", "QC 指标说明")
                .separator()
                .text("help-example-dir", "打开本地示例文件夹")
                .build()?;

            let app_menu = SubmenuBuilder::new(app, "LayerText")
                .about(None)
                .text("ai-settings", "AI 设置…")
                .text("tier-plan", "分层方案…（B/M/A 标准可调）")
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
                .items(&[&app_menu, &file_menu, &edit_menu, &qc_menu, &view_menu, &window_menu, &help_menu])
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
            reports_dir,
            examples_dir,
            list_local_examples,
            reveal_path,
            save_api_key,
            load_api_key,
            save_app_config,
            load_app_config,
            open_help_window
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
